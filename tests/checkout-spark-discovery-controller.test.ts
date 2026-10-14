import { describe, expect, it } from "bun:test"
import {
  startMerchantCheckoutSparkDiscovery,
  type MerchantCheckoutDiscoveryPage,
  type MerchantCheckoutDiscoveryStatus,
} from "../apps/merchant/src/lib/checkout-spark-discovery-controller"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function settled() {
  for (let index = 0; index < 24; index += 1) await Promise.resolve()
}

function page(
  pageStatus: MerchantCheckoutDiscoveryPage["history"]["pageStatus"],
  hasMore: boolean
): MerchantCheckoutDiscoveryPage {
  return {
    candidates: [],
    coverage: pageStatus === "source_eose" ? "complete" : "partial",
    declarationState: "declared",
    malformedCount: 0,
    decryptFailureCount: 0,
    conflictCount: 0,
    history: { hasMore, pageStatus, retentionLimitReached: false },
  }
}

function timers() {
  let scheduled = 0
  const pending: Array<{
    callback: () => void
    delayMs: number
    cancelled: boolean
  }> = []
  return {
    schedule(callback: () => void, delayMs: number) {
      scheduled += 1
      const task = { callback, delayMs, cancelled: false }
      pending.push(task)
      return () => {
        task.cancelled = true
      }
    },
    nextDelay() {
      return pending.find((task) => !task.cancelled)?.delayMs
    },
    scheduledCount: () => scheduled,
    run() {
      const index = pending.findIndex((task) => !task.cancelled)
      if (index === -1) throw new Error("No scheduled discovery step")
      const [task] = pending.splice(index, 1)
      task!.callback()
    },
  }
}

function rescanHarness(
  input: {
    active?: boolean
    opening?: Promise<void>
    nextPage?: (read: number) => Promise<MerchantCheckoutDiscoveryPage>
  } = {}
) {
  const timer = timers()
  const calls = {
    opened: 0,
    reads: 0,
    restarted: 0,
    closed: 0,
    inFlight: 0,
    maxInFlight: 0,
  }
  const observed: MerchantCheckoutDiscoveryPage[] = []
  const statuses: MerchantCheckoutDiscoveryStatus[] = []
  let lastPage: MerchantCheckoutDiscoveryPage | null = null
  const controller = startMerchantCheckoutSparkDiscovery({
    principalPubkey: "a".repeat(64),
    active: input.active,
    schedule: timer.schedule,
    createSession: async () => {
      calls.opened += 1
      await input.opening
      return {
        nextPage: async () => {
          calls.reads += 1
          calls.inFlight += 1
          calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight)
          try {
            const result = await (input.nextPage?.(calls.reads) ??
              Promise.resolve(page("source_eose", false)))
            lastPage = result
            return result
          } finally {
            calls.inFlight -= 1
          }
        },
        restartScan: () => {
          expect(calls.inFlight).toBe(0)
          if (lastPage?.history.hasMore)
            throw new Error(
              "Finish the current recovery discovery sweep first."
            )
          calls.restarted += 1
          lastPage = null
        },
        dispose: () => {
          calls.closed += 1
        },
      }
    },
    onPage: (result) => observed.push(result),
    onStatus: (status) => statuses.push(status),
  })
  return { controller, timer, calls, observed, statuses }
}

describe("active Merchant recovery discovery scheduling", () => {
  it("coalesces idle rescan requests into one prompt restart of the retained session", async () => {
    const test = rescanHarness()
    test.timer.run()
    await settled()
    expect(test.timer.nextDelay()).toBe(60_000)
    const before = test.timer.scheduledCount()
    expect(test.controller.requestRescan()).toBeUndefined()
    test.controller.requestRescan()
    test.controller.requestRescan()
    expect(test.timer.nextDelay()).toBe(750)
    expect(test.timer.scheduledCount()).toBe(before + 1)
    expect(test.calls.reads).toBe(1)
    expect(test.calls.restarted).toBe(0)
    expect(test.calls.closed).toBe(0)
    test.timer.run()
    await settled()
    expect(test.calls.reads).toBe(2)
    expect(test.calls.restarted).toBe(1)
    expect(test.calls.opened).toBe(1)
    expect(test.timer.nextDelay()).toBe(60_000)
    test.controller.requestRescan()
    expect(test.timer.nextDelay()).toBe(750)
    test.timer.run()
    await settled()
    expect(test.calls.restarted).toBe(2)
    expect(test.calls.maxInFlight).toBe(1)
    test.controller.dispose()
  })

  it("queues a requested rescan after an in-flight page without overlapping or draining it", async () => {
    const held = deferred<MerchantCheckoutDiscoveryPage>()
    const test = rescanHarness({
      nextPage: async (read) =>
        read === 1 ? held.promise : page("source_eose", false),
    })
    test.timer.run()
    await settled()
    expect(test.calls.inFlight).toBe(1)
    expect(test.controller.requestRescan()).toBeUndefined()
    test.controller.requestRescan()
    expect(test.timer.nextDelay()).toBeUndefined()
    expect(test.calls.reads).toBe(1)
    expect(test.calls.restarted).toBe(0)
    expect(test.calls.closed).toBe(0)
    held.resolve(page("source_eose", false))
    await settled()
    expect(test.timer.nextDelay()).toBe(750)
    expect(test.calls.restarted).toBe(0)
    test.timer.run()
    await settled()
    expect(test.calls.reads).toBe(2)
    expect(test.calls.restarted).toBe(1)
    expect(test.calls.maxInFlight).toBe(1)
    expect(test.timer.nextDelay()).toBe(60_000)
    test.controller.dispose()
  })

  it("finishes remaining bounded pages before restarting a requested sweep", async () => {
    const pages = [
      page("partial", true),
      page("advanced", true),
      page("source_eose", false),
      page("source_eose", false),
    ]
    const test = rescanHarness({ nextPage: async (read) => pages[read - 1]! })
    test.timer.run()
    await settled()
    expect(test.timer.nextDelay()).toBe(5_000)
    test.controller.requestRescan()
    for (let index = 0; index < 2; index += 1) {
      expect(test.timer.nextDelay()).toBe(750)
      test.timer.run()
      await settled()
      expect(test.calls.restarted).toBe(0)
      test.controller.requestRescan()
    }
    expect(test.calls.reads).toBe(3)
    expect(test.timer.nextDelay()).toBe(750)
    test.timer.run()
    await settled()
    expect(test.calls.restarted).toBe(1)
    expect(test.calls.reads).toBe(4)
    expect(test.observed).toEqual(pages)
    expect(test.calls.maxInFlight).toBe(1)
    expect(test.calls.opened).toBe(1)
    expect(test.timer.nextDelay()).toBe(60_000)
    test.controller.dispose()
  })

  it("keeps rescan requests behind in-flight signer setup without opening another session", async () => {
    const opening = deferred<void>()
    const test = rescanHarness({ opening: opening.promise })
    test.timer.run()
    await settled()
    test.controller.requestRescan()
    test.controller.requestRescan()
    expect(test.calls.opened).toBe(1)
    expect(test.calls.reads).toBe(0)
    expect(test.timer.nextDelay()).toBeUndefined()
    opening.resolve()
    await settled()
    expect(test.calls.reads).toBe(1)
    expect(test.calls.restarted).toBe(0)
    expect(test.timer.nextDelay()).toBe(750)
    test.timer.run()
    await settled()
    expect(test.calls.opened).toBe(1)
    expect(test.calls.restarted).toBe(1)
    expect(test.calls.reads).toBe(2)
    expect(test.calls.closed).toBe(0)
    test.controller.dispose()
  })

  it("defers hidden rescan requests and retains the minimum delay after visibility resumes", async () => {
    const test = rescanHarness({ active: false })
    test.controller.requestRescan()
    await settled()
    expect(test.calls.opened).toBe(0)
    expect(test.timer.nextDelay()).toBeUndefined()
    test.controller.setActive(true)
    expect(test.timer.nextDelay()).toBe(750)
    test.timer.run()
    await settled()
    test.controller.setActive(false)
    test.controller.requestRescan()
    expect(test.timer.nextDelay()).toBeUndefined()
    expect(test.calls.restarted).toBe(0)
    test.controller.setActive(true)
    expect(test.timer.nextDelay()).toBe(750)
    test.timer.run()
    await settled()
    expect(test.calls.opened).toBe(1)
    expect(test.calls.restarted).toBe(1)
    expect(test.calls.reads).toBe(2)
    test.controller.dispose()
  })

  it("keeps an in-flight rescan request paused while hidden without overlapping on resume", async () => {
    const held = deferred<MerchantCheckoutDiscoveryPage>()
    const test = rescanHarness({
      nextPage: async (read) =>
        read === 1 ? held.promise : page("source_eose", false),
    })
    test.timer.run()
    await settled()
    test.controller.requestRescan()
    test.controller.setActive(false)
    held.resolve(page("source_eose", false))
    await settled()
    expect(test.timer.nextDelay()).toBeUndefined()
    expect(test.statuses.at(-1)).toBe("paused")
    expect(test.calls.restarted).toBe(0)
    test.controller.setActive(true)
    expect(test.timer.nextDelay()).toBe(750)
    test.timer.run()
    await settled()
    expect(test.calls.restarted).toBe(1)
    expect(test.calls.maxInFlight).toBe(1)
    test.controller.dispose()
  })

  it("does not let requested rescans reopen a failed or retention-capped session", async () => {
    for (const terminal of ["error", "retention"] as const) {
      const held = deferred<MerchantCheckoutDiscoveryPage>()
      const test = rescanHarness({ nextPage: () => held.promise })
      test.timer.run()
      await settled()
      test.controller.requestRescan()
      if (terminal === "error")
        held.reject(new Error("Synthetic authority ended"))
      else {
        const limited = page("capped", false)
        limited.history.retentionLimitReached = true
        held.resolve(limited)
      }
      await settled()
      expect(test.statuses.at(-1)).toBe("unavailable")
      expect(test.calls.closed).toBe(1)
      test.controller.requestRescan()
      test.controller.setActive(false)
      test.controller.setActive(true)
      expect(test.timer.nextDelay()).toBeUndefined()
      expect(test.calls.opened).toBe(1)
      expect(test.calls.reads).toBe(1)
      expect(test.calls.restarted).toBe(0)
      test.controller.dispose()
    }
  })

  it("cancels a queued rescan on disposal and cannot be reactivated by another request", async () => {
    const test = rescanHarness()
    test.timer.run()
    await settled()
    test.controller.requestRescan()
    expect(test.timer.nextDelay()).toBe(750)
    test.controller.dispose()
    test.controller.requestRescan()
    test.controller.setActive(true)
    await settled()
    expect(test.calls.closed).toBe(1)
    expect(test.calls.reads).toBe(1)
    expect(test.calls.restarted).toBe(0)
    expect(test.timer.nextDelay()).toBeUndefined()
  })

  it("continues through multiple history pages without per-order clicks", async () => {
    const timer = timers()
    const pages = [
      page("advanced", true),
      page("advanced", true),
      page("source_eose", false),
    ]
    const observed: MerchantCheckoutDiscoveryPage[] = []
    const statuses: MerchantCheckoutDiscoveryStatus[] = []
    let reads = 0
    let closed = 0
    let restarted = 0
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => ({
        nextPage: async () => pages[reads++]!,
        restartScan: () => {
          restarted += 1
        },
        dispose: () => {
          closed += 1
        },
      }),
      onPage: (result) => observed.push(result),
      onStatus: (status) => statuses.push(status),
    })
    expect(timer.nextDelay()).toBe(0)
    timer.run()
    await settled()
    expect(timer.nextDelay()).toBe(750)
    timer.run()
    await settled()
    timer.run()
    await settled()
    expect(reads).toBe(3)
    expect(observed).toEqual(pages)
    expect(statuses.at(-1)).toBe("finished")
    expect(timer.nextDelay()).toBe(60_000)
    expect(closed).toBe(0)
    pages.push(page("source_eose", false))
    timer.run()
    await settled()
    expect(restarted).toBe(1)
    expect(reads).toBe(4)
    expect(timer.nextDelay()).toBe(60_000)
    controller.dispose()
    expect(closed).toBe(1)
  })

  it("backs off degraded sources and keeps only one page in flight", async () => {
    const timer = timers()
    const held = deferred<MerchantCheckoutDiscoveryPage>()
    let reads = 0
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => ({
        nextPage: () =>
          ++reads === 1 ? held.promise : Promise.resolve(page("partial", true)),
        restartScan() {},
        dispose() {},
      }),
      onPage() {},
      onStatus() {},
    })
    timer.run()
    await settled()
    expect(reads).toBe(1)
    expect(timer.nextDelay()).toBeUndefined()
    controller.setActive(false)
    controller.setActive(true)
    expect(timer.nextDelay()).toBeUndefined()
    held.resolve(page("unavailable", true))
    await settled()
    for (const expected of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      expect(timer.nextDelay()).toBe(expected)
      timer.run()
      await settled()
    }
    controller.dispose()
    expect(timer.nextDelay()).toBeUndefined()
  })

  it("does no signer work while hidden and pauses if hidden during session opening", async () => {
    const timer = timers()
    const held = deferred<{
      nextPage(): Promise<MerchantCheckoutDiscoveryPage>
      restartScan(): void
      dispose(): void
    }>()
    let opened = 0
    let reads = 0
    const statuses: MerchantCheckoutDiscoveryStatus[] = []
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      active: false,
      schedule: timer.schedule,
      createSession: () => {
        opened += 1
        return held.promise
      },
      onPage() {},
      onStatus: (status) => statuses.push(status),
    })
    expect(opened).toBe(0)
    expect(timer.nextDelay()).toBeUndefined()
    controller.setActive(true)
    timer.run()
    await settled()
    controller.setActive(false)
    held.resolve({
      nextPage: async () => {
        reads += 1
        return page("source_eose", false)
      },
      restartScan() {},
      dispose() {},
    })
    await settled()
    expect(reads).toBe(0)
    expect(statuses.at(-1)).toBe("paused")
    controller.setActive(true)
    timer.run()
    await settled()
    expect(reads).toBe(1)
    expect(opened).toBe(1)
    controller.dispose()
  })

  it("disposes a late signer session without reading or publishing its result", async () => {
    const timer = timers()
    const held = deferred<{
      nextPage(): Promise<MerchantCheckoutDiscoveryPage>
      restartScan(): void
      dispose(): void
    }>()
    let closed = 0
    let reads = 0
    let results = 0
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: () => held.promise,
      onPage: () => {
        results += 1
      },
      onStatus() {},
    })
    timer.run()
    controller.dispose()
    held.resolve({
      nextPage: async () => {
        reads += 1
        return page("source_eose", false)
      },
      restartScan() {},
      dispose: () => {
        closed += 1
      },
    })
    await settled()
    expect({ closed, reads, results }).toEqual({
      closed: 1,
      reads: 0,
      results: 0,
    })
    expect(timer.nextDelay()).toBeUndefined()
  })

  it("drops an old account's in-flight page after disposal", async () => {
    const timer = timers()
    const held = deferred<MerchantCheckoutDiscoveryPage>()
    let results = 0
    let closed = 0
    const statuses: MerchantCheckoutDiscoveryStatus[] = []
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => ({
        nextPage: () => held.promise,
        restartScan() {},
        dispose: () => {
          closed += 1
        },
      }),
      onPage: () => {
        results += 1
      },
      onStatus: (status) => statuses.push(status),
    })
    timer.run()
    await settled()
    controller.dispose()
    const statusCount = statuses.length
    held.resolve(page("advanced", true))
    await settled()
    expect(results).toBe(0)
    expect(closed).toBe(1)
    expect(statuses).toHaveLength(statusCount)
    expect(timer.nextDelay()).toBeUndefined()
  })

  it("stops a rejected authority/session without reopening it or exposing errors", async () => {
    const timer = timers()
    let opened = 0
    let closed = 0
    const statuses: MerchantCheckoutDiscoveryStatus[] = []
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => {
        opened += 1
        return {
          nextPage: async () => {
            throw new Error("private signer failure text")
          },
          restartScan() {},
          dispose: () => {
            closed += 1
          },
        }
      },
      onPage() {
        throw new Error("Must not publish a result")
      },
      onStatus: (status) => statuses.push(status),
    })
    timer.run()
    await settled()
    expect(statuses.at(-1)).toBe("unavailable")
    expect(JSON.stringify(statuses)).not.toContain("private")
    expect(opened).toBe(1)
    expect(closed).toBe(1)
    controller.setActive(false)
    controller.setActive(true)
    expect(timer.nextDelay()).toBeUndefined()
    controller.dispose()
  })

  it("drains a stopped page before allowing the next explicit action", async () => {
    const timer = timers()
    const held = deferred<MerchantCheckoutDiscoveryPage>()
    let results = 0
    let disposed = 0
    let drained = false
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => ({
        nextPage: () => held.promise,
        restartScan() {},
        dispose: () => {
          disposed += 1
        },
      }),
      onPage: () => {
        results += 1
      },
      onStatus() {},
    })
    timer.run()
    await settled()
    const drain = controller.stopAndDrain().then(() => {
      drained = true
    })
    await settled()
    expect(disposed).toBe(1)
    expect(drained).toBe(false)
    held.resolve(page("advanced", true))
    await drain
    expect(drained).toBe(true)
    expect(results).toBe(0)
    expect(timer.nextDelay()).toBeUndefined()
  })

  it("backs off incomplete sweeps while retaining the same discovery session", async () => {
    const timer = timers()
    let opened = 0
    let restarted = 0
    const observed: MerchantCheckoutDiscoveryPage[] = []
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => {
        opened += 1
        return {
          nextPage: async () => page("capped", false),
          restartScan: () => {
            restarted += 1
          },
          dispose() {},
        }
      },
      onPage: (result) => observed.push(result),
      onStatus() {},
    })
    timer.run()
    await settled()
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      expect(timer.nextDelay()).toBe(delay)
      timer.run()
      await settled()
    }
    expect(opened).toBe(1)
    expect(restarted).toBe(5)
    expect(observed.every((result) => result.coverage === "partial")).toBe(true)
    controller.dispose()
  })

  it("releases a saturated session without automatic authority eviction or reopening", async () => {
    const timer = timers()
    let opened = 0
    let closed = 0
    const observed: MerchantCheckoutDiscoveryPage[] = []
    const statuses: MerchantCheckoutDiscoveryStatus[] = []
    const limited: MerchantCheckoutDiscoveryPage = {
      ...page("capped", false),
      history: {
        hasMore: false,
        pageStatus: "capped",
        retentionLimitReached: true,
      },
    }
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      createSession: async () => {
        opened += 1
        return {
          nextPage: async () => limited,
          restartScan() {
            throw new Error("Saturated session must not be restarted")
          },
          dispose: () => {
            closed += 1
          },
        }
      },
      onPage: (result) => observed.push(result),
      onStatus: (status) => statuses.push(status),
    })
    timer.run()
    await settled()
    expect(observed).toEqual([limited])
    expect(closed).toBe(1)
    expect(statuses.at(-1)).toBe("unavailable")
    expect(timer.nextDelay()).toBeUndefined()
    controller.setActive(false)
    controller.setActive(true)
    expect(timer.nextDelay()).toBeUndefined()
    expect(opened).toBe(1)
    controller.dispose()
  })

  it("bounds signer setup and disposes a session that resolves after the deadline", async () => {
    const timer = timers()
    const held = deferred<{
      nextPage(): Promise<MerchantCheckoutDiscoveryPage>
      restartScan(): void
      dispose(): void
    }>()
    let closed = 0
    let reads = 0
    let setupSignal: AbortSignal | undefined
    const statuses: MerchantCheckoutDiscoveryStatus[] = []
    const controller = startMerchantCheckoutSparkDiscovery({
      principalPubkey: "a".repeat(64),
      schedule: timer.schedule,
      openingTimeoutMs: 1,
      createSession: (_principal, options) => {
        setupSignal = options?.signal
        return held.promise
      },
      onPage() {
        throw new Error("Timed-out setup cannot publish results")
      },
      onStatus: (status) => statuses.push(status),
    })
    timer.run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await settled()
    expect(setupSignal?.aborted).toBe(true)
    expect(statuses.at(-1)).toBe("unavailable")
    await controller.stopAndDrain()
    held.resolve({
      nextPage: async () => {
        reads += 1
        return page("source_eose", false)
      },
      restartScan() {},
      dispose: () => {
        closed += 1
      },
    })
    await settled()
    expect(reads).toBe(0)
    expect(closed).toBe(1)
    expect(timer.nextDelay()).toBeUndefined()
  })
})
