import { useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  CalendarDays,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react"
import {
  formatNpub,
  getProfileDisplayLabel,
  useAuth,
  useProfiles,
} from "@conduit/core"
import {
  Badge,
  Button,
  EventMarketCard,
  getResultPresentation,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useTimeBoundaryNow,
} from "@conduit/ui"
import { useMerchantEventTimeline } from "../hooks/useMerchantEventTimeline"
import {
  parseOrganizerEventMarketReference,
  type MerchantOrganizerEventMarket,
} from "../lib/event-market"
import { rememberDiscoveredEventMarket } from "../lib/event-market-workflow"
import {
  filterAndSortMerchantEventTimeline,
  formatMerchantEventTimelineSchedule,
  getMerchantEventTimelineBoundaries,
  getMerchantEventTimelineStatus,
  MERCHANT_EVENT_RELATIONSHIP_FILTERS,
  MERCHANT_EVENT_TIMELINE_WINDOWS,
  type MerchantEventRelationship,
  type MerchantEventRelationshipFilter,
  type MerchantEventTimelineSearch,
  type MerchantEventTimelineWindow,
} from "../lib/merchant-event-timeline"

const RELATIONSHIP_LABELS: Record<MerchantEventRelationshipFilter, string> = {
  all: "All events",
  organizing: "Organizing",
  selling: "Selling at",
  saved: "Saved",
}

const WINDOW_LABELS: Record<MerchantEventTimelineWindow, string> = {
  upcoming: "Open & upcoming",
  "7d": "Next 7 days",
  "30d": "Next 30 days",
  past: "Past events",
  history: "History",
  all: "All dates",
}

function relationshipActionLabel(
  relationships: readonly MerchantEventRelationship[]
): string {
  if (relationships.includes("organizing")) return "Manage"
  if (relationships.includes("selling")) return "Open"
  return "Sell here"
}

function organizerFallback(market: MerchantOrganizerEventMarket): string {
  return market.organizerPubkey.slice(0, 1).toUpperCase() || "C"
}

export function MerchantEventsTimeline({
  merchantPubkey,
  currentReference,
  search,
  onSearchChange,
  onOpen,
  onCreate,
  createDisabled = false,
}: {
  merchantPubkey: string
  currentReference?: string
  search: MerchantEventTimelineSearch
  onSearchChange: (search: MerchantEventTimelineSearch) => void
  onOpen: (reference: string) => void
  onCreate: () => void
  createDisabled?: boolean
}) {
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const [storageRevision, setStorageRevision] = useState(0)
  const [importValue, setImportValue] = useState("")
  const [importError, setImportError] = useState("")
  const discovery = useMerchantEventTimeline({
    merchantPubkey,
    source: "combined",
    currentReference,
    storageRevision,
  })
  const timelineBoundaries = useMemo(
    () => getMerchantEventTimelineBoundaries(discovery.items, search.window),
    [discovery.items, search.window]
  )
  const nowMs = useTimeBoundaryNow(timelineBoundaries)
  const visibleItems = useMemo(
    () => filterAndSortMerchantEventTimeline(discovery.items, search, nowMs),
    [discovery.items, nowMs, search]
  )
  const organizerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(visibleItems.map((item) => item.market.organizerPubkey))
      ),
    [visibleItems]
  )
  const profiles = useProfiles(organizerPubkeys, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    priority: "visible",
    maxUnresolvedRefetches: 1,
    relayHintsByPubkey: discovery.profileRelayHintsByPubkey,
  })
  const resultPresentation = getResultPresentation({
    resultCount: discovery.items.length,
    visibleResultCount: visibleItems.length,
    reliability:
      discovery.network &&
      ["complete", "complete_empty"].includes(discovery.network.state) &&
      !discovery.isRefreshStale
        ? "complete"
        : "degraded",
  })
  const selectedCoordinate = useMemo(() => {
    if (!currentReference) return null
    try {
      return parseOrganizerEventMarketReference(currentReference).coordinate
    } catch {
      return null
    }
  }, [currentReference])

  function openMarket(market: MerchantOrganizerEventMarket): void {
    rememberDiscoveredEventMarket(merchantPubkey, {
      reference: market.naddr,
      title: market.title,
      savedAt: Date.now(),
    })
    setStorageRevision((current) => current + 1)
    onOpen(market.naddr)
  }

  function importEvent(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    try {
      const parsed = parseOrganizerEventMarketReference(importValue)
      rememberDiscoveredEventMarket(merchantPubkey, {
        reference: parsed.naddr,
        savedAt: Date.now(),
      })
      setStorageRevision((current) => current + 1)
      setImportValue("")
      setImportError("")
      onOpen(parsed.naddr)
    } catch (error) {
      setImportError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Paste a valid event naddr or shopper link."
      )
    }
  }

  return (
    <section
      className="space-y-5"
      aria-labelledby="merchant-events-timeline-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2
            id="merchant-events-timeline-title"
            className="text-balance text-xl font-semibold text-[var(--text-primary)]"
          >
            Event timeline
          </h2>
          <p className="mt-1 max-w-3xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Browse events from your network and Conduit discovery together.
            Events you organize, sell at, or save stay available by their exact
            signed coordinates.
          </p>
        </div>
        <Button type="button" onClick={onCreate} disabled={createDisabled}>
          <Plus aria-hidden="true" />
          Create event
        </Button>
      </div>

      <div className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5 text-xs text-[var(--text-secondary)]">
              <Label
                htmlFor="timeline-relationship-filter"
                className="flex items-center gap-1.5"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                Relationship
              </Label>
              <Select
                value={search.relation ?? "all"}
                onValueChange={(value) =>
                  onSearchChange({
                    ...search,
                    relation: value as MerchantEventRelationshipFilter,
                  })
                }
              >
                <SelectTrigger id="timeline-relationship-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MERCHANT_EVENT_RELATIONSHIP_FILTERS.map((relationship) => (
                    <SelectItem key={relationship} value={relationship}>
                      {RELATIONSHIP_LABELS[relationship]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 text-xs text-[var(--text-secondary)]">
              <Label
                htmlFor="timeline-date-filter"
                className="flex items-center gap-1.5"
              >
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                Date
              </Label>
              <Select
                value={search.window ?? "upcoming"}
                onValueChange={(value) =>
                  onSearchChange({
                    ...search,
                    window: value as MerchantEventTimelineWindow,
                  })
                }
              >
                <SelectTrigger id="timeline-date-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MERCHANT_EVENT_TIMELINE_WINDOWS.map((window) => (
                    <SelectItem key={window} value={window}>
                      {WINDOW_LABELS[window]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <form className="grid content-start gap-1.5" onSubmit={importEvent}>
          <Label htmlFor="event-timeline-import">Open a known event</Label>
          <div className="flex gap-2">
            <Input
              id="event-timeline-import"
              value={importValue}
              onChange={(event) => setImportValue(event.target.value)}
              placeholder="naddr1... or https://..."
              aria-invalid={!!importError}
              aria-describedby={
                importError ? "event-timeline-import-error" : undefined
              }
            />
            <Button
              type="submit"
              variant="outline"
              disabled={!importValue.trim()}
            >
              <Search aria-hidden="true" />
              Open
            </Button>
          </div>
          {importError ? (
            <p
              id="event-timeline-import-error"
              className="text-xs text-error"
              role="alert"
            >
              {importError}
            </p>
          ) : (
            <p className="text-xs leading-5 text-[var(--text-muted)]">
              Paste a known event address or shopper link to open it directly.
            </p>
          )}
        </form>
      </div>

      {discovery.isInitialLoading ? (
        <div
          className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Loading events"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="h-80 animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]"
            />
          ))}
        </div>
      ) : visibleItems.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visibleItems.map((item) => {
            const market = item.market
            const profile = profiles.getProfile(market.organizerPubkey)
            const status = getMerchantEventTimelineStatus(item, nowMs)
            return (
              <div key={market.collectionCoordinate} className="space-y-2">
                <EventMarketCard
                  title={market.title}
                  summary={market.summary}
                  imageUrl={market.imageUrl}
                  organizerName={getProfileDisplayLabel(
                    profile,
                    market.organizerPubkey,
                    { lookupSettled: profiles.lookupSettled }
                  )}
                  organizerImageUrl={profile?.picture}
                  organizerFallback={organizerFallback(market)}
                  organizerPending={!profiles.lookupSettled && !profile}
                  schedule={formatMerchantEventTimelineSchedule(market)}
                  location={market.eventLocation ?? market.eventGeohash}
                  statusLabel={status.label}
                  statusTone={status.tone}
                  topics={market.source.calendar?.topics}
                  className={
                    selectedCoordinate === market.collectionCoordinate
                      ? "border-primary-500"
                      : undefined
                  }
                  action={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`${relationshipActionLabel(item.relationships)} ${market.title}`}
                      onClick={() => openMarket(market)}
                    >
                      {relationshipActionLabel(item.relationships)}
                    </Button>
                  }
                />
                {item.relationships.length > 0 ? (
                  <div
                    className="flex flex-wrap gap-1.5 px-1"
                    aria-label={`Your relationship to ${market.title}`}
                  >
                    {item.relationships.map((relationship) => (
                      <Badge key={relationship} variant="outline">
                        {RELATIONSHIP_LABELS[relationship]}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <span className="sr-only">
                  Organized by {formatNpub(market.organizerPubkey)}
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <div
          className={
            resultPresentation.visibility === "compact"
              ? "rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-6 py-12 text-center"
              : "rounded-xl border border-dashed border-[var(--border)] px-6 py-12 text-center"
          }
          role={
            resultPresentation.visibility === "compact" ? "alert" : undefined
          }
        >
          <Search
            className="mx-auto h-8 w-8 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <h3 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">
            {resultPresentation.kind === "degraded_empty"
              ? "Events couldn't be fully loaded"
              : resultPresentation.kind === "filter_empty"
                ? "No events match these filters"
                : "No events yet"}
          </h3>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-muted)]">
            {resultPresentation.kind === "degraded_empty"
              ? "Retry to check for events, or open a known event directly."
              : resultPresentation.kind === "filter_empty"
                ? resultPresentation.visibility === "compact"
                  ? "Discovery is incomplete, so matching events may still be available. Retry or change the relationship or date filter."
                  : "Change the relationship or date filter to see other events."
                : "Open a known event directly or create your first event."}
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
              <RefreshCw
                className={discovery.isFetching ? "animate-spin" : ""}
                aria-hidden="true"
              />
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </section>
  )
}
