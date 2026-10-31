import {
  DexieCheckoutSparkSettledRepository,
  observeCheckoutSparkOperation,
  projectCheckoutSparkMerchantSettlement,
  isCheckoutSparkNativeTreasuryPlan,
  type CheckoutSparkPerformanceObserver,
  type CheckoutSparkSettledOutgoingStepResult,
  type CheckoutSparkNativeRetirementObservation,
  type MerchantCheckoutSparkReconciliationStatus,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  checkoutSparkRecoveryTiming,
  checkoutSparkRecoveryTimingMatches,
  restoreCheckoutSparkRecoveryTiming,
} from "@conduit/core/protocol/checkout-spark-recovery-timing"
import { getCheckoutSparkBuyerTakeoverAt } from "@conduit/core/protocol/checkout-spark-buyer-activation"
import {
  inspectMerchantCheckoutSparkSettledPayoutHistory,
  reconcileMerchantCheckoutSparkSettledCredit,
} from "./checkout-spark-settled-recovery"
import {
  continueMerchantCheckoutSparkSettledPayout,
  continueMerchantCheckoutSparkNativeTreasury,
  selectMerchantCheckoutSparkSignedNextPayout,
  type MerchantCheckoutSparkSignedNextPayoutSelection,
} from "./checkout-spark-settled-continuation"
import { prepareNextMerchantCheckoutSparkSettledPayout } from "./checkout-spark-settled-leg-preparation"
import { queueMerchantCheckoutSparkSupplierNotifications } from "./checkout-spark-supplier-notifications"
import { verifySavedMerchantCheckoutSparkRecipients } from "./checkout-spark-invoice-recipient"
import { observeMerchantCheckoutSparkOrder } from "./checkout-spark-order-observation"

interface ReconciliationDependencies {
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    | "loadMerchantOrderWitness"
    | "loadMerchantSettlement"
    | "load"
    | "save"
    | "savePreparedWithInvoiceOrigin"
    | "assertLocalInvoiceOrigin"
    | "recordMerchantCredit"
    | "recordMerchantPayout"
  > &
    Partial<
      Pick<
        DexieCheckoutSparkSettledRepository,
        | "hasInvoiceRecipient"
        | "hasInvoiceRecipientSettlement"
        | "loadMerchantPlanSourceEvents"
        | "recordInvoiceRecipientVerification"
        | "assertInvoiceRecipient"
        | "saveRenewedWithInvoiceOrigin"
        | "saveTreasuryPrepared"
        | "recordMerchantTreasury"
      >
    >
  checkCredit?: typeof reconcileMerchantCheckoutSparkSettledCredit
  inspectPayouts?: typeof inspectMerchantCheckoutSparkSettledPayoutHistory
  notifySuppliers?: typeof queueMerchantCheckoutSparkSupplierNotifications
  verifyRecipients?: typeof verifySavedMerchantCheckoutSparkRecipients
  observeNative?: typeof observeMerchantCheckoutSparkOrder
  /** Observe exact saved facts without any claim-capable wallet operation. */
  observationOnly?: boolean
  /** Session/page guard independent of a replaceable recovery candidate. */
  assertNotificationActive?: () => void
  now?: () => number
}

/**
 * Observe exact recipient receipts and query-only native facts immediately.
 * Receiver reads alone never confirm this checkout paid. Ordinary recovered
 * wallet initialization can claim funds, so that history path still waits for
 * takeover and respects active-page guards.
 */
export async function reconcileMerchantCheckoutSparkOrder(
  principalPubkey: string,
  candidate: MerchantCheckoutSparkRecoveryCandidate,
  assertActive: () => void,
  dependencies: ReconciliationDependencies = {}
): Promise<MerchantCheckoutSparkReconciliationStatus> {
  return inspectMerchantCheckoutSparkOrder(
    principalPubkey,
    candidate,
    assertActive,
    dependencies,
    false
  )
}

async function inspectMerchantCheckoutSparkOrder(
  principalPubkey: string,
  candidate: MerchantCheckoutSparkRecoveryCandidate,
  assertActive: () => void,
  dependencies: ReconciliationDependencies,
  includeRouterPayouts: boolean,
  onNextPayout?: (
    selection: MerchantCheckoutSparkSignedNextPayoutSelection
  ) => void
): Promise<MerchantCheckoutSparkReconciliationStatus> {
  const principal = principalPubkey.trim().toLowerCase()
  candidate = {
    ...candidate,
    ...(candidate.merchantProgress
      ? { merchantProgress: { ...candidate.merchantProgress } }
      : {}),
  }
  const now = dependencies.now ?? Date.now
  restoreCheckoutSparkRecoveryTiming(candidate)
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  assertActive()
  if (candidate.schemaVersion === 1) return "unbound"

  const witness = await repository.loadMerchantOrderWitness(
    principal,
    candidate.checkoutId,
    candidate.planDigest
  )
  assertActive()
  if (!witness) return "unbound"
  if (
    witness.merchantPubkey !== principal ||
    witness.checkoutId !== candidate.checkoutId ||
    witness.planDigest !== candidate.planDigest ||
    witness.orderId !== candidate.orderId
  ) {
    return "needs_attention"
  }
  const saved = await repository.load(
    candidate.checkoutId,
    candidate.planDigest
  )
  assertActive()
  if (saved.status === "retired") {
    try {
      const notify =
        dependencies.notifySuppliers ??
        queueMerchantCheckoutSparkSupplierNotifications
      notify({
        principal,
        candidate,
        assertActive: dependencies.assertNotificationActive ?? assertActive,
      })
    } catch {
      // Advisory messaging never changes terminal payment state.
    }
    return "retired"
  }
  if (saved.status !== "active") return "unbound"
  if (
    saved.state.plan.merchantPubkey !== principal ||
    saved.state.plan.orderId !== witness.orderId ||
    saved.state.plan.checkoutId !== witness.checkoutId ||
    saved.state.plan.planDigest !== witness.planDigest ||
    !checkoutSparkRecoveryTimingMatches(
      candidate,
      checkoutSparkRecoveryTiming(saved.state.plan, saved.state.buyerActivation)
    )
  ) {
    return "needs_attention"
  }
  const takeoverAt = getCheckoutSparkBuyerTakeoverAt(
    saved.state.plan,
    saved.state.buyerActivation
  )
  if (takeoverAt === null) return "pending"

  // This independent, bounded lookup repairs cross-device attribution before
  // projecting paid facts or continuing a preserved unpaid invoice. It never
  // treats a recovery message or the mere existence of a transfer as a receipt.
  let attributionUnavailable = false
  if (
    repository.hasInvoiceRecipient &&
    repository.recordInvoiceRecipientVerification
  ) {
    const attribution = await (
      dependencies.verifyRecipients ??
      verifySavedMerchantCheckoutSparkRecipients
    )({
      state: saved.state,
      repository: {
        hasInvoiceRecipient: repository.hasInvoiceRecipient.bind(repository),
        ...(repository.hasInvoiceRecipientSettlement
          ? {
              hasInvoiceRecipientSettlement:
                repository.hasInvoiceRecipientSettlement.bind(repository),
            }
          : {}),
        recordInvoiceRecipientVerification:
          repository.recordInvoiceRecipientVerification.bind(repository),
      },
      assertCurrent: assertActive,
      now,
    })
    assertActive()
    // A recipient API outage cannot suppress unrelated exact Spark observations.
    // Reconcile those facts below, but do not advance a send without attribution.
    attributionUnavailable = attribution === "unavailable"
  }

  if (dependencies.observationOnly || now() < takeoverAt) {
    // This separate version-pinned adapter queries exact native/SSP evidence
    // without initialize, privacy mutation, claims, or outgoing capabilities.
    // Receiver-only evidence remains informational if that read cannot finish.
    let observation: "verified" | "pending" | "unavailable" = "pending"
    if (repository.loadMerchantPlanSourceEvents) {
      try {
        observation = await (
          dependencies.observeNative ?? observeMerchantCheckoutSparkOrder
        )(principal, candidate, assertActive, {
          repository: {
            load: repository.load.bind(repository),
            loadMerchantOrderWitness:
              repository.loadMerchantOrderWitness.bind(repository),
            loadMerchantPlanSourceEvents:
              repository.loadMerchantPlanSourceEvents.bind(repository),
            recordMerchantCredit:
              repository.recordMerchantCredit.bind(repository),
            recordMerchantPayout:
              repository.recordMerchantPayout.bind(repository),
            loadMerchantSettlement:
              repository.loadMerchantSettlement.bind(repository),
          },
          expectedOrderWitness: witness,
          now,
        })
        assertActive()
      } catch {
        assertActive()
        observation = "unavailable"
        // Failed reads preserve prior facts. They cannot authorize a fallback
        // claim-capable wallet initialization or mark receiver-only facts paid.
      }
    }
    // Observation remains inert after takeover when execution is unavailable.
    // Before takeover keep this candidate scheduled for its frozen boundary.
    return dependencies.observationOnly ? observation : "pending"
  }

  const readProjection = async () => {
    const record = await repository.loadMerchantSettlement(
      principal,
      candidate.checkoutId,
      candidate.planDigest
    )
    assertActive()
    if (!record) return null
    // Queue separately: inbox/signer/relay availability never decides whether
    // payment is verified, whether another payout runs, or whether to retire.
    try {
      const notify =
        dependencies.notifySuppliers ??
        queueMerchantCheckoutSparkSupplierNotifications
      notify({
        principal,
        candidate,
        assertActive: dependencies.assertNotificationActive ?? assertActive,
        plan: saved.state.plan,
        settlement: record,
      })
    } catch {
      // Notification preparation failure is independent of settlement truth.
    }
    const paid = new Set(record.paidLegs.map((leg) => leg.legId))
    const allCommerceProviderPaid = record.requiredCommerceLegIds.every(
      (legId) => paid.has(legId)
    )
    return {
      ...projectCheckoutSparkMerchantSettlement(record),
      allCommerceProviderPaid,
      allProviderPaid:
        allCommerceProviderPaid &&
        (record.schemaVersion !== 3 ||
          record.organizerLegId === null ||
          (record.organizerLegId !== undefined &&
            paid.has(record.organizerLegId))) &&
        (record.schemaVersion === 2 || record.schemaVersion === 3
          ? record.nativeTreasury !== null
          : paid.has(record.feeLegId)),
    }
  }
  const originNeedsAttention = (
    projection: Awaited<ReturnType<typeof readProjection>>
  ) =>
    projection?.recipientUnverified === true &&
    projection.creditVerified &&
    (includeRouterPayouts
      ? projection.allProviderPaid
      : !projection.commerceVerified && projection.allCommerceProviderPaid)
  const nativeReceiptNeedsReconciliation =
    isCheckoutSparkNativeTreasuryPlan(saved.state.plan) &&
    saved.state.treasuryFinalization?.status !== "paid"
  let projection = await readProjection()
  if (originNeedsAttention(projection))
    return attributionUnavailable ? "unavailable" : "recipient_unverified"
  if (projection?.commerceVerified) {
    if (!includeRouterPayouts) return "verified"
    if (!projection.feePending) {
      // Provider receipt persistence precedes the terminal router-state save.
      // An interrupted save must reconcile that same native request before
      // completion, not loop on an unpaid local state or infer it paid here.
      return nativeReceiptNeedsReconciliation ? "progress_pending" : "verified"
    }
  }

  const options = {
    repository,
    assertActive,
    expectedOrderWitness: witness,
    now,
  }
  // Query-only observation can attest funding in the independent receipt
  // ledger without advancing the signed router snapshot. History/continuation
  // still require its guarded saved credit, so reconcile the exact original
  // funding request after takeover when that state is missing.
  if (!projection?.creditVerified || !saved.state.credit) {
    const credit = await (
      dependencies.checkCredit ?? reconcileMerchantCheckoutSparkSettledCredit
    )(principal, candidate, options)
    assertActive()
    if (credit.status !== "consumed") return "unavailable"
    if (credit.creditStatus !== "recorded") return "pending"
    // Only the separate provider-attested record permits the next phase.
    projection = await readProjection()
    if (!projection?.creditVerified) return "unavailable"
  }
  const history = await (
    dependencies.inspectPayouts ??
    inspectMerchantCheckoutSparkSettledPayoutHistory
  )(principal, candidate, {
    ...options,
    ...(onNextPayout ? { selectNextPayout: true } : {}),
  })
  assertActive()
  if (history.status !== "consumed") return "unavailable"
  if (!history.payoutHistory) return "unavailable"
  if (history.payoutHistory.status === "credit_needed") return "pending"
  if (history.nextPayout) onNextPayout?.(history.nextPayout)
  projection = await readProjection()
  if (originNeedsAttention(projection))
    return attributionUnavailable ? "unavailable" : "recipient_unverified"
  if (projection?.commerceVerified) {
    if (!includeRouterPayouts) return "verified"
    if (!projection.feePending) {
      return nativeReceiptNeedsReconciliation ? "progress_pending" : "verified"
    }
  }
  if (attributionUnavailable) return "unavailable"
  if (includeRouterPayouts) return "progress_pending"
  if (
    history.payoutHistory?.status === "no_intents" ||
    (history.payoutHistory?.withoutIntentLegs ?? 0) > 0
  ) {
    // Missing obligations need preparation, not a fabricated invoice or send.
    // A missing optional fee does not roll back separately verified commerce.
    return "needs_attention"
  }
  return "pending"
}

export type MerchantCheckoutSparkPayoutObservation = Pick<
  CheckoutSparkSettledOutgoingStepResult,
  "outcome" | "reason" | "sendAttempted"
>

interface AdvancementDependencies extends ReconciliationDependencies {
  selectPayout?: typeof selectMerchantCheckoutSparkSignedNextPayout
  preparePayout?: typeof prepareNextMerchantCheckoutSparkSettledPayout
  continuePayout?: typeof continueMerchantCheckoutSparkSettledPayout
  continueNativeTreasury?: typeof continueMerchantCheckoutSparkNativeTreasury
  /** Queue discovery; never await or drain the worker calling this adapter. */
  requestRescan: () => void
  /** A newly paid continuation can wake its serialized owner, not bypass it. */
  onProgress?: () => void
  /** Existing payout result only; no provider call or execution authority. */
  onPayoutObservation?: (
    observation: MerchantCheckoutSparkPayoutObservation
  ) => void
  onNativeObservation?: (
    observation: CheckoutSparkNativeRetirementObservation
  ) => void
  /** Optional bounded, content-free observation of one advancement invocation. */
  observePerformance?: CheckoutSparkPerformanceObserver
}

/**
 * One bounded post-handoff phase for a serialized Merchant recovery worker.
 * Preparation and send require separate calls with freshly discovered exact
 * Merchant-signed progress between them. This function is not a timer or lock;
 * its owner supplies the active-session guard and drains work before replacement.
 */
export async function advanceMerchantCheckoutSparkOrder(
  principalPubkey: string,
  candidate: MerchantCheckoutSparkRecoveryCandidate,
  assertActive: () => void,
  dependencies: AdvancementDependencies
): Promise<MerchantCheckoutSparkReconciliationStatus> {
  return observeCheckoutSparkOperation({
    app: "merchant",
    step: "router_merchant_recovery",
    operation: () =>
      advanceMerchantCheckoutSparkOrderPhase(
        principalPubkey,
        candidate,
        assertActive,
        dependencies
      ),
    observe: dependencies.observePerformance,
  })
}

async function advanceMerchantCheckoutSparkOrderPhase(
  principalPubkey: string,
  candidate: MerchantCheckoutSparkRecoveryCandidate,
  assertActive: () => void,
  dependencies: AdvancementDependencies
): Promise<MerchantCheckoutSparkReconciliationStatus> {
  const principal = principalPubkey.trim().toLowerCase()
  candidate = {
    ...candidate,
    ...(candidate.merchantProgress
      ? { merchantProgress: { ...candidate.merchantProgress } }
      : {}),
  }
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  let inspectedPayout:
    MerchantCheckoutSparkSignedNextPayoutSelection | undefined
  const status = await inspectMerchantCheckoutSparkOrder(
    principal,
    candidate,
    assertActive,
    { ...dependencies, repository, now },
    true,
    dependencies.selectPayout
      ? undefined
      : (selection) => {
          inspectedPayout = selection
        }
  )
  assertActive()
  if (status !== "progress_pending") return status
  // Only a read-only result crosses the history callback. The final phase
  // still authenticates fresh recovery under its own lock before wallet work.
  const selection =
    inspectedPayout ??
    (await (
      dependencies.selectPayout ?? selectMerchantCheckoutSparkSignedNextPayout
    )(principal, candidate, assertActive, { repository, now }))
  assertActive()
  const shouldContinue = () => {
    assertActive()
    return true
  }
  if (selection.status === "native_treasury") {
    if (!repository.saveTreasuryPrepared || !repository.recordMerchantTreasury)
      return "unavailable"
    const settlement = await repository.loadMerchantSettlement(
      principal,
      candidate.checkoutId,
      candidate.planDigest
    )
    assertActive()
    // A retained receipt is not a shortcut to terminal state. It limits this
    // invocation to exact provider reconciliation: a delayed/missing readback
    // must never turn an older prepared snapshot into another native send.
    const inspectionOnly =
      (settlement?.schemaVersion === 2 || settlement?.schemaVersion === 3) &&
      settlement.nativeTreasury !== null
    const result = await (
      dependencies.continueNativeTreasury ??
      continueMerchantCheckoutSparkNativeTreasury
    )(principal, candidate, {
      repository: repository as NonNullable<
        Parameters<typeof continueMerchantCheckoutSparkNativeTreasury>[2]
      >["repository"],
      now,
      shouldContinue,
      inspectionOnly,
      onObservation(observation) {
        try {
          assertActive()
          dependencies.onNativeObservation?.(observation)
        } catch {
          // A stale or failed display cannot change the financial operation.
        }
      },
    })
    assertActive()
    if (result.status !== "consumed" || !result.payout) return "unavailable"
    try {
      dependencies.onPayoutObservation?.({
        outcome: result.payout.outcome,
        ...(result.payout.reason ? { reason: result.payout.reason } : {}),
        sendAttempted: result.payout.sendAttempted,
      })
    } catch {
      // Existing result only; observer failures do not change scheduling.
    }
    if (
      result.payout.reason === "terminal_failure" ||
      result.payout.reason === "provider_evidence_conflicting" ||
      result.payout.reason === "zero_remainder" ||
      result.payout.reason === "funding_shortfall" ||
      result.payout.reason === "fee_over_cap" ||
      result.payout.reason === "insufficient_funds" ||
      result.payout.reason === "prerequisite_unpaid" ||
      result.payout.reason === "authority_not_started" ||
      result.payout.reason === "authority_transferred" ||
      result.payout.reason === "native_invoice_rejected" ||
      result.payout.reason === "native_provider_validation" ||
      result.payout.reason === "native_provider_authentication" ||
      result.payout.reason === "native_unrecognized_result"
    )
      return "needs_attention"
    if (
      result.payout.reason === "provider_evidence_unavailable" ||
      result.payout.reason === "recovery_handoff_unavailable" ||
      result.payout.reason === "fee_unavailable" ||
      result.payout.reason === "native_provider_unavailable" ||
      result.payout.reason === "native_provider_request" ||
      result.payout.reason === "native_provider_error"
    )
      return "unavailable"
    if (result.payout.reason === "recipient_unverified")
      return "recipient_unverified"
    if (result.payout.reason === "prior_possible_send") {
      // Pending exact history stays query-only. A restored terminal marker with
      // no current cancellation capability is not healthy payment progress.
      assertActive()
      const current = await repository.load(
        candidate.checkoutId,
        candidate.planDigest
      )
      assertActive()
      if (
        current.status !== "active" ||
        current.state.plan.merchantPubkey !== principal ||
        current.state.plan.checkoutId !== candidate.checkoutId ||
        current.state.plan.orderId !== candidate.orderId ||
        current.state.plan.planDigest !== candidate.planDigest ||
        !checkoutSparkRecoveryTimingMatches(
          candidate,
          checkoutSparkRecoveryTiming(
            current.state.plan,
            current.state.buyerActivation
          )
        )
      )
        return "unavailable"
      if (
        current.state.treasuryFinalization?.status === "terminal_failure" ||
        current.state.treasuryFinalization?.status === "conflicting_evidence"
      )
        return "needs_attention"
    }
    dependencies.requestRescan()
    if (result.payout.outcome === "paid") {
      assertActive()
      dependencies.onProgress?.()
    }
    return "progress_pending"
  }
  if (
    selection.status === "preparation_needed" ||
    selection.status === "renewal_needed"
  ) {
    const result = await (
      dependencies.preparePayout ??
      prepareNextMerchantCheckoutSparkSettledPayout
    )(
      principal,
      candidate,
      { shouldContinue, allowRenewal: true },
      { repository, now }
    )
    assertActive()
    if (result.status === "retired") return "retired"
    if (result.status === "save_required") return "unbound"
    if (result.status === "handoff_wait") return "pending"
    if (result.status !== "attempted") return "pending"
    if (result.recovery.status !== "consumed") return "unavailable"
    const prepared = result.recovery.preparation
    if (!prepared) return "unavailable"
    if (
      prepared.status === "prepared" ||
      prepared.status === "existing_intent" ||
      prepared.status === "recovery_pending"
    ) {
      dependencies.requestRescan()
      return "progress_pending"
    }
    if (
      selection.status === "renewal_needed" &&
      prepared.status === "history_wait"
    ) {
      return "renewal_wait"
    }
    return prepared.status === "allocation_unavailable"
      ? "needs_attention"
      : "pending"
  }
  if (selection.status !== "ready") {
    if (selection.status === "retired") return "retired"
    if (selection.status === "save_required") return "unbound"
    if (selection.status === "recovery_unavailable") return "unavailable"
    // No unpaid local row does not prove every payout or wallet retirement.
    return "pending"
  }
  const result = await (
    dependencies.continuePayout ?? continueMerchantCheckoutSparkSettledPayout
  )(principal, candidate, selection.review, {
    repository,
    now,
    shouldContinue,
  })
  assertActive()
  if (result.status !== "consumed" || !result.payout) return "unavailable"
  try {
    dependencies.onPayoutObservation?.({
      outcome: result.payout.outcome,
      ...(result.payout.reason ? { reason: result.payout.reason } : {}),
      sendAttempted: result.payout.sendAttempted,
    })
  } catch {
    // A display observer must not change provider outcome or scheduling.
  }
  if (result.payout.reason === "recipient_unverified")
    return "recipient_unverified"
  // Let discovery select a new signed pointer. Never manufacture one from local
  // state, reset an uncertain intent, or send another leg within this invocation.
  dependencies.requestRescan()
  if (result.payout.outcome === "paid") {
    assertActive()
    dependencies.onProgress?.()
  }
  return result.payout.reason === "invoice_window_insufficient"
    ? "needs_attention"
    : "progress_pending"
}
