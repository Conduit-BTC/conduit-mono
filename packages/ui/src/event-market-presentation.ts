export type EventRelayReadCoverage = {
  attemptedRelayCount: number
  completeRelayCount: number
  partialRelayCount?: number
  failedRelayCount?: number
}

export function formatEventRelayReadCoverage(
  coverage: EventRelayReadCoverage | undefined
): string | null {
  if (!coverage || coverage.attemptedRelayCount <= 0) return null
  const planned = coverage.attemptedRelayCount
  const completed = Math.min(planned, Math.max(0, coverage.completeRelayCount))
  const incomplete = planned - completed
  if (incomplete === 0) {
    return `${completed} of ${planned} planned relay reads completed.`
  }
  return `${completed} of ${planned} planned relay reads completed; ${incomplete} ${incomplete === 1 ? "was" : "were"} incomplete.`
}
