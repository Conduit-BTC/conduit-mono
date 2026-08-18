export type ProtectedReadPresentationState =
  "pending" | "complete" | "cached" | "partial" | "unavailable"

export interface ProtectedReadPresentationInput {
  visibleCount: number
  pending?: boolean
  error?: unknown
  meta?: {
    source?: "commerce" | "public" | "local_cache"
    stale?: boolean
    degraded?: boolean
    inbox?: {
      coverage?: "complete" | "partial" | "unavailable"
    }
  }
}

/**
 * Keep the rows from a completed live read paired with that read's metadata.
 * Protected live APIs already merge their cache before returning, so the
 * route-local cache is only a fallback while the live result is still absent.
 */
export function selectProtectedReadRows<T>(
  liveRows: T[] | undefined,
  cachedRows: T[] | undefined
): T[] {
  return liveRows ?? cachedRows ?? []
}

/**
 * Convert distributed inbox coverage into the four states UI surfaces need.
 * In particular, a non-throwing all-relay auth outage is unavailable, never an
 * authoritative empty or merely partial result.
 */
export function deriveProtectedReadPresentationState(
  input: ProtectedReadPresentationInput
): ProtectedReadPresentationState {
  const coverage = input.meta?.inbox?.coverage
  if (input.pending && !input.meta && !input.error) {
    return input.visibleCount > 0 ? "cached" : "pending"
  }
  if (input.visibleCount > 0) {
    if (
      input.error ||
      coverage === "unavailable" ||
      input.meta?.source === "local_cache" ||
      input.meta?.stale
    ) {
      return "cached"
    }
    if (coverage === "partial" || input.meta?.degraded) return "partial"
    return "complete"
  }

  if (input.error || coverage === "unavailable") return "unavailable"
  if (
    coverage === "partial" ||
    input.meta?.stale ||
    input.meta?.degraded ||
    input.meta?.source === "local_cache"
  ) {
    return "partial"
  }
  return "complete"
}
