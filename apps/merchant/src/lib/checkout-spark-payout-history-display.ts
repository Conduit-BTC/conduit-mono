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

const PAYOUT_OBSERVATION_REASON_MESSAGES = {
  fee_over_cap: "The provider fee exceeded this payout's approved cap.",
  insufficient_funds:
    "The provider reported insufficient available checkout funds.",
  fee_unavailable: "The provider fee could not be verified for this payout.",
  recovery_handoff_unavailable:
    "The required recovery handoff could not be confirmed.",
  provider_evidence_unavailable:
    "The required provider proof could not be confirmed.",
  prerequisite_unpaid: "Earlier recipient payments still need verified proof.",
} as const

const NATIVE_CHECK_PHASE_LABELS = {
  waiting_for_current_check: "waiting for the previous check",
  recovery_delivery: "recovery delivery",
  wallet_open: "wallet opening",
  privacy_readiness: "wallet privacy readiness",
  input_validation: "proof input validation",
  wallet_validation: "wallet identity",
  funding_proof: "original funding proof",
  commerce_proof: "recipient payment proofs",
  history_first_read: "exact transfer history",
  funds_read: "remaining funds",
  history_second_read: "history stability",
  freshness: "proof freshness",
  complete: "remaining-funds proof",
} as const

/** Local preparation details only; a passed proof is not a payment receipt. */
export function formatMerchantCheckoutSparkNativeObservation(
  observation: unknown
): string | null {
  try {
    if (
      !observation ||
      typeof observation !== "object" ||
      Array.isArray(observation)
    )
      return null
    const own = (key: string): unknown =>
      Object.getOwnPropertyDescriptor(observation, key)?.value
    const phase = own("phase")
    const status = own("status")
    if (
      typeof phase !== "string" ||
      !Object.hasOwn(NATIVE_CHECK_PHASE_LABELS, phase) ||
      (status !== "not_verified" && status !== "verified")
    )
      return null
    const label =
      NATIVE_CHECK_PHASE_LABELS[phase as keyof typeof NATIVE_CHECK_PHASE_LABELS]
    let text = `Last Conduit check: ${label} (${status === "verified" ? "passed" : "checking"}).`
    for (const [key, comparison] of [
      ["availableMatchesAuthorized", "Approved remainder match"],
      ["ownedMatchesAvailable", "Ownership match"],
      ["pendingEmpty", "No pending transfers confirmed"],
    ]) {
      const value = own(key)
      if (typeof value === "boolean")
        text += ` ${comparison}: ${value ? "confirmed" : "not confirmed"}.`
    }
    return text
  } catch {
    return null
  }
}

/** A finite check result is informational, never payment or retry authority. */
export function formatMerchantCheckoutSparkPayoutObservation(
  observation: unknown
): string | null {
  try {
    if (
      typeof observation !== "object" ||
      observation === null ||
      Array.isArray(observation)
    )
      return null
    const outcome: unknown = Object.getOwnPropertyDescriptor(
      observation,
      "outcome"
    )?.value
    const reason: unknown = Object.getOwnPropertyDescriptor(
      observation,
      "reason"
    )?.value
    const sendAttempted: unknown = Object.getOwnPropertyDescriptor(
      observation,
      "sendAttempted"
    )?.value
    if (
      (outcome !== "wait" && outcome !== "send_ambiguous") ||
      typeof reason !== "string" ||
      !Object.hasOwn(PAYOUT_OBSERVATION_REASON_MESSAGES, reason) ||
      typeof sendAttempted !== "boolean"
    )
      return null
    const message =
      PAYOUT_OBSERVATION_REASON_MESSAGES[
        reason as keyof typeof PAYOUT_OBSERVATION_REASON_MESSAGES
      ]
    return `${message} ${sendAttempted ? "Funds may have moved; inspect exact history." : "No new provider send was entered by that check."}`
  } catch {
    return null
  }
}

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
