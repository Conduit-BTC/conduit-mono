export function getSavedDateRecoveryAction(input: {
  savedEventId: string | null
  observedEventId: string | null
  coverage: "complete" | "partial" | "stale" | "unavailable"
  canEdit: boolean
}): "already_live" | "retry_saved" | "continue" | "blocked" {
  if (input.savedEventId && input.observedEventId === input.savedEventId)
    return input.coverage === "complete" ? "already_live" : "retry_saved"
  return input.canEdit ? "continue" : "blocked"
}
