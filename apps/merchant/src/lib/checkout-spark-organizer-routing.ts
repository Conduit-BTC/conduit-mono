import type { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  CheckoutSparkSettledRepositoryConflictError,
  RelayPublishDiagnosticsError,
  assertCheckoutSparkTreasuryAddressAllowed,
  assertCheckoutSparkSettledMerchantPreparationWindow,
  assertCheckoutSparkSettledRecoveryProgression,
  createCheckoutSparkSettledNativeOutgoingProvider,
  deriveCheckoutSparkNativeTreasuryBudget,
  isCheckoutSparkNativePreProviderRetry,
  proveSparkCheckoutReceiveCredit,
  resolveCheckoutSparkLnurlInvoice,
  runCheckoutSparkFinancialWorkflow,
  runWithCheckoutSparkMerchantRecoveryLock,
  verifyCheckoutSparkInvoiceRecipient,
  type AccountSigner,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkNativeTreasuryProvider,
  type CheckoutSparkNativeTreasuryTarget,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkInvoiceRecipientDependencies,
  type CheckoutSparkSettledLegPreparationDependencies,
} from "@conduit/core"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertCheckoutSparkOrganizerRecoveryWriterCurrent,
  withCheckoutSparkOrganizerRecovery,
  type CheckoutSparkOrganizerRecoveryAuthority,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import {
  proveCheckoutSparkOrganizerCommerce,
  type CheckoutSparkOrganizerCommerceProof,
} from "@conduit/core/protocol/checkout-spark-organizer-commerce"
import {
  createCheckoutSparkOrganizerExecutionProgress,
  publishCheckoutSparkOrganizerExecutionProgress,
  DexieCheckoutSparkOrganizerProgressRepository,
  type CheckoutSparkOrganizerProgressTransport,
} from "@conduit/core/protocol/checkout-spark-organizer-progress"
import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  inspectExactMerchantPayout,
  openMerchantCheckoutSparkRecoveryWallet,
  proveMerchantCheckoutSparkNativeCommerce,
} from "./checkout-spark-settled-recovery"
import { assertCheckoutSparkMerchantPricingAuthority } from "./checkout-spark-pricing-authority"
import { assertCheckoutSparkRecoveryDestination } from "./checkout-spark-recovery-policy"

export interface CheckoutSparkOrganizerRoutingInput {
  db: ConduitDB
  authority: CheckoutSparkOrganizerRecoveryAuthority
  signer: AccountSigner
  authenticatedPubkey: string
  shouldContinue(): boolean
}
export interface CheckoutSparkOrganizerRoutingDependencies {
  repository?: DexieCheckoutSparkSettledRepository
  openWallet?: typeof openMerchantCheckoutSparkRecoveryWallet
  deriveIdentity?: typeof deriveMerchantCheckoutSparkRecoveryIdentity
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  lockManager?: CheckoutSparkMerchantRecoveryLockManager | null
  requireCrossTabLock?: boolean
  resolveInvoice?: CheckoutSparkSettledLegPreparationDependencies["resolveInvoice"]
  receiverDependencies?: CheckoutSparkInvoiceRecipientDependencies
  progressTransport?: CheckoutSparkOrganizerProgressTransport
}
export interface CheckoutSparkOrganizerRoutingResult {
  status: "complete" | "waiting"
  reason?: string
  commerceProof: CheckoutSparkOrganizerCommerceProof | null
  /** Payment completion never silently destroys an offline receiver's evidence. */
  walletRetirement: "retained"
}

/** Only an exact persisted progress delivery may enter the bounded retry loop. */
class OrganizerProgressAckUnavailableError extends Error {}

/**
 * The organizer is the authorized post-cutoff writer, not a Merchant alias.
 * The existing Core engine still owns invoice preparation, exact-attempt CAS,
 * possible-send reconciliation and native collection. Wallet material remains
 * inside the branded recovery callback and is never returned to the route.
 */
export async function routeCheckoutSparkOrganizerOrder(
  input: CheckoutSparkOrganizerRoutingInput,
  dependencies: CheckoutSparkOrganizerRoutingDependencies = {}
): Promise<CheckoutSparkOrganizerRoutingResult> {
  input = { ...input }
  const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(
    input.authority
  )
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const deadline = startedAt + 2 * 60_000
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository(input.db)
  const progressStore = new DexieCheckoutSparkOrganizerProgressRepository(
    input.db
  )
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const signerRevision = input.signer.revision
  const signerMethod = input.signer.authMethod
  const assertSession = () => {
    const current = assertCheckoutSparkOrganizerRecoveryAuthority(
      input.authority
    )
    if (
      !input.shouldContinue() ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      current.plan.eventMarket?.organizerPubkey !== input.authenticatedPubkey ||
      current.handoffId !== purchase.handoffId ||
      input.signer.revision !== signerRevision ||
      input.signer.authMethod !== signerMethod ||
      !signerRevision ||
      !signerMethod ||
      !input.signer.capabilities.nip44 ||
      !Number.isSafeInteger(now()) ||
      now() < startedAt ||
      now() >= deadline
    )
      throw new Error("Organizer payment processing is no longer active.")
  }
  const assertWriter = async () => {
    assertSession()
    await assertCheckoutSparkOrganizerRecoveryWriterCurrent(input.authority)
    assertSession()
  }
  assertSession()
  if ((await input.signer.getPublicKey()) !== input.authenticatedPubkey)
    throw new Error("Organizer signer changed.")
  await assertWriter()
  return runWithCheckoutSparkMerchantRecoveryLock(
    purchase.plan.planDigest,
    () =>
      withCheckoutSparkOrganizerRecovery(input.authority, async (context) => {
        const { initial } = context
        const plan = initial.plan
        const assertCurrent = () => {
          context.assertCurrent()
          assertSession()
        }
        const check = async () => {
          assertCurrent()
          await assertWriter()
          assertCurrent()
        }
        if (
          plan.schemaVersion !== 5 ||
          plan.eventMarket?.mode !== "organizer_handoff" ||
          !plan.nativeTreasury
        )
          throw new Error("Exact organizer checkout plan is unavailable.")
        const conduit = plan.recipients.find((row) => row.kind === "conduit")!
        assertCheckoutSparkRecoveryDestination(plan)
        assertCheckoutSparkTreasuryAddressAllowed(
          plan.network,
          plan.nativeTreasury.sparkAddress
        )
        const identity = await deriveIdentity(
          initial.wallet.mnemonic,
          initial.wallet.accountNumber
        )
        await check()
        if (
          identity !== plan.funding.receiverIdentityPublicKey ||
          identity !== plan.nativeTreasury.senderIdentityPublicKey
        )
          throw new Error(
            "Organizer checkout recovery key does not match funding."
          )
        // Import merges only monotonic stronger recovery. It does not fabricate
        // an authenticated Merchant order witness or establish payment truth.
        const local = await repository.load(plan.checkoutId, plan.planDigest)
        await check()
        let strongerLocal = false
        if (local.status === "active") {
          try {
            assertCheckoutSparkSettledRecoveryProgression(
              context.state,
              local.state
            )
            strongerLocal = true
          } catch {
            // A newer authenticated snapshot may advance local state. Import
            // still rejects unrelated or incompatible histories; no witness is
            // fabricated merely to retain an older local projection.
          }
        }
        const imported = strongerLocal
          ? local
          : await repository.importRecoveryState(context.state, assertCurrent)
        await check()
        if (imported.status !== "active")
          throw new CheckoutSparkSettledRepositoryConflictError()
        let expected = imported.state
        const load = async () => {
          await check()
          const saved = await repository.load(plan.checkoutId, plan.planDigest)
          await check()
          if (
            saved.status !== "active" ||
            JSON.stringify(saved.state) !== JSON.stringify(expected)
          )
            throw new CheckoutSparkSettledRepositoryConflictError()
          assertCheckoutSparkSettledRecoveryProgression(
            context.state,
            saved.state
          )
          return saved
        }
        const wallet = await openWallet({
          mnemonic: initial.wallet.mnemonic,
          accountNumber: initial.wallet.accountNumber,
          network: initial.wallet.network,
          outgoing: true,
        })
        let commerceProof: CheckoutSparkOrganizerCommerceProof | null = null
        try {
          await check()
          await wallet.ensurePrivateReady()
          await check()
          if (
            (await wallet.getIdentityPublicKey()).toLowerCase() !== identity ||
            !wallet.outgoing ||
            !wallet.nativeTreasury
          )
            throw new Error("Organizer checkout wallet is unavailable.")
          const readFunding = async () => {
            await check()
            const receive = await wallet.getLightningReceiveRequest(
              plan.funding.requestId
            )
            await check()
            if (
              !receive ||
              receive.status !== "TRANSFER_COMPLETED" ||
              !receive.transfer?.sparkId
            )
              return null
            const transfer = await wallet.getTransfer(receive.transfer.sparkId)
            await check()
            if (!transfer) return null
            return {
              expectedRequest: {
                id: plan.funding.requestId,
                network: plan.network,
                paymentRequest: plan.funding.paymentRequest,
                paymentHash: plan.funding.paymentHash,
                grossFundingSats: plan.funding.grossFundingSats,
              },
              expectedReceive: { mode: "ordinary_v3" as const },
              walletIdentityPublicKey: identity,
              receive,
              transfer,
            }
          }
          const funding = await readFunding()
          if (!funding)
            return {
              status: "waiting",
              reason: "funding_wait",
              commerceProof,
              walletRetirement: "retained",
            }
          const credit = proveSparkCheckoutReceiveCredit(funding)
          assertCheckoutSparkMerchantPricingAuthority({
            plan,
            fundingProof: credit,
          })
          const progressFailure: { failed: boolean; error?: unknown } = {
            failed: false,
          }
          const acknowledgeExact = async (
            state: CheckoutSparkSettledReconciliation
          ) => {
            await load()
            if (JSON.stringify(state) !== JSON.stringify(expected))
              throw new CheckoutSparkSettledRepositoryConflictError()
            const delivery =
              await publishCheckoutSparkOrganizerExecutionProgress({
                payload: createCheckoutSparkOrganizerExecutionProgress({
                  initialHandoffId: initial.handoffId,
                  initialMerchantHandoffId: initial.merchantHandoffId,
                  organizerPubkey: initial.organizerPubkey,
                  writerBindings: purchase.writerBindings,
                  orderBinding: initial.orderBinding,
                  state,
                }),
                signer: input.signer,
                store: progressStore,
                shouldContinue: () => {
                  assertCurrent()
                  return true
                },
                transport: dependencies.progressTransport,
              })
            await load()
            if (!delivery.merchantAccepted || !delivery.selfAccepted)
              throw new OrganizerProgressAckUnavailableError(
                "Organizer checkout progress requires both relay acknowledgments."
              )
          }
          const acknowledge = async (
            state: CheckoutSparkSettledReconciliation
          ) => {
            try {
              await acknowledgeExact(state)
            } catch (error) {
              if (
                !(error instanceof RelayPublishDiagnosticsError) &&
                !(error instanceof OrganizerProgressAckUnavailableError)
              ) {
                // The shared engine deliberately retains a paid projection
                // when ACK delivery fails. Preserve that safety result, but
                // do not retry a signing/storage failure as if it were merely
                // a missing relay acknowledgment.
                progressFailure.failed = true
                progressFailure.error = error
              }
              throw error
            }
          }
          const save = async (
            state: CheckoutSparkSettledReconciliation,
            revision: number
          ) => {
            await check()
            const saved = await repository.save(state, revision, assertCurrent)
            expected = state
            await check()
            return saved
          }
          const store = {
            outgoingAdmissionScope: repository.outgoingAdmissionScope,
            load,
            save,
            saveOutgoingPreProviderRetry: async (
              ...args: Parameters<
                DexieCheckoutSparkSettledRepository["saveOutgoingPreProviderRetry"]
              >
            ) => {
              await check()
              const saved = await repository.saveOutgoingPreProviderRetry(
                args[0],
                args[1],
                args[2],
                assertCurrent
              )
              expected = args[0]
              await check()
              return saved
            },
          }
          const inspect = (target: CheckoutSparkSettledOutgoingTarget) =>
            inspectExactMerchantPayout(plan, target, wallet, assertCurrent)
          let dispatchTarget: CheckoutSparkSettledOutgoingTarget | null = null
          const provider = createCheckoutSparkSettledNativeOutgoingProvider({
            plan,
            wallet: wallet.outgoing,
            reconcile: async (target) => {
              await check()
              const result = await inspect(target)
              await check()
              return result
            },
            now,
            assertBeforeSend: async () => {
              await load()
              if (!dispatchTarget)
                throw new Error("Exact organizer payout is unavailable.")
              await repository.assertInvoiceRecipient(
                plan,
                dispatchTarget,
                assertCurrent
              )
              await check()
            },
          })
          const recordPaid = async (
            target: CheckoutSparkSettledOutgoingTarget,
            observation: Extract<
              Awaited<ReturnType<typeof inspect>>,
              { status: "paid" }
            >
          ) => {
            const result = await verifyCheckoutSparkInvoiceRecipient(
              { plan, target, now: now(), assertCurrent },
              dependencies.receiverDependencies
            )
            await check()
            if (result.status !== "verified" || !result.settled) return false
            await repository.recordInvoiceRecipientVerification(
              plan,
              target,
              result.proof,
              assertCurrent
            )
            await repository.recordMerchantPayout(
              plan,
              target,
              observation,
              now(),
              assertCurrent
            )
            await check()
            return true
          }
          const preparedAdmissions = new Set<string>()
          const nativeRequest = async (
            target: CheckoutSparkNativeTreasuryTarget
          ) => {
            await load()
            if (
              target.planDigest !== plan.planDigest ||
              target.legId !== conduit.legId ||
              target.walletId !== plan.walletId ||
              target.network !== plan.network ||
              JSON.stringify(target.nativeTreasury) !==
                JSON.stringify(plan.nativeTreasury) ||
              JSON.stringify(target.intent) !==
                JSON.stringify(expected.treasuryFinalization?.intent)
            )
              throw new Error("Organizer native payment authority changed.")
            return {
              network: plan.network,
              nativeTreasury: target.nativeTreasury,
              amountSats: target.intent.amountSats,
              authorizedDebitSats: target.intent.authorizedDebitSats,
              providerTransferId:
                expected.treasuryFinalization!.providerTransferId,
            }
          }
          const nativeProvider: CheckoutSparkNativeTreasuryProvider = {
            reconcile: async (target) => {
              const result =
                await wallet.nativeTreasury!.inspectCheckoutTreasury(
                  await nativeRequest(target)
                )
              await check()
              if (result.status === "paid") {
                await proveMerchantCheckoutSparkNativeCommerce({
                  state: expected,
                  wallet,
                  repository,
                  now,
                  assertCurrent,
                  proofMode: "receipt",
                })
                await repository.recordMerchantTreasury(
                  expected,
                  { ...result, status: "paid", observedAt: now() },
                  assertCurrent
                )
                await check()
              }
              return result
            },
            preflight: async (target, cancellation) => {
              const request = await nativeRequest(target)
              const admissible = () =>
                expected.treasuryFinalization?.status === "prepared" ||
                (expected.treasuryFinalization?.status === "terminal_failure" &&
                  isCheckoutSparkNativePreProviderRetry(cancellation, target))
              if (!admissible()) return "unavailable"
              const result =
                await wallet.nativeTreasury!.preflightCheckoutTreasury(request)
              await load()
              if (!admissible()) return "unavailable"
              if (result === "ready")
                preparedAdmissions.add(JSON.stringify(target))
              return result
            },
            send: async (target) => {
              const request = await nativeRequest(target)
              if (
                expected.treasuryFinalization?.status !== "submitted" ||
                !preparedAdmissions.delete(JSON.stringify(target))
              )
                throw new Error("Organizer native payment was not admitted.")
              const result = await wallet.nativeTreasury!.sendCheckoutTreasury({
                ...request,
                priorSendMayHaveOccurred: false,
                assertBeforeSend: async () => {
                  await load()
                  const record = await proveMerchantCheckoutSparkNativeCommerce(
                    { state: expected, wallet, repository, now, assertCurrent }
                  )
                  await load()
                  if (
                    deriveCheckoutSparkNativeTreasuryBudget(expected, record)
                      .accountingDigest !== target.intent.accountingDigest
                  )
                    throw new Error("Organizer final payment amount changed.")
                },
              })
              await check()
              return {
                status: result.status === "not_sent" ? "not_sent" : "submitted",
              }
            },
          }
          const proveGoods = async () => {
            try {
              commerceProof = await proveCheckoutSparkOrganizerCommerce({
                initial,
                state: expected,
                now,
                assertCurrent,
                receiverDependencies: dependencies.receiverDependencies,
                inspectPayout: inspect,
                readFunding: async () => {
                  const evidence = await readFunding()
                  if (!evidence)
                    throw new Error("Exact organizer funding is unavailable.")
                  return evidence
                },
              })
            } catch {
              await check()
              commerceProof = null
            }
          }
          let waitingReason = "bounded_reconciliation"
          for (let step = 0; step < plan.recipients.length * 3 + 12; step++) {
            await load()
            progressFailure.failed = false
            delete progressFailure.error
            try {
              const result = await runCheckoutSparkFinancialWorkflow(
                {
                  checkoutId: plan.checkoutId,
                  planDigest: plan.planDigest,
                  actor: "merchant",
                  mode: "advance",
                },
                {
                  now,
                  assertCurrent: check,
                  store,
                  credit: {
                    proof: credit,
                    record: (current, proof) =>
                      repository.recordMerchantCredit(
                        current,
                        proof,
                        now(),
                        assertCurrent
                      ),
                  },
                  acknowledgeRecoverySnapshot: acknowledge,
                  outgoing: {
                    reconcile: provider.reconcile,
                    preflight: (target) => {
                      dispatchTarget = target
                      return provider.preflight(target)
                    },
                    send: (target) => {
                      dispatchTarget = target
                      return provider.send(target)
                    },
                  },
                  recordPaid,
                  preparation: {
                    repository: {
                      load,
                      savePreparedWithInvoiceOrigin: async (
                        state,
                        revision,
                        proof,
                        assert
                      ) => {
                        await check()
                        const saved =
                          await repository.savePreparedWithInvoiceOrigin(
                            state,
                            revision,
                            proof,
                            assert
                          )
                        expected = state
                        await check()
                        return saved
                      },
                    },
                    assertAuthority: (state, time) => {
                      assertCurrent()
                      assertCheckoutSparkSettledMerchantPreparationWindow(
                        state,
                        time
                      )
                    },
                    acknowledgeRecoverySnapshot: acknowledge,
                    nowMs: now,
                    estimateFee: async (request) => {
                      await check()
                      const value = await wallet.outgoing!.estimateFee({
                        paymentRequest: request.paymentRequest,
                      })
                      await check()
                      return value
                    },
                    resolveInvoice:
                      dependencies.resolveInvoice ??
                      ((request) => resolveCheckoutSparkLnurlInvoice(request)),
                  },
                  native: {
                    store: {
                      load,
                      save,
                      nativeAdmissionScope:
                        repository.nativeTreasuryAdmissionScope,
                      savePrepared: async (state, revision, settlement) => {
                        await check()
                        const saved = await repository.saveTreasuryPrepared(
                          state,
                          revision,
                          settlement,
                          assertCurrent
                        )
                        expected = state
                        await check()
                        return saved
                      },
                      savePreProviderRetry: async (
                        state,
                        revision,
                        cancellation
                      ) => {
                        await check()
                        const saved =
                          await repository.saveTreasuryPreProviderRetry(
                            state,
                            revision,
                            cancellation,
                            assertCurrent
                          )
                        expected = state
                        await check()
                        return saved
                      },
                    },
                    provider: nativeProvider,
                    proveCommerce: async (state) => {
                      await load()
                      return proveMerchantCheckoutSparkNativeCommerce({
                        state,
                        wallet,
                        repository,
                        now,
                        assertCurrent,
                      })
                    },
                  },
                }
              )
              await load()
              if (progressFailure.failed) throw progressFailure.error
              if (result.status === "outgoing_step" && result.step.reason)
                waitingReason = result.step.reason
              if (
                result.status === "outgoing_step" &&
                ["paid", "already_paid"].includes(result.step.outcome) &&
                expected.legs.every((leg) => leg.status === "paid")
              ) {
                // Imported/signed paid projections are not payment authority.
                // Core just rechecked every Lightning leg; independently check
                // the exact native request as well, including an offline claim.
                const intent = expected.treasuryFinalization?.intent
                if (!intent)
                  throw new Error(
                    "Exact organizer native payment is unavailable."
                  )
                const native = await nativeProvider.reconcile({
                  walletId: plan.walletId,
                  network: plan.network,
                  legId: conduit.legId,
                  planDigest: plan.planDigest,
                  nativeTreasury: plan.nativeTreasury!,
                  intent,
                })
                if (native.status !== "paid") {
                  await proveGoods()
                  return {
                    status: "waiting",
                    reason: "provider_evidence_unavailable",
                    commerceProof,
                    walletRetirement: "retained",
                  }
                }
                await proveGoods()
                return {
                  status: "complete",
                  commerceProof,
                  walletRetirement: "retained",
                }
              }
              if (
                result.status === "payout_prepared" ||
                (result.status === "outgoing_step" &&
                  ["paid", "already_paid"].includes(result.step.outcome))
              )
                continue
              if (
                result.status === "outgoing_step" &&
                result.step.reason &&
                ![
                  "provider_evidence_unavailable",
                  "recovery_handoff_unavailable",
                  "fee_unavailable",
                  "prior_possible_send",
                ].includes(result.step.reason)
              ) {
                await proveGoods()
                return {
                  status: "waiting",
                  reason: result.step.reason,
                  commerceProof,
                  walletRetirement: "retained",
                }
              }
            } catch (error) {
              await check()
              if (
                !(error instanceof RelayPublishDiagnosticsError) &&
                !(error instanceof OrganizerProgressAckUnavailableError)
              )
                throw error
            }
            await wait(Math.min(5_000, 1_000 * 2 ** Math.min(step, 2)))
          }
          await proveGoods()
          return {
            status: "waiting",
            reason: waitingReason,
            commerceProof,
            walletRetirement: "retained",
          }
        } finally {
          await wallet.cleanup()
        }
      }),
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}
