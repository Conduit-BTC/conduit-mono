import type { ParsedEventMarketCalendar } from "@conduit/core"
import type { EventTimelineDateParts } from "@conduit/ui"
import type { ProductCatalogSourceMode } from "./productCatalogRead"

export type EventTimelineWindow =
  "upcoming" | "7d" | "30d" | "past" | "history" | "all"

export interface EventTimelineSearch {
  source?: ProductCatalogSourceMode
  window?: EventTimelineWindow
  organizer?: string
  location?: string
}

export const MARKET_EVENT_TIMELINE_PAGE_SIZE = 12

export const EVENT_TIMELINE_WINDOWS: EventTimelineWindow[] = [
  "upcoming",
  "7d",
  "30d",
  "past",
  "history",
  "all",
]

const DAY_MS = 86_400_000

export function getNextEventTimelineLimit(
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
    normalizedVisibleCount + MARKET_EVENT_TIMELINE_PAGE_SIZE
  )
}

export function formatEventTimelineSchedule(
  calendar: ParsedEventMarketCalendar,
  locale?: string
): string {
  if (calendar.kind === 31922 && calendar.startDate) {
    const inclusiveEnd = new Date(calendar.end - DAY_MS)
      .toISOString()
      .slice(0, 10)
    return calendar.endDate && inclusiveEnd !== calendar.startDate
      ? `${calendar.startDate} to ${inclusiveEnd}`
      : calendar.startDate
  }

  const timeZone = calendar.startTzid || undefined
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    })
    const start = formatter.format(new Date(calendar.start))
    const end = formatter.format(new Date(calendar.end))
    return `${start} – ${end}${timeZone ? ` (${timeZone})` : ""}`
  } catch {
    return `${new Date(calendar.start).toLocaleString()} – ${new Date(calendar.end).toLocaleString()}`
  }
}

export function getEventTimelineDateParts(
  calendar: ParsedEventMarketCalendar,
  locale?: string
): EventTimelineDateParts {
  const dateTime =
    calendar.kind === 31922 && calendar.startDate
      ? calendar.startDate
      : new Date(calendar.start).toISOString()
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(calendar.kind === 31922
      ? { timeZone: "UTC" }
      : calendar.startTzid
        ? { timeZone: calendar.startTzid }
        : {}),
  }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat(locale, options).formatToParts(
      calendar.start
    )
  } catch {
    parts = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).formatToParts(calendar.start)
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? ""
  return {
    dateTime,
    month: part("month"),
    day: part("day"),
    year: part("year"),
  }
}
