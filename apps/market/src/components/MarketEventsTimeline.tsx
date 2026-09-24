import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, RefreshCw, SlidersHorizontal } from "lucide-react"
import {
  buildEventMarketShareRelayHints,
  encodeEventMarketNaddr,
  useAuth,
  type EventMarketRosterReadResult,
} from "@conduit/core"
import {
  Button,
  cn,
  EventTimelineEntry,
  EventTimelineLoading,
  EventTimelineViewport,
  getResultPresentation,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useEventTimelineAnchor,
  useTimeBoundaryNow,
} from "@conduit/ui"
import { useEventTimeline } from "../hooks/useEventTimeline"
import {
  filterAndSortEventMarkets,
  formatEventTimelineSchedule,
  getEventTimelineBoundaries,
  getEventTimelineDateParts,
  getEventTimelineFacets,
  getEventTimelinePresentation,
  getNextEventTimelineLimit,
  MARKET_EVENT_TIMELINE_PAGE_SIZE,
  type EventTimelineSearch,
  type TimelineEventMarket,
} from "../lib/eventTimeline"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"
import { EventTimelineEmptyState } from "./EventTimelineEmptyState"
import { useMerchantIdentities } from "../hooks/useMerchantIdentities"

interface TimelinePresentationLimits {
  earlier: number
  key: string
  later: number
}

export function MarketEventsTimeline({
  onOpen,
  onSearchChange,
  search,
  source,
}: {
  onOpen: (reference: string) => void
  onSearchChange: (search: EventTimelineSearch) => void
  search: EventTimelineSearch
  source: ProductCatalogSourceMode
}) {
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const connected = status === "connected"
  const discovery = useEventTimeline(source)
  const filterKey = `${discovery.effectiveSource}:${connected ? pubkey : "guest"}:${search.organizer ?? "all"}:${search.location ?? "all"}`
  const [presentationLimits, setPresentationLimits] =
    useState<TimelinePresentationLimits>({
      earlier: MARKET_EVENT_TIMELINE_PAGE_SIZE,
      key: filterKey,
      later: MARKET_EVENT_TIMELINE_PAGE_SIZE,
    })
  const activePresentationLimits =
    presentationLimits.key === filterKey
      ? presentationLimits
      : {
          earlier: MARKET_EVENT_TIMELINE_PAGE_SIZE,
          key: filterKey,
          later: MARKET_EVENT_TIMELINE_PAGE_SIZE,
        }
  const timelineBoundaries = useMemo(
    () => [
      ...getEventTimelineBoundaries(discovery.markets, "all"),
      ...discovery.futureMarkets.flatMap((read) =>
        read.calendar ? [read.calendar.start, read.calendar.end] : []
      ),
    ],
    [discovery.markets, discovery.futureMarkets]
  )
  const nowMs = useTimeBoundaryNow(timelineBoundaries)
  const filteredMarkets = useMemo(
    () =>
      filterAndSortEventMarkets(
        discovery.markets,
        { ...search, window: "all" },
        nowMs
      ),
    [discovery.markets, nowMs, search]
  )
  const futureMarkets = useMemo(
    () =>
      discovery.futureMarkets.filter((read) => {
        if (read.resolution.state !== "current" || !read.calendar) return false
        const market = read.resolution.market
        if (search.organizer && market.organizerPubkey !== search.organizer)
          return false
        if (
          search.location &&
          ![...read.calendar.locations, read.calendar.geohash ?? ""].some(
            (location) =>
              location.toLocaleLowerCase() ===
              search.location?.toLocaleLowerCase()
          )
        )
          return false
        return true
      }),
    [discovery.futureMarkets, search.location, search.organizer]
  )
  const presentation = useMemo(
    () =>
      getEventTimelinePresentation(
        filteredMarkets,
        {
          earlier: activePresentationLimits.earlier,
          later: activePresentationLimits.later,
        },
        nowMs
      ),
    [
      activePresentationLimits.earlier,
      activePresentationLimits.later,
      filteredMarkets,
      nowMs,
    ]
  )
  const presentedMarkets = useMemo(
    () => [...presentation.past, ...presentation.currentAndFuture],
    [presentation.currentAndFuture, presentation.past]
  )
  const timelineAnchor = useEventTimelineAnchor({
    isFetching: discovery.isFetching,
    itemCount: filteredMarkets.length + futureMarkets.length,
    pastCount:
      presentation.past.length +
      futureMarkets.filter((read) => (read.calendar?.end ?? Infinity) <= nowMs)
        .length,
    viewportKey: filterKey,
  })
  const facets = useMemo(() => {
    const legacy = getEventTimelineFacets(discovery.markets)
    return {
      organizers: Array.from(
        new Set([
          ...legacy.organizers,
          ...discovery.futureMarkets.flatMap((read) =>
            read.resolution.state === "current"
              ? [read.resolution.market.organizerPubkey]
              : []
          ),
        ])
      ).sort(),
      locations: Array.from(
        new Set([
          ...legacy.locations,
          ...discovery.futureMarkets.flatMap(
            (read) => read.calendar?.locations ?? []
          ),
        ])
      ).sort(),
    }
  }, [discovery.futureMarkets, discovery.markets])
  const visibleOrganizerPubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...presentedMarkets.map((market) => market.organizerPubkey),
          ...futureMarkets.flatMap((read) =>
            read.resolution.state === "current"
              ? [read.resolution.market.organizerPubkey]
              : []
          ),
        ])
      ),
    [futureMarkets, presentedMarkets]
  )
  const organizerIdentities = useMerchantIdentities({
    accountPubkey: connected ? pubkey : null,
    authenticatedPubkey: connected ? pubkey : null,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    allMerchantPubkeys: facets.organizers,
    visibleMerchantPubkeys: visibleOrganizerPubkeys,
    relayHintsByPubkey: discovery.profileRelayHintsByPubkey,
  })
  const hasLocalFilters = !!(search.organizer || search.location)
  const discoveryComplete =
    !discovery.error &&
    !discovery.isRefreshStale &&
    (discovery.data?.state === "complete" ||
      discovery.data?.state === "complete_empty")
  const resultPresentation = getResultPresentation({
    resultCount: discovery.markets.length + discovery.futureMarkets.length,
    visibleResultCount: filteredMarkets.length + futureMarkets.length,
    reliability: discoveryComplete ? "complete" : "degraded",
  })
  const filteredDiscoveryIncomplete =
    resultPresentation.kind === "filter_empty" &&
    resultPresentation.visibility === "compact"

  function updateFilters(updates: Partial<EventTimelineSearch>): void {
    timelineAnchor.rememberPosition()
    onSearchChange({ ...search, ...updates })
  }

  function clearFilters(): void {
    timelineAnchor.rememberPosition()
    onSearchChange({ source: search.source })
  }

  function loadEarlier(): void {
    timelineAnchor.prepareForPrepend()
    const totalCount =
      presentation.past.length + presentation.hiddenEarlierCount
    setPresentationLimits((current) => {
      const active =
        current.key === filterKey ? current : activePresentationLimits
      return {
        ...active,
        earlier: getNextEventTimelineLimit(active.earlier, totalCount),
      }
    })
  }

  function loadLater(): void {
    const totalCount =
      presentation.currentAndFuture.length + presentation.hiddenLaterCount
    setPresentationLimits((current) => {
      const active =
        current.key === filterKey ? current : activePresentationLimits
      return {
        ...active,
        later: getNextEventTimelineLimit(active.later, totalCount),
      }
    })
  }

  function openMarket(market: TimelineEventMarket): void {
    const relayHints = buildEventMarketShareRelayHints([
      market.collection.sourceRelayUrls,
      market.calendar.sourceRelayUrls,
      ...market.pickups.map((pickup) => pickup.sourceRelayUrls),
    ])
    timelineAnchor.rememberPosition()
    onOpen(encodeEventMarketNaddr(market.collection.coordinate, relayHints))
  }

  function renderEntry(market: TimelineEventMarket) {
    const organizer = organizerIdentities.getIdentity(market.organizerPubkey)
    return (
      <EventTimelineEntry
        key={market.reference}
        date={getEventTimelineDateParts(market.calendar)}
        imageUrl={market.calendar.image ?? market.collection.image}
        onOpen={() => openMarket(market)}
        organizerName={organizer.displayName}
        organizerPending={organizer.status === "pending"}
        schedule={formatEventTimelineSchedule(market.calendar)}
        title={market.calendar.title}
      />
    )
  }

  function renderFutureEntry(read: EventMarketRosterReadResult) {
    if (read.resolution.state !== "current" || !read.calendar) return null
    const market = read.resolution.market
    const calendar = read.calendar
    const organizer = organizerIdentities.getIdentity(market.organizerPubkey)
    return (
      <EventTimelineEntry
        key={market.coordinate}
        date={getEventTimelineDateParts(calendar)}
        imageUrl={calendar.image}
        onOpen={() => {
          timelineAnchor.rememberPosition()
          onOpen(
            encodeEventMarketNaddr(market.coordinate, read.observedRelayUrls)
          )
        }}
        organizerName={organizer.displayName}
        organizerPending={organizer.status === "pending"}
        schedule={formatEventTimelineSchedule(calendar)}
        title={calendar.title}
      />
    )
  }

  function renderMixedEntries(
    legacy: TimelineEventMarket[],
    future: EventMarketRosterReadResult[]
  ) {
    return [
      ...legacy.map((market) => ({
        start: market.calendar.start,
        node: renderEntry(market),
      })),
      ...future.flatMap((read) =>
        read.calendar
          ? [{ start: read.calendar.start, node: renderFutureEntry(read) }]
          : []
      ),
    ]
      .sort((left, right) => left.start - right.start)
      .map((entry) => entry.node)
  }
  const futurePast = futureMarkets.filter(
    (read) => (read.calendar?.end ?? Infinity) <= nowMs
  )
  const futureUpcoming = futureMarkets.filter(
    (read) => (read.calendar?.end ?? -Infinity) > nowMs
  )

  return (
    <section className="space-y-5" aria-label="Events timeline">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-balance font-display text-xl font-semibold text-[var(--text-primary)]">
          Events
        </h1>
        <div className="flex items-center gap-2">
          <p
            className="text-sm tabular-nums text-[var(--text-muted)]"
            aria-live="polite"
          >
            {discovery.isInitialLoading
              ? "Loading events"
              : `${filteredMarkets.length + futureMarkets.length} ${filteredMarkets.length + futureMarkets.length === 1 ? "event" : "events"}`}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Refresh events"
            disabled={discovery.isFetching}
            onClick={discovery.refetch}
          >
            <RefreshCw
              className={cn(
                "size-4 shrink-0",
                discovery.isFetching &&
                  "animate-spin motion-reduce:animate-none"
              )}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      <section
        aria-label="Event filters"
        className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            Filter events
          </div>
          {hasLocalFilters ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="event-organizer-filter">Organizer</Label>
            <Select
              value={search.organizer ?? "all"}
              onValueChange={(value) =>
                updateFilters({
                  organizer: value === "all" ? undefined : value,
                })
              }
            >
              <SelectTrigger id="event-organizer-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All organizers</SelectItem>
                {facets.organizers.map((organizerPubkey) => (
                  <SelectItem key={organizerPubkey} value={organizerPubkey}>
                    {
                      organizerIdentities.getIdentity(organizerPubkey)
                        .displayName
                    }
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="event-location-filter">Location</Label>
            <Select
              value={search.location ? `value:${search.location}` : "all"}
              onValueChange={(value) =>
                updateFilters({
                  location: value === "all" ? undefined : value.slice(6),
                })
              }
            >
              <SelectTrigger id="event-location-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {facets.locations.map((location) => (
                  <SelectItem key={location} value={`value:${location}`}>
                    {location}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {discovery.isInitialLoading ? (
        <EventTimelineLoading />
      ) : filteredMarkets.length + futureMarkets.length > 0 ? (
        <EventTimelineViewport
          busy={discovery.isFetching}
          currentAndFutureEvents={renderMixedEntries(
            presentation.currentAndFuture,
            futureUpcoming
          )}
          hiddenEarlierCount={presentation.hiddenEarlierCount}
          hiddenLaterCount={presentation.hiddenLaterCount}
          nowAnchorRef={timelineAnchor.nowAnchorRef}
          onLoadEarlier={loadEarlier}
          onLoadLater={loadLater}
          pageSize={MARKET_EVENT_TIMELINE_PAGE_SIZE}
          pastEvents={renderMixedEntries(presentation.past, futurePast)}
          viewportRef={timelineAnchor.timelineViewportRef}
        />
      ) : discovery.markets.length + discovery.futureMarkets.length > 0 ? (
        <div
          className={cn(
            "rounded-xl px-6 py-12 text-center",
            filteredDiscoveryIncomplete
              ? "border border-[var(--warning)]/40 bg-[var(--warning)]/10"
              : "border border-dashed border-[var(--border)]"
          )}
          role={filteredDiscoveryIncomplete ? "alert" : undefined}
        >
          <CalendarDays
            className="mx-auto size-8 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <h2 className="mt-4 text-balance text-lg font-semibold text-[var(--text-primary)]">
            No events match these filters
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-pretty text-sm text-[var(--text-secondary)]">
            {filteredDiscoveryIncomplete
              ? "Discovery is incomplete, so matching events may still be available. Retry or change the filters."
              : "Clear a filter to see more events already found."}
          </p>
          {filteredDiscoveryIncomplete ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              disabled={discovery.isFetching}
              onClick={discovery.refetch}
            >
              <RefreshCw
                className={cn(
                  "size-4 shrink-0",
                  discovery.isFetching &&
                    "animate-spin motion-reduce:animate-none"
                )}
                aria-hidden="true"
              />
              Retry
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <EventTimelineEmptyState
          discoveryState={discovery.data?.state}
          hasError={Boolean(discovery.error)}
          refreshIncomplete={discovery.isRefreshStale}
          onRetry={discovery.refetch}
          retrying={discovery.isFetching}
        />
      )}
    </section>
  )
}
