import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { ArrowLeft } from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { useAuth } from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@conduit/ui"

import { FindEventsPanel, MyEventsPanel } from "../events"
import { parseOrganizerEventMarketReference } from "../../lib/event-market"

export const Route = createFileRoute("/events/$collectionRef")({
  component: EventDetailPage,
})

function EventDetailPage() {
  const { collectionRef } = Route.useParams()
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  const navigate = useNavigate({ from: Route.fullPath })

  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])

  const eventReference = useMemo(() => {
    try {
      return parseOrganizerEventMarketReference(collectionRef)
    } catch {
      return null
    }
  }, [collectionRef])
  const canonicalReference = eventReference?.naddr

  useEffect(() => {
    if (!canonicalReference || canonicalReference === collectionRef) return
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: canonicalReference },
      search: {},
      replace: true,
    })
  }, [canonicalReference, collectionRef, navigate])

  if (!eventReference || !canonicalReference) {
    return (
      <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
        <Button asChild variant="ghost" size="sm">
          <Link to="/events" search={{}}>
            <ArrowLeft aria-hidden="true" />
            All events
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Event link is invalid</CardTitle>
            <CardDescription>
              Open this event again from its exact catalog naddr or Market share
              link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/events" search={{}}>
                Browse events
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const merchantPubkey = pubkey ?? ""
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const shouldContinue = () => authGenerationRef.current === authGeneration
  const organizerPubkey = eventReference.coordinate.split(":")[1]
  const selectedIsOwned = organizerPubkey === merchantPubkey
  const openEvent = (reference: string) => {
    const nextReference = parseOrganizerEventMarketReference(reference).naddr
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: nextReference },
      search: {},
      replace: true,
    })
  }

  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/events" search={{}}>
          <ArrowLeft aria-hidden="true" />
          All events
        </Link>
      </Button>

      {selectedIsOwned ? (
        <MyEventsPanel
          key={`${merchantPubkey}:${canonicalReference}`}
          organizerPubkey={merchantPubkey}
          initialReference={canonicalReference}
          embedded
          onPublished={openEvent}
          onSelected={openEvent}
          authenticatedPubkey={authenticatedPubkey}
          shouldContinue={shouldContinue}
        />
      ) : (
        <FindEventsPanel
          key={`${merchantPubkey}:${canonicalReference}`}
          merchantPubkey={merchantPubkey}
          authenticatedPubkey={authenticatedPubkey}
          shouldContinue={shouldContinue}
          initialReference={canonicalReference}
          embedded
        />
      )}
    </div>
  )
}
