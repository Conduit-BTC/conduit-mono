import { useLayoutEffect, useRef } from "react"
import { ArrowLeft, ExternalLink } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  buildMarketEventCatalogUrl,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  getEventMarket,
  inferConduitAppOrigin,
  useAuth,
  useConduitSession,
} from "@conduit/core"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@conduit/ui"
import { FutureEventMarketManager } from "../../components/FutureEventMarketManager"
import { LegacyOrganizerHandoffQueue } from "../../components/LegacyOrganizerHandoffQueue"

export const Route = createFileRoute("/events/$collectionRef")({
  component: EventDetailPage,
})

function EventDetailPage() {
  const { collectionRef } = Route.useParams()
  if (decodeEventMarketReference(collectionRef, [30409])) {
    return <FutureEventMarketManager reference={collectionRef} />
  }
  return <LegacyEventReadOnly reference={collectionRef} />
}

/** Historical kind-30405 links remain readable without a second active event writer. */
function LegacyEventReadOnly({ reference }: { reference: string }) {
  const { accountPubkey, pubkey, signerReadiness, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const session = useConduitSession()
  const decoded = decodeEventMarketReference(reference, [30405])
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  const query = useQuery({
    queryKey: [
      "legacy-event-read-only",
      reference,
      session.relayScope,
      authenticatedPubkey,
      authGeneration,
    ],
    queryFn: ({ signal }) =>
      getEventMarket({
        reference,
        authenticatedPubkey,
        signal,
        includeParticipation: false,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled: !!decoded && session.relaySettingsReady,
    retry: false,
  })
  const market = query.data
  const canonical = decoded
    ? encodeEventMarketNaddr(decoded.coordinate, decoded.relayHints)
    : null
  const marketUrl =
    canonical && typeof window !== "undefined"
      ? buildMarketEventCatalogUrl(
          inferConduitAppOrigin(
            "market",
            window.location,
            import.meta.env.VITE_BUILD_BRANCH
          ),
          canonical
        )
      : null
  return (
    <div className="mx-auto max-w-[68rem] space-y-6 py-2 sm:py-6">
      <Button asChild variant="outline" className="w-fit">
        <Link to="/events" search={{}}>
          <ArrowLeft aria-hidden="true" /> Back to events
        </Link>
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>
            {market?.calendar?.title ??
              market?.collection?.title ??
              "Historical event"}
          </CardTitle>
          <CardDescription>
            This older Event Market remains available for existing links and
            orders. New merchant admission and product setup use the current
            Event Market model.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!decoded ? <p role="alert">Event link is invalid.</p> : null}
          {query.isPending && decoded ? (
            <p role="status">Checking historical event records…</p>
          ) : null}
          {query.isError ? (
            <p role="alert">Historical event records could not be checked.</p>
          ) : null}
          {market?.calendar ? (
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="font-medium">Schedule</dt>
                <dd>
                  {new Date(market.calendar.start).toLocaleString()} –{" "}
                  {new Date(market.calendar.end).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Location</dt>
                <dd>
                  {market.calendar.locations.join(", ") ||
                    market.calendar.geohash ||
                    "Not published"}
                </dd>
              </div>
            </dl>
          ) : null}
          {marketUrl ? (
            <Button asChild variant="outline">
              <a href={marketUrl}>
                Open historical catalog{" "}
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          {decoded ? (
            <Button
              type="button"
              variant="ghost"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh records
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {decoded && authenticatedPubkey === decoded.authorPubkey ? (
        <LegacyOrganizerHandoffQueue
          key={`${decoded.coordinate}:${authGeneration}`}
          organizerPubkey={decoded.authorPubkey}
          collectionCoordinate={decoded.coordinate}
        />
      ) : null}
    </div>
  )
}
