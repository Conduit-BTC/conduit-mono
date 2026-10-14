import { describe, expect, it } from "bun:test"
import {
  createMerchantSupplierNotificationQueue,
  type SupplierNotificationInput,
} from "../apps/merchant/src/lib/checkout-spark-supplier-notifications"

function input(): SupplierNotificationInput {
  return {
    principal: "a".repeat(64),
    candidate: {
      schemaVersion: 2,
      wrapId: "b".repeat(64),
      checkoutId: "supplier-queue-order",
      orderId: "supplier-queue-order",
      planDigest: "c".repeat(64),
      preparedAt: 1_000,
      takeoverAt: 2_000,
    },
    assertActive() {},
  }
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe("Merchant supplier notification dispatch queue", () => {
  it("dispatches newer verified evidence arriving while an earlier notice is in flight", async () => {
    const observed: SupplierNotificationInput[] = []
    let release!: (retry: boolean) => void
    const queued: Array<() => void> = []
    const queue = createMerchantSupplierNotificationQueue(
      async (next) => {
        observed.push(next)
        if (observed.length === 1)
          return await new Promise<boolean>((resolve) => {
            release = resolve
          })
        return false
      },
      (run) => queued.push(run)
    )
    const first = input()
    const second = input()
    queue(first)
    queue(second)
    expect(observed).toHaveLength(1)
    release(false)
    await flush()
    expect(observed).toHaveLength(2)
    expect(observed[1]?.assertActive).toBe(second.assertActive)
    expect(queued).toHaveLength(0)
    // A successful notice does not leave a backoff that drops later suppliers.
    queue(input())
    await flush()
    expect(observed).toHaveLength(3)
  })

  it("retains frozen verified evidence if retirement arrives during retry backoff", async () => {
    const observed: SupplierNotificationInput[] = []
    const timers: Array<{ run: () => void; delay: number }> = []
    const queue = createMerchantSupplierNotificationQueue(
      async (next) => {
        observed.push(next)
        return observed.length === 1
      },
      (run, delay) => timers.push({ run, delay })
    )
    // Opaque scheduling-only fixtures: dispatch's protocol validation is covered
    // by checkout-spark-supplier-notification.test.ts, not bypassed in runtime.
    const active = {
      ...input(),
      plan: { planDigest: "c".repeat(64) },
      settlement: { paidLegs: [] },
    } as SupplierNotificationInput
    queue(active)
    await flush()
    expect(timers[0]?.delay).toBe(60_000)
    const retired = input()
    queue(retired)
    timers[0]!.run()
    await flush()
    expect(observed).toHaveLength(2)
    expect(observed[1]?.plan).toBe(active.plan)
    expect(observed[1]?.settlement).toBe(active.settlement)
    expect(observed[1]?.assertActive).toBe(retired.assertActive)
  })

  it("bounds automatic retries and never delegates payment or wallet work", async () => {
    let attempts = 0
    const timers: Array<{ run: () => void; delay: number }> = []
    const queue = createMerchantSupplierNotificationQueue(
      async () => {
        attempts += 1
        return true
      },
      (run, delay) => timers.push({ run, delay })
    )
    queue(input())
    await flush()
    timers[0]!.run()
    await flush()
    timers[1]!.run()
    await flush()
    expect(attempts).toBe(3)
    expect(timers.map((timer) => timer.delay)).toEqual([60_000, 120_000])
  })

  it("suppresses queued retries after account/page guard revocation", async () => {
    let active = true
    let calls = 0
    const timers: Array<() => void> = []
    const queue = createMerchantSupplierNotificationQueue(
      async () => {
        calls += 1
        return true
      },
      (run) => timers.push(run)
    )
    queue({
      ...input(),
      assertActive() {
        if (!active) throw new Error("Notification page is inactive")
      },
    })
    await flush()
    active = false
    timers[0]!()
    await flush()
    expect(calls).toBe(1)
    expect(timers).toHaveLength(1)
    // A later valid page can resume from its own durable outbox.
    queue(input())
    await flush()
    expect(calls).toBe(2)
  })

  it("catches a late failed delivery after revocation without starting a retry", async () => {
    let active = true
    let reject!: (error: Error) => void
    let scheduled = 0
    const queue = createMerchantSupplierNotificationQueue(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise
        }),
      () => {
        scheduled += 1
      }
    )
    queue({
      ...input(),
      assertActive() {
        if (!active) throw new Error("Notification page is inactive")
      },
    })
    active = false
    reject(new Error("Late private relay response"))
    await flush()
    expect(scheduled).toBe(0)
  })
})
