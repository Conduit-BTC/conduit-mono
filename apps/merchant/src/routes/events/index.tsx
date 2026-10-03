import { useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { decodeEventMarketReference, EVENT_KINDS, useAuth } from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@conduit/ui"

import { EventsDirectoryPage } from "../events"

export const Route = createFileRoute("/events/")({
  component: EventsIndexPage,
})

function EventsIndexPage() {
  const [marketReference, setMarketReference] = useState("")
  const { accountPubkey } = useAuth()
  const market = decodeEventMarketReference(marketReference.trim(), [
    EVENT_KINDS.EVENT_MARKET,
  ])
  const organizerMarket = market?.authorPubkey === accountPubkey ? market : null

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Future Event Market</CardTitle>
          <CardDescription>
            Open a version-2 market you organize to manage merchant admission.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="future-market-reference">
              Market address or naddr
            </Label>
            <Input
              id="future-market-reference"
              value={marketReference}
              onChange={(event) => setMarketReference(event.target.value)}
              placeholder="30409:organizer:market or naddr…"
              spellCheck={false}
            />
          </div>
          <Button asChild={!!organizerMarket} disabled={!organizerMarket}>
            {organizerMarket ? (
              <Link
                to="/events/$collectionRef"
                params={{ collectionRef: marketReference.trim() }}
              >
                Manage merchants
              </Link>
            ) : (
              <span>Manage merchants</span>
            )}
          </Button>
        </CardContent>
      </Card>
      <EventsDirectoryPage />
    </div>
  )
}
