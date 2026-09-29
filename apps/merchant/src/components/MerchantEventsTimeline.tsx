import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, Plus, RefreshCw } from "lucide-react"
import {
  useProgressiveEventMarketDiscovery,
  encodeEventMarketNaddr,
  getProfileDisplayLabel,
  useAuth,
  useConduitSession,
  useProfiles,
} from "@conduit/core"
import {
  Button,
  cn,
  EventTimelineEntry,
  EventTimelineLoading,
  EventTimelineViewport,
  getResultPresentation,
  paginateEventTimeline,
  SegmentedControl,
  SegmentedControlItem,
  useEventTimelineAnchor,
  useTimeBoundaryNow,
} from "@conduit/ui"
import { useMerchantEventTimeline } from "../hooks/useMerchantEventTimeline"

import {
  getNextMerchantEventTimelineLimit,
  getFutureMerchantTimelineDateParts,
  projectFutureMerchantTimelineOccurrences,
  type FutureMerchantTimelineOccurrence,
  MERCHANT_EVENT_RELATIONSHIP_FILTERS,
  MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
  type MerchantEventRelationshipFilter,
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

type TimelineRow = {
  entry: FutureMerchantTimelineOccurrence
  start: number
  end: number
  key: string
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
  const activePresentationLimits = useMemo(
    () =>
      presentationLimits.key === relationship
        ? presentationLimits
        : {
            earlier: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
            key: relationship,
            later: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
          },
    [presentationLimits, relationship]
  )
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
  const futureQuery = useProgressiveEventMarketDiscovery({
    queryKey: [
      "merchant-future-event-timeline",
      session.relayScope,
      authenticatedPubkey,
      authGeneration,
      futureAuthors.join(","),
    ],
    discoveryInput: {
      organizerPubkeys: futureAuthors,
      authenticatedPubkey,
      shouldContinue: () => authGenerationRef.current === authGeneration,
    },
    enabled: session.relaySettingsReady && !!merchantPubkey,
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
      ...visibleFutureOccurrences.flatMap(({ calendar }) => [
        calendar.start,
        calendar.end,
      ]),
    ],
    [visibleFutureOccurrences]
  )
  const nowMs = useTimeBoundaryNow(timelineBoundaries)
  const presentation = useMemo(() => {
    const rows: TimelineRow[] = [
      ...visibleFutureOccurrences.map((entry) => ({
        entry,
        start: entry.calendar.start,
        end: entry.calendar.end,
        key: `${entry.read.coordinate}:${entry.coordinate}`,
      })),
    ]
    return paginateEventTimeline(rows, activePresentationLimits, nowMs)
  }, [activePresentationLimits, nowMs, visibleFutureOccurrences])
  const timelineAnchor = useEventTimelineAnchor({
    isFetching: discovery.isFetching || futureQuery.isFetching,
    itemCount: visibleFutureOccurrences.length,
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
              row.entry.read.resolution.state === "current"
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
    futureQuery.data?.coverage === "complete" &&
    !discovery.isRefreshStale &&
    !futureQuery.isError &&
    !futureDateReadIncomplete
  const resultPresentation = getResultPresentation({
    resultCount: Math.max(
      futureQuery.data?.markets.length ?? 0,
      futureOccurrences.length
    ),
    visibleResultCount: visibleFutureOccurrences.length,
    reliability: discoveryComplete ? "complete" : "degraded",
  })
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
        date={getFutureMerchantTimelineDateParts(calendar)}
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
    return rows.map((row) => renderFutureEntry(row.entry))
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
            {discovery.isInitialLoading || futureQuery.isPending
              ? "Loading events"
              : `${visibleFutureOccurrences.length} ${visibleFutureOccurrences.length === 1 ? "event" : "events"}`}
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

      {discovery.isInitialLoading || futureQuery.isPending ? (
        <EventTimelineLoading />
      ) : visibleFutureOccurrences.length > 0 ? (
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
            {futureDateReadIncomplete && visibleFutureOccurrences.length === 0
              ? "Event dates couldn't be fully loaded"
              : resultPresentation.kind === "degraded_empty"
                ? "Events couldn't be fully loaded"
                : resultPresentation.kind === "filter_empty"
                  ? "No events match this relationship"
                  : "No events yet"}
          </h3>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-muted)]">
            {futureDateReadIncomplete && visibleFutureOccurrences.length === 0
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
