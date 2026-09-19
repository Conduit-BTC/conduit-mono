export type RefreshChipPhase = "idle" | "refreshing" | "done"

export function resolveRefreshChipPhase(input: {
  phase: RefreshChipPhase
  refreshing: boolean
  stale: boolean
}): RefreshChipPhase {
  if (input.refreshing || input.phase === "refreshing") return "refreshing"
  if (input.stale) return "idle"
  return input.phase
}
