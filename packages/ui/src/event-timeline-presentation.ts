/** Chronological pages around now, using concrete signed occurrence bounds. */
export function paginateEventTimeline<
  T extends { key: string; start: number; end: number },
>(
  rows: readonly T[],
  limits: { earlier: number; later: number },
  nowMs: number
): {
  past: T[]
  currentAndFuture: T[]
  hiddenEarlierCount: number
  hiddenLaterCount: number
} {
  const byStart = (left: T, right: T) =>
    left.start - right.start || left.key.localeCompare(right.key)
  const past = rows.filter((row) => row.end <= nowMs).sort(byStart)
  const future = rows.filter((row) => row.end > nowMs).sort(byStart)
  const bounded = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 12
  const earlier = bounded(limits.earlier)
  const later = bounded(limits.later)
  return {
    past: earlier > 0 ? past.slice(-earlier) : [],
    currentAndFuture: future.slice(0, later),
    hiddenEarlierCount: Math.max(0, past.length - earlier),
    hiddenLaterCount: Math.max(0, future.length - later),
  }
}
