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
  type EventMarketPerspectiveSource,
} from "@conduit/core"
import {
  Badge,
  Button,
  EventMarketCard,
  getOrganizerDiscoveryPresentation,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  getMerchantEventTimelineStatus,
  MERCHANT_EVENT_RELATIONSHIP_FILTERS,
  MERCHANT_EVENT_TIMELINE_WINDOWS,
  type MerchantEventRelationship,
  type MerchantEventRelationshipFilter,
  type MerchantEventTimelineSearch,
  type MerchantEventTimelineWindow,
} from "../lib/merchant-event-timeline"

const SOURCE_OPTIONS: EventMarketPerspectiveSource[] = [
  "combined",
  "following",
  "conduit",
]

const SOURCE_LABELS: Record<EventMarketPerspectiveSource, string> = {
  combined: "Combined",
  following: "Following",
  conduit: "Conduit",
}

const RELATIONSHIP_LABELS: Record<MerchantEventRelationshipFilter, string> = {
  all: "All events",
  organizing: "Organizing",
  selling: "Selling at",
  saved: "Saved",
}

const WINDOW_LABELS: Record<MerchantEventTimelineWindow, string> = {
  upcoming: "Upcoming",
  "7d": "Next 7 days",
  "30d": "Next 30 days",
  past: "Past events",
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
  source,
  search,
  onSourceChange,
  onSearchChange,
  onOpen,
  onCreate,
  createDisabled = false,
}: {
  merchantPubkey: string
  currentReference?: string
  source: EventMarketPerspectiveSource
  search: MerchantEventTimelineSearch
  onSourceChange: (source: EventMarketPerspectiveSource) => void
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
    source,
    currentReference,
    storageRevision,
  })
  const nowMs = Date.now()
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
  const discoveryPresentation = discovery.network
    ? getOrganizerDiscoveryPresentation({
        state: discovery.network.state,
        eventCount: discovery.network.markets.length,
        perspective: discovery.network.perspective,
        candidateScanCoverage: discovery.network.candidateScanCoverage,
        searchedOrganizerCount: discovery.network.searchedOrganizerCount,
        incompleteOrganizerCount: discovery.network.incompleteOrganizerCount,
      })
    : null
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
            Browse the same public Conduit and follow perspectives as Market.
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
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Network perspective
            </div>
            <div
              className="grid grid-cols-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
              role="group"
              aria-label="Event network perspective"
            >
              {SOURCE_OPTIONS.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={source === option ? "secondary" : "ghost"}
                  aria-pressed={source === option}
                  onClick={() => onSourceChange(option)}
                >
                  {SOURCE_LABELS[option]}
                </Button>
              ))}
            </div>
          </div>
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
              Exact links remain usable when bounded discovery is incomplete.
            </p>
          )}
        </form>
      </div>

      {discoveryPresentation ? (
        <div
          role={discoveryPresentation.role}
          aria-live="polite"
          className={
            discoveryPresentation.prominent
              ? "flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm leading-6 text-[var(--text-primary)] sm:flex-row sm:items-center sm:justify-between"
              : "flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)] sm:flex-row sm:items-center sm:justify-between"
          }
          data-testid="merchant-event-timeline-discovery-status"
        >
          <span className="text-pretty tabular-nums">
            {discoveryPresentation.message}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={discovery.isFetching}
            onClick={discovery.refetch}
          >
            <RefreshCw
              className={discovery.isFetching ? "animate-spin" : ""}
              aria-hidden="true"
            />
            Retry event discovery
          </Button>
        </div>
      ) : null}

      {discovery.isRefreshStale && !discoveryPresentation?.prominent ? (
        <div
          className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm leading-6 text-[var(--text-primary)] sm:flex-row sm:items-center sm:justify-between"
          role="status"
          aria-live="polite"
          data-testid="merchant-event-timeline-relationship-status"
        >
          <span>
            Some saved, owned, or product-linked event evidence is incomplete.
            Verified events remain available while this bounded view refreshes.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={discovery.isFetching}
            onClick={discovery.refetch}
          >
            <RefreshCw
              className={discovery.isFetching ? "animate-spin" : ""}
              aria-hidden="true"
            />
            Retry event relationships
          </Button>
        </div>
      ) : null}

      {discovery.unresolvedRelationshipCount > 0 ? (
        <div
          className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm leading-6 text-[var(--text-primary)]"
          role="status"
        >
          {discovery.unresolvedRelationshipCount} saved or product-linked event
          {discovery.unresolvedRelationshipCount === 1 ? "" : "s"} could not be
          verified in this relay view. Existing verified events remain
          available; retry before inferring that an event is gone.
        </div>
      ) : null}

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
        <div className="rounded-xl border border-dashed border-[var(--border)] px-6 py-12 text-center">
          <Search
            className="mx-auto h-8 w-8 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <h3 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">
            No matching verified events in this relay view
          </h3>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-muted)]">
            Change the relationship or date filter, retry discovery, or open a
            canonical event link. This bounded view does not prove an event is
            missing from the network.
          </p>
        </div>
      )}
    </section>
  )
}
