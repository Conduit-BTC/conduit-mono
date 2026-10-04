import { ArrowLeft } from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { Button } from "@conduit/ui"

import { FutureEventMarketCreate } from "../../components/FutureEventMarketCreate"

export const Route = createFileRoute("/events/new")({
  component: NewEventPage,
})

function NewEventPage() {
  const navigate = useNavigate({ from: Route.fullPath })
  const openEvent = (reference: string) => {
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: reference },
      search: {},
      replace: true,
    })
  }

  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <Button asChild variant="outline" className="w-fit">
        <Link to="/events" search={{}}>
          <ArrowLeft aria-hidden="true" />
          Back to events
        </Link>
      </Button>

      <FutureEventMarketCreate onPublished={openEvent} />
    </div>
  )
}
