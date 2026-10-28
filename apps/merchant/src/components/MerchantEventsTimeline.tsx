import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, ChevronDown, Plus, RefreshCw } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import {
  useProgressiveEventMarketDiscovery,
  encodeEventMarketNaddr,
  getProfileDisplayLabel,
  useAuth,
  useConduitSession,
  useProfiles,
  readEventMarketRoster,
} from "@conduit/core"
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EventTimelineEntry,
  EventTimelineViewport,
  paginateEventTimeline,
  SegmentedControl,
  SegmentedControlItem,
  useEventTimelineAnchor,
  useTimeBoundaryNow,
} from "@conduit/ui"
import { useMerchantEventTimeline } from "../hooks/useMerchantEventTimeline"
import {
  hydrateMerchantProductMarkets,
  isMerchantTimelineMarketReadIncomplete,
  mergeMerchantTimelineMarketReads,
} from "../lib/merchant-event-relationship-hydration"

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

// Keep revealed pages with the scroll position when an event is opened and
// the directory is remounted by back navigation. This is browser-memory only.
const savedPresentationLimits = new Map<string, TimelinePresentationLimits>()
const savedSectionVisibility = new Map<string, boolean>()

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
  const ownQuery = useProgressiveEventMarketDiscovery({
    queryKey: [
      "merchant-owned-event-timeline",
      session.relayScope,
      authenticatedPubkey,
      authGeneration,
      merchantPubkey,
    ],
    discoveryInput: {
      organizerPubkeys: [merchantPubkey],
      authenticatedPubkey,
      shouldContinue: () => authGenerationRef.current === authGeneration,
    },
    enabled: session.relaySettingsReady && !!merchantPubkey,
    refetchInterval: 60_000,
  })
  const futureAuthors = useMemo(
    () =>
      Array.from(
        new Set(
          (discovery.perspective.organizerPubkeys ?? []).filter(
            (author) => author !== merchantPubkey
          )
        )
      ),
    [discovery.perspective.organizerPubkeys, merchantPubkey]
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
    enabled:
      session.relaySettingsReady &&
      !!merchantPubkey &&
      futureAuthors.length > 0,
    refetchInterval: 60_000,
  })
  const marketReads = useMemo(
    () =>
      mergeMerchantTimelineMarketReads(
        mergeMerchantTimelineMarketReads(
          ownQuery.data?.markets ?? [],
          futureQuery.data?.markets ?? []
        ),
        discovery.relationships.markets
      ),
    [
      ownQuery.data?.markets,
      futureQuery.data?.markets,
      discovery.relationships.markets,
    ]
  )
  const sellingCoordinates = marketReads
    .filter((read) =>
      matchesMerchantEventRelationship(read, merchantPubkey, "selling")
    )
    .map((read) => read.coordinate)
    .sort()
  const sellingQuery = useQuery({
    queryKey: [
      "merchant-selling-event-refresh",
      session.relayScope,
      authenticatedPubkey,
      authGeneration,
      merchantPubkey,
    ],
    queryFn: ({ signal }) =>
      hydrateMerchantProductMarkets({
        references: sellingCoordinates,
        signal,
        shouldContinue: () => authGenerationRef.current === authGeneration,
        read: (reference, marketSignal) =>
          readEventMarketRoster({
            reference,
            authenticatedPubkey,
            signal: marketSignal,
            shouldContinue: () =>
              !signal.aborted && authGenerationRef.current === authGeneration,
          }),
      }),
    enabled: false,
    retry: false,
  })
  // Refreshed signed evidence outlives coordinate-set changes. Only current
  // coordinates contribute rows; auth, relay and merchant changes use a new key.
  const currentSellingCoordinates = new Set(sellingCoordinates)
  const knownRosterReads = (sellingQuery.data?.markets ?? []).filter((read) =>
    currentSellingCoordinates.has(read.coordinate)
  )
  const allReads = mergeMerchantTimelineMarketReads(
    marketReads,
    knownRosterReads
  )
  const networkPending =
    discovery.perspective.isInitialLoading ||
    (futureAuthors.length > 0 && futureQuery.isPending)
  const ownerIncomplete =
    ownQuery.isError ||
    (!!ownQuery.data && ownQuery.data.coverage !== "complete")
  const futureIncomplete =
    futureQuery.isError ||
    (!!futureQuery.data && futureQuery.data.coverage !== "complete")
  const knownRosterIncomplete =
    sellingQuery.isError ||
    (sellingQuery.data?.failedCount ?? 0) > 0 ||
    knownRosterReads.some(isMerchantTimelineMarketReadIncomplete)
  const ownerUnavailable =
    (ownQuery.isError && !ownQuery.data) ||
    ownQuery.data?.coverage === "unavailable"
  const futureUnavailable =
    (futureQuery.isError && !futureQuery.data) ||
    futureQuery.data?.coverage === "unavailable"
  const knownRosterAvailable = knownRosterReads.some(
    (read) => read.coverage !== "unavailable" || read.retained
  )
  const organizingUnavailable =
    ownerUnavailable &&
    discovery.relationships.unavailable &&
    !knownRosterAvailable
  const compositeUnavailable =
    organizingUnavailable && (futureAuthors.length === 0 || futureUnavailable)
  const networkLimited =
    networkPending || discovery.perspective.incomplete || futureIncomplete
  const refetchIncludedSources = () =>
    Promise.all([
      discovery.perspective.refetch(),
      discovery.relationships.refetch(),
      !ownQuery.isFetching && !ownQuery.isPaused
        ? ownQuery.refetch({ cancelRefetch: false })
        : undefined,
      futureAuthors.length > 0 &&
      !futureQuery.isFetching &&
      !futureQuery.isPaused
        ? futureQuery.refetch({ cancelRefetch: false })
        : undefined,
      sellingCoordinates.length > 0 &&
      !sellingQuery.isFetching &&
      !sellingQuery.isPaused
        ? sellingQuery.refetch({ cancelRefetch: false })
        : undefined,
    ])
  return {
    marketReads: allReads,
    futureOccurrences: allReads.flatMap(
      projectFutureMerchantTimelineOccurrences
    ),
    organizing: {
      initialLoading: ownQuery.isPending,
      isFetching: ownQuery.isFetching,
      unavailable: organizingUnavailable,
      limited:
        ownerIncomplete ||
        knownRosterIncomplete ||
        discovery.relationships.isInitialLoading ||
        discovery.relationships.incomplete ||
        discovery.relationships.unavailable,
      refetch: () =>
        Promise.all([
          !ownQuery.isFetching && !ownQuery.isPaused
            ? ownQuery.refetch({ cancelRefetch: false })
            : undefined,
          discovery.relationships.refetch(),
        ]),
    },
    selling: {
      initialLoading: discovery.relationships.isInitialLoading,
      isFetching: discovery.relationships.isFetching || sellingQuery.isFetching,
      unavailable: compositeUnavailable,
      limited:
        networkLimited ||
        ownQuery.isPending ||
        ownerIncomplete ||
        discovery.relationships.incomplete ||
        knownRosterIncomplete,
      refetch: refetchIncludedSources,
    },
    all: {
      initialLoading: networkPending || ownQuery.isPending,
      isFetching:
        discovery.perspective.isFetching ||
        futureQuery.isFetching ||
        ownQuery.isFetching ||
        sellingQuery.isFetching,
      unavailable: compositeUnavailable,
      limited:
        networkLimited ||
        ownerIncomplete ||
        discovery.relationships.isInitialLoading ||
        discovery.relationships.incomplete ||
        discovery.relationships.unavailable ||
        knownRosterIncomplete,
      refetch: refetchIncludedSources,
    },
    accountPubkey,
    authenticatedPubkey,
    authGeneration,
    authGenerationRef,
    isAuthGenerationCurrent,
    refreshScope: session.relayScope,
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
  const pageRestorationRef = useRef<string | null>(null)
  const relationship =
    props.search.relation === "selling" ? "selling" : "organizing"
  const pagePositionKey = `merchant-events-page:${props.merchantPubkey}:${relationship}`
  const pageIsFetching = data[relationship].isFetching || data.all.isFetching
  const hasMyEvents = data.futureOccurrences.some(({ read }) =>
    matchesMerchantEventRelationship(read, props.merchantPubkey, relationship)
  )
  const mySectionClosed =
    savedSectionVisibility.get(`${props.merchantPubkey}:${relationship}`) ===
    false
  return (
    <div className="space-y-6">
      <MerchantEventTimelineSection
        {...props}
        data={{ ...data, ...data[relationship] }}
        title="My Events"
        relationship={relationship}
        pagePositionKey={pagePositionKey}
        pageIsFetching={pageIsFetching}
        pageRestorationRef={pageRestorationRef}
        restorePageOnMount
      />
      <MerchantEventTimelineSection
        {...props}
        data={{ ...data, ...data.all }}
        title="All Events"
        relationship="all"
        pagePositionKey={pagePositionKey}
        pageIsFetching={pageIsFetching}
        pageRestorationRef={pageRestorationRef}
        restorePageOnMount={!hasMyEvents || mySectionClosed}
      />
    </div>
  )
}

function MerchantEventTimelineSection({
  merchantPubkey,
  relationship,
  title,
  data,
  pagePositionKey,
  pageIsFetching,
  pageRestorationRef,
  restorePageOnMount,
  onSearchChange,
  onOpen,
  onCreate,
  createDisabled = false,
}: MerchantEventsTimelineProps & {
  relationship: MerchantEventRelationshipFilter
  title: string
  pagePositionKey: string
  pageIsFetching: boolean
  pageRestorationRef: { current: string | null }
  restorePageOnMount: boolean
  data: ReturnType<typeof useMerchantEventTimelineData> &
    ReturnType<typeof useMerchantEventTimelineData>[
      "organizing" | "selling" | "all"]
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
  const presentationKey = `${merchantPubkey}:${relationship}`
  const [sectionVisibility, setSectionVisibility] = useState<
    Record<string, boolean>
  >({})
  const open =
    sectionVisibility[presentationKey] ??
    savedSectionVisibility.get(presentationKey) ??
    true
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const refreshKey = JSON.stringify([
    data.refreshScope,
    merchantPubkey,
    authGeneration,
    relationship,
  ])
  const isFetching = data.isFetching || refreshing[refreshKey] === true
  async function refresh() {
    setRefreshing((current) => ({ ...current, [refreshKey]: true }))
    try {
      await data.refetch()
    } finally {
      setRefreshing((current) => {
        const next = { ...current }
        delete next[refreshKey]
        return next
      })
    }
  }
  const [presentationLimits, setPresentationLimits] = useState<
    Record<string, TimelinePresentationLimits>
  >({})
  const activePresentationLimits = useMemo(
    () =>
      presentationLimits[relationship] ??
      savedPresentationLimits.get(presentationKey) ?? {
        earlier: 0,
        key: relationship,
        later: MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
      },
    [presentationLimits, presentationKey, relationship]
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
    isFetching: pageIsFetching || isFetching,
    itemCount: open ? visibleFutureOccurrences.length : 0,
    pastCount: presentation.past.length,
    viewportKey: pagePositionKey,
    scrollMode: "page",
    restorationRef: pageRestorationRef,
    restoreOnMount: restorePageOnMount,
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
    const next = {
      ...activePresentationLimits,
      earlier: getNextMerchantEventTimelineLimit(
        activePresentationLimits.earlier,
        totalCount
      ),
    }
    savedPresentationLimits.set(presentationKey, next)
    setPresentationLimits((current) => ({ ...current, [relationship]: next }))
  }

  function loadLater(): void {
    const totalCount =
      presentation.currentAndFuture.length + presentation.hiddenLaterCount
    const next = {
      ...activePresentationLimits,
      later: getNextMerchantEventTimelineLimit(
        activePresentationLimits.later,
        totalCount
      ),
    }
    savedPresentationLimits.set(presentationKey, next)
    setPresentationLimits((current) => ({ ...current, [relationship]: next }))
  }

  function hideEarlier(): void {
    timelineAnchor.prepareForPrepend()
    const next = { ...activePresentationLimits, earlier: 0 }
    savedPresentationLimits.set(presentationKey, next)
    setPresentationLimits((current) => ({ ...current, [relationship]: next }))
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
        savedSectionVisibility.set(presentationKey, next)
        setSectionVisibility((current) => ({
          ...current,
          [presentationKey]: next,
        }))
      }}
      className="space-y-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-[var(--radius-md)] py-2 text-left text-lg font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:text-xl">
            <ChevronDown
              className="size-5 shrink-0 group-data-[state=closed]:-rotate-90"
              aria-hidden="true"
            />
            <span className="text-balance">{title}</span>
            <span
              className="ml-auto text-sm font-normal tabular-nums text-[var(--text-muted)]"
              aria-live="polite"
            >
              {initialLoading
                ? "Loading"
                : `${visibleFutureOccurrences.length} ${visibleFutureOccurrences.length === 1 ? "event" : "events"}`}
            </span>
          </CollapsibleTrigger>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Refresh ${relationship === "all" ? "All Events" : RELATIONSHIP_LABELS[relationship]}`}
          disabled={isFetching}
          onClick={refresh}
          className="shrink-0"
        >
          <RefreshCw
            className={cn(
              "size-4",
              isFetching && "animate-spin motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>
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
          <div
            role="status"
            aria-label="Loading events"
            className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
          >
            <span className="sr-only">Loading events</span>
            {[0, 1].map((row) => (
              <div
                key={row}
                aria-hidden="true"
                className="flex h-10 items-center gap-3"
              >
                <div className="size-8 shrink-0 rounded bg-[var(--surface-elevated)]" />
                <div className="h-3 w-2/3 rounded bg-[var(--surface-elevated)]" />
              </div>
            ))}
          </div>
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
              scrollMode="page"
              busy={isFetching}
              currentAndFutureEvents={renderMixedEntries(
                presentation.currentAndFuture
              )}
              hiddenEarlierCount={presentation.hiddenEarlierCount}
              hiddenLaterCount={presentation.hiddenLaterCount}
              nowAnchorRef={timelineAnchor.nowAnchorRef}
              onLoadEarlier={loadEarlier}
              onHideEarlier={hideEarlier}
              onLoadLater={loadLater}
              onScroll={timelineAnchor.rememberPosition}
              pageSize={MERCHANT_EVENT_TIMELINE_PAGE_SIZE}
              pastEvents={renderMixedEntries(presentation.past)}
              visiblePastCount={presentation.past.length}
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
      : limited
        ? relationship === "organizing"
          ? "No organizing events found yet"
          : relationship === "selling"
            ? "No selling events found yet"
            : "No events found yet"
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
    <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] p-4">
      <div className="flex items-center gap-2">
        <CalendarDays
          className="size-5 shrink-0 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <h3 className="text-balance text-sm font-semibold text-[var(--text-primary)] sm:text-base">
          {title}
        </h3>
      </div>
      <p className="mt-2 max-w-xl text-pretty text-sm text-[var(--text-secondary)]">
        {description}
      </p>
      {relationship === "organizing" &&
      !unavailable &&
      !datesUnavailable &&
      onCreate ? (
        <Button
          type="button"
          size="sm"
          className="mt-3"
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
