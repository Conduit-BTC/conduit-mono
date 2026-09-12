import { describe, expect, it } from "bun:test"
import { subscribeToTimeBoundaries } from "@conduit/ui"
import { createFakeTimeBoundaryClock } from "./helpers/fake-time-boundary-clock"

const MAX_TIMER_DELAY_MS = 2_147_483_647

describe("time boundary subscriptions", () => {
  it("re-arms waits longer than the browser timer ceiling", () => {
    const boundary = MAX_TIMER_DELAY_MS + 1_000
    const clock = createFakeTimeBoundaryClock(0)
    const observed: number[] = []
    const unsubscribe = subscribeToTimeBoundaries({
      boundaries: [boundary],
      currentNowMs: clock.now(),
      onBoundary: (nowMs) => observed.push(nowMs),
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    expect(clock.nextTimerDelayMs()).toBe(MAX_TIMER_DELAY_MS)
    clock.fireNextTimerAt(MAX_TIMER_DELAY_MS)
    expect(observed).toEqual([])
    expect(clock.nextTimerDelayMs()).toBe(1_000)

    clock.fireNextTimerAt(boundary)
    expect(observed).toEqual([boundary])
    expect(clock.pendingTimerCount()).toBe(0)

    unsubscribe()
  })

  it("coalesces a delayed wake that crosses multiple boundaries", () => {
    const clock = createFakeTimeBoundaryClock(999)
    const observed: number[] = []
    const unsubscribe = subscribeToTimeBoundaries({
      boundaries: [1_000, 2_000, 3_000],
      currentNowMs: clock.now(),
      onBoundary: (nowMs) => observed.push(nowMs),
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    clock.fireNextTimerAt(2_500)
    expect(observed).toEqual([2_500])
    expect(clock.nextTimerDelayMs()).toBe(500)

    clock.fireNextTimerAt(3_000)
    expect(observed).toEqual([2_500, 3_000])
    expect(clock.pendingTimerCount()).toBe(0)

    unsubscribe()
  })

  it("synchronizes subscribers after the wall clock moves backwards", () => {
    const clock = createFakeTimeBoundaryClock(2_000)
    const observed: number[] = []
    const unsubscribe = subscribeToTimeBoundaries({
      boundaries: [5_000],
      currentNowMs: clock.now(),
      onBoundary: (nowMs) => observed.push(nowMs),
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    clock.fireNextTimerAt(1_000)
    expect(observed).toEqual([1_000])
    expect(clock.nextTimerDelayMs()).toBe(4_000)

    unsubscribe()
    expect(clock.pendingTimerCount()).toBe(0)
  })

  it("cancels pending work on cleanup", () => {
    const clock = createFakeTimeBoundaryClock(0)
    const observed: number[] = []
    const unsubscribe = subscribeToTimeBoundaries({
      boundaries: [1_000],
      currentNowMs: clock.now(),
      onBoundary: (nowMs) => observed.push(nowMs),
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })

    expect(clock.pendingTimerCount()).toBe(1)
    unsubscribe()
    clock.advanceTo(1_000)

    expect(clock.pendingTimerCount()).toBe(0)
    expect(observed).toEqual([])
  })
})
