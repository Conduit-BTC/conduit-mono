import {
  decodeEventMarketReference,
  type EventMarketResolutionState,
} from "@conduit/core"
import type { EventMarketCardStatusTone } from "@conduit/ui"
import type { MerchantOrganizerEventMarket } from "./event-market"
import {
  findSavedOrganizerEventMarketReference,
  selectOrganizerEventMarketResolution,
  type SavedOrganizerEventMarketReference,
} from "./event-market-workflow"

export type MerchantEventRelationship = "organizing" | "selling" | "saved"
export type MerchantEventRelationshipFilter = "all" | MerchantEventRelationship
export type MerchantEventTimelineWindow =
  "upcoming" | "7d" | "30d" | "past" | "all"

export const MERCHANT_EVENT_RELATIONSHIP_FILTERS: MerchantEventRelationshipFilter[] =
  ["all", "organizing", "selling", "saved"]

export const MERCHANT_EVENT_TIMELINE_WINDOWS: MerchantEventTimelineWindow[] = [
  "upcoming",
  "7d",
  "30d",
  "past",
  "all",
]

export interface MerchantEventTimelineItem {
  market: MerchantOrganizerEventMarket
  relationships: MerchantEventRelationship[]
  /** A card may remain visible while exact relay frontiers are reconciled. */
  reconciliationPending: boolean
}

export interface MerchantEventTimelineSearch {
  relation?: MerchantEventRelationshipFilter
  window?: MerchantEventTimelineWindow
}

export interface MerchantEventTimelineStatus {
  label: string
  tone: EventMarketCardStatusTone
}

function coordinateFromReference(reference: string): string | null {
  return decodeEventMarketReference(reference, [30405])?.coordinate ?? null
}

function referenceMap(
  references: readonly SavedOrganizerEventMarketReference[]
): Map<string, SavedOrganizerEventMarketReference> {
  return new Map(
    references.flatMap((reference) => {
      const coordinate = coordinateFromReference(reference.reference)
      return coordinate ? [[coordinate, reference] as const] : []
    })
  )
}

function positiveResolution(
  value:
    | MerchantOrganizerEventMarket
    | ReturnType<typeof selectOrganizerEventMarketResolution>
): value is MerchantOrganizerEventMarket {
  return !!value && !("terminal" in value)
}

/**
 * Builds one event registry from public perspective discovery plus exact local
 * relationships. Relationship coordinates are presentation inputs only; every
 * visible card still requires a valid, signed event-market resolution.
 */
export function mergeMerchantEventTimeline(input: {
  merchantPubkey: string
  perspectiveMarkets: readonly MerchantOrganizerEventMarket[]
  ownedMarkets: readonly MerchantOrganizerEventMarket[]
  exactRelationshipMarkets: readonly MerchantOrganizerEventMarket[]
  savedReferences: readonly SavedOrganizerEventMarketReference[]
  sellingCollectionCoordinates: readonly string[]
}): MerchantEventTimelineItem[] {
  const normalizedMerchant = input.merchantPubkey.trim().toLowerCase()
  const savedByCoordinate = referenceMap(input.savedReferences)
  const sellingCoordinates = new Set(
    input.sellingCollectionCoordinates.map((value) => value.trim())
  )
  const byCoordinate = new Map<string, MerchantEventTimelineItem>()

  const include = (
    market: MerchantOrganizerEventMarket,
    candidateKind: "perspective" | "owned" | "exact"
  ) => {
    const coordinate = market.collectionCoordinate
    const current = byCoordinate.get(coordinate)
    const savedReference =
      savedByCoordinate.get(coordinate) ??
      findSavedOrganizerEventMarketReference(
        input.savedReferences,
        market.naddr
      )
    const selected = current
      ? candidateKind === "exact"
        ? selectOrganizerEventMarketResolution(
            current.market,
            market,
            savedReference
          )
        : selectOrganizerEventMarketResolution(
            market,
            current.market,
            savedReference
          )
      : market
    const reconciliationPending =
      current?.reconciliationPending === true ||
      (!!selected && "terminal" in selected && selected.state === "pending")
    const selectedMarket = positiveResolution(selected)
      ? selected
      : (current?.market ?? market)
    const relationshipSet = new Set<MerchantEventRelationship>(
      current?.relationships ?? []
    )
    if (
      candidateKind === "owned" ||
      selectedMarket.organizerPubkey === normalizedMerchant
    ) {
      relationshipSet.add("organizing")
    }
    if (sellingCoordinates.has(coordinate)) relationshipSet.add("selling")
    if (savedByCoordinate.has(coordinate)) relationshipSet.add("saved")

    byCoordinate.set(coordinate, {
      market: selectedMarket,
      relationships: Array.from(relationshipSet).sort(),
      reconciliationPending,
    })
  }

  for (const market of input.perspectiveMarkets) include(market, "perspective")
  for (const market of input.ownedMarkets) include(market, "owned")
  for (const market of input.exactRelationshipMarkets) include(market, "exact")

  return Array.from(byCoordinate.values())
}

function dateOnlyMs(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed : null
}

export function merchantEventTimelineBounds(
  market: MerchantOrganizerEventMarket
): { startMs: number; endMs: number } | null {
  if (market.calendarKind === 31922) {
    if (typeof market.start !== "string") return null
    const startMs = dateOnlyMs(market.start)
    const endMs =
      typeof market.end === "string" ? dateOnlyMs(market.end) : startMs
    return startMs === null || endMs === null ? null : { startMs, endMs }
  }
  if (typeof market.start !== "number" || !Number.isFinite(market.start)) {
    return null
  }
  const startMs = market.start * 1_000
  const endMs =
    typeof market.end === "number" && Number.isFinite(market.end)
      ? market.end * 1_000
      : startMs
  return { startMs, endMs }
}

function isPast(item: MerchantEventTimelineItem, nowMs: number): boolean {
  const bounds = merchantEventTimelineBounds(item.market)
  return item.market.state === "ended" || (!!bounds && bounds.endMs < nowMs)
}

function matchesWindow(
  item: MerchantEventTimelineItem,
  window: MerchantEventTimelineWindow,
  nowMs: number
): boolean {
  const bounds = merchantEventTimelineBounds(item.market)
  if (!bounds) return window === "all"
  const past = isPast(item, nowMs)
  if (window === "past") return past
  if (window === "all") return true
  if (past) return false
  if (window === "upcoming") return true
  const horizon = nowMs + (window === "7d" ? 7 : 30) * 86_400_000
  return bounds.startMs <= horizon
}

export function filterAndSortMerchantEventTimeline(
  items: readonly MerchantEventTimelineItem[],
  search: MerchantEventTimelineSearch,
  nowMs = Date.now()
): MerchantEventTimelineItem[] {
  const relationship = search.relation ?? "all"
  const window = search.window ?? "upcoming"
  return items
    .filter(
      (item) =>
        relationship === "all" || item.relationships.includes(relationship)
    )
    .filter((item) => matchesWindow(item, window, nowMs))
    .sort((left, right) => {
      const leftPast = isPast(left, nowMs)
      const rightPast = isPast(right, nowMs)
      if (leftPast !== rightPast) return leftPast ? 1 : -1
      const leftStart = merchantEventTimelineBounds(left.market)?.startMs ?? 0
      const rightStart = merchantEventTimelineBounds(right.market)?.startMs ?? 0
      const delta = leftStart - rightStart
      if (delta !== 0) return leftPast ? -delta : delta
      return left.market.collectionCoordinate.localeCompare(
        right.market.collectionCoordinate
      )
    })
}

export function getMerchantEventTimelineStatus(
  item: MerchantEventTimelineItem,
  nowMs = Date.now()
): MerchantEventTimelineStatus {
  if (isPast(item, nowMs)) return { label: "Past event", tone: "secondary" }
  if (item.reconciliationPending) {
    return { label: "Refreshing evidence", tone: "warning" }
  }
  const labels: Partial<
    Record<EventMarketResolutionState, MerchantEventTimelineStatus>
  > = {
    active: { label: "Active event", tone: "success" },
    partial: { label: "Partial relay view", tone: "warning" },
    stale: { label: "Refresh needed", tone: "warning" },
  }
  return labels[item.market.state] ?? { label: "Event", tone: "outline" }
}

export function formatMerchantEventTimelineSchedule(
  market: MerchantOrganizerEventMarket,
  locale?: string
): string {
  if (market.calendarKind === 31922) {
    if (typeof market.start !== "string") return "Schedule unavailable"
    const start = dateOnlyMs(market.start)
    const end = typeof market.end === "string" ? dateOnlyMs(market.end) : null
    if (start === null) return "Schedule unavailable"
    const formatter = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    })
    const startLabel = formatter.format(start)
    return end && end !== start
      ? `${startLabel} – ${formatter.format(end)}`
      : startLabel
  }

  const bounds = merchantEventTimelineBounds(market)
  if (!bounds) return "Schedule unavailable"
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(market.timezone ? { timeZone: market.timezone } : {}),
  }
  try {
    const formatter = new Intl.DateTimeFormat(locale, options)
    const startLabel = formatter.format(bounds.startMs)
    return bounds.endMs !== bounds.startMs
      ? `${startLabel} – ${formatter.format(bounds.endMs)}`
      : startLabel
  } catch {
    const formatter = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC",
    })
    const startLabel = formatter.format(bounds.startMs)
    return bounds.endMs !== bounds.startMs
      ? `${startLabel} – ${formatter.format(bounds.endMs)}`
      : startLabel
  }
}
