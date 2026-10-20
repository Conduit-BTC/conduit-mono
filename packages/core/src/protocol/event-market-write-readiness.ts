import type { EventMarketAuthorizationReadResult } from "./event-market-authorization-read"
import type { EventMarketRosterReadResult } from "./event-market-roster-read"

/** Per-scope observations, distinct from whether every planned peer answered. */
export interface EventMarketWriteObservation {
  selectedLive: boolean
  limited: boolean
  scopesChecked: boolean
}

export function observeEventMarketWriteScope(input: {
  selectedLive: boolean
  limited: boolean
  reads: readonly { relays: readonly { status: string }[] }[]
}): EventMarketWriteObservation {
  return {
    selectedLive: input.selectedLive,
    limited: input.limited,
    scopesChecked:
      input.reads.length > 0 &&
      input.reads.every((read) =>
        read.relays.some((relay) => relay.status === "success")
      ),
  }
}

function hasWriteEvidence(input: {
  coverage: string | undefined
  retained: boolean
  observation?: EventMarketWriteObservation
}): boolean {
  if (!input.retained) return false
  if (input.coverage === "complete" && !input.observation) return true
  return (
    (input.coverage === "complete" || input.coverage === "partial") &&
    input.observation?.selectedLive === true &&
    input.observation.limited === false &&
    input.observation.scopesChecked === true
  )
}

/** Current signed authority can survive an optional peer failure, never a missing scope. */
export function isEventMarketRosterWriteReady(
  read: EventMarketRosterReadResult | null | undefined
): boolean {
  return (
    read?.resolution.state === "current" &&
    hasWriteEvidence({
      coverage: read.coverage,
      retained: read.retained,
      observation: read.writeObservation,
    })
  )
}

export function isEventMarketCalendarWriteReady(
  read: EventMarketRosterReadResult | null | undefined
): boolean {
  return (
    !!read &&
    hasWriteEvidence({
      coverage: read.calendarCoverage,
      retained: read.retained,
      observation: read.calendarWriteObservation,
    })
  )
}

export function isEventMarketAuthorizationWriteReady(
  read: EventMarketAuthorizationReadResult | null | undefined
): boolean {
  if (!read) return false
  // Keep first-grant absence and explicit repair on the existing complete-read lane.
  if (!["active", "revoked"].includes(read.resolution.state))
    return read.retained && read.coverage === "complete"
  return hasWriteEvidence({
    coverage: read.coverage,
    retained: read.retained,
    observation: read.writeObservation,
  })
}
