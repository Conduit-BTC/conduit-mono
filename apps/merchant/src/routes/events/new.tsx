import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { EventBreadcrumbs } from "../../components/EventBreadcrumbs"

import { FutureEventMarketCreate } from "../../components/FutureEventMarketCreate"

export const Route = createFileRoute("/events/new")({
  component: NewEventPage,
})

function NewEventPage() {
  const navigate = useNavigate({ from: Route.fullPath })
  const { relation } = Route.useSearch()
  const openEvent = (reference: string) => {
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: reference },
      search: { relation },
      replace: true,
    })
  }

  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <EventBreadcrumbs title="Create event" />

      <FutureEventMarketCreate onPublished={openEvent} />
    </div>
  )
}
