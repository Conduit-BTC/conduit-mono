import type {
  EventMarketPerspectiveSnapshot,
  EventMarketResolution,
  ParsedEventMarketCalendar,
  ParsedEventMarketCollection,
} from "@conduit/core"
import type { EventMarketCardStatusTone } from "@conduit/ui"
import type { ProductCatalogSourceMode } from "./productCatalogRead"

export type EventTimelineWindow = "upcoming" | "7d" | "30d" | "past" | "all"

export interface EventTimelineSearch {
  source?: ProductCatalogSourceMode
  window?: EventTimelineWindow
  organizer?: string
  location?: string
  topic?: string
}

export type TimelineEventMarket = EventMarketResolution & {
  organizerPubkey: string
  collection: ParsedEventMarketCollection
  calendar: ParsedEventMarketCalendar
}

export interface EventTimelineFacets {
  organizers: string[]
  locations: string[]
  topics: string[]
}

export interface EventTimelineStatus {
  label: string
  tone: EventMarketCardStatusTone
}

export const EVENT_TIMELINE_WINDOWS: EventTimelineWindow[] = [
  "upcoming",
  "7d",
  "30d",
  "past",
  "all",
]

export function getEventTimelinePresentationPerspective(
  perspective: EventMarketPerspectiveSnapshot,
  isRefreshStale: boolean
): EventMarketPerspectiveSnapshot {
  if (!isRefreshStale || perspective.coverage !== "complete") {
    return perspective
  }

  return { ...perspective, coverage: "limited" }
}

const DAY_MS = 86_400_000

function eventTimelineWindowDurationMs(
  window: EventTimelineWindow | undefined
): number | null {
  if (window === "7d") return 7 * DAY_MS
  if (window === "30d") return 30 * DAY_MS
  return null
}

export function isTimelineEventMarket(
  market: EventMarketResolution
): market is TimelineEventMarket {
  return (
    !!market.organizerPubkey &&
    !!market.collection &&
    !!market.calendar &&
    (market.state === "active" ||
      market.state === "partial" ||
      market.state === "stale" ||
      market.state === "ended")
  )
}

function normalized(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? ""
}

function isPast(market: TimelineEventMarket, nowMs: number): boolean {
  return market.state === "ended" || market.calendar.end <= nowMs
}

function matchesWindow(
  market: TimelineEventMarket,
  window: EventTimelineWindow,
  nowMs: number
): boolean {
  const past = isPast(market, nowMs)
  if (window === "past") return past
  if (window === "all") return true
  if (past) return false
  if (window === "upcoming") return true
  const horizon = nowMs + (window === "7d" ? 7 : 30) * 86_400_000
  return market.calendar.start <= horizon
}

function compareTimelineMarkets(
  left: TimelineEventMarket,
  right: TimelineEventMarket,
  nowMs: number
): number {
  const leftPast = isPast(left, nowMs)
  const rightPast = isPast(right, nowMs)
  if (leftPast !== rightPast) return leftPast ? 1 : -1
  const startDelta = left.calendar.start - right.calendar.start
  if (startDelta !== 0) return leftPast ? -startDelta : startDelta
  return left.reference.localeCompare(right.reference)
}

export function filterAndSortEventMarkets(
  markets: readonly EventMarketResolution[],
  search: EventTimelineSearch,
  nowMs = Date.now()
): TimelineEventMarket[] {
  const window = search.window ?? "upcoming"
  const organizer = normalized(search.organizer)
  const location = normalized(search.location)
  const topic = normalized(search.topic)

  return markets
    .filter(isTimelineEventMarket)
    .filter((market) => matchesWindow(market, window, nowMs))
    .filter(
      (market) => !organizer || normalized(market.organizerPubkey) === organizer
    )
    .filter(
      (market) =>
        !location ||
        [...market.calendar.locations, market.calendar.geohash ?? ""].some(
          (value) => normalized(value) === location
        )
    )
    .filter(
      (market) =>
        !topic ||
        (market.calendar.topics ?? []).some(
          (value) => normalized(value) === topic
        )
    )
    .sort((left, right) => compareTimelineMarkets(left, right, nowMs))
}

/** Wall-clock boundaries that can change the selected timeline projection. */
export function getEventTimelineBoundaries(
  markets: readonly EventMarketResolution[],
  window: EventTimelineWindow | undefined
): number[] {
  const windowDurationMs = eventTimelineWindowDurationMs(window)
  return markets
    .filter(isTimelineEventMarket)
    .flatMap((market) => [
      ...(windowDurationMs === null
        ? []
        : [market.calendar.start - windowDurationMs]),
      market.calendar.start,
      market.calendar.end,
    ])
}

export function getEventTimelineFacets(
  markets: readonly EventMarketResolution[]
): EventTimelineFacets {
  const organizers = new Set<string>()
  const locations = new Set<string>()
  const topics = new Set<string>()
  for (const market of markets.filter(isTimelineEventMarket)) {
    organizers.add(market.organizerPubkey)
    for (const location of market.calendar.locations) {
      if (location.trim()) locations.add(location.trim())
    }
    if (market.calendar.geohash?.trim()) {
      locations.add(market.calendar.geohash.trim())
    }
    for (const topic of market.calendar.topics ?? []) {
      if (topic.trim()) topics.add(topic.trim())
    }
  }
  const byLabel = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  return {
    organizers: Array.from(organizers).sort(),
    locations: Array.from(locations).sort(byLabel),
    topics: Array.from(topics).sort(byLabel),
  }
}

export function getEventTimelineStatus(
  market: TimelineEventMarket,
  nowMs = Date.now()
): EventTimelineStatus {
  if (isPast(market, nowMs)) return { label: "Past event", tone: "secondary" }
  if (market.state === "partial" || market.state === "stale") {
    return { label: "Partial relay view", tone: "warning" }
  }
  if (market.calendar.start <= nowMs) {
    return { label: "Happening now", tone: "success" }
  }
  return { label: "Upcoming", tone: "success" }
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
