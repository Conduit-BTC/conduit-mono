import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { decodeEventMarketReference } from "@conduit/core"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@conduit/ui"
import { EventBreadcrumbs } from "../../components/EventBreadcrumbs"
import { FutureEventMarketManager } from "../../components/FutureEventMarketManager"

export const Route = createFileRoute("/events/$collectionRef")({
  component: EventDetailPage,
})
function EventDetailPage() {
  const { collectionRef } = Route.useParams()
  const { occurrence } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  if (!decodeEventMarketReference(collectionRef, [30409]))
    return (
      <div className="space-y-4">
        <EventBreadcrumbs title="Event" />
        <Card>
          <CardHeader>
            <CardTitle>Repost this event</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p>
              This event uses a retired format. Create an Event Market to offer
              products and manage merchants.
            </p>
            <Button asChild>
              <Link to="/events/new">Create event</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  return (
    <FutureEventMarketManager
      reference={collectionRef}
      selectedOccurrence={occurrence}
      onSelectOccurrence={(coordinate) =>
        void navigate({
          search: (previous) => ({ ...previous, occurrence: coordinate }),
          replace: true,
        })
      }
    />
  )
}
