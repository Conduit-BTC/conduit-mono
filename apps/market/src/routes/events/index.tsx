import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowRight, RefreshCw, SlidersHorizontal } from "lucide-react"
import {
  buildEventMarketShareRelayHints,
  encodeEventMarketNaddr,
  normalizePubkey,
  pubkeyToNpub,
  useAuth,
} from "@conduit/core"
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  EventMarketCard,
  getResultPresentation,
  useTimeBoundaryNow,
} from "@conduit/ui"
import {
  MARKET_SOURCE_OPTIONS,
  MarketBrowseNavigation,
} from "../../components/MarketBrowseNavigation"
import { EventTimelineEmptyState } from "../../components/EventTimelineEmptyState"
import { MerchantAvatarFallback } from "../../components/MerchantIdentity"
import { useEventTimeline } from "../../hooks/useEventTimeline"
import { useMerchantIdentities } from "../../hooks/useMerchantIdentities"
import {
  EVENT_TIMELINE_WINDOWS,
  filterAndSortEventMarkets,
  formatEventTimelineSchedule,
  getEventTimelineBoundaries,
  getEventTimelineFacets,
  getEventTimelineStatus,
  type EventTimelineSearch,
  type EventTimelineWindow,
} from "../../lib/eventTimeline"
import {
  DEFAULT_MARKET_CATALOG_SOURCE,
  type ProductCatalogSourceMode,
} from "../../lib/productCatalogRead"

const WINDOW_LABELS: Record<EventTimelineWindow, string> = {
  upcoming: "Open & upcoming",
  "7d": "Next 7 days",
  "30d": "Next 30 days",
  past: "Past events",
  history: "History",
  all: "All dates",
}

export const Route = createFileRoute("/events/")({
  component: EventsTimelinePage,
  validateSearch: (raw: Record<string, unknown>): EventTimelineSearch => {
    const source = MARKET_SOURCE_OPTIONS.includes(
      raw.source as ProductCatalogSourceMode
    )
      ? (raw.source as ProductCatalogSourceMode)
      : undefined
    const window = EVENT_TIMELINE_WINDOWS.includes(
      raw.window as EventTimelineWindow
    )
      ? (raw.window as EventTimelineWindow)
      : undefined
    const organizer =
      typeof raw.organizer === "string"
        ? (normalizePubkey(raw.organizer) ?? undefined)
        : undefined
    const location =
      typeof raw.location === "string" && raw.location.trim()
        ? raw.location.trim()
        : undefined
    return { source, window, organizer, location }
  },
})

function EventsTimelinePage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const connected = status === "connected"
  const discovery = useEventTimeline(
    search.source ?? DEFAULT_MARKET_CATALOG_SOURCE
  )
  const updateSearch = useCallback(
    (updates: Partial<EventTimelineSearch>) => {
      navigate({
        search: (previous: EventTimelineSearch) => {
          const next = { ...previous, ...updates }
          for (const key of Object.keys(
            next
          ) as (keyof EventTimelineSearch)[]) {
            const value = next[key]
            if (value === undefined || value === null || value === "") {
              delete next[key]
            }
          }
          if (next.organizer) next.organizer = pubkeyToNpub(next.organizer)
          return next
        },
        replace: true,
      })
    },
    [navigate]
  )
  const timelineBoundaries = useMemo(
    () => getEventTimelineBoundaries(discovery.markets, search.window),
    [discovery.markets, search.window]
  )
  const nowMs = useTimeBoundaryNow(timelineBoundaries)
  const filteredMarkets = useMemo(
    () => filterAndSortEventMarkets(discovery.markets, search, nowMs),
    [discovery.markets, nowMs, search]
  )
  const facets = useMemo(
    () => getEventTimelineFacets(discovery.markets),
    [discovery.markets]
  )
  const allOrganizerPubkeys = facets.organizers
  const visibleOrganizerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(filteredMarkets.map((market) => market.organizerPubkey))
      ),
    [filteredMarkets]
  )
  const organizerIdentities = useMerchantIdentities({
    accountPubkey: connected ? pubkey : null,
    authenticatedPubkey: connected ? pubkey : null,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    allMerchantPubkeys: allOrganizerPubkeys,
    visibleMerchantPubkeys: visibleOrganizerPubkeys,
    relayHintsByPubkey: discovery.profileRelayHintsByPubkey,
  })
  const hasLocalFilters = !!(
    search.organizer ||
    search.location ||
    (search.window && search.window !== "upcoming")
  )
  const filteredResultPresentation = getResultPresentation({
    resultCount: discovery.markets.length,
    visibleResultCount: filteredMarkets.length,
    reliability:
      !discovery.error &&
      !discovery.isRefreshStale &&
      (discovery.data?.state === "complete" ||
        discovery.data?.state === "complete_empty")
        ? "complete"
        : "degraded",
  })
  const filteredDiscoveryIncomplete =
    filteredResultPresentation.kind === "filter_empty" &&
    filteredResultPresentation.visibility === "compact"

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <MarketBrowseNavigation
        active="events"
        source={discovery.effectiveSource}
        connected={connected}
        onSelectSource={(source) =>
          updateSearch({
            source:
              source === DEFAULT_MARKET_CATALOG_SOURCE ? undefined : source,
          })
        }
      />

      <section
        aria-label="Event filters"
        className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Filter events
          </div>
          {hasLocalFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                updateSearch({
                  window: undefined,
                  organizer: undefined,
                  location: undefined,
                })
              }
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="event-date-filter">Date</Label>
            <Select
              value={search.window ?? "upcoming"}
              onValueChange={(value) =>
                updateSearch({
                  window:
                    value === "upcoming"
                      ? undefined
                      : (value as EventTimelineWindow),
                })
              }
            >
              <SelectTrigger id="event-date-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TIMELINE_WINDOWS.map((window) => (
                  <SelectItem key={window} value={window}>
                    {WINDOW_LABELS[window]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="event-organizer-filter">Organizer</Label>
            <Select
              value={search.organizer ?? "all"}
              onValueChange={(value) =>
                updateSearch({ organizer: value === "all" ? undefined : value })
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
                updateSearch({
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

      <div className="flex items-center justify-between gap-3">
        <h1
          id="event-results-heading"
          className="text-balance font-display text-xl font-semibold text-[var(--text-primary)]"
        >
          {search.window === "history"
            ? "Event history"
            : search.window === "past"
              ? "Past events"
              : "Event timeline"}
        </h1>
        <div className="flex items-center gap-2">
          <span className="text-sm tabular-nums text-[var(--text-muted)]">
            {discovery.isInitialLoading
              ? "Loading events"
              : `${filteredMarkets.length} ${filteredMarkets.length === 1 ? "event" : "events"}`}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0"
            disabled={discovery.isFetching}
            onClick={discovery.refetch}
            aria-label="Refresh events"
            title="Refresh events"
          >
            <RefreshCw
              className={`size-4 ${discovery.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      {discovery.isInitialLoading ? (
        <div
          className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Loading events"
        >
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="h-[26rem] animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]"
            />
          ))}
        </div>
      ) : filteredMarkets.length > 0 ? (
        <section aria-labelledby="event-results-heading">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filteredMarkets.map((market) => {
              const organizer = organizerIdentities.getIdentity(
                market.organizerPubkey
              )
              const relayHints = buildEventMarketShareRelayHints([
                market.collection.sourceRelayUrls,
                market.calendar.sourceRelayUrls,
                ...market.pickups.map((pickup) => pickup.sourceRelayUrls),
              ])
              const naddr = encodeEventMarketNaddr(
                market.collection.coordinate,
                relayHints
              )
              const eventStatus = getEventTimelineStatus(market, nowMs)
              const location = [
                ...market.calendar.locations,
                market.calendar.geohash,
              ]
                .filter(Boolean)
                .join(" · ")
              return (
                <EventMarketCard
                  key={market.reference}
                  title={market.calendar.title}
                  summary={
                    (market.calendar.summary ??
                      market.collection.summary ??
                      market.calendar.content) ||
                    undefined
                  }
                  imageUrl={market.calendar.image ?? market.collection.image}
                  organizerName={organizer.displayName}
                  organizerImageUrl={organizer.picture}
                  organizerFallback={<MerchantAvatarFallback />}
                  organizerPending={organizer.status === "pending"}
                  schedule={formatEventTimelineSchedule(market.calendar)}
                  location={location || undefined}
                  statusLabel={eventStatus.label}
                  statusTone={eventStatus.tone}
                  topics={market.calendar.topics}
                  action={
                    <Button asChild size="sm">
                      <Link
                        to="/events/$collectionRef"
                        params={{ collectionRef: naddr }}
                      >
                        View
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    </Button>
                  }
                />
              )
            })}
          </div>
        </section>
      ) : discovery.markets.length > 0 ? (
        <section
          className={
            filteredDiscoveryIncomplete
              ? "rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-6 py-14 text-center"
              : "rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-14 text-center"
          }
          role={filteredDiscoveryIncomplete ? "alert" : undefined}
        >
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            No events match these filters
          </h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            {filteredDiscoveryIncomplete
              ? "Discovery is incomplete, so matching events may still be available. Retry or change the filters."
              : "Clear a filter or widen the date window to see more events already found."}
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
                className={discovery.isFetching ? "animate-spin" : ""}
                aria-hidden="true"
              />
              Retry
            </Button>
          ) : null}
        </section>
      ) : (
        <EventTimelineEmptyState
          discoveryState={discovery.data?.state}
          hasError={Boolean(discovery.error)}
          refreshIncomplete={discovery.isRefreshStale}
          onRetry={discovery.refetch}
          retrying={discovery.isFetching}
        />
      )}
    </div>
  )
}
