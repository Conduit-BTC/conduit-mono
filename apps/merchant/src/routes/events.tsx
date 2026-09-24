import { useEffect } from "react"
import { Loader2, Plus } from "lucide-react"
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router"
import { useAuth } from "@conduit/core"
import { Button } from "@conduit/ui"
import { MerchantEventsTimeline } from "../components/MerchantEventsTimeline"
import { parseMerchantEventsSearch } from "../lib/market-links"

export const Route = createFileRoute("/events")({
  validateSearch: parseMerchantEventsSearch,
  component: EventsLayout,
})

function EventsLayout() {
  const { event } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  useEffect(() => {
    if (!event) return
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: event },
      search: {},
      replace: true,
    })
  }, [event, navigate])
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
    void navigate({ to: "/events/new", search: {} })
  }
  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            Events
          </h1>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Find events where you can sell, or create and manage an event of
            your own.
          </p>
        </div>
        <Button type="button" onClick={createEvent}>
          <Plus aria-hidden="true" />
          Create event
        </Button>
      </header>
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
        onOpen={(reference) =>
          void navigate({
            to: "/events/$collectionRef",
            params: { collectionRef: reference },
            search: {},
          })
        }
        onCreate={createEvent}
      />
    </div>
  )
}
