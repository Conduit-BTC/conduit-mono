import type { EventMarketRosterReadResult } from "@conduit/core"

export type MerchantEventRelationship = "organizing" | "selling"
export type MerchantEventRelationshipFilter = "all" | MerchantEventRelationship
export const MERCHANT_EVENT_RELATIONSHIP_FILTERS: MerchantEventRelationshipFilter[] =
  ["all", "organizing", "selling"]
export const MERCHANT_EVENT_TIMELINE_PAGE_SIZE = 12
export interface MerchantEventTimelineSearch {
  relation?: MerchantEventRelationshipFilter
}

/** Advances one presentation direction without revealing more than one page. */
export function getNextMerchantEventTimelineLimit(
  visibleCount: number,
  totalCount: number
): number {
  const normalizedVisibleCount = Number.isFinite(visibleCount)
    ? Math.max(0, Math.floor(visibleCount))
    : 0
  const normalizedTotalCount = Number.isFinite(totalCount)
    ? Math.max(0, Math.floor(totalCount))
    : 0
  return Math.min(
    normalizedTotalCount,
    normalizedVisibleCount + MERCHANT_EVENT_TIMELINE_PAGE_SIZE
  )
}

export interface FutureMerchantTimelineOccurrence {
  read: EventMarketRosterReadResult
  calendar: NonNullable<EventMarketRosterReadResult["calendar"]>
  coordinate: string
  series: boolean
}

/** Role filters operate on the current signed roster, including the host's own events. */
export function matchesMerchantEventRelationship(
  read: EventMarketRosterReadResult,
  merchantPubkey: string,
  relationship: MerchantEventRelationshipFilter
): boolean {
  if (read.resolution.state !== "current") return false
  const market = read.resolution.market
  return (
    relationship === "all" ||
    (relationship === "organizing"
      ? market.organizerPubkey === merchantPubkey
      : market.merchants.some((row) => row.pubkey === merchantPubkey))
  )
}

/** A known signed event with unreadable dates is different from an empty discovery. */
export function merchantEventDatesUnavailable(
  read: EventMarketRosterReadResult
): boolean {
  if (read.resolution.state !== "current") return false
  if (read.resolution.market.calendarCoordinate.startsWith("31924:"))
    return (
      read.schedule?.kind !== "series" ||
      read.schedule.unresolvedCoordinates.length > 0 ||
      read.scheduleCoverage !== "complete"
    )
  return !read.calendar && read.schedule?.kind !== "single"
}

/** Project only signed, resolved concrete dates from the current schedule. */
export function projectFutureMerchantTimelineOccurrences(
  read: EventMarketRosterReadResult
): FutureMerchantTimelineOccurrence[] {
  if (read.resolution.state !== "current") return []
  if (read.schedule?.kind === "series") {
    return read.schedule.occurrences.map(({ occurrence }) => ({
      read,
      calendar: occurrence,
      coordinate: occurrence.coordinate,
      series: true,
    }))
  }
  const calendar =
    read.schedule?.kind === "single" ? read.schedule.occurrence : read.calendar
  return calendar
    ? [{ read, calendar, coordinate: calendar.coordinate, series: false }]
    : []
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const MAX_DATE_FORMATTERS = 32

/** Reuses the signed timezone formatter while keeping imported zone growth bounded. */
export function getFutureMerchantTimelineDateParts(
  calendar: FutureMerchantTimelineOccurrence["calendar"]
) {
  const timeZone = calendar.kind === 31922 ? "UTC" : calendar.startTzid
  const formatterKey = timeZone ?? "local"
  let formatter = dateFormatters.get(formatterKey)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(timeZone ? { timeZone } : {}),
    })
    if (dateFormatters.size >= MAX_DATE_FORMATTERS) {
      const oldestKey = dateFormatters.keys().next().value
      if (oldestKey !== undefined) dateFormatters.delete(oldestKey)
    }
    dateFormatters.set(formatterKey, formatter)
  }
  const parts = formatter.formatToParts(calendar.start)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? ""
  return {
    dateTime:
      calendar.kind === 31922 && calendar.startDate
        ? calendar.startDate
        : new Date(calendar.start).toISOString(),
    day: part("day"),
    month: part("month"),
    year: part("year"),
  }
}
