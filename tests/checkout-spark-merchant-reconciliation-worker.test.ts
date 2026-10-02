import { describe, expect, it } from "bun:test"
import {
  startMerchantCheckoutSparkReconciliation,
  type MerchantCheckoutSparkReconciliationSummary,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"

function candidate(
  checkoutId: string,
  takeoverAt = 0,
  wrapId = `wrap-${checkoutId}`
): MerchantCheckoutSparkRecoveryCandidate {
  return {
    wrapId,
    schemaVersion: 3,
    checkoutId,
    orderId: `order-${checkoutId}`,
    planDigest: "a".repeat(64),
    takeoverAt,
    preparedAt: 0,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let step = 0; step < 12; step += 1) await Promise.resolve()
}

function fakeClock() {
  let time = 0
  const timers: Array<{
    at: number
    callback: () => void
    cancelled: boolean
  }> = []
  return {
    now: () => time,
    schedule(callback: () => void, delayMs: number) {
      const timer = { at: time + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    nextDelay() {
      const next = timers
        .filter((timer) => !timer.cancelled)
        .sort((left, right) => left.at - right.at)[0]
      return next ? next.at - time : null
    },
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        const next = timers
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((left, right) => left.at - right.at)[0]
        if (!next) break
        time = next.at
        next.cancelled = true
        next.callback()
        await flush()
      }
      time = end
      await flush()
    },
  }
}

describe("bounded merchant Spark reconciliation scheduling", () => {
  it("pauses exact candidates missing local invoice origin without claiming verification", async () => {
    const clock = fakeClock()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const options = {
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected: MerchantCheckoutSparkRecoveryCandidate) => {
        calls.push(selected.wrapId)
        return "recipient_unverified" as const
      },
      onUpdate: (summary: MerchantCheckoutSparkReconciliationSummary) =>
        updates.push(summary),
    }
    const worker = startMerchantCheckoutSparkReconciliation(options)
    worker.replaceCandidates([candidate("origin")])
    await clock.advance(0)
    expect(updates.at(-1)?.counts.recipient_unverified).toBe(1)
    expect(updates.at(-1)?.counts.verified).toBe(0)
    expect(updates.at(-1)?.counts.retired).toBe(0)
    expect(clock.nextDelay()).toBeNull()
    worker.replaceCandidates([candidate("origin")])
    await clock.advance(600_000)
    expect(calls).toEqual(["wrap-origin"])
    worker.replaceCandidates([candidate("origin", 0, "new-signed-candidate")])
    await clock.advance(0)
    expect(calls).toEqual(["wrap-origin", "new-signed-candidate"])
    await worker.stopAndDrain()

    // A deliberate manual restart re-evaluates even the same signed pointer.
    const restarted = startMerchantCheckoutSparkReconciliation(options)
    restarted.replaceCandidates([
      candidate("origin", 0, "new-signed-candidate"),
    ])
    await clock.advance(0)
    expect(calls).toHaveLength(3)
    restarted.dispose()
  })

  it("waits for takeover, serializes candidates, and keeps a minimum work gap", async () => {
    const clock = fakeClock()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected) => {
        calls.push(selected.checkoutId)
        return "verified"
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([candidate("b", 10_000), candidate("a", 10_000)])
    expect(clock.nextDelay()).toBe(10_000)
    await clock.advance(9_999)
    expect(calls).toEqual([])
    await clock.advance(1)
    expect(calls).toEqual(["a"])
    expect(clock.nextDelay()).toBe(750)
    await clock.advance(749)
    expect(calls).toEqual(["a"])
    await clock.advance(1)
    expect(calls).toEqual(["a", "b"])
    expect(updates.at(-1)?.counts.verified).toBe(2)
    expect(updates.at(-1)?.lastCheckedAt).toBe(10_750)
    expect(clock.nextDelay()).toBeNull()
    worker.dispose()
  })

  it.each([
    "pending",
    "progress_pending",
    "retirement_pending",
    "renewal_wait",
  ] as const)(
    "gives other due candidates a turn and backs off %s to five minutes",
    async (status) => {
      const clock = fakeClock()
      const calls: Array<{ id: string; at: number }> = []
      const updates: MerchantCheckoutSparkReconciliationSummary[] = []
      const worker = startMerchantCheckoutSparkReconciliation({
        now: clock.now,
        schedule: clock.schedule,
        reconcile: async (selected) => {
          calls.push({ id: selected.checkoutId, at: clock.now() })
          return selected.checkoutId === "b" ? "retired" : status
        },
        onUpdate: (summary) => updates.push(summary),
      })
      worker.replaceCandidates([candidate("a"), candidate("b")])
      await clock.advance(0)
      expect(calls).toEqual([{ id: "a", at: 0 }])
      expect(updates.at(-1)?.counts.verified).toBe(0)
      await clock.advance(750)
      expect(calls.at(-1)).toEqual({ id: "b", at: 750 })
      expect(updates.at(-1)?.counts[status]).toBe(1)
      expect(clock.nextDelay()).toBe(29_250)
      await clock.advance(29_250)
      expect(calls.at(-1)).toEqual({ id: "a", at: 30_000 })
      expect(clock.nextDelay()).toBe(60_000)
      await clock.advance(60_000)
      expect(clock.nextDelay()).toBe(120_000)
      await clock.advance(120_000)
      expect(clock.nextDelay()).toBe(240_000)
      await clock.advance(240_000)
      expect(clock.nextDelay()).toBe(300_000)
      await clock.advance(300_000)
      expect(clock.nextDelay()).toBe(300_000)
      expect(calls.filter((call) => call.id === "b")).toHaveLength(1)
      expect(updates.at(-1)?.counts[status]).toBe(1)
      expect(updates.at(-1)?.counts.verified).toBe(0)
      worker.dispose()
    }
  )

  it.each(["progress_pending", "retirement_pending"] as const)(
    "invalidates held %s on visibility, account, and disposal changes without overlap",
    async (status) => {
      for (const transition of ["hidden", "account", "disposed"] as const) {
        const clock = fakeClock()
        const held = deferred<typeof status>()
        const updates: MerchantCheckoutSparkReconciliationSummary[] = []
        const calls: string[] = []
        let activeCalls = 0
        let maxActiveCalls = 0
        let assertHeldCurrent: (() => void) | undefined
        const worker = startMerchantCheckoutSparkReconciliation({
          now: clock.now,
          schedule: clock.schedule,
          reconcile: async (selected, assertCurrent) => {
            calls.push(selected.checkoutId)
            activeCalls += 1
            maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
            try {
              if (calls.length === 1) {
                assertHeldCurrent = assertCurrent
                // The worker must invalidate the result even if an adapter
                // completes without calling its guard again after the await.
                return await held.promise
              }
              assertCurrent()
              return status
            } finally {
              activeCalls -= 1
            }
          },
          onUpdate: (summary) => updates.push(summary),
        })
        worker.replaceCandidates([candidate("old-account")])
        await clock.advance(0)
        expect(activeCalls, transition).toBe(1)

        let drained = false
        let drain: Promise<void> | undefined
        if (transition === "hidden") {
          worker.setActive(false)
        } else if (transition === "account") {
          worker.replaceCandidates([])
          worker.replaceCandidates([candidate("new-account")])
        } else {
          drain = worker.stopAndDrain().then(() => {
            drained = true
          })
        }

        expect(() => assertHeldCurrent?.(), transition).toThrow(
          "Merchant checkout reconciliation candidate changed."
        )
        expect(clock.nextDelay(), transition).toBeNull()
        await clock.advance(60_000)
        expect(calls, transition).toEqual(["old-account"])
        expect(activeCalls, transition).toBe(1)
        expect(drained, transition).toBe(false)
        const updateCount = updates.length

        held.resolve(status)
        await flush()
        await drain
        expect(activeCalls, transition).toBe(0)
        expect(updates.at(-1)?.counts[status], transition).toBe(0)
        expect(updates.at(-1)?.counts.verified, transition).toBe(0)
        expect(updates.at(-1)?.lastCheckedAt, transition).toBeNull()

        if (transition === "disposed") {
          expect(drained).toBe(true)
          expect(updates.length).toBe(updateCount)
          expect(clock.nextDelay()).toBeNull()
          await clock.advance(300_000)
          expect(calls).toEqual(["old-account"])
        } else {
          expect(updates.at(-1)?.counts.pending, transition).toBe(1)
          if (transition === "hidden") {
            expect(updates.at(-1)?.paused).toBe(true)
            expect(clock.nextDelay()).toBeNull()
            worker.setActive(true)
          }
          await clock.advance(0)
          expect(calls, transition).toEqual([
            "old-account",
            transition === "account" ? "new-account" : "old-account",
          ])
          expect(updates.at(-1)?.counts[status], transition).toBe(1)
          expect(updates.at(-1)?.lastCheckedAt, transition).toBe(60_000)
          expect(clock.nextDelay(), transition).toBe(30_000)
        }
        expect(maxActiveCalls, transition).toBe(1)
        worker.dispose()
      }
    }
  )

  it("invalidates a held candidate when its signed wrap changes and waits before restart", async () => {
    const clock = fakeClock()
    const first = deferred<"verified">()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected, assertCurrent) => {
        calls.push(selected.wrapId)
        if (selected.wrapId === "old") {
          const result = await first.promise
          assertCurrent()
          return result
        }
        return "verified"
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([candidate("a", 0, "old")])
    await clock.advance(0)
    worker.replaceCandidates([candidate("a", 0, "new")])
    expect(clock.nextDelay()).toBeNull()
    first.resolve("verified")
    await flush()
    expect(updates.at(-1)?.counts.pending).toBe(1)
    expect(updates.at(-1)?.lastCheckedAt).toBeNull()
    expect(clock.nextDelay()).toBe(750)
    await clock.advance(750)
    expect(calls).toEqual(["old", "new"])
    expect(updates.at(-1)?.counts.verified).toBe(1)
    worker.dispose()
  })

  it("invalidates a held result when only the Merchant progress pointer changes", async () => {
    const clock = fakeClock()
    const first = deferred<"verified">()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const withProgress = (snapshotId: string) => ({
      ...candidate("a", 0, "buyer-wrap"),
      merchantProgress: {
        wrapId: `merchant-wrap-${snapshotId}`,
        snapshotId,
        recordedAt: snapshotId === "first" ? 1 : 2,
      },
    })
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected, assertCurrent) => {
        const snapshotId = selected.merchantProgress?.snapshotId ?? "missing"
        calls.push(snapshotId)
        if (snapshotId === "first") {
          const result = await first.promise
          assertCurrent()
          return result
        }
        return "verified"
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([withProgress("first")])
    await clock.advance(0)
    worker.replaceCandidates([withProgress("second")])
    first.resolve("verified")
    await flush()
    expect(updates.at(-1)?.counts.pending).toBe(1)
    expect(updates.at(-1)?.lastCheckedAt).toBeNull()
    await clock.advance(750)
    expect(calls).toEqual(["first", "second"])
    expect(updates.at(-1)?.counts.verified).toBe(1)
    worker.dispose()
  })

  it("pauses without overlapping work and drains before a manual action", async () => {
    const clock = fakeClock()
    const held = deferred<"verified">()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected, assertCurrent) => {
        calls.push(selected.checkoutId)
        const result = await held.promise
        assertCurrent()
        return result
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([candidate("a"), candidate("b")])
    await clock.advance(0)
    worker.setActive(false)
    expect(updates.at(-1)?.paused).toBe(true)
    expect(updates.at(-1)?.checking).toBe(false)
    worker.setActive(true)
    expect(clock.nextDelay()).toBeNull()
    await clock.advance(60_000)
    expect(calls).toEqual(["a"])
    let drained = false
    const drain = worker.stopAndDrain().then(() => {
      drained = true
    })
    await flush()
    expect(drained).toBe(false)
    const updateCount = updates.length
    held.resolve("verified")
    await drain
    await clock.advance(60_000)
    expect(drained).toBe(true)
    expect(calls).toEqual(["a"])
    expect(updates.length).toBe(updateCount)
  })

  it("retires terminal results until a changed wrap and bounds retained candidates", async () => {
    const clock = fakeClock()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected) => {
        calls.push(selected.wrapId)
        return "verified"
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([candidate("a", 0, "first")])
    await clock.advance(0)
    await clock.advance(600_000)
    expect(calls).toEqual(["first"])
    worker.replaceCandidates([candidate("a", 0, "second")])
    expect(updates.at(-1)?.counts.pending).toBe(1)
    await clock.advance(0)
    expect(calls).toEqual(["first", "second"])

    worker.setActive(false)
    worker.replaceCandidates(
      Array.from({ length: 513 }, (_, index) => candidate(`id-${index}`))
    )
    expect(updates.at(-1)?.capacityReached).toBe(true)
    expect(updates.at(-1)?.counts.pending).toBe(512)
    worker.dispose()
  })

  it("rechecks long-future takeover timers without running early", async () => {
    const clock = fakeClock()
    const calls: string[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected) => {
        calls.push(selected.checkoutId)
        return "verified"
      },
      onUpdate() {},
    })
    const takeoverAt = 2_147_483_647 + 1_000
    worker.replaceCandidates([candidate("future", takeoverAt)])
    expect(clock.nextDelay()).toBe(2_147_483_647)
    await clock.advance(2_147_483_647)
    expect(calls).toEqual([])
    expect(clock.nextDelay()).toBe(1_000)
    await clock.advance(1_000)
    expect(calls).toEqual(["future"])
    worker.dispose()
  })

  it("rejects a retained checkout also duplicated beyond the capacity boundary", () => {
    const clock = fakeClock()
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async () => "verified",
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([
      ...Array.from({ length: 512 }, (_, index) => candidate(`id-${index}`)),
      candidate("id-0", 0, "conflicting-overflow-wrap"),
    ])
    expect(updates.at(-1)?.capacityReached).toBe(true)
    expect(updates.at(-1)?.selectionConflictCount).toBe(1)
    expect(updates.at(-1)?.counts.pending).toBe(511)
    worker.dispose()
  })

  it("reports a duplicate selection separately from capacity overflow", () => {
    const clock = fakeClock()
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async () => "verified",
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([
      candidate("same", 0, "first"),
      candidate("same", 0, "second"),
      candidate("same", 0, "third"),
      candidate("distinct"),
    ])
    expect(updates.at(-1)?.capacityReached).toBe(false)
    expect(updates.at(-1)?.selectionConflictCount).toBe(1)
    expect(updates.at(-1)?.counts.pending).toBe(1)
    worker.dispose()
  })

  it("marks malformed takeover times unavailable without scheduling or provider reads", async () => {
    const clock = fakeClock()
    const calls: string[] = []
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async (selected) => {
        calls.push(selected.checkoutId)
        return "verified"
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([
      candidate("nan", Number.NaN),
      candidate("infinity", Number.POSITIVE_INFINITY),
      candidate("negative", -1),
      candidate("unsafe", Number.MAX_SAFE_INTEGER + 1),
    ])
    expect(updates.at(-1)?.counts.unavailable).toBe(4)
    expect(clock.nextDelay()).toBeNull()
    await clock.advance(300_000)
    expect(calls).toEqual([])
    worker.replaceCandidates([candidate("nan", 300_000)])
    await clock.advance(0)
    expect(calls).toEqual(["nan"])
    worker.dispose()
  })

  it("drops removed candidates and converts thrown reads into retryable unavailable", async () => {
    const clock = fakeClock()
    const held = deferred<void>()
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    let calls = 0
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: async () => {
        calls += 1
        if (calls === 1) {
          await held.promise
          return "verified"
        }
        throw new Error("bounded provider read unavailable")
      },
      onUpdate: (summary) => updates.push(summary),
    })
    worker.replaceCandidates([candidate("old")])
    await clock.advance(0)
    worker.replaceCandidates([candidate("new")])
    held.resolve()
    await flush()
    expect(updates.at(-1)?.counts.pending).toBe(1)
    await clock.advance(750)
    expect(updates.at(-1)?.counts.unavailable).toBe(1)
    expect(clock.nextDelay()).toBe(30_000)
    worker.dispose()
  })
})
