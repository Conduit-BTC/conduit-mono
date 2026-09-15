import { useEffect, useMemo, useState } from "react"

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface TimeBoundarySubscriptionOptions {
  boundaries: readonly number[]
  currentNowMs: number
  onBoundary: (nowMs: number) => void
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
}

function normalizedTimeBoundaries(boundaries: readonly number[]): number[] {
  return Array.from(
    new Set(boundaries.filter((boundary) => Number.isFinite(boundary)))
  ).sort((left, right) => left - right)
}

/**
 * Advances a mounted view exactly when wall time crosses one of its known
 * boundaries. Long waits are re-armed below the browser timeout ceiling; this
 * is boundary-driven rather than interval polling.
 */
export function subscribeToTimeBoundaries({
  boundaries,
  currentNowMs,
  onBoundary,
  now = Date.now,
  schedule = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel = (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}: TimeBoundarySubscriptionOptions): () => void {
  const orderedBoundaries = normalizedTimeBoundaries(boundaries)
  let lastRenderedNowMs = currentNowMs
  let active = true
  let timer: unknown

  const arm = (): void => {
    if (!active) return
    const observedNowMs = now()
    const crossedBoundary = orderedBoundaries.some(
      (boundary) => boundary > lastRenderedNowMs && boundary <= observedNowMs
    )

    if (crossedBoundary) {
      lastRenderedNowMs = observedNowMs
      onBoundary(observedNowMs)
    } else if (observedNowMs < lastRenderedNowMs) {
      // A wall-clock correction must not strand future boundaries behind the
      // prior observation or leave the mounted view rendering a future time.
      lastRenderedNowMs = observedNowMs
      onBoundary(observedNowMs)
    }

    const nextBoundary = orderedBoundaries.find(
      (boundary) => boundary > observedNowMs
    )
    if (nextBoundary === undefined) return

    timer = schedule(
      () => {
        timer = undefined
        arm()
      },
      Math.min(MAX_TIMER_DELAY_MS, nextBoundary - observedNowMs)
    )
  }

  arm()

  return () => {
    active = false
    if (timer !== undefined) cancel(timer)
  }
}

/** Returns a stable wall-clock snapshot that advances at known UI boundaries. */
export function useTimeBoundaryNow(boundaries: readonly number[]): number {
  const stableBoundaries = useMemo(
    () => normalizedTimeBoundaries(boundaries),
    [boundaries]
  )
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(
    () =>
      subscribeToTimeBoundaries({
        boundaries: stableBoundaries,
        currentNowMs: nowMs,
        onBoundary: setNowMs,
      }),
    [nowMs, stableBoundaries]
  )

  return nowMs
}
