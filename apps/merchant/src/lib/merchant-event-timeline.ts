import {
  decodeEventMarketReference,
  type EventMarketResolutionState,
  type EventMarketResolution,
  type PerspectiveEventMarketDiscoveryResult,
} from "@conduit/core"
import type { EventMarketCardStatusTone } from "@conduit/ui"
import {
  projectOrganizerEventMarketDeletion,
  type MerchantOrganizerEventMarket,
} from "./event-market"
import {
  findSavedOrganizerEventMarketReference,
  reconcileOrganizerEventMarketInvalidation,
  selectOrganizerEventMarketResolution,
  type OrganizerEventMarketCandidate,
  type OrganizerEventMarketInvalidationReadScope,
  type SavedOrganizerEventMarketReference,
} from "./event-market-workflow"

export type MerchantEventRelationship = "organizing" | "selling"
export type MerchantEventRelationshipFilter = "all" | MerchantEventRelationship

export const MERCHANT_EVENT_RELATIONSHIP_FILTERS: MerchantEventRelationshipFilter[] =
  ["all", "organizing", "selling"]

const DAY_MS = 86_400_000
export const MERCHANT_EVENT_TIMELINE_PAGE_SIZE = 12

export interface MerchantEventTimelineItem {
  market: MerchantOrganizerEventMarket
  relationships: MerchantEventRelationship[]
  /** A card may remain visible while exact relay frontiers are reconciled. */
  reconciliationPending: boolean
}

export interface MerchantEventTimelineSearch {
  relation?: MerchantEventRelationshipFilter
}

export interface MerchantEventTimelinePresentation {
  /** Past events are chronological, with the event nearest now last. */
  past: MerchantEventTimelineItem[]
  /** Ongoing and future events are chronological, with the nearest event first. */
  currentAndFuture: MerchantEventTimelineItem[]
  hiddenEarlierCount: number
  hiddenLaterCount: number
}

export interface MerchantEventTimelineStatus {
  label: string
  tone: EventMarketCardStatusTone
}

export interface MerchantEventTimelineDateParts {
  dateTime: string
  day: string
  month: string
  year: string
}

export function isMerchantEventTimelineInitialLoading(input: {
  authorResolutionPending: boolean
  itemCount: number
  perspectiveReadPending: boolean
  ownedReadPending: boolean
  productRelationshipReadPending: boolean
  exactRelationshipReadPending: boolean
}): boolean {
  return (
    input.authorResolutionPending ||
    (input.itemCount === 0 &&
      (input.perspectiveReadPending ||
        input.ownedReadPending ||
        input.productRelationshipReadPending ||
        input.exactRelationshipReadPending))
  )
}

export function qualifyMerchantEventTimelineNetwork(
  network: PerspectiveEventMarketDiscoveryResult | undefined,
  perspectiveRefreshStale: boolean
): PerspectiveEventMarketDiscoveryResult | undefined {
  if (
    !network ||
    !perspectiveRefreshStale ||
    network.perspective.coverage !== "complete"
  ) {
    return network
  }

  return {
    ...network,
    perspective: { ...network.perspective, coverage: "limited" },
  }
}

export type MerchantEventTimelineReadScope = "perspective" | "owned" | "exact"

export interface MerchantEventTimelineResolutionObservation {
  readScope: MerchantEventTimelineReadScope
  resolution: EventMarketResolution
}

const INVALIDATING_EVENT_MARKET_STATES = new Set<EventMarketResolutionState>([
  "malformed",
  "conflicting",
  "unsupported",
])

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

function resolutionFrontier(
  resolution: EventMarketResolution,
  naddr: string
): OrganizerEventMarketCandidate | null {
  const collectionCoordinate = resolution.collectionCoordinate
  if (!collectionCoordinate) return null
  return {
    state: resolution.state,
    collectionCoordinate,
    ...(resolution.calendarCoordinate
      ? { calendarCoordinate: resolution.calendarCoordinate }
      : {}),
    ...(resolution.pickupCoordinate
      ? { pickupCoordinate: resolution.pickupCoordinate }
      : {}),
    ...(resolution.collection
      ? {
          collectionCreatedAt: resolution.collection.createdAt,
          collectionEventId: resolution.collection.eventId,
        }
      : {}),
    ...(resolution.calendar
      ? {
          calendarCreatedAt: resolution.calendar.createdAt,
          calendarEventId: resolution.calendar.eventId,
        }
      : {}),
    ...(resolution.pickup
      ? {
          pickupCreatedAt: resolution.pickup.createdAt,
          pickupEventId: resolution.pickup.eventId,
        }
      : {}),
    naddr,
  }
}

function relayCoverageTier(
  resolution: EventMarketResolution
): "complete" | "partial" | "unavailable" {
  const coverage = resolution.coverage
  if (
    coverage.attemptedRelayCount > 0 &&
    coverage.completeRelayCount === coverage.attemptedRelayCount &&
    coverage.partialRelayCount === 0 &&
    coverage.failedRelayCount === 0
  ) {
    return "complete"
  }
  return coverage.completeRelayCount > 0 || coverage.partialRelayCount > 0
    ? "partial"
    : "unavailable"
}

function compareEqualFrontierReadScope(
  positiveScope: MerchantEventTimelineReadScope,
  positive: EventMarketResolution,
  invalidScope: MerchantEventTimelineReadScope,
  invalid: EventMarketResolution
): OrganizerEventMarketInvalidationReadScope {
  // Different queries can have disjoint relay plans. Their equal signed
  // frontiers do not make either bounded observation globally authoritative.
  if (positiveScope !== invalidScope) return "incomparable"
  const ranks = { unavailable: 0, partial: 1, complete: 2 } as const
  const positiveTier = relayCoverageTier(positive)
  const invalidTier = relayCoverageTier(invalid)
  if (ranks[invalidTier] > ranks[positiveTier]) return "invalid_dominates"
  if (ranks[invalidTier] < ranks[positiveTier]) return "positive_dominates"
  const positiveCoverage = positive.coverage
  const invalidCoverage = invalid.coverage
  return positiveCoverage.attemptedRelayCount ===
    invalidCoverage.attemptedRelayCount &&
    positiveCoverage.completeRelayCount ===
      invalidCoverage.completeRelayCount &&
    positiveCoverage.partialRelayCount === invalidCoverage.partialRelayCount &&
    positiveCoverage.failedRelayCount === invalidCoverage.failedRelayCount
    ? "invalid_dominates"
    : "incomparable"
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
  resolutionObservations?: readonly MerchantEventTimelineResolutionObservation[]
}): MerchantEventTimelineItem[] {
  const normalizedMerchant = input.merchantPubkey.trim().toLowerCase()
  const savedByCoordinate = referenceMap(input.savedReferences)
  const sellingCoordinates = new Set(
    input.sellingCollectionCoordinates.map((value) => value.trim())
  )
  const byCoordinate = new Map<string, MerchantEventTimelineItem>()
  const resolutionObservations = input.resolutionObservations ?? []

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
    const organizing =
      candidateKind === "owned" || market.organizerPubkey === normalizedMerchant
    const selling = sellingCoordinates.has(coordinate)
    if (
      candidateKind === "exact" &&
      !current &&
      savedReference &&
      !organizing &&
      !selling
    ) {
      return
    }
    let invalidationPending = false
    for (const observation of resolutionObservations) {
      const resolution = observation.resolution
      if (
        INVALIDATING_EVENT_MARKET_STATES.has(resolution.state) &&
        resolution.collectionCoordinate === coordinate
      ) {
        const invalid = resolutionFrontier(resolution, market.naddr)
        if (!invalid) continue
        const decision = reconcileOrganizerEventMarketInvalidation(
          market,
          invalid,
          compareEqualFrontierReadScope(
            candidateKind,
            market.source,
            observation.readScope,
            resolution
          )
        )
        if (decision === "retire") return
        if (decision === "pending") invalidationPending = true
      }
      if (
        resolution.state !== "deleted" ||
        resolution.collectionCoordinate !== coordinate
      )
        continue
      const deletion = projectOrganizerEventMarketDeletion(
        resolution,
        market.naddr
      )
      if (!deletion) continue
      const reconciled = selectOrganizerEventMarketResolution(
        market,
        deletion,
        savedReference
      )
      if (
        reconciled &&
        "terminal" in reconciled &&
        reconciled.state === "deleted"
      )
        return
    }
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
      invalidationPending ||
      (!!selected && "terminal" in selected && selected.state === "pending")
    const selectedMarket = positiveResolution(selected)
      ? selected
      : (current?.market ?? market)
    const relationshipSet = new Set<MerchantEventRelationship>(
      current?.relationships ?? []
    )
    if (organizing || selectedMarket.organizerPubkey === normalizedMerchant) {
      relationshipSet.add("organizing")
    }
    if (selling) relationshipSet.add("selling")

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
      typeof market.end === "string"
        ? dateOnlyMs(market.end)
        : startMs === null
          ? null
          : startMs + DAY_MS
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
  return !!bounds && bounds.endMs <= nowMs
}

export function filterAndSortMerchantEventTimeline(
  items: readonly MerchantEventTimelineItem[],
  search: MerchantEventTimelineSearch,
  nowMs = Date.now()
): MerchantEventTimelineItem[] {
  const relationship = search.relation ?? "all"
  return items
    .filter(
      (item) =>
        relationship === "all" || item.relationships.includes(relationship)
    )
    .sort((left, right) => {
      const leftPast = isPast(left, nowMs)
      const rightPast = isPast(right, nowMs)
      if (leftPast !== rightPast) return leftPast ? -1 : 1
      const leftStart =
        merchantEventTimelineBounds(left.market)?.startMs ??
        Number.POSITIVE_INFINITY
      const rightStart =
        merchantEventTimelineBounds(right.market)?.startMs ??
        Number.POSITIVE_INFINITY
      const delta = leftStart - rightStart
      if (delta !== 0) return delta
      return left.market.collectionCoordinate.localeCompare(
        right.market.collectionCoordinate
      )
    })
}

function boundedPresentationLimit(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(value ?? 0))
    : MERCHANT_EVENT_TIMELINE_PAGE_SIZE
}

/**
 * Keeps rendering bounded around now. Earlier pages prepend chronologically;
 * later pages append chronologically.
 */
export function getMerchantEventTimelinePresentation(
  items: readonly MerchantEventTimelineItem[],
  limits: { earlier?: number; later?: number } = {},
  nowMs = Date.now()
): MerchantEventTimelinePresentation {
  const chronological = filterAndSortMerchantEventTimeline(items, {}, nowMs)
  const past = chronological.filter((item) => isPast(item, nowMs))
  const currentAndFuture = chronological.filter((item) => !isPast(item, nowMs))
  const earlierLimit = boundedPresentationLimit(limits.earlier)
  const laterLimit = boundedPresentationLimit(limits.later)
  const visiblePast = past.slice(Math.max(0, past.length - earlierLimit))
  const visibleCurrentAndFuture = currentAndFuture.slice(0, laterLimit)

  return {
    past: visiblePast,
    currentAndFuture: visibleCurrentAndFuture,
    hiddenEarlierCount: past.length - visiblePast.length,
    hiddenLaterCount: currentAndFuture.length - visibleCurrentAndFuture.length,
  }
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

/** Wall-clock boundaries that can change the selected timeline projection. */
export function getMerchantEventTimelineBoundaries(
  items: readonly MerchantEventTimelineItem[]
): number[] {
  return items.flatMap((item) => {
    const bounds = merchantEventTimelineBounds(item.market)
    return bounds ? [bounds.startMs, bounds.endMs] : []
  })
}

export function getMerchantEventTimelineStatus(
  item: MerchantEventTimelineItem,
  nowMs = Date.now()
): MerchantEventTimelineStatus {
  if (item.market.orderAcceptance === "closed") {
    return { label: "Closed", tone: "secondary" }
  }
  if (isPast(item, nowMs)) {
    if (item.market.orderAcceptance !== "open") {
      return { label: "Past event", tone: "secondary" }
    }
    const refreshNeeded =
      item.market.state === "stale" || item.reconciliationPending
    return {
      label: refreshNeeded
        ? "Scheduled time has passed · Refresh needed"
        : "Scheduled time has passed · Open",
      tone: refreshNeeded ? "warning" : "secondary",
    }
  }
  if (item.reconciliationPending) {
    return { label: "Refresh needed", tone: "warning" }
  }
  const labels: Partial<
    Record<EventMarketResolutionState, MerchantEventTimelineStatus>
  > = {
    active: { label: "Active event", tone: "success" },
    partial: { label: "Active event", tone: "success" },
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
    const exclusiveEnd =
      typeof market.end === "string"
        ? dateOnlyMs(market.end)
        : start === null
          ? null
          : start + DAY_MS
    if (start === null || exclusiveEnd === null) return "Schedule unavailable"
    const formatter = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    })
    const startLabel = formatter.format(start)
    const inclusiveEnd = exclusiveEnd - DAY_MS
    return inclusiveEnd > start
      ? `${startLabel} – ${formatter.format(inclusiveEnd)}`
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

export function getMerchantEventTimelineDateParts(
  market: MerchantOrganizerEventMarket,
  locale?: string
): MerchantEventTimelineDateParts {
  const bounds = merchantEventTimelineBounds(market)
  if (!bounds) {
    return { dateTime: "", day: "—", month: "Date", year: "unavailable" }
  }
  const startMs = bounds.startMs
  const dateTime =
    market.calendarKind === 31922 && typeof market.start === "string"
      ? market.start
      : new Date(startMs).toISOString()
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(market.calendarKind === 31922
      ? { timeZone: "UTC" }
      : market.timezone
        ? { timeZone: market.timezone }
        : {}),
  }
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat(locale, options).formatToParts(startMs)
  } catch {
    parts = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).formatToParts(startMs)
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
