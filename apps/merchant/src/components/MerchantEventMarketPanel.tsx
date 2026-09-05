import { useState } from "react"
import {
  CalendarDays,
  ExternalLink,
  MapPin,
  PackagePlus,
  RefreshCw,
  Store,
} from "lucide-react"
import { formatNpub } from "@conduit/core"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@conduit/ui"
import type { MerchantOrganizerEventMarket } from "../lib/event-market"
import { getEventMarketUrl } from "../lib/market-links"
import { EventProductPublisherDialog } from "./EventProductPublisherDialog"

function formatSchedule(market: MerchantOrganizerEventMarket): string {
  if (market.calendarKind === 31922) {
    return market.end ? `${market.start} – ${market.end}` : String(market.start)
  }
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: market.timezone || "UTC",
    })
    const start =
      typeof market.start === "number"
        ? formatter.format(new Date(market.start * 1_000))
        : String(market.start)
    const end =
      typeof market.end === "number"
        ? formatter.format(new Date(market.end * 1_000))
        : market.end
    return end ? `${start} – ${end}` : start
  } catch {
    return "Schedule unavailable"
  }
}

function stateBadge(market: MerchantOrganizerEventMarket) {
  if (market.state === "active") {
    return <Badge variant="success">Active event</Badge>
  }
  if (market.state === "ended") {
    return <Badge variant="secondary">Ended</Badge>
  }
  return <Badge variant="warning">Evidence degraded</Badge>
}

export function MerchantEventMarketPanel({
  merchantPubkey,
  market,
  refreshing,
  onRefresh,
}: {
  merchantPubkey: string
  market: MerchantOrganizerEventMarket
  refreshing: boolean
  onRefresh: () => void | Promise<void>
}) {
  const [publisherOpen, setPublisherOpen] = useState(false)
  const [publishedProduct, setPublishedProduct] = useState<string | null>(null)
  const [publishedAccepted, setPublishedAccepted] = useState(false)
  const ownsMarket = merchantPubkey === market.organizerPubkey
  const publishable = market.state === "active" || market.state === "partial"

  return (
    <>
      <Card className="overflow-hidden">
        {market.imageUrl && (
          <img
            src={market.imageUrl}
            alt=""
            className="h-48 w-full border-b border-[var(--border)] object-cover sm:h-60"
          />
        )}
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {stateBadge(market)}
              <Badge variant="outline">Published by organizer</Badge>
            </div>
            <CardTitle className="text-balance text-2xl">
              {market.title}
            </CardTitle>
            {market.summary && (
              <CardDescription className="mt-2 max-w-3xl text-pretty leading-6">
                {market.summary}
              </CardDescription>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={refreshing}
              onClick={() => void onRefresh()}
            >
              <RefreshCw
                className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              />
              Refresh
            </Button>
            <Button type="button" variant="outline" asChild>
              <a
                href={getEventMarketUrl(market.naddr)}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink /> Shopper page
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
              <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
              <div>
                <dt className="font-medium text-[var(--text-primary)]">
                  Date and time
                </dt>
                <dd className="mt-1 leading-6 text-[var(--text-secondary)]">
                  {formatSchedule(market)}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
              <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
              <div>
                <dt className="font-medium text-[var(--text-primary)]">
                  Location
                </dt>
                <dd className="mt-1 leading-6 text-[var(--text-secondary)]">
                  {market.eventLocation ||
                    market.eventGeohash ||
                    "Not provided"}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
              <Store className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
              <div>
                <dt className="font-medium text-[var(--text-primary)]">
                  Organizer
                </dt>
                <dd className="mt-1 font-mono text-xs leading-6 text-[var(--text-secondary)]">
                  {formatNpub(market.organizerPubkey, 12)}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
              <PackagePlus className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
              <div>
                <dt className="font-medium text-[var(--text-primary)]">
                  Pickup
                </dt>
                <dd className="mt-1 leading-6 text-[var(--text-secondary)]">
                  {market.pickupCoordinate
                    ? "Organizer handoff is available, or you can hand out from your own pickup point."
                    : "Merchants hand out from their own pickup point."}
                </dd>
              </div>
            </div>
          </dl>

          <div className="flex flex-col gap-3 rounded-xl border border-primary-500/30 bg-primary-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-balance font-semibold text-[var(--text-primary)]">
                Sell at this event
              </h3>
              <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
                Publish a new product from scratch or copy one of your existing
                products.{" "}
                {ownsMarket
                  ? "Your own product is accepted into this event when you approve its collection signature."
                  : "The organizer reviews it before it appears in the event collection."}
              </p>
              {publishedProduct && (
                <p
                  className="mt-2 text-xs font-medium text-success"
                  role="status"
                >
                  {publishedAccepted
                    ? "Product published and accepted into your event."
                    : "Product published. Organizer acceptance is pending."}
                </p>
              )}
            </div>
            <Button
              type="button"
              className="shrink-0"
              disabled={!publishable}
              aria-describedby={
                !publishable ? "event-publish-disabled" : undefined
              }
              onClick={() => setPublisherOpen(true)}
            >
              <PackagePlus /> Publish product
            </Button>
          </div>
          {!publishable && (
            <p
              id="event-publish-disabled"
              className="text-xs leading-5 text-[var(--text-muted)]"
            >
              Publishing is unavailable until current event evidence is active
              or safely recoverable from a partial relay view.
            </p>
          )}
        </CardContent>
      </Card>

      <EventProductPublisherDialog
        key={`${publisherOpen ? "open" : "closed"}:${market.collectionCoordinate}`}
        open={publisherOpen}
        merchantPubkey={merchantPubkey}
        market={market}
        onOpenChange={setPublisherOpen}
        onPublished={async (productCoordinate, accepted) => {
          setPublishedProduct(productCoordinate)
          setPublishedAccepted(accepted)
          await onRefresh()
        }}
      />
    </>
  )
}
