import { useState } from "react"
import { ExternalLink, PackagePlus, Printer, RefreshCw } from "lucide-react"
import { useProductImageUpload, useProfile } from "@conduit/core"
import {
  Badge,
  Button,
  Card,
  CardContent,
  EventPageHeader,
  eventMarketRequiredRecordsResolved,
  formatEventRelayReadCoverage,
  getEventActionabilityPresentation,
} from "@conduit/ui"
import {
  buildMerchantEventQrSignSheet,
  isMerchantEligibleForEventSign,
} from "../lib/event-signage"
import {
  isParticipationProductAvailable,
  getResolvedEventMarketRelayHints,
  type MerchantOrganizerEventMarket,
} from "../lib/event-market"
import { getEventMarketUrl } from "../lib/market-links"
import { EventActorName, EventActorProvenance } from "./EventActorIdentity"
import { EventProductPublisherDialog } from "./EventProductPublisherDialog"
import { EventQrPrintPreview } from "./EventQrPrintPreview"

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

function actionabilityClassName(
  presentation: ReturnType<typeof getEventActionabilityPresentation>
): string {
  if (presentation.visibility !== "prominent") {
    return "text-pretty text-sm font-medium text-[var(--text-secondary)]"
  }
  return presentation.tone === "destructive"
    ? "rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-pretty text-sm font-medium text-error"
    : "rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-pretty text-sm font-medium text-[var(--text-primary)]"
}

function getMerchantProductAvailability(market: MerchantOrganizerEventMarket): {
  availableProductCount: number
  unresolvedProductCount: number
} {
  const acceptedProducts = market.participation.filter(
    (item) => item.status === "accepted"
  )
  const organizerOnlyProductCount = market.participation.filter(
    (item) => item.status === "organizer_only"
  ).length
  const availableProductCount = acceptedProducts.filter((item) =>
    isParticipationProductAvailable(item, market.organizerPubkey)
  ).length

  return {
    availableProductCount,
    unresolvedProductCount:
      organizerOnlyProductCount +
      (acceptedProducts.length - availableProductCount),
  }
}

function getPickupSummary(market: MerchantOrganizerEventMarket): string {
  if (!market.pickupCoordinate) {
    return "Merchants hand out from their own pickup point."
  }
  if (!market.source.pickup) {
    return "Organizer handoff details are unresolved. Your exact merchant pickup evidence still controls whether your product can be handed out safely."
  }
  return "Organizer handoff is available, or you can hand out from your own pickup point."
}

function MerchantEventSignageAction({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  market,
  refreshing,
  onRefresh,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  refreshing: boolean
  onRefresh: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const eligible = isMerchantEligibleForEventSign(market, merchantPubkey)
  const merchantProfileQuery = useProfile(eligible ? merchantPubkey : null, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const sheet = buildMerchantEventQrSignSheet(
    market,
    merchantPubkey,
    merchantProfileQuery.data
  )

  if (!sheet) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Printer />
        Print my event sign
      </Button>
      <EventQrPrintPreview
        open={open}
        onOpenChange={setOpen}
        title="My event sign preview"
        sheets={[sheet]}
        mode="merchant"
        eventState={market.state}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    </>
  )
}

export function MerchantEventMarketPanel({
  merchantPubkey,
  authenticatedPubkey,
  shouldContinue,
  market,
  actionReady = true,
  refreshing,
  onRefresh,
  compact = false,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  actionReady?: boolean
  refreshing: boolean
  onRefresh: () => void | Promise<void>
  compact?: boolean
}) {
  const [publisherOpen, setPublisherOpen] = useState(false)
  const productImageUpload = useProductImageUpload()
  const [publishedAccepted, setPublishedAccepted] = useState<boolean | null>(
    null
  )
  const ownsMarket = merchantPubkey === market.organizerPubkey
  const publishable =
    actionReady && (market.state === "active" || market.state === "partial")
  const organizerProfileQuery = useProfile(market.organizerPubkey, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    relayHints: getResolvedEventMarketRelayHints(market.source),
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const { availableProductCount, unresolvedProductCount } =
    getMerchantProductAvailability(market)
  const actionability = getEventActionabilityPresentation({
    state: market.state,
    orderAcceptance: market.orderAcceptance,
    availableProductCount,
    unresolvedProductCount,
    requiredEventRecordsResolved: eventMarketRequiredRecordsResolved(
      market.source
    ),
  })
  const relayCoverage = formatEventRelayReadCoverage(market.source.coverage)
  const publisherControls = (
    <>
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
          {publishedAccepted !== null && (
            <p className="mt-2 text-xs font-medium text-success" role="status">
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
          aria-describedby={!publishable ? "event-publish-disabled" : undefined}
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
          Publishing is unavailable until the current event details can be
          confirmed.
        </p>
      )}
    </>
  )

  return (
    <>
      {compact ? (
        <section className="grid gap-3" aria-label="Sell at this event">
          {publisherControls}
        </section>
      ) : (
        <div className="space-y-5">
          <EventPageHeader
            title={market.title}
            summary={market.summary}
            imageUrl={market.imageUrl}
            schedule={formatSchedule(market)}
            location={
              market.eventLocation || market.eventGeohash || "Not provided"
            }
            organizer={
              <div className="min-w-0">
                <span>Organized by </span>
                <EventActorName
                  pubkey={market.organizerPubkey}
                  profile={organizerProfileQuery.data}
                  className="inline text-sm"
                />
                <EventActorProvenance
                  pubkey={market.organizerPubkey}
                  copyLabel="Copy organizer npub"
                  className="mt-0.5 max-w-full text-xs"
                />
              </div>
            }
            actions={
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => void onRefresh()}
                >
                  <RefreshCw
                    className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                  />
                  Refresh
                </Button>
                <Button type="button" variant="outline" size="sm" asChild>
                  <a
                    href={getEventMarketUrl(market.naddr)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink /> Shopper page
                  </a>
                </Button>
                <MerchantEventSignageAction
                  merchantPubkey={merchantPubkey}
                  authenticatedPubkey={authenticatedPubkey}
                  shouldContinue={shouldContinue}
                  market={market}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              </>
            }
            shareUrl={getEventMarketUrl(market.naddr)}
            shareTitle={market.title}
          >
            <div className="flex flex-wrap items-center gap-2">
              {actionability.visibility !== "silent" ? (
                <Badge variant={actionability.tone}>
                  {actionability.label}
                </Badge>
              ) : null}
              <Badge variant="outline">Published by organizer</Badge>
            </div>
            {actionability.visibility !== "silent" ? (
              <p
                className={actionabilityClassName(actionability)}
                role={actionability.role}
                data-testid="merchant-event-actionability-status"
              >
                {actionability.visibility === "prominent" ? (
                  <span className="sr-only">{actionability.label}: </span>
                ) : null}
                {actionability.message}
              </p>
            ) : null}
            {relayCoverage ? (
              <details className="text-xs text-[var(--text-muted)]">
                <summary className="w-fit cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
                  Technical details
                </summary>
                <p
                  className="mt-2 text-pretty tabular-nums"
                  data-testid="merchant-event-relay-read-coverage"
                >
                  {relayCoverage}
                </p>
              </details>
            ) : null}
          </EventPageHeader>

          <Card>
            <CardContent className="grid gap-5 pt-6">
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <h2 className="text-sm font-medium text-[var(--text-primary)]">
                  Pickup
                </h2>
                <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
                  {getPickupSummary(market)}
                </p>
              </section>
              {publisherControls}
            </CardContent>
          </Card>
        </div>
      )}

      <EventProductPublisherDialog
        key={`${publisherOpen ? "open" : "closed"}:${market.collectionCoordinate}`}
        open={publisherOpen}
        merchantPubkey={merchantPubkey}
        authenticatedPubkey={authenticatedPubkey}
        shouldContinue={shouldContinue}
        market={market}
        productImageUpload={productImageUpload}
        onOpenChange={setPublisherOpen}
        onPublished={(accepted) => {
          setPublishedAccepted(accepted)
          void onRefresh()
        }}
      />
    </>
  )
}
