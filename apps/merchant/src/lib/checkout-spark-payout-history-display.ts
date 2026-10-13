import type { MerchantCheckoutSparkPayoutHistory } from "./checkout-spark-settled-recovery"

const SAVED_STATUS_LABELS = {
  unprepared: "not prepared",
  prepared: "prepared",
  submitted: "submitted",
  ambiguous: "uncertain",
  lookup_unavailable: "verification unavailable",
  conflicting_evidence: "conflicting evidence",
  paid: "recorded complete",
  terminal_failure: "failed",
} as const

const PROVIDER_STATUS_LABELS = {
  not_checked: "not checked",
  not_found: "not found",
  lookup_unavailable: "unavailable",
  conflicting_evidence: "conflicting evidence",
  pending: "pending",
  terminal_failure: "failed",
  paid: "reported complete",
} as const

const RECEIPT_LABELS = {
  not_checked: "not checked",
  verified: "verified",
  unavailable: "incomplete",
} as const

/** Explicit recovery details only; provider completion is not receipt proof. */
export function formatMerchantCheckoutSparkPayoutHistory(
  history: MerchantCheckoutSparkPayoutHistory
): string {
  const summary = `Checked ${history.checkedLegs} exact payout transfer${history.checkedLegs === 1 ? "" : "s"}: ${history.newlyConfirmedLegs} newly confirmed, ${history.unresolvedLegs} unresolved. ${history.withoutIntentLegs} leg${history.withoutIntentLegs === 1 ? "" : "s"} still lack a frozen invoice. No payout was sent by this check.`
  const native = history.nativeSummary
  if (!native) return summary
  const savedStatus = Object.hasOwn(SAVED_STATUS_LABELS, native.savedStatus)
    ? SAVED_STATUS_LABELS[native.savedStatus]
    : "unavailable"
  const providerStatus = Object.hasOwn(
    PROVIDER_STATUS_LABELS,
    native.providerObservation
  )
    ? PROVIDER_STATUS_LABELS[native.providerObservation]
    : "unavailable"
  const receipt = Object.hasOwn(RECEIPT_LABELS, native.receiptProof)
    ? RECEIPT_LABELS[native.receiptProof]
    : "incomplete"
  return `${summary} Saved fee status before this check: ${savedStatus}. Transfer reference before this check: ${native.hasProviderTransferId === true ? "saved" : "not saved"}. Exact provider check: ${providerStatus}. Receipt proof: ${receipt}.`
}
