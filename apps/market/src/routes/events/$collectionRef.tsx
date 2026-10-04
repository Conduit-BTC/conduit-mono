import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import {
  decodeEventMarketReference,
  normalizePubkey,
  pubkeyToNpub,
} from "@conduit/core"
import { Button } from "@conduit/ui"
import { FutureEventMarketPage } from "../../components/FutureEventMarketPage"
import { parseEventCatalogSearch } from "../../lib/event-catalog-search"

export const Route = createFileRoute("/events/$collectionRef")({
  component: EventCatalogRoute,
  validateSearch: parseEventCatalogSearch,
})

function EventCatalogRoute() {
  const { collectionRef } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  return decodeEventMarketReference(collectionRef, [30409]) ? (
    <FutureEventMarketPage
      reference={collectionRef}
      selectedMerchant={normalizePubkey(search.merchant) ?? undefined}
      selectedOccurrence={search.occurrence}
      onOccurrenceChange={(occurrence) =>
        void navigate({
          search: {
            ...(search.merchant ? { merchant: search.merchant } : {}),
            ...(occurrence ? { occurrence } : {}),
          },
          replace: true,
        })
      }
      onMerchantChange={(merchant) =>
        void navigate({
          search: {
            ...(merchant ? { merchant: pubkeyToNpub(merchant) } : {}),
            ...(search.occurrence ? { occurrence: search.occurrence } : {}),
          },
          replace: true,
        })
      }
    />
  ) : (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-balance text-2xl font-semibold">
        This event needs to be reposted
      </h1>
      <p className="text-pretty text-[var(--text-secondary)]">
        Ask the organizer for a new Event Market link.
      </p>
      <Button asChild>
        <Link to="/events">Browse events</Link>
      </Button>
    </div>
  )
}
