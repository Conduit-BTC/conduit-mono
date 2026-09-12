export interface FakeTimeBoundaryClock {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
  advanceTo: (nowMs: number) => void
  fireNextTimerAt: (nowMs: number) => void
  nextTimerDelayMs: () => number | null
  pendingTimerCount: () => number
}

export function createFakeTimeBoundaryClock(
  initialNowMs: number
): FakeTimeBoundaryClock {
  let nowMs = initialNowMs
  let nextHandle = 1
  const timers = new Map<
    number,
    { callback: () => void; scheduledForMs: number }
  >()

  const nextTimer = () =>
    Array.from(timers.entries()).sort(
      ([leftHandle, left], [rightHandle, right]) =>
        left.scheduledForMs - right.scheduledForMs || leftHandle - rightHandle
    )[0]

  const runDueTimers = (): void => {
    while (true) {
      const next = nextTimer()
      if (!next || next[1].scheduledForMs > nowMs) return
      const [handle, timer] = next
      timers.delete(handle)
      timer.callback()
    }
  }

  return {
    now: () => nowMs,
    schedule: (callback, delayMs) => {
      const handle = nextHandle++
      timers.set(handle, {
        callback,
        scheduledForMs: nowMs + delayMs,
      })
      return handle
    },
    cancel: (handle) => {
      if (typeof handle === "number") timers.delete(handle)
    },
    advanceTo: (nextNowMs) => {
      nowMs = nextNowMs
      runDueTimers()
    },
    fireNextTimerAt: (nextNowMs) => {
      const next = nextTimer()
      if (!next) return
      const [handle, timer] = next
      timers.delete(handle)
      nowMs = nextNowMs
      timer.callback()
    },
    nextTimerDelayMs: () => {
      const next = nextTimer()
      return next ? next[1].scheduledForMs - nowMs : null
    },
    pendingTimerCount: () => timers.size,
  }
}
