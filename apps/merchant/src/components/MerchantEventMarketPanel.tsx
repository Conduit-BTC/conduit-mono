import { useId, useMemo, useState } from "react"
import {
  ExternalLink,
  PackagePlus,
  Printer,
  RefreshCw,
  UserRound,
} from "lucide-react"
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
import { getMerchantEventPublishPresentation } from "../lib/event-product-publishing"
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
        <Printer className="size-4 shrink-0" aria-hidden="true" />
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
  participationMarket = null,
  actionReady = true,
  refreshing,
  onRefresh,
  sellersLoading = false,
  compact = false,
}: {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
  market: MerchantOrganizerEventMarket
  participationMarket?: MerchantOrganizerEventMarket | null
  actionReady?: boolean
  refreshing: boolean
  onRefresh: () => void | Promise<void>
  sellersLoading?: boolean
  compact?: boolean
}) {
  const [publisherOpen, setPublisherOpen] = useState(false)
  const publishDisabledId = useId()
  const productImageUpload = useProductImageUpload()
  const [publishedAccepted, setPublishedAccepted] = useState<boolean | null>(
    null
  )
  const ownsMarket = merchantPubkey === market.organizerPubkey
  const publishPresentation = getMerchantEventPublishPresentation({
    actionReady,
    orderAcceptance: market.orderAcceptance,
    refreshing,
    requiredRecordsResolved: eventMarketRequiredRecordsResolved(market.source),
    state: market.state,
  })
  const organizerProfileQuery = useProfile(market.organizerPubkey, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    relayHints: getResolvedEventMarketRelayHints(market.source),
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const sellerMarket = participationMarket ?? market
  const sellerPubkeys = useMemo(
    () =>
      getEligibleEventSignMerchants(sellerMarket)
        .filter((seller) =>
          sellerMarket.participation.some(
            (item) =>
              item.status === "accepted" &&
              item.merchantPubkey === seller.pubkey &&
              isParticipationProductAvailable(
                item,
                sellerMarket.organizerPubkey
              )
          )
        )
        .map((seller) => seller.pubkey),
    [sellerMarket]
  )
  const sellerProfiles = useProfiles(sellerPubkeys, {
    accountPubkey: merchantPubkey,
    authenticatedPubkey,
    shouldContinue,
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })
  const organizerProfile =
    organizerProfileQuery.data?.pubkey.toLowerCase() ===
    market.organizerPubkey.toLowerCase()
      ? organizerProfileQuery.data
      : undefined
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
          disabled={!publishPresentation.publishable}
          aria-describedby={
            publishPresentation.message ? publishDisabledId : undefined
          }
          onClick={() => setPublisherOpen(true)}
        >
          <PackagePlus className="size-4 shrink-0" aria-hidden="true" />
          Publish product
        </Button>
      </div>
      {publishPresentation.message ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p
            id={publishDisabledId}
            className="min-w-0 flex-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]"
          >
            {publishPresentation.message}
          </p>
          {publishPresentation.retryLabel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => void onRefresh()}
            >
              <RefreshCw
                className={`size-4 shrink-0 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                aria-hidden="true"
              />
              {publishPresentation.retryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
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
                className="flex min-w-0 items-start gap-2"
                data-testid="merchant-event-organizer"
              >
                <Avatar className="size-7 shrink-0 border border-[var(--border)]">
                  <AvatarImage
                    src={organizerProfile?.picture}
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
                <span className="min-w-0">
                  <span className="block break-words">
                    Organized by{" "}
                    <EventActorName
                      pubkey={market.organizerPubkey}
                      profile={organizerProfile}
                      className="inline text-sm"
                    />
                  </span>
                  {!ownsMarket ? (
                    <EventActorProvenance
                      pubkey={market.organizerPubkey}
                      copyLabel="Copy organizer npub"
                      className="mt-0.5 max-w-full text-[11px]"
                    />
                  ) : null}
                </span>
              </div>
            }
            actions={
              <MerchantEventSignageAction
                merchantPubkey={merchantPubkey}
                authenticatedPubkey={authenticatedPubkey}
                shouldContinue={shouldContinue}
                market={sellerMarket}
                refreshing={refreshing}
                onRefresh={onRefresh}
              />
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
                  <ExternalLink
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                  View products
                </a>
              </Button>
            </div>

            {sellersLoading ? (
              <p
                className="mt-4 text-pretty text-sm text-[var(--text-muted)]"
                role="status"
              >
                Loading sellers…
              </p>
            ) : sellerPubkeys.length > 0 ? (
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
