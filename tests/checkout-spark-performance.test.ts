import { describe, expect, test } from "bun:test"
import {
  observeCheckoutSparkOperation,
  type CheckoutSparkPerformanceObservation,
} from "../packages/core/src/protocol/checkout-spark-performance"
import { sanitizeTelemetryEventProperties } from "../packages/core/src/telemetry"

describe("content-free checkout operation observation", () => {
  test("measures one operation without observing its private input or result", async () => {
    const observations: CheckoutSparkPerformanceObservation[] = []
    let now = 100
    const privateResult = { invoice: "private fixture", amountSats: 7 }
    const result = await observeCheckoutSparkOperation({
      app: "market",
      step: "router_recipient_metadata",
      now: () => now,
      observe: (observation) => observations.push(observation),
      operation: async () => {
        now = 425
        return privateResult
      },
    })
    expect(result).toBe(privateResult)
    expect(observations).toEqual([
      {
        step: "router_recipient_metadata",
        status: "success",
        durationMs: 325,
        count: 1,
      },
    ])
  })

  test("preserves the exact thrown error and contains no error text", async () => {
    const observations: CheckoutSparkPerformanceObservation[] = []
    const error = new Error("private provider fixture")
    let now = 5
    try {
      await observeCheckoutSparkOperation({
        app: "merchant",
        step: "router_merchant_recovery",
        now: () => now,
        observe: (value) => observations.push(value),
        operation: async () => {
          now = 15
          throw error
        },
      })
      throw new Error("operation should reject")
    } catch (cause) {
      expect(cause).toBe(error)
    }
    expect(observations).toEqual([
      {
        step: "router_merchant_recovery",
        status: "failure",
        durationMs: 10,
        count: 1,
      },
    ])
    expect(JSON.stringify(observations)).not.toContain("private")
  })

  test("diagnostic clock and observer failures cannot alter payment behavior", async () => {
    let operations = 0
    const result = await observeCheckoutSparkOperation({
      app: "market",
      step: "router_funding_observation",
      now: () => {
        throw new Error("unavailable clock")
      },
      observe: () => {
        throw new Error("unavailable observer")
      },
      operation: async () => ++operations,
    })
    expect(result).toBe(1)
    expect(operations).toBe(1)
  })

  test("invalid or reversed diagnostic clocks produce unknown duration", async () => {
    for (const end of [Number.NaN, Number.POSITIVE_INFINITY, 2, 1_000_001]) {
      const observations: CheckoutSparkPerformanceObservation[] = []
      let now = 5
      await observeCheckoutSparkOperation({
        app: "merchant",
        step: "router_retirement",
        now: () => now,
        observe: (value) => observations.push(value),
        operation: async () => {
          now = end
        },
      })
      expect(observations[0]?.durationMs).toBeNull()
    }
  })

  test("asynchronous diagnostic rejection is observed without delaying the operation", async () => {
    expect(
      await observeCheckoutSparkOperation({
        app: "market",
        step: "router_preparation",
        observe: async () => {
          await Promise.resolve()
          throw new Error("diagnostic failure")
        },
        operation: async () => "unchanged",
      })
    ).toBe("unchanged")
    await Promise.resolve()
  })

  test("the shared telemetry contract admits only content-free bucketed properties", () => {
    for (const app of ["market", "merchant"] as const) {
      const properties = {
        step: "router_outgoing_observation",
        status: "success",
        latency_bucket: "250ms_1s",
        count_bucket: "1",
      }
      expect(
        sanitizeTelemetryEventProperties({
          app,
          eventName: "checkout_router_operation_result",
          properties,
        })
      ).toEqual({
        ...properties,
        app,
        event_name: "checkout_router_operation_result",
      })
      for (const unwanted of [
        { step: "private-provider-or-order" },
        { durationMs: 327 },
        { invoice: "private" },
        { recipient: "private" },
      ]) {
        expect(
          sanitizeTelemetryEventProperties({
            app,
            eventName: "checkout_router_operation_result",
            properties: { ...properties, ...unwanted },
          })
        ).toBeNull()
      }
    }
  })
})
