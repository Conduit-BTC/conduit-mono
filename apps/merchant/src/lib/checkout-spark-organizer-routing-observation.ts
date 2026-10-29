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

export interface CheckoutSparkOrganizerRoutingDiagnostic {
  /** Fixed product label, never a provider error or payment identifier. */
  stage: (typeof stages)[keyof typeof stages]
  elapsedMs: number
  writerChecks: number
  writerCheckMs: number
}

export class CheckoutSparkOrganizerRoutingTimeoutError extends Error {
  readonly diagnostic: Readonly<CheckoutSparkOrganizerRoutingDiagnostic>

  constructor(diagnostic: CheckoutSparkOrganizerRoutingDiagnostic) {
    super(
      "This recovery check reached its time limit. Saved payments are preserved. Reopen this saved order to check its existing payments; do not pay again."
    )
    this.name = "CheckoutSparkOrganizerRoutingTimeoutError"
    this.diagnostic = Object.freeze({ ...diagnostic })
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
  const elapsed = (since: number) => Math.max(0, now() - since)
  return {
    stage(value: keyof typeof stages) {
      stage = value
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
      })
    },
  }
}
