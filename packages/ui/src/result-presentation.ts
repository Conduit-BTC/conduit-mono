export type ResultReliability = "complete" | "degraded"

export type ResultPresentationKind =
  "results" | "filter_empty" | "complete_empty" | "degraded_empty"

export type ResultPresentation = {
  kind: ResultPresentationKind
  visibility: "silent" | "compact"
}

/**
 * Project retained network evidence through the consequence for the current
 * result surface. The evidence remains typed at the caller; this helper only
 * decides whether the result is trustworthy enough to stay quiet.
 */
export function getResultPresentation(input: {
  resultCount: number
  visibleResultCount?: number
  reliability: ResultReliability
  /** Set when an incomplete result set changes the user's task, such as an
   * inventory or inbox that is expected to be complete. */
  degradedResultsAreMaterial?: boolean
}): ResultPresentation {
  const resultCount = Math.max(0, input.resultCount)
  const visibleResultCount = Math.max(
    0,
    input.visibleResultCount ?? resultCount
  )
  const degraded = input.reliability === "degraded"

  if (visibleResultCount > 0) {
    return {
      kind: "results",
      visibility:
        degraded && input.degradedResultsAreMaterial ? "compact" : "silent",
    }
  }

  if (resultCount > 0) {
    return {
      kind: "filter_empty",
      // A filter explains why retained rows are hidden, but a degraded read
      // cannot establish that unseen rows would not match. Keep the filter
      // context and expose one compact recovery path.
      visibility: degraded ? "compact" : "silent",
    }
  }

  if (degraded) {
    return { kind: "degraded_empty", visibility: "compact" }
  }

  return { kind: "complete_empty", visibility: "silent" }
}
