const stages = {
  recovery: "Checking recovery access",
  wallet: "Opening the checkout wallet",
  funding: "Verifying the original funding",
  recipients: "Verifying payout recipients",
  routing: "Checking saved payment progress",
  payout: "Checking a saved payout",
  preparation: "Preparing a remaining payout",
  progress: "Delivering saved recovery progress",
  fee: "Checking the Conduit payment",
  goods: "Verifying goods payments",
  waiting: "Waiting before another saved-payment check",
} as const

const payoutObservations = [
  "not_observed",
  "not_found",
  "lookup_unavailable",
  "conflicting_evidence",
  "pending",
  "terminal_failure",
  "paid",
] as const
const recipientObservations = [
  "not_observed",
  "verified_settled",
  "verified_unsettled",
  "unsupported",
  "unavailable",
  "conflicting",
] as const
const progressAcks = [
  "not_observed",
  "accepted",
  "missing",
  "unavailable",
] as const
const nativeObservations = [
  ...payoutObservations,
  "pending_sender",
  "pending_receiver",
] as const
const nativePreflights = [
  "not_observed",
  "ready",
  "fee_over_cap",
  "insufficient_funds",
  "unavailable",
  "recipient_unverified",
] as const
const nativeSends = [
  "not_observed",
  "submitted",
  "ambiguous",
  "not_sent",
] as const
const workflowOutcomes = [
  "not_observed",
  "retired",
  "credited",
  "reconciled",
  "payout_prepared",
  "funding_wait",
  "invoice_needed",
  "already_paid",
  "paid",
  "wait",
  "send_ambiguous",
] as const
const workflowWaitReasons = [
  "none",
  "authority_not_started",
  "authority_transferred",
  "fee_over_cap",
  "insufficient_funds",
  "fee_unavailable",
  "recipient_unverified",
  "invoice_window_insufficient",
  "inspection_only",
  "prior_possible_send",
  "native_invoice_rejected",
  "native_provider_validation",
  "native_provider_request",
  "native_provider_authentication",
  "native_provider_error",
  "native_provider_unavailable",
  "native_unrecognized_result",
  "provider_evidence_unavailable",
  "provider_evidence_conflicting",
  "recovery_handoff_unavailable",
  "terminal_failure",
  "sibling_possible_send",
  "prerequisite_unpaid",
  "renewal_return_unavailable",
  "zero_remainder",
  "funding_shortfall",
] as const

export interface CheckoutSparkOrganizerRoutingDiagnostic {
  /** Fixed product label, never a provider error or payment identifier. */
  stage: (typeof stages)[keyof typeof stages]
  elapsedMs: number
  writerChecks: number
  writerCheckMs: number
  lastPayoutObservation: (typeof payoutObservations)[number]
  lastRecipientObservation: (typeof recipientObservations)[number]
  lastProgressAck: (typeof progressAcks)[number]
  lastNativeObservation: (typeof nativeObservations)[number]
  lastNativePreflight: (typeof nativePreflights)[number]
  lastNativeSend: (typeof nativeSends)[number]
  lastWorkflowOutcome: (typeof workflowOutcomes)[number]
  lastWorkflowWaitReason: (typeof workflowWaitReasons)[number]
  completedWorkflowSteps: number
  scheduledBackoffMs: number
}

function fixedValue<T extends string>(values: readonly T[], value: T): T {
  return values.includes(value) ? value : values[0]!
}

export class CheckoutSparkOrganizerRoutingTimeoutError extends Error {
  readonly diagnostic: Readonly<CheckoutSparkOrganizerRoutingDiagnostic>

  constructor(diagnostic: CheckoutSparkOrganizerRoutingDiagnostic) {
    super(
      "This recovery check reached its time limit. Saved payments are preserved. Reopen this saved order to check its existing payments; do not pay again."
    )
    this.name = "CheckoutSparkOrganizerRoutingTimeoutError"
    this.diagnostic = Object.freeze({
      stage: fixedValue(Object.values(stages), diagnostic.stage),
      elapsedMs: diagnostic.elapsedMs,
      writerChecks: diagnostic.writerChecks,
      writerCheckMs: diagnostic.writerCheckMs,
      lastPayoutObservation: fixedValue(
        payoutObservations,
        diagnostic.lastPayoutObservation
      ),
      lastRecipientObservation: fixedValue(
        recipientObservations,
        diagnostic.lastRecipientObservation
      ),
      lastProgressAck: fixedValue(progressAcks, diagnostic.lastProgressAck),
      lastNativeObservation: fixedValue(
        nativeObservations,
        diagnostic.lastNativeObservation
      ),
      lastNativePreflight: fixedValue(
        nativePreflights,
        diagnostic.lastNativePreflight
      ),
      lastNativeSend: fixedValue(nativeSends, diagnostic.lastNativeSend),
      lastWorkflowOutcome: fixedValue(
        workflowOutcomes,
        diagnostic.lastWorkflowOutcome
      ),
      lastWorkflowWaitReason: fixedValue(
        workflowWaitReasons,
        diagnostic.lastWorkflowWaitReason
      ),
      completedWorkflowSteps: diagnostic.completedWorkflowSteps,
      scheduledBackoffMs: diagnostic.scheduledBackoffMs,
    })
  }
}

/** Attempt-local observations only: no logging, storage, identifiers or telemetry. */
export function createCheckoutSparkOrganizerRoutingObservation(
  now: () => number,
  startedAt: number
) {
  let stage: keyof typeof stages = "recovery"
  let writerChecks = 0
  let writerCheckMs = 0
  let lastPayoutObservation: CheckoutSparkOrganizerRoutingDiagnostic["lastPayoutObservation"] =
    "not_observed"
  let lastRecipientObservation: CheckoutSparkOrganizerRoutingDiagnostic["lastRecipientObservation"] =
    "not_observed"
  let lastProgressAck: CheckoutSparkOrganizerRoutingDiagnostic["lastProgressAck"] =
    "not_observed"
  let lastNativeObservation: CheckoutSparkOrganizerRoutingDiagnostic["lastNativeObservation"] =
    "not_observed"
  let lastNativePreflight: CheckoutSparkOrganizerRoutingDiagnostic["lastNativePreflight"] =
    "not_observed"
  let lastNativeSend: CheckoutSparkOrganizerRoutingDiagnostic["lastNativeSend"] =
    "not_observed"
  let lastWorkflowOutcome: CheckoutSparkOrganizerRoutingDiagnostic["lastWorkflowOutcome"] =
    "not_observed"
  let lastWorkflowWaitReason: CheckoutSparkOrganizerRoutingDiagnostic["lastWorkflowWaitReason"] =
    "none"
  let completedWorkflowSteps = 0
  let scheduledBackoffMs = 0
  const elapsed = (since: number) => Math.max(0, now() - since)
  return {
    stage(value: keyof typeof stages) {
      stage = value
    },
    payout(
      value: CheckoutSparkOrganizerRoutingDiagnostic["lastPayoutObservation"]
    ) {
      if (payoutObservations.includes(value)) lastPayoutObservation = value
    },
    recipient(
      value: CheckoutSparkOrganizerRoutingDiagnostic["lastRecipientObservation"]
    ) {
      if (recipientObservations.includes(value))
        lastRecipientObservation = value
    },
    progressAck(
      value: CheckoutSparkOrganizerRoutingDiagnostic["lastProgressAck"]
    ) {
      if (progressAcks.includes(value)) lastProgressAck = value
    },
    nativeObservation(
      value: CheckoutSparkOrganizerRoutingDiagnostic["lastNativeObservation"]
    ) {
      if (nativeObservations.includes(value)) lastNativeObservation = value
    },
    nativePreflight(
      value: CheckoutSparkOrganizerRoutingDiagnostic["lastNativePreflight"]
    ) {
      if (nativePreflights.includes(value)) lastNativePreflight = value
    },
    nativeSend(
      value: CheckoutSparkOrganizerRoutingDiagnostic["lastNativeSend"]
    ) {
      if (nativeSends.includes(value)) lastNativeSend = value
    },
    workflow(
      outcome: CheckoutSparkOrganizerRoutingDiagnostic["lastWorkflowOutcome"],
      reason: CheckoutSparkOrganizerRoutingDiagnostic["lastWorkflowWaitReason"] = "none"
    ) {
      if (workflowOutcomes.includes(outcome)) lastWorkflowOutcome = outcome
      if (workflowWaitReasons.includes(reason)) lastWorkflowWaitReason = reason
      completedWorkflowSteps++
    },
    backoff(milliseconds: number) {
      if (
        Number.isSafeInteger(milliseconds) &&
        milliseconds >= 0 &&
        milliseconds <= 5_000
      )
        scheduledBackoffMs += milliseconds
    },
    async checkWriter(check: () => Promise<void>) {
      writerChecks++
      const checkStartedAt = now()
      try {
        await check()
      } finally {
        writerCheckMs += elapsed(checkStartedAt)
      }
    },
    timeout() {
      return new CheckoutSparkOrganizerRoutingTimeoutError({
        stage: stages[stage],
        elapsedMs: elapsed(startedAt),
        writerChecks,
        writerCheckMs,
        lastPayoutObservation,
        lastRecipientObservation,
        lastProgressAck,
        lastNativeObservation,
        lastNativePreflight,
        lastNativeSend,
        lastWorkflowOutcome,
        lastWorkflowWaitReason,
        completedWorkflowSteps,
        scheduledBackoffMs,
      })
    },
  }
}
