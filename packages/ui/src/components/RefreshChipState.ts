export type RefreshChipPhase = "idle" | "refreshing" | "done"

export function resolveRefreshChipPhase(input: {
  currentPhase: RefreshChipPhase
  refreshCompleted: boolean
  refreshing: boolean
  stale: boolean
}): RefreshChipPhase {
  if (input.refreshing) return "refreshing"
  if (input.stale) return "idle"
  if (input.refreshCompleted) return "done"
  return input.currentPhase
}
