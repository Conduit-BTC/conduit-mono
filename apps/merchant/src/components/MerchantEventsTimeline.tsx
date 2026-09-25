import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, Plus, RefreshCw } from "lucide-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  discoverFutureEventMarkets,
  encodeEventMarketNaddr,
  getProfileDisplayLabel,
  useAuth,
  useConduitSession,
  useProfiles,
  type EventMarketRosterReadResult,
} from "@conduit/core"
import {
  Button,
  cn,
  EventTimelineEntry,
  EventTimelineLoading,
  EventTimelineViewport,
  getResultPresentation,
  SegmentedControl,
  SegmentedControlItem,
  useEventTimelineAnchor,
  useTimeBoundaryNow,
} from "@conduit/ui"
import { useMerchantEventTimeline } from "../hooks/useMerchantEventTimeline"
import type { MerchantOrganizerEventMarket } from "../lib/event-market"
import {
  merchantEventMarketQueryIdentity,
  type MerchantEventMarketQueryData,
} from "../lib/merchant-event-query"
import {
  filterAndSortMerchantEventTimeline,
  getMerchantEventTimelineBoundaries,
  getMerchantEventTimelineDateParts,
  getMerchantEventTimelinePresentation,
  getNextMerchantEventTimelineLimit,
  formatMerchantEventTimelineSchedule,
  MERCHANT_EVENT_RELATIONSHIP_FILTERS,
  MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
  type MerchantEventRelationshipFilter,
  type MerchantEventTimelineItem,
  type MerchantEventTimelineSearch,
} from "../lib/merchant-event-timeline"

const RELATIONSHIP_LABELS: Record<MerchantEventRelationshipFilter, string> = {
  all: "All events",
  organizing: "Organizing",
  selling: "Selling at",
}

interface TimelinePresentationLimits {
  earlier: number
  key: string
  later: number
}

export interface FutureMerchantTimelineOccurrence {
  read: EventMarketRosterReadResult
  calendar: NonNullable<EventMarketRosterReadResult["calendar"]>
  coordinate: string
  series: boolean
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

type TimelineRow =
  | {
      kind: "legacy"
      item: MerchantEventTimelineItem
      start: number
      key: string
    }
  | {
      kind: "future"
      entry: FutureMerchantTimelineOccurrence
      start: number
      key: string
    }

function futureCalendarDateParts(
  calendar: FutureMerchantTimelineOccurrence["calendar"]
) {
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(calendar.kind === 31922
      ? { timeZone: "UTC" }
      : calendar.startTzid
        ? { timeZone: calendar.startTzid }
        : {}),
  }
  const parts = new Intl.DateTimeFormat(undefined, options).formatToParts(
    calendar.start
  )
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

export function MerchantEventsTimeline({
  merchantPubkey,
  search,
  onSearchChange,
  onOpen,
  onCreate,
  createDisabled = false,
}: {
  merchantPubkey: string
  search: MerchantEventTimelineSearch
  onSearchChange: (search: MerchantEventTimelineSearch) => void
  onOpen: (reference: string, occurrence?: string) => void
  onCreate: () => void
  createDisabled?: boolean
}) {
  const queryClient = useQueryClient()
  const session = useConduitSession()
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  const relationship = search.relation ?? "all"
  const viewportKey = `${merchantPubkey}:${relationship}`
  const [presentationLimits, setPresentationLimits] =
    useState<TimelinePresentationLimits>({
      earlier: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
      key: relationship,
      later: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
    })
  const activePresentationLimits =
    presentationLimits.key === relationship
      ? presentationLimits
      : {
          earlier: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
          key: relationship,
          later: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
        }
  const discovery = useMerchantEventTimeline({
    merchantPubkey,
    source: "combined",
  })
  const futureAuthors = useMemo(
    () =>
      Array.from(
        new Set(
          [merchantPubkey, ...(discovery.organizerPubkeys ?? [])].filter(
            Boolean
          )
        )
      ),
    [discovery.organizerPubkeys, merchantPubkey]
  )
  const futureQuery = useQuery({
    queryKey: [
      "merchant-future-event-timeline",
      session.relayScope,
      authenticatedPubkey,
      futureAuthors.join(","),
    ],
    queryFn: ({ signal }) =>
      discoverFutureEventMarkets({
        organizerPubkeys: futureAuthors,
        authenticatedPubkey,
        signal,
      }),
    enabled: session.relaySettingsReady && !!merchantPubkey,
    retry: false,
    refetchInterval: 60_000,
  })
  const futureOccurrences = useMemo(
    () =>
      (futureQuery.data?.markets ?? []).flatMap(
        projectFutureMerchantTimelineOccurrences
      ),
    [futureQuery.data?.markets]
  )
  const visibleFutureOccurrences = useMemo(
    () =>
      futureOccurrences.filter(({ read }) => {
        if (read.resolution.state !== "current") return false
        const market = read.resolution.market
        if (
          relationship === "organizing" &&
          market.organizerPubkey !== merchantPubkey
        )
          return false
        if (
          relationship === "selling" &&
          !market.merchants.some((row) => row.pubkey === merchantPubkey)
        )
          return false
        return true
      }),
    [futureOccurrences, merchantPubkey, relationship]
  )
  const timelineBoundaries = useMemo(
    () => [
      ...getMerchantEventTimelineBoundaries(discovery.items),
      ...visibleFutureOccurrences.flatMap(({ calendar }) => [
        calendar.start,
        calendar.end,
      ]),
    ],
    [discovery.items, visibleFutureOccurrences]
  )
  const nowMs = useTimeBoundaryNow(timelineBoundaries)
  const filteredItems = useMemo(
    () => filterAndSortMerchantEventTimeline(discovery.items, search, nowMs),
    [discovery.items, nowMs, search]
  )
  const legacyPresentation = useMemo(
    () =>
      getMerchantEventTimelinePresentation(
        filteredItems,
        {
          earlier: filteredItems.length,
          later: filteredItems.length,
        },
        nowMs
      ),
    [filteredItems, nowMs]
  )
  const presentation = useMemo(() => {
    const rows: TimelineRow[] = [
      ...filteredItems.map((item) => ({
        kind: "legacy" as const,
        item,
        start: item.market.source.calendar?.start ?? 0,
        key: item.market.collectionCoordinate,
      })),
      ...visibleFutureOccurrences.map((entry) => ({
        kind: "future" as const,
        entry,
        start: entry.calendar.start,
        key: `${entry.read.coordinate}:${entry.coordinate}`,
      })),
    ]
    const pastLegacy = new Set(
      legacyPresentation.past.map((item) => item.market.collectionCoordinate)
    )
    const byStart = (left: TimelineRow, right: TimelineRow) =>
      left.start - right.start || left.key.localeCompare(right.key)
    const past = rows
      .filter((row) =>
        row.kind === "legacy"
          ? pastLegacy.has(row.item.market.collectionCoordinate)
          : row.entry.calendar.end <= nowMs
      )
      .sort(byStart)
    const currentAndFuture = rows
      .filter((row) =>
        row.kind === "legacy"
          ? !pastLegacy.has(row.item.market.collectionCoordinate)
          : row.entry.calendar.end > nowMs
      )
      .sort(byStart)
    return {
      past: past.slice(-activePresentationLimits.earlier),
      currentAndFuture: currentAndFuture.slice(
        0,
        activePresentationLimits.later
      ),
      hiddenEarlierCount: Math.max(
        0,
        past.length - activePresentationLimits.earlier
      ),
      hiddenLaterCount: Math.max(
        0,
        currentAndFuture.length - activePresentationLimits.later
      ),
    }
  }, [
    activePresentationLimits.earlier,
    activePresentationLimits.later,
    filteredItems,
    legacyPresentation.past,
    nowMs,
    visibleFutureOccurrences,
  ])
  const timelineAnchor = useEventTimelineAnchor({
    isFetching: discovery.isFetching || futureQuery.isFetching,
    itemCount: filteredItems.length + visibleFutureOccurrences.length,
    pastCount: presentation.past.length,
    viewportKey,
  })
  const organizerPubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...presentation.past
            .concat(presentation.currentAndFuture)
            .flatMap((row) =>
              row.kind === "legacy"
                ? [row.item.market.organizerPubkey]
                : row.entry.read.resolution.state === "current"
                  ? [row.entry.read.resolution.market.organizerPubkey]
                  : []
            ),
        ])
      ),
    [presentation.currentAndFuture, presentation.past]
  )
  const profiles = useProfiles(organizerPubkeys, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: () =>
      authGenerationRef.current === authGeneration &&
      isAuthGenerationCurrent(authGeneration),
    priority: "visible",
    maxUnresolvedRefetches: 1,
    relayHintsByPubkey: discovery.profileRelayHintsByPubkey,
  })
  const futureDateReadIncomplete = (futureQuery.data?.markets ?? []).some(
    (read) => {
      if (
        read.resolution.state !== "current" ||
        !read.resolution.market.calendarCoordinate.startsWith("31924:") ||
        (read.schedule?.kind === "series" &&
          read.schedule.unresolvedCoordinates.length === 0 &&
          read.scheduleCoverage === "complete")
      )
        return false
      const market = read.resolution.market
      return (
        (relationship !== "organizing" ||
          market.organizerPubkey === merchantPubkey) &&
        (relationship !== "selling" ||
          market.merchants.some((row) => row.pubkey === merchantPubkey))
      )
    }
  )
  const discoveryComplete =
    !!discovery.network &&
    ["complete", "complete_empty"].includes(discovery.network.state) &&
    !discovery.isRefreshStale &&
    !futureQuery.isError &&
    !futureDateReadIncomplete &&
    discovery.network.perspective.truncated !== true
  const resultPresentation = getResultPresentation({
    resultCount:
      discovery.items.length +
      Math.max(futureQuery.data?.markets.length ?? 0, futureOccurrences.length),
    visibleResultCount: filteredItems.length + visibleFutureOccurrences.length,
    reliability: discoveryComplete ? "complete" : "degraded",
  })
  function openMarket(market: MerchantOrganizerEventMarket): void {
    const identity = merchantEventMarketQueryIdentity(market.naddr, {
      relayScope: session.relayScope,
      authenticatedPubkey,
      authGeneration,
    })
    queryClient.setQueryData<MerchantEventMarketQueryData>(
      identity.queryKey,
      (current) => current ?? { read: market, complete: false },
      { updatedAt: 0 }
    )
    timelineAnchor.rememberPosition()
    onOpen(market.naddr)
  }

  function changeRelationship(value: string): void {
    const nextRelationship = value as MerchantEventRelationshipFilter
    timelineAnchor.rememberPosition()
    onSearchChange({
      relation: nextRelationship === "all" ? undefined : nextRelationship,
    })
  }

  function loadEarlier(): void {
    timelineAnchor.prepareForPrepend()
    const totalCount =
      presentation.past.length + presentation.hiddenEarlierCount
    setPresentationLimits((current) => {
      const active =
        current.key === relationship ? current : activePresentationLimits
      return {
        ...active,
        earlier: getNextMerchantEventTimelineLimit(active.earlier, totalCount),
      }
    })
  }

  function loadLater(): void {
    const totalCount =
      presentation.currentAndFuture.length + presentation.hiddenLaterCount
    setPresentationLimits((current) => {
      const active =
        current.key === relationship ? current : activePresentationLimits
      return {
        ...active,
        later: getNextMerchantEventTimelineLimit(active.later, totalCount),
      }
    })
  }

  function renderEntry(item: MerchantEventTimelineItem) {
    const market = item.market
    const profile = profiles.getProfile(market.organizerPubkey)
    return (
      <EventTimelineEntry
        key={market.collectionCoordinate}
        date={getMerchantEventTimelineDateParts(market)}
        imageUrl={market.imageUrl}
        organizerName={getProfileDisplayLabel(profile, market.organizerPubkey, {
          lookupSettled: profiles.lookupSettled,
        })}
        organizerPending={!profiles.lookupSettled && !profile}
        schedule={formatMerchantEventTimelineSchedule(market)}
        title={market.title}
        onOpen={() => openMarket(market)}
      />
    )
  }

  function renderFutureEntry({
    read,
    calendar,
    coordinate,
    series,
  }: FutureMerchantTimelineOccurrence) {
    if (read.resolution.state !== "current") return null
    const market = read.resolution.market
    const profile = profiles.getProfile(market.organizerPubkey)
    return (
      <EventTimelineEntry
        key={`${market.coordinate}:${coordinate}`}
        date={futureCalendarDateParts(calendar)}
        imageUrl={calendar.image}
        organizerName={getProfileDisplayLabel(profile, market.organizerPubkey, {
          lookupSettled: profiles.lookupSettled,
        })}
        organizerPending={!profiles.lookupSettled && !profile}
        schedule={
          calendar.kind === 31922 && calendar.startDate
            ? calendar.startDate
            : new Date(calendar.start).toLocaleString()
        }
        title={calendar.title}
        onOpen={() => {
          timelineAnchor.rememberPosition()
          onOpen(
            encodeEventMarketNaddr(market.coordinate, read.observedRelayUrls),
            series ? coordinate : undefined
          )
        }}
      />
    )
  }

  function renderMixedEntries(rows: TimelineRow[]) {
    return rows.map((row) =>
      row.kind === "legacy"
        ? renderEntry(row.item)
        : renderFutureEntry(row.entry)
    )
  }

  return (
    <section className="space-y-5" aria-label="Events timeline">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl role="group" aria-label="Event relationship">
          {MERCHANT_EVENT_RELATIONSHIP_FILTERS.map((option) => (
            <SegmentedControlItem
              key={option}
              selected={relationship === option}
              onClick={() => changeRelationship(option)}
            >
              {RELATIONSHIP_LABELS[option]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <div className="flex items-center gap-2">
          <p
            className="text-sm tabular-nums text-[var(--text-muted)]"
            aria-live="polite"
          >
            {discovery.isInitialLoading
              ? "Loading events"
              : `${filteredItems.length + visibleFutureOccurrences.length} ${filteredItems.length + visibleFutureOccurrences.length === 1 ? "event" : "events"}`}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Refresh events"
            disabled={discovery.isFetching || futureQuery.isFetching}
            onClick={() => {
              discovery.refetch()
              void futureQuery.refetch()
            }}
          >
            <RefreshCw
              className={cn(
                "size-4",
                discovery.isFetching &&
                  "animate-spin motion-reduce:animate-none"
              )}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      {discovery.isInitialLoading ? (
        <EventTimelineLoading />
      ) : filteredItems.length + visibleFutureOccurrences.length > 0 ? (
        <EventTimelineViewport
          busy={discovery.isFetching || futureQuery.isFetching}
          currentAndFutureEvents={renderMixedEntries(
            presentation.currentAndFuture
          )}
          hiddenEarlierCount={presentation.hiddenEarlierCount}
          hiddenLaterCount={presentation.hiddenLaterCount}
          nowAnchorRef={timelineAnchor.nowAnchorRef}
          onLoadEarlier={loadEarlier}
          onLoadLater={loadLater}
          pageSize={MERCHANT_EVENT_TIMELINE_PAGE_SIZE}
          pastEvents={renderMixedEntries(presentation.past)}
          viewportRef={timelineAnchor.timelineViewportRef}
        />
      ) : (
        <div
          className={cn(
            "rounded-xl px-6 py-12 text-center",
            resultPresentation.visibility === "compact"
              ? "border border-[var(--warning)]/40 bg-[var(--warning)]/10"
              : "border border-dashed border-[var(--border)]"
          )}
          role={
            resultPresentation.visibility === "compact" ? "alert" : undefined
          }
        >
          <CalendarDays
            className="mx-auto size-8 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <h3 className="mt-4 text-balance text-lg font-semibold text-[var(--text-primary)]">
            {futureDateReadIncomplete &&
            filteredItems.length + visibleFutureOccurrences.length === 0
              ? "Event dates couldn't be fully loaded"
              : resultPresentation.kind === "degraded_empty"
                ? "Events couldn't be fully loaded"
                : resultPresentation.kind === "filter_empty"
                  ? "No events match this relationship"
                  : "No events yet"}
          </h3>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-muted)]">
            {futureDateReadIncomplete &&
            filteredItems.length + visibleFutureOccurrences.length === 0
              ? "Retry to check the signed dates for this market."
              : resultPresentation.kind === "degraded_empty"
                ? "Retry to check for more events."
                : resultPresentation.kind === "filter_empty"
                  ? resultPresentation.visibility === "compact"
                    ? "Discovery is incomplete, so matching events may still be available. Retry or choose another relationship."
                    : "Choose another relationship to see other events."
                  : "Create your first event to add it to the timeline."}
          </p>
          {resultPresentation.visibility === "compact" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              disabled={discovery.isFetching || futureQuery.isFetching}
              onClick={() => {
                discovery.refetch()
                void futureQuery.refetch()
              }}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {discovery.isFetching ? "Refreshing…" : "Retry"}
            </Button>
          ) : resultPresentation.kind === "filter_empty" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => changeRelationship("all")}
            >
              Show all events
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              className="mt-4"
              onClick={onCreate}
              disabled={createDisabled}
            >
              <Plus className="size-4 shrink-0" aria-hidden="true" />
              Create event
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
