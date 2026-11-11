/**
 * Thrown only by an app-owned guard strictly before the provider SDK send call
 * is invoked. It is not provider evidence: provider `not_found` never means
 * not sent. Any other throw from `send` remains a possible send.
 */
export class CheckoutSparkOutgoingNotAdmittedError extends Error {
  readonly preAdmission = true as const
  constructor(cause?: unknown) {
    super("Checkout Spark payout was not admitted to the provider.", { cause })
    this.name = "CheckoutSparkOutgoingNotAdmittedError"
  }
}

/** No provider call happened, but the pre-admission cancellation is not durable. */
export class CheckoutSparkOutgoingPreAdmissionCancellationError extends Error {
  readonly preAdmission = true as const
  constructor(cause?: unknown) {
    super("Checkout Spark pre-admission cancellation was not persisted.", {
      cause,
    })
    this.name = "CheckoutSparkOutgoingPreAdmissionCancellationError"
  }
}
