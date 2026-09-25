import { useCallback } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { normalizePubkey, pubkeyToNpub, useAuth } from "@conduit/core"
import {
  MARKET_SOURCE_OPTIONS,
  MarketBrowseNavigation,
} from "../../components/MarketBrowseNavigation"
import { MarketEventsTimeline } from "../../components/MarketEventsTimeline"
import type { EventTimelineSearch } from "../../lib/eventTimeline"
import {
  DEFAULT_MARKET_CATALOG_SOURCE,
  type ProductCatalogSourceMode,
} from "../../lib/productCatalogRead"

export const Route = createFileRoute("/events/")({
  component: EventsTimelinePage,
  validateSearch: (raw: Record<string, unknown>): EventTimelineSearch => {
    const source = MARKET_SOURCE_OPTIONS.includes(
      raw.source as ProductCatalogSourceMode
    )
      ? (raw.source as ProductCatalogSourceMode)
      : undefined
    const organizer =
      typeof raw.organizer === "string"
        ? (normalizePubkey(raw.organizer) ?? undefined)
        : undefined
    const location =
      typeof raw.location === "string" && raw.location.trim()
        ? raw.location.trim()
        : undefined

    return { source, organizer, location }
  },
})

function EventsTimelinePage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { status } = useAuth()
  const connected = status === "connected"
  const requestedSource = search.source ?? DEFAULT_MARKET_CATALOG_SOURCE
  const effectiveSource = connected ? requestedSource : "conduit"

  const updateSearch = useCallback(
    (nextSearch: EventTimelineSearch) => {
      const normalizedSearch = { ...nextSearch }
      delete normalizedSearch.window
      for (const key of Object.keys(
        normalizedSearch
      ) as (keyof EventTimelineSearch)[]) {
        const value = normalizedSearch[key]
        if (value === undefined || value === null || value === "") {
          delete normalizedSearch[key]
        }
      }
      if (normalizedSearch.organizer) {
        normalizedSearch.organizer = pubkeyToNpub(normalizedSearch.organizer)
      }
      void navigate({ search: normalizedSearch, replace: true })
    },
    [navigate]
  )

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <MarketBrowseNavigation
        active="events"
        source={effectiveSource}
        connected={connected}
        onSelectSource={(source) =>
          updateSearch({
            ...search,
            source:
              source === DEFAULT_MARKET_CATALOG_SOURCE ? undefined : source,
          })
        }
      />

      <MarketEventsTimeline
        source={effectiveSource}
        search={search}
        onSearchChange={updateSearch}
        onOpen={(collectionRef, occurrence) => {
          void navigate({
            to: "/events/$collectionRef",
            params: { collectionRef },
            search: occurrence ? { occurrence } : {},
          })
        }}
      />
    </div>
  )
}
