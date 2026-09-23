import { ArrowLeft } from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { useAuth } from "@conduit/core"
import { Button } from "@conduit/ui"

import { MyEventsPanel } from "../events"
import { parseOrganizerEventMarketReference } from "../../lib/event-market"

export const Route = createFileRoute("/events/new")({
  component: NewEventPage,
})

function NewEventPage() {
  const {
    accountPubkey,
    pubkey,
    signerReadiness,
    authGeneration,
    isAuthGenerationCurrent,
  } = useAuth()
  const navigate = useNavigate({ from: Route.fullPath })

  const merchantPubkey = accountPubkey ?? ""
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
  const openEvent = (reference: string) => {
    const nextReference = parseOrganizerEventMarketReference(reference).naddr
    void navigate({
      to: "/events/$collectionRef",
      params: { collectionRef: nextReference },
      search: {},
      replace: true,
    })
  }
  const closeCreation = () => {
    void navigate({ to: "/events", search: {}, replace: true })
  }

  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <Button asChild variant="outline" className="w-fit">
        <Link to="/events" search={{}}>
          <ArrowLeft aria-hidden="true" />
          Back to events
        </Link>
      </Button>

      <MyEventsPanel
        key={`${merchantPubkey}:create`}
        organizerPubkey={merchantPubkey}
        authenticatedPubkey={authenticatedPubkey}
        shouldContinue={shouldContinue}
        startCreate
        onPublished={openEvent}
        onCreateDismiss={closeCreation}
      />
    </div>
  )
}
