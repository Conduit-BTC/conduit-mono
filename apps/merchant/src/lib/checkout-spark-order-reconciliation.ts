import {
  DexieCheckoutSparkSettledRepository,
  projectCheckoutSparkMerchantSettlement,
  type MerchantCheckoutSparkReconciliationStatus,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  inspectMerchantCheckoutSparkSettledPayoutHistory,
  reconcileMerchantCheckoutSparkSettledCredit,
  retireMerchantCheckoutSparkSettledRecovery,
} from "./checkout-spark-settled-recovery"
import {
  continueMerchantCheckoutSparkSettledPayout,
  continueMerchantCheckoutSparkNativeTreasury,
  selectMerchantCheckoutSparkSignedNextPayout,
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
  includeRouterPayouts: boolean
): Promise<MerchantCheckoutSparkReconciliationStatus> {
  const principal = principalPubkey.trim().toLowerCase()
  candidate = {
    ...candidate,
    ...(candidate.merchantProgress
      ? { merchantProgress: { ...candidate.merchantProgress } }
      : {}),
  }
  const now = dependencies.now ?? Date.now
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
    saved.state.plan.takeoverAt !== candidate.takeoverAt
  ) {
    return "needs_attention"
  }

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

  if (now() < saved.state.plan.takeoverAt) {
    // This separate version-pinned adapter queries exact native/SSP evidence
    // without initialize, privacy mutation, claims, or outgoing capabilities.
    // Receiver-only evidence remains informational if that read cannot finish.
    if (repository.loadMerchantPlanSourceEvents) {
      try {
        await (dependencies.observeNative ?? observeMerchantCheckoutSparkOrder)(
          principal,
          candidate,
          assertActive,
          {
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
          }
        )
        assertActive()
      } catch {
        assertActive()
        // Failed reads preserve prior facts. They cannot authorize a fallback
        // claim-capable wallet initialization or mark receiver-only facts paid.
      }
    }
    // Even verified commerce cannot advance fee, preparation or retirement
    // before takeover; keep this candidate scheduled for its frozen boundary.
    return "pending"
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
        (record.schemaVersion === 2
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
    saved.state.plan.schemaVersion === 4 &&
    saved.state.treasuryFinalization?.status !== "paid"
  let projection = await readProjection()
  if (originNeedsAttention(projection))
    return attributionUnavailable ? "unavailable" : "recipient_unverified"
  if (projection?.commerceVerified) {
    if (!includeRouterPayouts) return "verified"
    if (!projection.feePending) {
      // Provider receipt persistence precedes the terminal router-state save.
      // An interrupted save must reconcile that same native request before
      // retirement, not loop on an unpaid local state or infer it paid here.
      return nativeReceiptNeedsReconciliation
        ? "progress_pending"
        : "retirement_pending"
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
  )(principal, candidate, options)
  assertActive()
  if (history.status !== "consumed") return "unavailable"
  if (!history.payoutHistory) return "unavailable"
  if (history.payoutHistory.status === "credit_needed") return "pending"
  projection = await readProjection()
  if (originNeedsAttention(projection))
    return attributionUnavailable ? "unavailable" : "recipient_unverified"
  if (projection?.commerceVerified) {
    if (!includeRouterPayouts) return "verified"
    if (!projection.feePending) {
      return nativeReceiptNeedsReconciliation
        ? "progress_pending"
        : "retirement_pending"
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

interface AdvancementDependencies extends ReconciliationDependencies {
  repository?: NonNullable<ReconciliationDependencies["repository"]> &
    Pick<DexieCheckoutSparkSettledRepository, "retire">
  selectPayout?: typeof selectMerchantCheckoutSparkSignedNextPayout
  preparePayout?: typeof prepareNextMerchantCheckoutSparkSettledPayout
  continuePayout?: typeof continueMerchantCheckoutSparkSettledPayout
  continueNativeTreasury?: typeof continueMerchantCheckoutSparkNativeTreasury
  retireWallet?: typeof retireMerchantCheckoutSparkSettledRecovery
  /** Queue discovery; never await or drain the worker calling this adapter. */
  requestRescan: () => void
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
  const status = await inspectMerchantCheckoutSparkOrder(
    principal,
    candidate,
    assertActive,
    { ...dependencies, repository, now },
    true
  )
  assertActive()
  // Provider-attested all-paid is still not terminal wallet/claim/refund proof.
  if (status === "retirement_pending") {
    const result = await (
      dependencies.retireWallet ?? retireMerchantCheckoutSparkSettledRecovery
    )(principal, candidate, { repository, assertActive, now })
    assertActive()
    if (result.status !== "consumed") return "unavailable"
    if (result.retirementStatus === "retired") return "retired"
    return result.retirementStatus === "pending"
      ? "retirement_pending"
      : "unavailable"
  }
  if (status !== "progress_pending") return status
  const selection = await (
    dependencies.selectPayout ?? selectMerchantCheckoutSparkSignedNextPayout
  )(principal, candidate, assertActive, { repository, now })
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
      settlement?.schemaVersion === 2 && settlement.nativeTreasury !== null
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
    })
    assertActive()
    if (result.status !== "consumed" || !result.payout) return "unavailable"
    dependencies.requestRescan()
    return result.payout.reason === "zero_remainder"
      ? "needs_attention"
      : "progress_pending"
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
  if (result.payout.reason === "recipient_unverified")
    return "recipient_unverified"
  // Let discovery select a new signed pointer. Never manufacture one from local
  // state, reset an uncertain intent, or send another leg within this invocation.
  dependencies.requestRescan()
  return result.payout.reason === "invoice_window_insufficient"
    ? "needs_attention"
    : "progress_pending"
}
