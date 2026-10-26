import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkSettledNativeOutgoingProvider,
  getCheckoutSparkSettledLegGeneration,
  getAccountSigner,
  hasCheckoutSparkProviderSendWindow,
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  proveSparkCheckoutReceiveCredit,
  publishMerchantCheckoutSparkProgress,
  restoreCheckoutSparkMerchantOrderWitness,
  retryMerchantCheckoutSparkProgress,
  runCheckoutSparkFinancialWorkflow,
  runWithCheckoutSparkMerchantRecoveryLock,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkSettledOutgoingStepResult,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkRecoveryHandoffResult,
  type MerchantCheckoutSparkProgressDeliveryStore,
  type MerchantCheckoutSparkProgressTransport,
  type NostrKeySigner,
} from "@conduit/core"

import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  inspectExactMerchantPayout,
  openMerchantCheckoutSparkRecoveryWallet,
  proveMerchantCheckoutSparkReturnedPayout,
} from "./checkout-spark-settled-recovery"
import { assertMerchantCheckoutSparkDispatchPlan } from "./checkout-spark-recovery-policy"
import { assertCheckoutSparkMerchantPricingAuthority } from "./checkout-spark-pricing-authority"

import {
  payoutReview,
  type MerchantCheckoutSparkPayoutReview,
} from "./checkout-spark-signed-payout-selection"
export { selectMerchantCheckoutSparkSignedNextPayout } from "./checkout-spark-signed-payout-selection"
export type {
  MerchantCheckoutSparkPayoutReview,
  MerchantCheckoutSparkSignedNextPayoutSelection,
  MerchantCheckoutSparkSignedNextPayoutDependencies,
} from "./checkout-spark-signed-payout-selection"

type Store = Pick<
  DexieCheckoutSparkSettledRepository,
  | "load"
  | "save"
  | "loadMerchantOrderWitness"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
  | "assertLocalInvoiceOrigin"
> &
  Partial<
    Pick<
      DexieCheckoutSparkSettledRepository,
      | "assertInvoiceRecipient"
      | "outgoingAdmissionScope"
      | "saveOutgoingPreProviderRetry"
    >
  >
/** Local preview only. Fresh signed authority and provider proof are checked on confirm. */
export async function reviewMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  repository: Pick<Store, "load"> &
    Partial<
      Pick<
        DexieCheckoutSparkSettledRepository,
        "hasInvoiceOrigin" | "hasInvoiceRecipient"
      >
    > = new DexieCheckoutSparkSettledRepository()
): Promise<MerchantCheckoutSparkPayoutReview | null> {
  const current = await repository.load(
    selected.checkoutId,
    selected.planDigest
  )
  if (
    current.status !== "active" ||
    current.state.plan.merchantPubkey !== principalPubkey.trim().toLowerCase()
  ) {
    throw new Error(
      "Save this checkout recovery state before reviewing a payout."
    )
  }
  const next = current.state.legs.find((leg) => leg.status !== "paid")
  const review = next ? payoutReview(current.state, next.legId) : null
  if (!review || !next) return null
  const { plan } = current.state
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: plan.walletId,
    network: plan.network,
    legId: review.legId,
    recipientId: review.recipientId,
    allocationSats: review.allocationSats,
    unpaidAllocationSats: review.allocationSats,
    intent: review.intent,
    ...(review.generation === 1 ? { generation: 1 as const } : {}),
  }
  let recipientAttribution: NonNullable<
    MerchantCheckoutSparkPayoutReview["inspection"]
  >["recipientAttribution"] = "unavailable"
  try {
    if (repository.hasInvoiceOrigin) {
      if (await repository.hasInvoiceOrigin(plan, target)) {
        recipientAttribution = "local_origin"
      } else if (repository.hasInvoiceRecipient) {
        recipientAttribution = (await repository.hasInvoiceRecipient(
          plan,
          target
        ))
          ? "recipient_verified"
          : "missing"
      }
    }
  } catch {
    // An unavailable local read is not evidence that attribution is missing.
  }
  const amount = review.intent.invoiceAmountSats
  const fee = review.intent.maxFeeSats
  const total = amount + fee
  const budgetAvailable =
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    Number.isSafeInteger(fee) &&
    fee >= 0 &&
    Number.isSafeInteger(review.allocationSats) &&
    review.allocationSats > 0 &&
    Number.isSafeInteger(total)
  return {
    ...review,
    inspection: {
      recipientAttribution,
      savedStatus: next.status,
      allocationBudget: budgetAvailable
        ? total <= review.allocationSats
          ? "fits"
          : "exceeds"
        : "unavailable",
    },
  }
}

export { continueMerchantCheckoutSparkNativeTreasury } from "./checkout-spark-native-treasury-continuation"
export type { MerchantCheckoutSparkNativeTreasuryContinuationDependencies } from "./checkout-spark-native-treasury-continuation"

export interface MerchantCheckoutSparkContinuationDependencies {
  repository?: Store
  deriveIdentity?: typeof deriveMerchantCheckoutSparkRecoveryIdentity
  openWallet?: typeof openMerchantCheckoutSparkRecoveryWallet
  consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
  now?: () => number
  shouldContinue?: () => boolean
  lockManager?: CheckoutSparkMerchantRecoveryLockManager | null
  requireCrossTabLock?: boolean
  signer?: NostrKeySigner | null
  progressStore?: MerchantCheckoutSparkProgressDeliveryStore &
    Pick<DexieMerchantCheckoutSparkProgressRepository, "list">
  progressTransport?: MerchantCheckoutSparkProgressTransport
}

export interface MerchantCheckoutSparkContinuationResult extends MerchantCheckoutSparkRecoveryHandoffResult {
  payout: Pick<
    CheckoutSparkSettledOutgoingStepResult,
    "outcome" | "reason" | "sendAttempted"
  > | null
}

/**
 * Continue exactly one reviewed, privately restored frozen intent after takeover.
 * There is no new invoice, intent, Merchant app ACK, or distributed lease.
 * The same payment ID and parameters also survive another Merchant device.
 */
export async function continueMerchantCheckoutSparkSettledPayout(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  review: MerchantCheckoutSparkPayoutReview,
  dependencies: MerchantCheckoutSparkContinuationDependencies = {}
): Promise<MerchantCheckoutSparkContinuationResult> {
  const principal = principalPubkey.trim().toLowerCase()
  selected = {
    ...selected,
    ...(selected.merchantProgress
      ? { merchantProgress: { ...selected.merchantProgress } }
      : {}),
  }
  review = { ...review, intent: { ...review.intent } }
  // Preview classifications are advisory, not part of the frozen send intent.
  delete review.inspection
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const consumeRecovery =
    dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
  const progressStore =
    dependencies.progressStore ??
    new DexieMerchantCheckoutSparkProgressRepository()
  let payout: MerchantCheckoutSparkContinuationResult["payout"] = null

  const consume = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signedState: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void,
    retainMerchantProgress = false
  ) => {
    const { plan } = initial
    const assertEligible = () => {
      assertCurrent()
      assertMerchantCheckoutSparkDispatchPlan(plan)
      if (
        dependencies.shouldContinue?.() === false ||
        now() < plan.takeoverAt
      ) {
        throw new Error(
          "Merchant checkout continuation is not currently authorized."
        )
      }
    }
    assertEligible()
    if (
      principal !== initial.merchantPubkey ||
      principal !== plan.merchantPubkey ||
      selected.checkoutId !== plan.checkoutId ||
      selected.orderId !== plan.orderId ||
      selected.planDigest !== plan.planDigest ||
      signedState.plan.planDigest !== plan.planDigest ||
      initial.wallet.walletId !== plan.walletId ||
      initial.wallet.network !== plan.network ||
      review.checkoutId !== plan.checkoutId ||
      review.planDigest !== plan.planDigest
    ) {
      throw new Error("Checkout Spark merchant recovery binding is invalid.")
    }
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
    ) {
      throw new Error(
        "Checkout Spark Merchant continuation requires its authenticated order."
      )
    }
    // Local-only preparation must not invent an intent another device cannot restore.
    const signedReview = payoutReview(signedState, review.legId)
    if (
      !signedReview ||
      JSON.stringify(signedReview) !== JSON.stringify(review)
    ) {
      throw new Error("Review the exact signed payout before continuing.")
    }
    // Expiry does not erase recovery or prevent the separate history check.
    // This confirmation must not open a wallet that can claim inbound funds
    // when its saved payout already has too little time left to send.
    const pauseIfInvoiceStale = () => {
      if (
        hasCheckoutSparkProviderSendWindow({
          paymentRequest: review.intent.paymentRequest,
          nowMs: now(),
        })
      ) {
        return false
      }
      payout = {
        outcome: "wait",
        reason: "invoice_window_insufficient",
        sendAttempted: false,
      }
      return true
    }
    let expectedState: CheckoutSparkSettledReconciliation
    const load = async () => {
      assertEligible()
      const current = await repository.load(plan.checkoutId, plan.planDigest)
      assertEligible()
      if (
        current.status !== "active" ||
        current.state.plan.merchantPubkey !== principal ||
        current.state.plan.walletId !== plan.walletId ||
        current.state.plan.network !== plan.network
      ) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      assertCheckoutSparkSettledRecoveryProgression(signedState, current.state)
      if (
        JSON.stringify(payoutReview(current.state, review.legId)) !==
        JSON.stringify(review)
      ) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      return current
    }
    const imported = await load()
    expectedState = imported.state
    const assertDurableState = async () => {
      const current = await load()
      if (JSON.stringify(current.state) !== JSON.stringify(expectedState)) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
    }
    const shouldPublish = () => {
      assertEligible()
      return true
    }
    let progressSigner: NostrKeySigner | null = null
    if (retainMerchantProgress) {
      progressSigner =
        dependencies.signer === undefined
          ? (getAccountSigner() ?? null)
          : dependencies.signer
      if (!progressSigner) throw new Error("Merchant signer is not connected.")
      const signerPubkey = await progressSigner.getPublicKey()
      assertEligible()
      if (signerPubkey.toLowerCase() !== principal) {
        throw new Error("Checkout Spark Merchant continuation signer changed.")
      }
      // Retrying delivery preserves the original signed bytes even when local
      // progress has advanced. It is not a lease or evidence of payment.
      const entries = await progressStore.list(
        principal,
        plan.checkoutId,
        plan.planDigest
      )
      await assertDurableState()
      for (const entry of entries) {
        const record = parseMerchantCheckoutSparkProgressDeliveryRecord(
          entry.record
        )
        if (
          record.merchantPubkey !== principal ||
          record.checkoutId !== plan.checkoutId ||
          record.planDigest !== plan.planDigest ||
          record.initialHandoffId !== initial.handoffId ||
          typeof entry.relayAccepted !== "boolean"
        ) {
          throw new Error("Checkout Spark Merchant recovery binding changed.")
        }
        if (entry.relayAccepted) continue
        const delivery = await retryMerchantCheckoutSparkProgress({
          record,
          signer: progressSigner,
          store: progressStore,
          shouldContinue: shouldPublish,
          transport: dependencies.progressTransport,
        })
        await assertDurableState()
        if (!delivery.relayAccepted) {
          payout = {
            outcome: "wait",
            reason: "recovery_handoff_unavailable",
            sendAttempted: false,
          }
          return
        }
      }
    }
    let attemptedProgressState: string | null = null
    const retainProgress = async (
      state: CheckoutSparkSettledReconciliation
    ) => {
      const serialized = JSON.stringify(state)
      if (serialized !== JSON.stringify(expectedState)) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      await assertDurableState()
      if (!progressSigner) return
      attemptedProgressState = serialized
      const delivery = await publishMerchantCheckoutSparkProgress({
        payload: createCheckoutSparkMerchantProgress({
          initialHandoffId: initial.handoffId,
          state,
        }),
        signer: progressSigner,
        store: progressStore,
        shouldContinue: shouldPublish,
        transport: dependencies.progressTransport,
      })
      await assertDurableState()
      if (!delivery.relayAccepted) {
        throw new Error("Checkout Spark Merchant progress needs delivery.")
      }
    }
    const retainVerifiedProgress = async () => {
      if (
        !progressSigner ||
        attemptedProgressState === JSON.stringify(expectedState)
      )
        return
      try {
        await retainProgress(expectedState)
      } catch {
        // Provider-attested paid state stays paid when its private progress
        // delivery fails. No automatic resend or replacement intent follows.
        assertEligible()
      }
    }
    // Delivery repair remains available after invoice expiry. Only provider
    // initialization and an outgoing attempt require a usable send window.
    if (pauseIfInvoiceStale()) return
    const identity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(identity) ||
      identity !== plan.funding.receiverIdentityPublicKey
    ) {
      throw new Error("Checkout Spark recovery key does not match funding.")
    }
    await assertDurableState()
    if (pauseIfInvoiceStale()) return
    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: initial.wallet.network,
      outgoing: true,
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      const actualIdentity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (actualIdentity !== identity || !wallet.outgoing) {
        throw new Error("Checkout Spark continuation wallet is unavailable.")
      }
      // A signed buyer claim is not settlement. Re-attest the exact receive each run.
      const receive = await wallet.getLightningReceiveRequest(
        plan.funding.requestId
      )
      assertEligible()
      if (
        !receive ||
        receive.status !== "TRANSFER_COMPLETED" ||
        !receive.transfer?.sparkId
      ) {
        payout = { outcome: "funding_wait", sendAttempted: false }
        return
      }
      const transfer = await wallet.getTransfer(receive.transfer.sparkId)
      assertEligible()
      if (!transfer) {
        payout = { outcome: "funding_wait", sendAttempted: false }
        return
      }
      const proof = proveSparkCheckoutReceiveCredit({
        expectedRequest: {
          id: plan.funding.requestId,
          network: plan.network,
          paymentRequest: plan.funding.paymentRequest,
          paymentHash: plan.funding.paymentHash,
          grossFundingSats: plan.funding.grossFundingSats,
        },
        expectedReceive: { mode: "ordinary_v3" },
        walletIdentityPublicKey: actualIdentity,
        receive,
        transfer,
      })
      assertCheckoutSparkMerchantPricingAuthority({ plan, fundingProof: proof })
      assertEligible()
      const store = {
        ...(repository.outgoingAdmissionScope &&
        repository.saveOutgoingPreProviderRetry
          ? {
              outgoingAdmissionScope: repository.outgoingAdmissionScope,
              async saveOutgoingPreProviderRetry(
                next: CheckoutSparkSettledReconciliation,
                revision: number,
                cancellation: Parameters<
                  NonNullable<typeof repository.saveOutgoingPreProviderRetry>
                >[2]
              ) {
                assertEligible()
                const saved = await repository.saveOutgoingPreProviderRetry!(
                  next,
                  revision,
                  cancellation,
                  assertEligible
                )
                assertEligible()
                expectedState = next
                return saved
              },
            }
          : {}),
        async load() {
          const current = await load()
          if (JSON.stringify(current.state) !== JSON.stringify(expectedState)) {
            throw new CheckoutSparkSettledRepositoryConflictError()
          }
          return current
        },
        async save(next: CheckoutSparkSettledReconciliation, revision: number) {
          assertEligible()
          const saved = await repository.save(next, revision, assertEligible)
          assertEligible()
          expectedState = next
          return saved
        },
      }
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        wallet: wallet.outgoing,
        async reconcile(target) {
          const observed = await inspectExactMerchantPayout(
            plan,
            target,
            wallet,
            assertEligible
          )
          assertEligible()
          return observed
        },
        async assertBeforeSend() {
          await assertDurableState()
          // A signed recovery preserves an intent, not its recipient. Require
          // local issuance or an independent exact receiving-provider proof.
          // Exact history remains readable above without this attribution.
          await (
            repository.assertInvoiceRecipient ??
            repository.assertLocalInvoiceOrigin
          ).call(
            repository,
            plan,
            {
              walletId: plan.walletId,
              network: plan.network,
              legId: review.legId,
              recipientId: review.recipientId,
              allocationSats: review.allocationSats,
              unpaidAllocationSats: review.allocationSats,
              intent: review.intent,
              ...(review.generation === 1 ? { generation: 1 as const } : {}),
            },
            assertEligible
          )
          await assertDurableState()
          const activeLeg = expectedState.legs.find(
            (leg) => leg.legId === review.legId
          )!
          if (getCheckoutSparkSettledLegGeneration(activeLeg) === 1) {
            await proveMerchantCheckoutSparkReturnedPayout(
              expectedState,
              review.legId,
              wallet,
              assertEligible,
              now
            )
            assertEligible()
          }
        },
        now,
      })
      const execution = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: review.legId,
          actor: "merchant",
          mode: "advance",
        },
        {
          now,
          store,
          assertCurrent: assertEligible,
          outgoing: provider,
          credit: {
            proof,
            record: (creditPlan, creditProof) =>
              repository.recordMerchantCredit(
                creditPlan,
                creditProof,
                now(),
                assertEligible
              ),
          },
          recordPaid: async (target, observed) => {
            await repository.recordMerchantPayout(
              plan,
              target,
              observed,
              now(),
              assertEligible
            )
            assertEligible()
          },
          // The original buyer snapshot remains available. Merchant-authored
          // progress additionally uses the existing exact private self-outbox.
          // Neither relay acceptance nor the local write-ahead is a payment proof.
          acknowledgeRecoverySnapshot: retainProgress,
          proveRenewalReturn: async (state, legId) => {
            await assertDurableState()
            if (JSON.stringify(state) !== JSON.stringify(expectedState)) {
              throw new CheckoutSparkSettledRepositoryConflictError()
            }
            const proof = await proveMerchantCheckoutSparkReturnedPayout(
              state,
              legId,
              wallet,
              assertEligible,
              now
            )
            assertEligible()
            return proof
          },
        }
      )
      assertEligible()
      if (execution.status !== "outgoing_step")
        throw new Error("Merchant payout execution changed.")
      const step = execution.step
      if (step.outcome === "paid" || step.outcome === "already_paid") {
        await retainVerifiedProgress()
      }
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
        async consume(initial, assertCurrent) {
          if (initial.schemaVersion !== 2)
            throw new Error("This recovery is not a settled checkout.")
          await consume(initial, initial.state, assertCurrent)
        },
        async consumeSettled(initial, latest, assertCurrent) {
          await consume(initial, latest.state, assertCurrent)
        },
        async consumeMerchantProgress(
          initial,
          _latestBuyer,
          progress,
          assertCurrent
        ) {
          await consume(initial, progress.state, assertCurrent, true)
        },
      })
      return { ...result, payout: result.status === "consumed" ? payout : null }
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}
