import type { SignedPublicNostrEvent } from "@conduit/core"

/** Keep only retained signatures that exactly match the prepared date mutation. */
export function getMatchingSavedSeriesDateEvents(input: {
  signedEvents: readonly SignedPublicNostrEvent[]
  scheduleCoordinate: string
  expectedSchedule: { tags: string[][]; content: string }
  expectedOccurrences: readonly {
    coordinate: string
    draft: { tags: string[][]; content: string }
  }[]
  expectedPreviousCreatedAt: number
}): SignedPublicNostrEvent[] {
  return input.signedEvents.filter((event) => {
    const coordinate = `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
    if (
      coordinate === input.scheduleCoordinate &&
      event.created_at <= Math.floor(input.expectedPreviousCreatedAt / 1_000)
    )
      return false
    const expected =
      coordinate === input.scheduleCoordinate
        ? input.expectedSchedule
        : input.expectedOccurrences.find(
            (item) => item.coordinate === coordinate
          )?.draft
    return (
      !!expected &&
      JSON.stringify(event.tags) === JSON.stringify(expected.tags) &&
      event.content === expected.content
    )
  })
}

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
