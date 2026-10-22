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

const COMMERCE_PROVIDER_STATUS_LABELS = {
  not_found: PROVIDER_STATUS_LABELS.not_found,
  lookup_unavailable: PROVIDER_STATUS_LABELS.lookup_unavailable,
  conflicting_evidence: PROVIDER_STATUS_LABELS.conflicting_evidence,
  pending: PROVIDER_STATUS_LABELS.pending,
  terminal_failure: PROVIDER_STATUS_LABELS.terminal_failure,
  paid: PROVIDER_STATUS_LABELS.paid,
} as const

const RECEIPT_LABELS = {
  not_checked: "not checked",
  verified: "verified",
  unavailable: "incomplete",
} as const

const PENDING_PHASE_LABELS = {
  sender: "Sender completion pending",
  receiver: "Receiver completion pending",
} as const

function formatStatusCounts(
  counts: unknown,
  labels: Readonly<Record<string, string>>,
  fallback: string
): string {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts))
    return fallback
  const parts: string[] = []
  for (const [status, label] of Object.entries(labels)) {
    // Read allowlisted own data only: unknown keys, inherited counts and getters
    // cannot supply diagnostics or cause arbitrary value coercion.
    const count: unknown = Object.getOwnPropertyDescriptor(
      counts,
      status
    )?.value
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0)
      parts.push(`${count} ${label}`)
  }
  return parts.join(", ") || fallback
}

/** Explicit recovery details only; provider completion is not receipt proof. */
export function formatMerchantCheckoutSparkPayoutHistory(
  history: MerchantCheckoutSparkPayoutHistory
): string {
  let summary = `Checked ${history.checkedLegs} exact payout transfer${history.checkedLegs === 1 ? "" : "s"}: ${history.newlyConfirmedLegs} newly confirmed, ${history.unresolvedLegs} unresolved. ${history.withoutIntentLegs} leg${history.withoutIntentLegs === 1 ? "" : "s"} still lack a frozen invoice. No payout was sent by this check.`
  const commerce = history.commerceSummary
  if (commerce) {
    const saved = formatStatusCounts(
      commerce.savedStatusCounts,
      SAVED_STATUS_LABELS,
      "none recorded"
    )
    const observed = formatStatusCounts(
      commerce.providerObservationCounts,
      COMMERCE_PROVIDER_STATUS_LABELS,
      "not checked"
    )
    summary += ` Saved commerce statuses before this check: ${saved}. Exact commerce provider checks: ${observed}.`
  }
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
  const phase =
    native.providerObservation === "pending" &&
    typeof native.pendingPhase === "string" &&
    Object.hasOwn(PENDING_PHASE_LABELS, native.pendingPhase)
      ? ` ${PENDING_PHASE_LABELS[native.pendingPhase]}.`
      : ""
  return `${summary} Saved fee status before this check: ${savedStatus}. Transfer reference before this check: ${native.hasProviderTransferId === true ? "saved" : "not saved"}. Exact provider check: ${providerStatus}.${phase} Receipt proof: ${receipt}.`
}
