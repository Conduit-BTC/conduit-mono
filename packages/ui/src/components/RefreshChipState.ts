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

export function getRefreshChipDoneTimerDelay(input: {
  phase: RefreshChipPhase
  refreshing: boolean
  doneDurationMs: number
}): number | null {
  return input.phase === "done" && !input.refreshing
    ? input.doneDurationMs
    : null
}
