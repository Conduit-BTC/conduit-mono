import { describe, expect, it } from "bun:test"

import { getTelemetryLatencyBucket } from "@conduit/core"

import { awaitOrderDeliveryPresentation } from "../apps/market/src/lib/checkout-delivery-timing"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error("Deferred promise is unavailable")
      resolvePromise(value)
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("checkout order delivery timing", () => {
  it("records the publish latency while preserving the presentation hold", async () => {
    const publish = deferred<string>()
    const presentation = deferred<void>()
    let now = 0
    let completed = false

    const pending = awaitOrderDeliveryPresentation({
      now: () => now,
      publish: () => publish.promise,
      startedAt: 0,
      waitForPresentation: () => presentation.promise,
    }).then((result) => {
      completed = true
      return result
    })

    now = 120
    publish.resolve("accepted")
    await flushMicrotasks()

    expect(completed).toBe(false)

    now = 900
    presentation.resolve()
    const result = await pending

    expect(result).toEqual({
      delivery: "accepted",
      deliveryLatencyMs: 120,
    })
    expect(getTelemetryLatencyBucket(result.deliveryLatencyMs)).toBe("lt_250ms")
    expect(getTelemetryLatencyBucket(now)).toBe("250ms_1s")
  })
})
