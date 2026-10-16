import { useEffect } from "react"
import { Loader2, Plus } from "lucide-react"
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router"
import { useAuth } from "@conduit/core"
import { Button, PageHeader, PageLayout } from "@conduit/ui"
import { MerchantEventsTimeline } from "../components/MerchantEventsTimeline"
import { parseMerchantEventsSearch } from "../lib/market-links"

export const Route = createFileRoute("/events")({
  validateSearch: parseMerchantEventsSearch,
  component: EventsLayout,
})

function EventsLayout() {
  const { event, relation } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  useEffect(() => {
    if (!event) return
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: event },
      search: { relation },
      replace: true,
    })
  }, [event, relation, navigate])
  if (event)
    return (
      <div
        className="flex min-h-48 items-center justify-center gap-2 text-sm text-[var(--text-muted)]"
        aria-busy="true"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Opening event…
      </div>
    )
  return <Outlet />
}

export function EventsDirectoryPage() {
  const { accountPubkey } = useAuth()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const merchantPubkey = accountPubkey ?? ""
  const createEvent = () => {
    void navigate({ to: "/events/new", search: { relation: search.relation } })
  }
  return (
    <PageLayout>
      <PageHeader
        title="Events"
        description="Find events where you can sell, or create and manage an event of your own."
        actions={
          <Button type="button" onClick={createEvent}>
            <Plus aria-hidden="true" className="size-4 shrink-0" />
            Create event
          </Button>
        }
      />
      <MerchantEventsTimeline
        key={merchantPubkey || "disconnected"}
        merchantPubkey={merchantPubkey}
        search={{ relation: search.relation }}
        onSearchChange={(next) =>
          void navigate({
            to: "/events",
            search: {
              relation:
                !next.relation || next.relation === "all"
                  ? undefined
                  : next.relation,
            },
            replace: true,
          })
        }
        onOpen={(reference, occurrence) =>
          void navigate({
            to: "/events/$collectionRef",
            params: { collectionRef: reference },
            search: {
              relation: search.relation,
              ...(occurrence ? { occurrence } : {}),
            },
          })
        }
        onCreate={createEvent}
      />
    </PageLayout>
  )
}
