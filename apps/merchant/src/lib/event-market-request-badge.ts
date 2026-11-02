import {
  parseEventMarketEnrollmentMessage,
  reduceEventMarketEnrollment,
} from "@conduit/core/protocol/event-market-enrollment"
import type { ParsedDirectMessage } from "@conduit/core/protocol/messaging"

export type ObservedEventRequests = ReadonlyMap<string, readonly string[]>
export type ObservedEventRoster =
  { state: "current"; merchants: readonly string[] } | { state: "unresolved" }
export interface EventRequestBadgeState {
  pending: number
  unresolved: number
}

/** Advisory messages from the existing authenticated inbox, not admission authority. */
export function getObservedEventRequests(
  organizer: string | null,
  messages: readonly ParsedDirectMessage[]
): ObservedEventRequests {
  if (!organizer) return new Map()
  const byMarket = new Map<
    string,
    NonNullable<ReturnType<typeof parseEventMarketEnrollmentMessage>>[]
  >()
  for (const message of messages) {
    const parsed = parseEventMarketEnrollmentMessage(message)
    if (!parsed || parsed.organizerPubkey !== organizer) continue
    const rows = byMarket.get(parsed.marketCoordinate) ?? []
    rows.push(parsed)
    byMarket.set(parsed.marketCoordinate, rows)
  }
  const requests = new Map<string, string[]>()
  for (const [marketCoordinate, rows] of byMarket) {
    const pending = reduceEventMarketEnrollment({
      marketCoordinate,
      messages: rows,
    })
      .filter((row) => row.status === "requested")
      .map((row) => row.merchantPubkey)
    if (pending.length) requests.set(marketCoordinate, pending)
  }
  return requests
}

/** A missing/conflicted/failed local roster observation is not a confirmed zero. */
export function projectEventRequestBadge(
  requests: ObservedEventRequests,
  rosters: ReadonlyMap<string, ObservedEventRoster>
): EventRequestBadgeState {
  let pending = 0
  let unresolved = 0
  for (const [coordinate, merchants] of requests) {
    const roster = rosters.get(coordinate)
    if (roster?.state !== "current") {
      unresolved += merchants.length
      continue
    }
    const admitted = new Set(roster.merchants)
    pending += merchants.filter((merchant) => !admitted.has(merchant)).length
  }
  return { pending, unresolved }
}

export function getEventRequestBadgeDescription({
  pending,
  unresolved,
}: EventRequestBadgeState): string | null {
  if (!pending && !unresolved) return null
  const count = pending
    ? `${pending} observed pending merchant ${pending === 1 ? "request" : "requests"}.`
    : "Observed merchant requests need an event-status check."
  return `${count}${unresolved ? " Some event statuses are unavailable." : ""} Open Events to review current requests.`
}
