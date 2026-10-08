import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  createCheckoutSparkMerchantProgress,
  deriveCheckoutSparkNativeTreasuryBudget,
  getAccountSigner,
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  publishMerchantCheckoutSparkProgress,
  restoreCheckoutSparkMerchantOrderWitness,
  restoreCheckoutSparkSettledReconciliation,
  retryMerchantCheckoutSparkProgress,
  runCheckoutSparkNativeTreasuryStep,
  runWithCheckoutSparkMerchantRecoveryLock,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
  type CheckoutSparkNativeTreasuryTarget,
  type MerchantCheckoutSparkRecoveryCandidate,
  type NostrKeySigner,
} from "@conduit/core"
import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  openMerchantCheckoutSparkRecoveryWallet,
  proveMerchantCheckoutSparkNativeCommerce,
} from "./checkout-spark-settled-recovery"
import { assertMerchantCheckoutSparkDispatchPlan } from "./checkout-spark-recovery-policy"
import type {
  MerchantCheckoutSparkContinuationDependencies,
  MerchantCheckoutSparkContinuationResult,
} from "./checkout-spark-settled-continuation"

type NativeStore = Pick<
  DexieCheckoutSparkSettledRepository,
  | "load"
  | "save"
  | "saveTreasuryPrepared"
  | "loadMerchantOrderWitness"
  | "loadMerchantSettlement"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
  | "recordMerchantTreasury"
  | "assertLocalInvoiceOrigin"
> &
  Partial<Pick<DexieCheckoutSparkSettledRepository, "assertInvoiceRecipient">>

export interface MerchantCheckoutSparkNativeTreasuryContinuationDependencies extends Omit<
  MerchantCheckoutSparkContinuationDependencies,
  "repository"
> {
  repository?: NativeStore
  proveCommerce?: typeof proveMerchantCheckoutSparkNativeCommerce
  assertDispatchPlan?: typeof assertMerchantCheckoutSparkDispatchPlan
  /** Repair saved state from this exact request only; never prepare or send. */
  inspectionOnly?: boolean
}

/** Explicit native finalization; never prepares or reviews a Lightning fee invoice. */
export async function continueMerchantCheckoutSparkNativeTreasury(
  principalPubkey: string,
  selectedInput: MerchantCheckoutSparkRecoveryCandidate,
  dependencies: MerchantCheckoutSparkNativeTreasuryContinuationDependencies = {}
): Promise<MerchantCheckoutSparkContinuationResult> {
  const principal = principalPubkey.trim().toLowerCase()
  const selected = {
    ...selectedInput,
    ...(selectedInput.merchantProgress
      ? { merchantProgress: { ...selectedInput.merchantProgress } }
      : {}),
  }
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const consumeRecovery =
    dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const proveCommerce =
    dependencies.proveCommerce ?? proveMerchantCheckoutSparkNativeCommerce
  const progressStore =
    dependencies.progressStore ??
    new DexieMerchantCheckoutSparkProgressRepository()
  const assertDispatchPlan =
    dependencies.assertDispatchPlan ?? assertMerchantCheckoutSparkDispatchPlan
  let payout: MerchantCheckoutSparkContinuationResult["payout"] = null
  const consume = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signedInput: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ) => {
    const signed = restoreCheckoutSparkSettledReconciliation(signedInput)
    const { plan } = signed
    const assertEligible = () => {
      assertCurrent()
      assertDispatchPlan(plan)
      if (dependencies.shouldContinue?.() === false || now() < plan.takeoverAt)
        throw new Error(
          "Merchant treasury takeover is not currently authorized."
        )
    }
    assertEligible()
    if (
      plan.schemaVersion !== 4 ||
      !plan.nativeTreasury ||
      principal !== plan.merchantPubkey ||
      initial.merchantPubkey !== principal ||
      initial.plan.planDigest !== plan.planDigest ||
      selected.checkoutId !== plan.checkoutId ||
      selected.orderId !== plan.orderId ||
      selected.planDigest !== plan.planDigest ||
      selected.takeoverAt !== plan.takeoverAt ||
      initial.wallet.walletId !== plan.walletId ||
      initial.wallet.network !== plan.network ||
      typeof repository.saveTreasuryPrepared !== "function" ||
      typeof repository.recordMerchantTreasury !== "function" ||
      typeof repository.loadMerchantSettlement !== "function"
    )
      throw new Error(
        "Checkout Spark native treasury recovery binding is invalid."
      )
    const witness = await repository.loadMerchantOrderWitness(
      principal,
      plan.checkoutId,
      plan.planDigest
    )
    assertEligible()
    if (
      !witness ||
      restoreCheckoutSparkMerchantOrderWitness(witness, plan).buyerPubkey !==
        initial.senderPubkey
    )
      throw new Error(
        "Native treasury continuation requires its authenticated order."
      )
    const load = async () => {
      assertEligible()
      const saved = await repository.load(plan.checkoutId, plan.planDigest)
      assertEligible()
      if (saved.status !== "active")
        throw new CheckoutSparkSettledRepositoryConflictError()
      assertCheckoutSparkSettledRecoveryProgression(signed, saved.state)
      return saved
    }
    const loaded = await load()
    let expectedState = loaded.state
    const fee = plan.recipients.find(
      (recipient) => recipient.kind === "conduit"
    )!
    const next = expectedState.legs.find((leg) => leg.status !== "paid")
    if (!next) {
      payout = { outcome: "already_paid", sendAttempted: false }
      return
    }
    if (next.legId !== fee.legId) {
      payout = {
        outcome: "wait",
        reason: "prerequisite_unpaid",
        sendAttempted: false,
      }
      return
    }
    const assertDurable = async () => {
      const current = await load()
      if (JSON.stringify(current.state) !== JSON.stringify(expectedState))
        throw new CheckoutSparkSettledRepositoryConflictError()
    }
    const signer: NostrKeySigner | null =
      dependencies.signer === undefined
        ? (getAccountSigner() ?? null)
        : dependencies.signer
    if (!signer || (await signer.getPublicKey()).toLowerCase() !== principal)
      throw new Error(
        "Native treasury continuation requires the current Merchant signer."
      )
    assertEligible()
    const shouldContinue = () => {
      assertEligible()
      return true
    }
    for (const entry of await progressStore.list(
      principal,
      plan.checkoutId,
      plan.planDigest
    )) {
      const record = parseMerchantCheckoutSparkProgressDeliveryRecord(
        entry.record
      )
      if (
        record.initialHandoffId !== initial.handoffId ||
        record.merchantPubkey !== principal ||
        record.planDigest !== plan.planDigest
      )
        throw new Error("Merchant native progress binding changed.")
      if (entry.relayAccepted) continue
      const delivery = await retryMerchantCheckoutSparkProgress({
        record,
        signer,
        store: progressStore,
        shouldContinue,
        transport: dependencies.progressTransport,
      })
      await assertDurable()
      if (!delivery.relayAccepted) {
        payout = {
          outcome: "wait",
          reason: "recovery_handoff_unavailable",
          sendAttempted: false,
        }
        return
      }
    }
    const identity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      identity !== plan.funding.receiverIdentityPublicKey ||
      identity !== plan.nativeTreasury.senderIdentityPublicKey
    )
      throw new Error("Checkout Spark native sender identity changed.")
    await assertDurable()
    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: plan.network,
      outgoing: true,
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      if (
        (await wallet.getIdentityPublicKey()).toLowerCase() !== identity ||
        !wallet.nativeTreasury
      )
        throw new Error(
          "Checkout Spark native treasury provider is unavailable."
        )
      const treasury = wallet.nativeTreasury
      // These ports belong to this Core-engine invocation, not a standalone
      // wallet send action. Restored possible-send progress can only reconcile.
      const preparedAdmissions = new Set<string>()
      const admissionKey = (target: CheckoutSparkNativeTreasuryTarget) =>
        JSON.stringify(target)
      const request = (target: CheckoutSparkNativeTreasuryTarget) => {
        if (
          target.walletId !== plan.walletId ||
          target.network !== plan.network ||
          target.planDigest !== plan.planDigest ||
          target.legId !== fee.legId ||
          JSON.stringify(target.nativeTreasury) !==
            JSON.stringify(plan.nativeTreasury) ||
          JSON.stringify(target.intent) !==
            JSON.stringify(expectedState.treasuryFinalization?.intent)
        )
          throw new Error("Checkout Spark native payment authority changed.")
        return {
          network: target.network,
          nativeTreasury: target.nativeTreasury,
          amountSats: target.intent.amountSats,
          authorizedDebitSats: target.intent.authorizedDebitSats,
          providerTransferId:
            expectedState.treasuryFinalization!.providerTransferId,
        }
      }
      const step = await runCheckoutSparkNativeTreasuryStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId: fee.legId,
        actor: "merchant",
        now,
        inspectionOnly: dependencies.inspectionOnly,
        store: {
          load: async () => {
            await assertDurable()
            return load()
          },
          save: async (state, revision) => {
            assertEligible()
            const result = await repository.save(
              state,
              revision,
              assertEligible
            )
            assertEligible()
            expectedState = state
            return result
          },
          savePrepared: async (state, revision, settlement) => {
            assertEligible()
            const result = await repository.saveTreasuryPrepared(
              state,
              revision,
              settlement,
              assertEligible
            )
            assertEligible()
            expectedState = state
            return result
          },
        },
        proveCommerce: async (state) => {
          await assertDurable()
          return proveCommerce({
            state,
            wallet,
            repository,
            assertCurrent: assertEligible,
            now,
          })
        },
        acknowledgeRecoverySnapshot: async (state) => {
          await assertDurable()
          if (JSON.stringify(state) !== JSON.stringify(expectedState))
            throw new CheckoutSparkSettledRepositoryConflictError()
          const delivery = await publishMerchantCheckoutSparkProgress({
            payload: createCheckoutSparkMerchantProgress({
              initialHandoffId: initial.handoffId,
              state,
            }),
            signer,
            store: progressStore,
            shouldContinue,
            transport: dependencies.progressTransport,
          })
          await assertDurable()
          if (!delivery.relayAccepted)
            throw new Error(
              "Merchant native progress requires relay acknowledgment."
            )
        },
        provider: {
          reconcile: async (target) => {
            assertEligible()
            const observation = await treasury.inspectCheckoutTreasury(
              request(target)
            )
            assertEligible()
            if (observation.status === "paid") {
              await proveCommerce({
                state: expectedState,
                wallet,
                repository,
                assertCurrent: assertEligible,
                now,
                proofMode: "receipt",
              })
              assertEligible()
              await repository.recordMerchantTreasury(
                expectedState,
                { ...observation, status: "paid", observedAt: now() },
                assertEligible
              )
              assertEligible()
            }
            return observation
          },
          preflight: async (target) => {
            await assertDurable()
            const value = request(target)
            if (expectedState.treasuryFinalization?.status !== "prepared")
              return "unavailable"
            const status = await treasury.preflightCheckoutTreasury(value)
            await assertDurable()
            if (expectedState.treasuryFinalization?.status !== "prepared")
              return "unavailable"
            if (status === "ready") preparedAdmissions.add(admissionKey(target))
            return status
          },
          send: async (target) => {
            await assertDurable()
            const value = request(target)
            if (
              expectedState.treasuryFinalization?.status !== "submitted" ||
              !preparedAdmissions.delete(admissionKey(target))
            )
              throw new Error("Checkout Spark native payment was not admitted.")
            const sent = await treasury.sendCheckoutTreasury({
              ...value,
              priorSendMayHaveOccurred: false,
              assertBeforeSend: async () => {
                await assertDurable()
                const record = await proveCommerce({
                  state: expectedState,
                  wallet,
                  repository,
                  assertCurrent: assertEligible,
                  now,
                })
                assertEligible()
                if (
                  deriveCheckoutSparkNativeTreasuryBudget(expectedState, record)
                    .accountingDigest !== target.intent.accountingDigest
                )
                  throw new Error("Checkout Spark final amount changed.")
                await assertDurable()
              },
            })
            assertEligible()
            return {
              status: sent.status === "not_sent" ? "not_sent" : "submitted",
            }
          },
        },
      })
      assertEligible()
      payout = {
        outcome: step.outcome,
        reason: step.reason,
        sendAttempted: step.sendAttempted,
      }
    } finally {
      await wallet.cleanup()
    }
  }
  return runWithCheckoutSparkMerchantRecoveryLock(
    selected.planDigest,
    async () => {
      const result = await consumeRecovery(principal, selected, {
        consume: async (initial, guard) => {
          if (initial.schemaVersion !== 2)
            throw new Error("Native treasury requires settled recovery.")
          await consume(initial, initial.state, guard)
        },
        consumeSettled: async (initial, latest, guard) =>
          consume(initial, latest.state, guard),
        consumeMerchantProgress: async (initial, _buyer, progress, guard) => {
          if (
            progress.merchantPubkey !== principal ||
            progress.initialHandoffId !== initial.handoffId ||
            progress.snapshotId !== selected.merchantProgress?.snapshotId ||
            progress.recordedAt !== selected.merchantProgress.recordedAt
          )
            throw new Error("Merchant native progress selection changed.")
          await consume(initial, progress.state, guard)
        },
      })
      return { ...result, payout: result.status === "consumed" ? payout : null }
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}
