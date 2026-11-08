/** Fixed operational labels; no order, destination or provider identity. */
export const checkoutSparkOperationSteps = [
  "router_preparation",
  "router_funding_preparation",
  "router_recipient_profiles",
  "router_recipient_metadata",
  "router_funding_observation",
  "router_commerce_verification",
  "router_outgoing_observation",
  "router_native_commitment",
  "router_merchant_recovery",
] as const

export type CheckoutSparkOperationStep =
  (typeof checkoutSparkOperationSteps)[number]

export interface CheckoutSparkPerformanceObservation {
  step: CheckoutSparkOperationStep
  /** Operation return/rejection, never a payment settlement assertion. */
  status: "success" | "failure"
  /** Transient, bounded diagnostic duration; local observer only. */
  durationMs: number | null
  count: 1
}

export type CheckoutSparkPerformanceObserver = (
  observation: Readonly<CheckoutSparkPerformanceObservation>
) => void

/**
 * Observe an existing operation, never its arguments, result, error or identity.
 * The diagnostic clock is independent of every funding/dispatch policy clock.
 * No retained trace, correlation identifier, console output or new transport.
 */
export async function observeCheckoutSparkOperation<T>(input: {
  app: "market" | "merchant"
  step: CheckoutSparkOperationStep
  operation: () => Promise<T>
  observe?: CheckoutSparkPerformanceObserver
  now?: () => number
}): Promise<T> {
  const clock = () => {
    try {
      const value = input.now ? input.now() : performance.now()
      return Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }
  const started = clock()
  let status: "success" | "failure" = "failure"
  try {
    const value = await input.operation()
    status = "success"
    return value
  } finally {
    const ended = clock()
    const elapsed = started !== null && ended !== null ? ended - started : null
    const durationMs =
      elapsed !== null && elapsed >= 0 && elapsed <= 900_000 ? elapsed : null
    if (checkoutSparkOperationSteps.includes(input.step)) {
      try {
        void Promise.resolve(
          input.observe?.({ step: input.step, status, durationMs, count: 1 })
        ).catch(() => undefined)
      } catch {
        // An optional diagnostic consumer cannot affect financial execution.
      }
    }
  }
}
