import { useMemo, useState } from "react"
import { ExternalLink, PackagePlus, Printer, UserRound } from "lucide-react"
import {
  getProfileDisplayLabel,
  useProductImageUpload,
  useProfile,
  useProfiles,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  EventPageHeader,
  eventMarketRequiredRecordsResolved,
} from "@conduit/ui"
import {
  buildMerchantEventQrSignSheet,
  getEligibleEventSignMerchants,
  isMerchantEligibleForEventSign,
} from "../lib/event-signage"
import {
  isParticipationProductAvailable,
  getResolvedEventMarketRelayHints,
  type MerchantOrganizerEventMarket,
} from "../lib/event-market"
import { getEventMarketUrl } from "../lib/market-links"
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
    actionReady &&
    (market.state === "active" ||
      (market.state === "partial" &&
        eventMarketRequiredRecordsResolved(market.source)))
  const organizerProfileQuery = useProfile(market.organizerPubkey, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    relayHints: getResolvedEventMarketRelayHints(market.source),
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const sellerPubkeys = useMemo(
    () =>
      getEligibleEventSignMerchants(market)
        .filter((seller) =>
          market.participation.some(
            (item) =>
              item.status === "accepted" &&
              item.merchantPubkey === seller.pubkey &&
              isParticipationProductAvailable(item, market.organizerPubkey)
          )
        )
        .map((seller) => seller.pubkey),
    [market]
  )
  const sellerProfiles = useProfiles(sellerPubkeys, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const organizerName = getProfileDisplayLabel(
    organizerProfileQuery.data,
    market.organizerPubkey,
    { lookupSettled: organizerProfileQuery.lookupSettled }
  )
  const shopperUrl = getEventMarketUrl(market.naddr)
  const publisherControls = (
    <section className="rounded-2xl border border-primary-500/30 bg-primary-500/10 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
            Sell at this event
          </h2>
          <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Publish a new product from scratch or copy one of your existing
            products.{" "}
            {ownsMarket
              ? "Your own product is accepted into this event when you approve its collection signature."
              : "The organizer reviews it before it appears in the event collection."}
          </p>
          <p className="mt-2 text-pretty text-sm text-[var(--text-muted)]">
            {getPickupSummary(market)}
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
          className="mt-3 text-pretty text-sm leading-6 text-[var(--text-secondary)]"
        >
          Event details are still updating. Publishing will become available
          after the current organizer records are confirmed.
        </p>
      )}
    </section>
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
              <div
                className="flex min-w-0 items-center gap-2"
                data-testid="merchant-event-organizer"
              >
                <Avatar className="size-7 shrink-0 border border-[var(--border)]">
                  <AvatarImage
                    src={organizerProfileQuery.data?.picture}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                  <AvatarFallback>
                    <UserRound
                      className="size-4 text-[var(--text-muted)]"
                      aria-hidden="true"
                    />
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 break-words">
                  Organized by{" "}
                  <span className="font-medium text-[var(--text-primary)]">
                    {organizerName}
                  </span>
                </span>
              </div>
            }
            actions={
              <>
                <Button type="button" variant="outline" size="sm" asChild>
                  <a href={shopperUrl} target="_blank" rel="noreferrer">
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
            shareUrl={shopperUrl}
            shareTitle={market.title}
          />

          {publisherControls}

          <section
            className="rounded-2xl border border-[var(--border)] p-5"
            aria-labelledby="event-sellers-title"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2
                  id="event-sellers-title"
                  className="text-balance text-lg font-semibold text-[var(--text-primary)]"
                >
                  Sellers at this event
                </h2>
                <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
                  Merchants with products accepted by the organizer.
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <a href={shopperUrl} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  View products
                </a>
              </Button>
            </div>

            {sellerPubkeys.length > 0 ? (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sellerPubkeys.map((sellerPubkey) => {
                  const profile = sellerProfiles.getProfile(sellerPubkey)
                  const sellerName = getProfileDisplayLabel(
                    profile,
                    sellerPubkey,
                    { lookupSettled: sellerProfiles.lookupSettled }
                  )
                  return (
                    <li
                      key={sellerPubkey}
                      data-testid="merchant-event-seller"
                      className="flex min-w-0 items-center gap-3 rounded-xl bg-[var(--surface-elevated)] p-3"
                    >
                      <Avatar className="size-10 shrink-0 border border-[var(--border)]">
                        <AvatarImage
                          src={profile?.picture}
                          alt=""
                          referrerPolicy="no-referrer"
                        />
                        <AvatarFallback>
                          <UserRound
                            className="size-5 text-[var(--text-muted)]"
                            aria-hidden="true"
                          />
                        </AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">
                        {sellerName}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-4 text-pretty text-sm text-[var(--text-muted)]">
                No participating sellers are listed yet.
              </p>
            )}
          </section>
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
