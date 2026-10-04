import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, ChevronDown, Plus, RefreshCw } from "lucide-react"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EventTimelineEntry,
  EventTimelineLoading,
  EventTimelineViewport,
  paginateEventTimeline,
  SegmentedControl,
  SegmentedControlItem,
  useEventTimelineAnchor,
  useTimeBoundaryNow,
} from "@conduit/ui"
import { useMerchantEventTimeline } from "../hooks/useMerchantEventTimeline"
import { mergeMerchantTimelineMarketReads } from "../lib/merchant-event-relationship-hydration"

import {
  getNextMerchantEventTimelineLimit,
  matchesMerchantEventRelationship,
  getMerchantEventTimelineReadState,
  getFutureMerchantTimelineDateParts,
  projectFutureMerchantTimelineOccurrences,
  type FutureMerchantTimelineOccurrence,
  MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
  type MerchantEventRelationshipFilter,
  type MerchantEventTimelineSearch,
} from "../lib/merchant-event-timeline"

const RELATIONSHIP_LABELS: Record<MerchantEventRelationshipFilter, string> = {
  all: "All events",
  organizing: "Organizing",
  selling: "Selling At",
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

function useMerchantEventTimelineData(merchantPubkey: string) {
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
  const marketReads = useMemo(
    () =>
      mergeMerchantTimelineMarketReads(
        futureQuery.data?.markets ?? [],
        discovery.relationshipMarkets
      ),
    [futureQuery.data?.markets, discovery.relationshipMarkets]
  )
  const futureOccurrences = useMemo(
    () => marketReads.flatMap(projectFutureMerchantTimelineOccurrences),
    [marketReads]
  )
  return {
    marketReads,
    futureOccurrences,
    initialLoading:
      !!merchantPubkey &&
      (discovery.isInitialLoading ||
        discovery.relationshipPending ||
        futureQuery.isPending),
    isFetching: discovery.isFetching || futureQuery.isFetching,
    unavailable:
      futureQuery.isError || futureQuery.data?.coverage === "unavailable",
    limited:
      discovery.isRefreshStale ||
      (!!futureQuery.data && futureQuery.data.coverage !== "complete"),
    refetch() {
      discovery.refetch()
      void futureQuery.refetch()
    },
    accountPubkey,
    authenticatedPubkey,
    authGeneration,
    authGenerationRef,
    isAuthGenerationCurrent,
  }
}

interface MerchantEventsTimelineProps {
  merchantPubkey: string
  search: MerchantEventTimelineSearch
  onSearchChange: (search: MerchantEventTimelineSearch) => void
  onOpen: (reference: string, occurrence?: string) => void
  onCreate: () => void
  createDisabled?: boolean
}

export function MerchantEventsTimeline(props: MerchantEventsTimelineProps) {
  const data = useMerchantEventTimelineData(props.merchantPubkey)
  const relationship =
    props.search.relation === "selling" ? "selling" : "organizing"
  return (
    <div className="space-y-8">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Refresh events"
          disabled={data.isFetching}
          onClick={data.refetch}
        >
          <RefreshCw
            className={cn(
              "size-4",
              data.isFetching && "animate-spin motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>
      <MerchantEventTimelineSection
        {...props}
        data={data}
        title="My Events"
        relationship={relationship}
      />
      <MerchantEventTimelineSection
        {...props}
        data={data}
        title="All Events"
        relationship="all"
      />
    </div>
  )
}

function MerchantEventTimelineSection({
  merchantPubkey,
  relationship,
  title,
  data,
  onSearchChange,
  onOpen,
  onCreate,
  createDisabled = false,
}: MerchantEventsTimelineProps & {
  relationship: MerchantEventRelationshipFilter
  title: string
  data: ReturnType<typeof useMerchantEventTimelineData>
}) {
  const {
    marketReads,
    futureOccurrences,
    accountPubkey,
    authenticatedPubkey,
    authGeneration,
    authGenerationRef,
    isAuthGenerationCurrent,
  } = data
  const [open, setOpen] = useState(true)
  const viewportKey = `${merchantPubkey}:${relationship}`
  const [presentationLimits, setPresentationLimits] = useState<
    Record<string, TimelinePresentationLimits>
  >({})
  const activePresentationLimits = useMemo(
    () =>
      presentationLimits[relationship] ?? {
        earlier: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
        key: relationship,
        later: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
      },
    [presentationLimits, relationship]
  )
  const visibleFutureOccurrences = useMemo(
    () =>
      futureOccurrences.filter(({ read }) =>
        matchesMerchantEventRelationship(read, merchantPubkey, relationship)
      ),
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
    isFetching: data.isFetching,
    itemCount: open ? visibleFutureOccurrences.length : 0,
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
  const { datesUnavailable: futureDateReadIncomplete, unavailable } =
    getMerchantEventTimelineReadState(
      marketReads,
      merchantPubkey,
      relationship,
      data.unavailable
    )
  const initialLoading =
    data.initialLoading && visibleFutureOccurrences.length === 0
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
    setPresentationLimits((current) => ({
      ...current,
      [relationship]: {
        ...activePresentationLimits,
        earlier: getNextMerchantEventTimelineLimit(
          activePresentationLimits.earlier,
          totalCount
        ),
      },
    }))
  }

  function loadLater(): void {
    const totalCount =
      presentation.currentAndFuture.length + presentation.hiddenLaterCount
    setPresentationLimits((current) => ({
      ...current,
      [relationship]: {
        ...activePresentationLimits,
        later: getNextMerchantEventTimelineLimit(
          activePresentationLimits.later,
          totalCount
        ),
      },
    }))
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
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        timelineAnchor.rememberPosition()
        setOpen(next)
      }}
      className="space-y-4"
    >
      <h2>
        <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-lg py-2 text-left text-xl font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          <ChevronDown
            className="size-5 shrink-0 group-data-[state=closed]:-rotate-90"
            aria-hidden="true"
          />
          {title}
          <span
            className="ml-auto text-sm font-normal tabular-nums text-[var(--text-muted)]"
            aria-live="polite"
          >
            {initialLoading
              ? "Loading events"
              : `${visibleFutureOccurrences.length} ${visibleFutureOccurrences.length === 1 ? "event" : "events"}`}
          </span>
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent
        className="space-y-4"
        role="region"
        aria-label={`${title} timeline`}
      >
        {relationship !== "all" ? (
          <SegmentedControl role="group" aria-label="My Events relationship">
            {(["organizing", "selling"] as const).map((option) => (
              <SegmentedControlItem
                key={option}
                aria-pressed={relationship === option}
                selected={relationship === option}
                onClick={() => changeRelationship(option)}
              >
                {RELATIONSHIP_LABELS[option]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        ) : null}
        {initialLoading ? (
          <EventTimelineLoading />
        ) : visibleFutureOccurrences.length > 0 ? (
          <>
            {futureDateReadIncomplete ? (
              <p
                role="status"
                className="text-pretty text-sm text-[var(--text-secondary)]"
              >
                Some event dates are unavailable. The dates we found are shown
                below.
              </p>
            ) : null}
            <EventTimelineViewport
              busy={data.isFetching}
              currentAndFutureEvents={renderMixedEntries(
                presentation.currentAndFuture
              )}
              hiddenEarlierCount={presentation.hiddenEarlierCount}
              hiddenLaterCount={presentation.hiddenLaterCount}
              nowAnchorRef={timelineAnchor.nowAnchorRef}
              onLoadEarlier={loadEarlier}
              onLoadLater={loadLater}
              onScroll={timelineAnchor.rememberPosition}
              pageSize={MERCHANT_EVENT_TIMELINE_PAGE_SIZE}
              pastEvents={renderMixedEntries(presentation.past)}
              viewportRef={timelineAnchor.timelineViewportRef}
            />
          </>
        ) : (
          <MerchantEventTimelineEmptyState
            relationship={relationship}
            datesUnavailable={futureDateReadIncomplete}
            unavailable={unavailable}
            limited={data.limited}
            onCreate={onCreate}
            createDisabled={createDisabled}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function MerchantEventTimelineEmptyState({
  relationship,
  datesUnavailable = false,
  unavailable = false,
  limited = false,
  onCreate,
  createDisabled = false,
}: {
  relationship: MerchantEventRelationshipFilter
  datesUnavailable?: boolean
  unavailable?: boolean
  limited?: boolean
  onCreate?: () => void
  createDisabled?: boolean
}) {
  const title = datesUnavailable
    ? "Event dates are unavailable"
    : unavailable
      ? "Couldn’t connect to your relays"
      : relationship === "organizing"
        ? "You aren’t organizing any events"
        : relationship === "selling"
          ? "You aren’t selling at any events"
          : "No events found on your relays"
  const description = datesUnavailable
    ? "An event was found, but its dates could not be read. Use Refresh to check again."
    : unavailable
      ? "Use Refresh to check the connection again."
      : relationship === "selling"
        ? "Browse All Events below to find an event to join."
        : relationship === "organizing"
          ? "Create an event to get started."
          : "Events available through your relays will appear here."
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] px-6 py-10 text-center">
      <CalendarDays
        className="mx-auto size-8 text-[var(--text-muted)]"
        aria-hidden="true"
      />
      <h3 className="mt-4 text-balance text-lg font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
        {description}
      </p>
      {limited && !unavailable && !datesUnavailable ? (
        <p
          role="status"
          className="mt-2 text-pretty text-xs text-[var(--text-muted)]"
        >
          Some relay checks did not finish.
        </p>
      ) : null}
      {relationship === "organizing" &&
      !unavailable &&
      !datesUnavailable &&
      onCreate ? (
        <Button
          type="button"
          size="sm"
          className="mt-4"
          onClick={onCreate}
          disabled={createDisabled}
        >
          <Plus className="size-4" aria-hidden="true" />
          Create event
        </Button>
      ) : null}
    </div>
  )
}
