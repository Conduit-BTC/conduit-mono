import { recordBrowserTelemetryEvent } from "../telemetry"
import { checkoutSparkOperationSteps } from "../telemetry-contract"
import { getTelemetryLatencyBucket } from "../telemetry-event-properties"

export type CheckoutSparkOperationStep =
  (typeof checkoutSparkOperationSteps)[number]

export interface CheckoutSparkPerformanceObservation {
  step: CheckoutSparkOperationStep
  /** Operation return/rejection, never a payment settlement assertion. */
  status: "success" | "failure"
  /** Transient, bounded diagnostic duration; telemetry receives a bucket only. */
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
      recordBrowserTelemetryEvent({
        app: input.app,
        eventName: "checkout_router_operation_result",
        properties: {
          step: input.step,
          status,
          latency_bucket: getTelemetryLatencyBucket(durationMs),
          count_bucket: "1",
        },
      })
    }
  }
}
