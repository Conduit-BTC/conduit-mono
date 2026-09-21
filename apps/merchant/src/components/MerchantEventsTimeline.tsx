import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, Plus, RefreshCw } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getProfileDisplayLabel,
  useAuth,
  useConduitSession,
  useProfiles,
} from "@conduit/core"
import {
  Button,
  cn,
  getResultPresentation,
  SegmentedControl,
  SegmentedControlItem,
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
  getMerchantEventTimelinePresentation,
  getNextMerchantEventTimelineLimit,
  MERCHANT_EVENT_RELATIONSHIP_FILTERS,
  MERCHANT_EVENT_TIMELINE_PAGE_SIZE,
  type MerchantEventRelationshipFilter,
  type MerchantEventTimelineItem,
  type MerchantEventTimelineSearch,
} from "../lib/merchant-event-timeline"
import { MerchantEventTimelineEntry } from "./MerchantEventTimelineEntry"

const RELATIONSHIP_LABELS: Record<MerchantEventRelationshipFilter, string> = {
  all: "All events",
  organizing: "Organizing",
  selling: "Selling at",
}

interface TimelineViewportPosition {
  scrollTop: number
}

interface TimelinePresentationLimits {
  earlier: number
  key: string
  later: number
}

const timelineViewportPositions = new Map<string, TimelineViewportPosition>()

function rememberTimelineViewport(
  key: string,
  viewport: HTMLDivElement | null
): void {
  if (!viewport) return
  timelineViewportPositions.set(key, {
    scrollTop: viewport.scrollTop,
  })
}

function preserveTimelineAnchor(
  viewport: HTMLDivElement | null,
  delta: number
): void {
  if (!viewport) return
  if (Math.abs(delta) < 0.5) return
  viewport.scrollTop += delta
}

function paginationControlLabel(
  direction: "earlier" | "later",
  hiddenCount: number
): string {
  const count = Math.min(hiddenCount, MERCHANT_EVENT_TIMELINE_PAGE_SIZE)
  return `Load ${count} ${direction} ${count === 1 ? "event" : "events"}`
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
  onOpen: (reference: string) => void
  onCreate: () => void
  createDisabled?: boolean
}) {
  const timelineId = useId()
  const queryClient = useQueryClient()
  const session = useConduitSession()
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const relationship = search.relation ?? "all"
  const viewportKey = `${merchantPubkey}:${relationship}`
  const restoredViewportKeyRef = useRef<string | null>(null)
  const timelineViewportRef = useRef<HTMLDivElement>(null)
  const nowAnchorRef = useRef<HTMLDivElement>(null)
  const pendingPrependAnchorTopRef = useRef<number | null>(null)
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
  const timelineBoundaries = useMemo(
    () => getMerchantEventTimelineBoundaries(discovery.items),
    [discovery.items]
  )
  const nowMs = useTimeBoundaryNow(timelineBoundaries)
  const filteredItems = useMemo(
    () => filterAndSortMerchantEventTimeline(discovery.items, search, nowMs),
    [discovery.items, nowMs, search]
  )
  const presentation = useMemo(
    () =>
      getMerchantEventTimelinePresentation(
        filteredItems,
        {
          earlier: activePresentationLimits.earlier,
          later: activePresentationLimits.later,
        },
        nowMs
      ),
    [
      activePresentationLimits.earlier,
      activePresentationLimits.later,
      filteredItems,
      nowMs,
    ]
  )
  const presentedItems = useMemo(
    () => [...presentation.past, ...presentation.currentAndFuture],
    [presentation.currentAndFuture, presentation.past]
  )
  const organizerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(presentedItems.map((item) => item.market.organizerPubkey))
      ),
    [presentedItems]
  )
  const profiles = useProfiles(organizerPubkeys, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    priority: "visible",
    maxUnresolvedRefetches: 1,
    relayHintsByPubkey: discovery.profileRelayHintsByPubkey,
  })
  const discoveryComplete =
    !!discovery.network &&
    ["complete", "complete_empty"].includes(discovery.network.state) &&
    !discovery.isRefreshStale &&
    discovery.network.perspective.truncated !== true
  const resultPresentation = getResultPresentation({
    resultCount: discovery.items.length,
    visibleResultCount: filteredItems.length,
    reliability: discoveryComplete ? "complete" : "degraded",
  })
  useLayoutEffect(() => {
    if (restoredViewportKeyRef.current === viewportKey) return
    if (filteredItems.length === 0 || typeof window === "undefined") return
    const frame = window.requestAnimationFrame(() => {
      const viewport = timelineViewportRef.current
      const nowAnchor = nowAnchorRef.current
      if (!viewport || !nowAnchor) return
      const hasSavedPosition = timelineViewportPositions.has(viewportKey)
      const saved = timelineViewportPositions.get(viewportKey)
      viewport.scrollTop = saved
        ? saved.scrollTop
        : Math.max(
            0,
            viewport.scrollTop +
              nowAnchor.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top
          )
      // Progressive discovery can prepend past events after the first useful
      // result. Keep Now anchored until that initial read settles, then leave
      // subsequent background refreshes alone so they never steal the scroll.
      if (hasSavedPosition || !discovery.isFetching) {
        restoredViewportKeyRef.current = viewportKey
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    discovery.isFetching,
    filteredItems.length,
    presentation.past.length,
    viewportKey,
  ])

  useLayoutEffect(() => {
    const previousTop = pendingPrependAnchorTopRef.current
    if (previousTop === null) return
    pendingPrependAnchorTopRef.current = null
    const nextTop = nowAnchorRef.current?.getBoundingClientRect().top
    if (nextTop === undefined) return
    preserveTimelineAnchor(timelineViewportRef.current, nextTop - previousTop)
  }, [presentation.past.length])

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
    rememberTimelineViewport(viewportKey, timelineViewportRef.current)
    onOpen(market.naddr)
  }

  function changeRelationship(value: string): void {
    const nextRelationship = value as MerchantEventRelationshipFilter
    rememberTimelineViewport(viewportKey, timelineViewportRef.current)
    onSearchChange({
      relation: nextRelationship === "all" ? undefined : nextRelationship,
    })
  }

  function loadEarlier(): void {
    pendingPrependAnchorTopRef.current =
      nowAnchorRef.current?.getBoundingClientRect().top ?? null
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
      <MerchantEventTimelineEntry
        key={market.collectionCoordinate}
        market={market}
        organizerName={getProfileDisplayLabel(profile, market.organizerPubkey, {
          lookupSettled: profiles.lookupSettled,
        })}
        organizerPending={!profiles.lookupSettled && !profile}
        onOpen={() => openMarket(market)}
      />
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
              : `${filteredItems.length} ${filteredItems.length === 1 ? "event" : "events"}`}
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
        <div className="space-y-5" role="status" aria-label="Loading events">
          <span className="sr-only">Loading events</span>
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4"
              aria-hidden="true"
            >
              <div className="h-14 rounded-lg bg-[var(--surface-elevated)]" />
              <div className="relative">
                <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--border)]" />
              </div>
              <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="aspect-[3/1] bg-[var(--surface-elevated)]" />
                <div className="space-y-3 p-4">
                  <div className="h-5 w-2/3 rounded bg-[var(--surface-elevated)]" />
                  <div className="h-4 w-1/2 rounded bg-[var(--surface-elevated)]" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filteredItems.length > 0 ? (
        <div
          ref={timelineViewportRef}
          id={`${timelineId}-results`}
          role="region"
          aria-label="Chronological events"
          tabIndex={0}
          className="max-h-[70dvh] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border)] bg-[var(--background)] px-3 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:px-5"
          aria-busy={discovery.isFetching}
        >
          {presentation.hiddenEarlierCount > 0 ? (
            <div className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 pb-4 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4">
              <span />
              <span className="relative" aria-hidden="true">
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
              </span>
              <div className="flex justify-center sm:justify-start">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-controls={`${timelineId}-past-events`}
                  onClick={loadEarlier}
                >
                  {paginationControlLabel(
                    "earlier",
                    presentation.hiddenEarlierCount
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          <ol id={`${timelineId}-past-events`} aria-label="Past events">
            {presentation.past.map(renderEntry)}
          </ol>

          <div
            ref={nowAnchorRef}
            id={`${timelineId}-now`}
            role="separator"
            aria-label="Now"
            className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 py-2 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4"
          >
            <span className="self-center text-right text-sm font-semibold text-primary-500">
              Now
            </span>
            <span className="relative min-h-8" aria-hidden="true">
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary-500" />
              <span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--background)] bg-primary-500 ring-1 ring-primary-500" />
            </span>
            <span
              className="self-center h-px bg-primary-500/50"
              aria-hidden="true"
            />
          </div>

          <ol
            id={`${timelineId}-current-and-future-events`}
            aria-label="Current and upcoming events"
          >
            {presentation.currentAndFuture.map(renderEntry)}
          </ol>

          {presentation.hiddenLaterCount > 0 ? (
            <div className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 pt-1 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4">
              <span />
              <span className="relative" aria-hidden="true">
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
              </span>
              <div className="flex justify-center sm:justify-start">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-controls={`${timelineId}-current-and-future-events`}
                  onClick={loadLater}
                >
                  {paginationControlLabel(
                    "later",
                    presentation.hiddenLaterCount
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
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
            {resultPresentation.kind === "degraded_empty"
              ? "Events couldn't be fully loaded"
              : resultPresentation.kind === "filter_empty"
                ? "No events match this relationship"
                : "No events yet"}
          </h3>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-muted)]">
            {resultPresentation.kind === "degraded_empty"
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
              disabled={discovery.isFetching}
              onClick={discovery.refetch}
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
              <Plus aria-hidden="true" />
              Create event
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
