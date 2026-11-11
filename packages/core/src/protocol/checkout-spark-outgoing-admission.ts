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

/**
 * Runs a provider send behind a currency guard. Only a rejection of the guard
 * evaluated before `send` is invoked is typed as not admitted; the guard after
 * `send` and any throw from `send` itself stay untyped (possibly sent).
 */
export async function sendAfterPreAdmissionGuard<T>(
  assertCurrent: () => void | Promise<void>,
  send: () => Promise<T>
): Promise<T> {
  try {
    await assertCurrent()
  } catch (error) {
    throw error instanceof CheckoutSparkOutgoingNotAdmittedError
      ? error
      : new CheckoutSparkOutgoingNotAdmittedError(error)
  }
  const value = await send()
  await assertCurrent()
  return value
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
