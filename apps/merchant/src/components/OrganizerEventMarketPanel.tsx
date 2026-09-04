import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  ImageOff,
  MapPin,
  RefreshCw,
  Trash2,
  UserRound,
  WifiOff,
} from "lucide-react"
import {
  formatNpub,
  formatSourcePrice,
  getProfileName,
  normalizeCurrencyCode,
  pubkeyToNpub,
  useProfiles,
  type Profile,
  type ProductImage,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  QRCodeSVG,
  StatusPill,
} from "@conduit/ui"
import {
  getOrganizerEventMarketDisplayState,
  type OrganizerCollectionMembershipAction,
} from "../lib/event-market-workflow"
import {
  isParticipationHandoffVerified,
  isParticipationProductPreviewVerified,
  type MerchantOrganizerEventMarket,
  type MerchantOrganizerParticipation,
  type MerchantOrganizerRecordDelivery,
} from "../lib/event-market"
import {
  getEventMarketUrl,
  getMerchantEventParticipationUrl,
  getStorefrontUrl,
} from "../lib/market-links"
import {
  getMerchantProfileState,
  type MerchantProfileState,
} from "../lib/event-market-participation-identity"

function statusMeta(state: MerchantOrganizerEventMarket["state"]): {
  label: string
  tone: "success" | "info" | "warning" | "error" | "neutral"
} {
  switch (state) {
    case "active":
      return { label: "Active", tone: "success" }
    case "ended":
      return { label: "Ended", tone: "neutral" }
    case "deleted":
      return { label: "Deleted", tone: "error" }
    case "partial":
      return { label: "Partial relay view", tone: "warning" }
    case "stale":
      return { label: "Saved evidence", tone: "warning" }
    case "unavailable":
      return { label: "Relays unavailable", tone: "error" }
    case "missing":
      return { label: "Missing records", tone: "warning" }
    case "conflicting":
      return { label: "Conflicting records", tone: "error" }
    case "malformed":
      return { label: "Malformed records", tone: "error" }
    default:
      return { label: "Unsupported records", tone: "error" }
  }
}

function formatSchedule(market: MerchantOrganizerEventMarket): string {
  if (market.calendarKind === 31922) {
    return market.end ? `${market.start} - ${market.end}` : String(market.start)
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
    return end ? `${start} - ${end}` : start
  } catch {
    return "Unsupported schedule"
  }
}

function RelayEvidenceNotice({
  unavailable,
  refreshing,
  onRefresh,
}: {
  unavailable: boolean
  refreshing: boolean
  onRefresh: () => void
}) {
  const Icon = unavailable ? WifiOff : AlertTriangle
  return (
    <div
      className={
        unavailable
          ? "flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error"
          : "flex items-center justify-between gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-sm text-[var(--text-primary)]"
      }
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" />
        {unavailable
          ? "Live event evidence is unavailable. Consequential actions remain blocked."
          : "This is a degraded relay view. Verify current event evidence before acting."}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw className={refreshing ? "animate-spin" : ""} />
        Retry
      </Button>
    </div>
  )
}

function participantLabel(item: MerchantOrganizerParticipation): string {
  if (item.title) return item.title
  const [kind, pubkey, ...dTag] = item.productCoordinate.split(":")
  return pubkey
    ? `${kind}:${formatNpub(pubkey, 6)}:${dTag.join(":")}`
    : item.productCoordinate
}

function ProductPreviewImage({
  image,
  title,
}: {
  image?: ProductImage
  title: string
}) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [image?.url])

  return (
    <div className="aspect-[4/3] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)]">
      {image && !failed ? (
        <img
          src={image.url}
          alt={image.alt ?? title}
          width={320}
          height={240}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full min-h-20 flex-col items-center justify-center gap-1.5 bg-[var(--surface)] px-2 text-center text-[var(--text-muted)]">
          <ImageOff className="h-5 w-5" aria-hidden="true" />
          <span className="text-xs">Image unavailable</span>
        </div>
      )}
    </div>
  )
}

function SignedProductPreview({
  item,
}: {
  item: MerchantOrganizerParticipation
}) {
  if (!isParticipationProductPreviewVerified(item)) {
    const previewMessage =
      item.productPreview?.priceStatus === "malformed"
        ? item.status === "pending"
          ? "The current signed listing has malformed price evidence. It cannot be reviewed or accepted."
          : "The current signed listing has malformed price evidence and cannot be shown as a verified product."
        : item.status === "pending"
          ? "The exact signed product preview is unavailable or no longer matches this request. Refresh evidence before accepting."
          : item.status === "accepted"
            ? "The exact signed preview for this accepted product is unavailable. Refresh evidence; removal remains available."
            : "No current merchant-signed product preview was verified for this organizer-only entry."
    return (
      <div
        data-testid="organizer-product-preview"
        data-preview-state="unavailable"
        className="flex gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2.5 text-xs leading-5 text-[var(--text-secondary)]"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
        <span>{previewMessage}</span>
      </div>
    )
  }

  const { productPreview } = item
  const price = formatSourcePrice({
    amount: productPreview.price,
    currency: productPreview.currency,
    normalizedCurrency: normalizeCurrencyCode(productPreview.currency),
  })
  const productType =
    productPreview.type === "variable"
      ? "Variable product"
      : productPreview.type === "variation"
        ? "Product variation"
        : "Simple product"

  return (
    <div
      data-testid="organizer-product-preview"
      data-preview-state="verified"
      className="grid gap-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]"
    >
      <ProductPreviewImage
        image={productPreview.images[0]}
        title={productPreview.title}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="line-clamp-2 text-sm font-semibold leading-5 text-[var(--text-primary)]">
              {productPreview.title}
            </div>
            <div className="mt-1 text-sm font-semibold text-secondary-400">
              {price}
            </div>
          </div>
          <Badge variant="outline">{productType}</Badge>
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">
          {productPreview.summary?.trim() || "No signed product description."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
          <span>Merchant {formatNpub(item.merchantPubkey, 6)}</span>
          <span aria-hidden="true">{"\u00b7"}</span>
          <span>Exact signed listing</span>
          {productPreview.stock === 0 ? (
            <>
              <span aria-hidden="true">{"\u00b7"}</span>
              <span className="text-[var(--warning)]">Sold out</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DeliveryRow({
  delivery,
  retrying,
  blocked,
  onRetry,
}: {
  delivery: MerchantOrganizerRecordDelivery
  retrying: boolean
  blocked: boolean
  onRetry: (delivery: MerchantOrganizerRecordDelivery) => void
}) {
  const needsRetry =
    delivery.acknowledgedCount === 0 ||
    delivery.rejectedCount + delivery.timedOutCount > 0
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2.5">
      <div>
        <div className="text-sm font-medium capitalize text-[var(--text-primary)]">
          {delivery.record}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {delivery.acknowledgedCount > 0 && (
            <Badge variant="success">
              {delivery.acknowledgedCount} acknowledged
            </Badge>
          )}
          {delivery.acknowledgedCount === 0 && (
            <Badge variant="warning">Not acknowledged</Badge>
          )}
          {delivery.rejectedCount > 0 && (
            <Badge variant="destructive">
              {delivery.rejectedCount} rejected
            </Badge>
          )}
          {delivery.timedOutCount > 0 && (
            <Badge variant="warning">{delivery.timedOutCount} timed out</Badge>
          )}
        </div>
      </div>
      {needsRetry && delivery.signedEvent ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={retrying || blocked}
          onClick={() => onRetry(delivery)}
        >
          <RefreshCw className={retrying ? "animate-spin" : ""} />
          {blocked ? "Retry prerequisites first" : "Retry delivery"}
        </Button>
      ) : null}
    </div>
  )
}

export function OrganizerEventMarketDeliveryList({
  deliveries,
  retryingRecord,
  onRetryDelivery,
}: {
  deliveries: MerchantOrganizerRecordDelivery[]
  retryingRecord: MerchantOrganizerRecordDelivery["record"] | null
  onRetryDelivery: (delivery: MerchantOrganizerRecordDelivery) => void
}) {
  if (deliveries.length === 0) return null
  const prerequisiteAcknowledged = (record: "calendar" | "pickup") =>
    (deliveries.find((delivery) => delivery.record === record)
      ?.acknowledgedCount ?? 0) > 0
  const pickupWasPublished = deliveries.some(
    (delivery) => delivery.record === "pickup"
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Relay delivery</CardTitle>
        <CardDescription>
          Relay acknowledgements confirm acceptance by those relays, not global
          visibility or shopper receipt.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {deliveries.map((delivery) => (
          <DeliveryRow
            key={delivery.record}
            delivery={delivery}
            retrying={retryingRecord === delivery.record}
            blocked={
              delivery.record === "collection" &&
              (!prerequisiteAcknowledged("calendar") ||
                (pickupWasPublished && !prerequisiteAcknowledged("pickup")))
            }
            onRetry={onRetryDelivery}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function ParticipationRow({
  item,
  merchantProfile,
  merchantProfileState,
  organizerPubkey,
  pending,
  onMembership,
}: {
  item: MerchantOrganizerParticipation
  merchantProfile?: Profile
  merchantProfileState: MerchantProfileState
  organizerPubkey: string
  pending: boolean
  onMembership: (
    item: MerchantOrganizerParticipation,
    action: OrganizerCollectionMembershipAction
  ) => void
}) {
  const accepted = item.status === "accepted"
  const organizerOnly = item.status === "organizer_only"
  const removable = accepted || organizerOnly
  const handoffVerified = isParticipationHandoffVerified(item, organizerPubkey)
  const previewVerified = isParticipationProductPreviewVerified(item)
  const canAccept = handoffVerified && previewVerified
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
      <SignedProductPreview item={item} />
      {item.merchantPubkey ? (
        <MerchantIdentity
          pubkey={item.merchantPubkey}
          profile={merchantProfile}
          state={merchantProfileState}
        />
      ) : null}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-[var(--border)] pt-3">
        <div className="min-w-0">
          {!previewVerified ? (
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {participantLabel(item)}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            <StatusPill
              variant={accepted ? "success" : "warning"}
              iconSize={10}
            >
              {accepted
                ? "Accepted"
                : organizerOnly
                  ? "Organizer-only entry"
                  : "Pending request"}
            </StatusPill>
            {item.handoffMode && item.handlerPubkey && (
              <span>
                {item.handoffMode === "organizer_handoff"
                  ? "Organizer hands out"
                  : "Merchant hands out"}
                {" \u00b7 "}
                {formatNpub(item.handlerPubkey, 6)}
              </span>
            )}
            {!removable && (!handoffVerified || !previewVerified) && (
              <span>
                {!previewVerified
                  ? "Exact signed product preview is required"
                  : "Signed handoff evidence is unavailable or ambiguous"}
              </span>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={removable ? "outline" : "primary"}
          disabled={pending || (!removable && !canAccept)}
          onClick={() => onMembership(item, removable ? "remove" : "accept")}
        >
          {removable ? <Trash2 /> : <Check />}
          {removable ? "Remove" : canAccept ? "Accept" : "Cannot accept"}
        </Button>
      </div>
    </div>
  )
}

function MerchantIdentity({
  pubkey,
  profile,
  state,
}: {
  pubkey: string
  profile?: Profile
  state: MerchantProfileState
}) {
  const [copied, setCopied] = useState(false)
  const profileName = getProfileName(profile)
  const displayName =
    profileName ??
    (state === "loading"
      ? "Loading merchant profile..."
      : state === "unavailable"
        ? "Profile lookup unavailable"
        : state === "unresolved"
          ? "Profile not loaded"
          : "Public profile")
  const fullNpub = pubkeyToNpub(pubkey)

  async function copyNpub(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fullNpub)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      data-testid="participation-merchant-identity"
      data-profile-state={state}
      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="h-10 w-10 border border-[var(--border)]">
          <AvatarImage
            src={state === "available" ? profile?.picture : undefined}
            alt={profileName ?? "Merchant profile"}
            className="object-cover"
          />
          <AvatarFallback>
            <UserRound
              className="h-5 w-5 text-[var(--text-muted)]"
              aria-hidden="true"
            />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {displayName}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-[var(--text-muted)]">
            {formatNpub(pubkey, 8)}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copyNpub}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy npub"}
        </Button>
        <Button type="button" size="sm" variant="ghost" asChild>
          <a href={getStorefrontUrl(pubkey)} target="_blank" rel="noreferrer">
            <ExternalLink />
            Open storefront
          </a>
        </Button>
      </div>
    </div>
  )
}

export function OrganizerEventMarketPanel({
  market,
  deliveries,
  copiedUrl,
  refreshing,
  membershipPending,
  retryingRecord,
  onCopy,
  onEdit,
  onRefresh,
  onMembership,
  onRetryDelivery,
}: {
  market: MerchantOrganizerEventMarket
  deliveries: MerchantOrganizerRecordDelivery[]
  copiedUrl: string | null
  refreshing: boolean
  membershipPending: boolean
  retryingRecord: MerchantOrganizerRecordDelivery["record"] | null
  onCopy: (url: string) => void
  onEdit: () => void
  onRefresh: () => void
  onMembership: (
    item: MerchantOrganizerParticipation,
    action: OrganizerCollectionMembershipAction
  ) => void
  onRetryDelivery: (delivery: MerchantOrganizerRecordDelivery) => void
}) {
  const status = statusMeta(market.state)
  const displayState = getOrganizerEventMarketDisplayState(market.state)
  const shopperUrl = getEventMarketUrl(market.naddr)
  const merchantUrl = getMerchantEventParticipationUrl(market.naddr)
  const canEdit = market.state === "active" || market.state === "ended"
  const canChangeMembership = market.state === "active"
  const pendingRequests = market.participation.filter(
    (item) => item.status === "pending"
  )
  const acceptedProducts = market.participation.filter(
    (item) => item.status === "accepted"
  )
  const organizerOnlyProducts = market.participation.filter(
    (item) => item.status === "organizer_only"
  )
  const merchantPubkeys = useMemo(
    () => market.participation.map((item) => item.merchantPubkey),
    [market.participation]
  )
  const merchantProfilesQuery = useProfiles(merchantPubkeys, {
    authenticatedPubkey: market.organizerPubkey,
    priority: "visible",
    maxUnresolvedRefetches: 1,
  })

  function merchantProfileState(
    pubkey: string | undefined
  ): MerchantProfileState {
    if (!pubkey) return "unresolved"
    return getMerchantProfileState({
      hasProfile: merchantProfilesQuery.hasProfile(pubkey),
      lookupSettled: merchantProfilesQuery.lookupSettled,
      error: merchantProfilesQuery.error,
    })
  }

  return (
    <div className="space-y-5">
      {(displayState === "degraded" || displayState === "unavailable") && (
        <RelayEvidenceNotice
          unavailable={displayState === "unavailable"}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}

      <Card className="overflow-hidden">
        {market.imageUrl && (
          <img
            src={market.imageUrl}
            alt=""
            className="h-52 w-full object-cover"
          />
        )}
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-2xl">{market.title}</CardTitle>
              <CardDescription className="mt-2 max-w-2xl leading-6">
                {market.summary ?? "No public event summary."}
              </CardDescription>
            </div>
            <StatusPill variant={status.tone}>{status.label}</StatusPill>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-primary-400" />
              <div>
                <div className="font-medium text-[var(--text-primary)]">
                  {formatSchedule(market)}
                </div>
                {market.timezone && (
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {market.timezone}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-secondary-400" />
              <div>
                <div className="font-medium text-[var(--text-primary)]">
                  {market.pickupCoordinate
                    ? market.pickupTitle
                    : "Organizer handoff not offered"}
                </div>
                <div className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                  {market.pickupCoordinate ? (
                    <>
                      {market.pickupLocation ??
                        market.pickupGeohash ??
                        "Missing"}
                      {" · "}
                      {Number(market.pickupPrice ?? "0") === 0
                        ? "No added pickup fee"
                        : `${market.pickupPrice} ${market.pickupCurrency ?? "SAT"}`}
                    </>
                  ) : (
                    "Merchants can still offer their own pickup point."
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Organizer signer
            </div>
            <div className="mt-1 font-mono text-sm text-[var(--text-primary)]">
              {formatNpub(market.organizerPubkey, 12)}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <Button type="button" variant="outline" onClick={onEdit}>
                Update event
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              Refresh evidence
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Share this event</CardTitle>
          <CardDescription>
            Use the shopper link for attendees and the merchant link for sellers
            who want to add a product.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <section
            aria-labelledby="shopper-event-link-title"
            className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:grid-cols-[12.5rem_minmax(0,1fr)]"
          >
            <div
              role="img"
              aria-label="Shopper event catalog QR code"
              className="w-fit rounded-xl border border-[var(--border)] bg-white p-3"
            >
              <QRCodeSVG value={shopperUrl} size={176} level="M" />
            </div>
            <div className="min-w-0 space-y-3">
              <div>
                <h3
                  id="shopper-event-link-title"
                  className="font-semibold text-[var(--text-primary)]"
                >
                  Shopper event catalog
                </h3>
                <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                  Send this to shoppers so they can browse products accepted for
                  this event.
                </p>
              </div>
              <div className="break-all font-mono text-xs leading-5 text-[var(--text-muted)]">
                {shopperUrl}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onCopy(shopperUrl)}
                >
                  {copiedUrl === shopperUrl ? <Check /> : <Copy />}
                  {copiedUrl === shopperUrl
                    ? "Shopper link copied"
                    : "Copy shopper link"}
                </Button>
                <Button type="button" size="sm" variant="ghost" asChild>
                  <a href={shopperUrl} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Open shopper catalog
                  </a>
                </Button>
              </div>
            </div>
          </section>

          <section
            aria-labelledby="merchant-event-link-title"
            className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
          >
            <div>
              <h3
                id="merchant-event-link-title"
                className="font-semibold text-[var(--text-primary)]"
              >
                Merchant participation link
              </h3>
              <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                Send this to merchants. It opens Merchant with this exact event
                selected so they can publish a product request.
              </p>
            </div>
            <div className="break-all font-mono text-xs leading-5 text-[var(--text-muted)]">
              {merchantUrl}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onCopy(merchantUrl)}
              >
                {copiedUrl === merchantUrl ? <Check /> : <Copy />}
                {copiedUrl === merchantUrl
                  ? "Merchant link copied"
                  : "Copy merchant link"}
              </Button>
              <Button type="button" size="sm" variant="ghost" asChild>
                <a href={merchantUrl} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open merchant participation
                </a>
              </Button>
            </div>
          </section>

          <details className="rounded-xl border border-[var(--border)] px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-[var(--text-secondary)]">
              Portable event address (naddr)
            </summary>
            <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
              Technical detail for Nostr clients and manual import. The naddr
              preserves the organizer-owned collection coordinate.
            </p>
            <div className="mt-2 break-all font-mono text-xs text-[var(--text-secondary)]">
              {market.naddr}
            </div>
          </details>
        </CardContent>
      </Card>

      <OrganizerEventMarketDeliveryList
        deliveries={deliveries}
        retryingRecord={retryingRecord}
        onRetryDelivery={onRetryDelivery}
      />

      <Card>
        <CardHeader>
          <CardTitle>Product participation</CardTitle>
          <CardDescription>
            A merchant reference is only a request. Products appear in the
            official catalog only after this organizer collection accepts their
            exact coordinates. Profile context is informational; acceptance
            still uses the exact signed product and handoff evidence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Requests
              </h3>
              <Badge variant="outline">{pendingRequests.length}</Badge>
            </div>
            <div className="space-y-2">
              {pendingRequests.length > 0 ? (
                pendingRequests.map((item) => (
                  <ParticipationRow
                    key={item.productCoordinate}
                    item={item}
                    merchantProfile={
                      item.merchantPubkey
                        ? merchantProfilesQuery.getProfile(item.merchantPubkey)
                        : undefined
                    }
                    merchantProfileState={merchantProfileState(
                      item.merchantPubkey
                    )}
                    organizerPubkey={market.organizerPubkey}
                    pending={membershipPending || !canChangeMembership}
                    onMembership={onMembership}
                  />
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--text-muted)]">
                  No pending product requests were found in this bounded relay
                  view.
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Accepted products
              </h3>
              <Badge variant="outline">{acceptedProducts.length}</Badge>
            </div>
            <div className="space-y-2">
              {acceptedProducts.length > 0 ? (
                acceptedProducts.map((item) => (
                  <ParticipationRow
                    key={item.productCoordinate}
                    item={item}
                    merchantProfile={
                      item.merchantPubkey
                        ? merchantProfilesQuery.getProfile(item.merchantPubkey)
                        : undefined
                    }
                    merchantProfileState={merchantProfileState(
                      item.merchantPubkey
                    )}
                    organizerPubkey={market.organizerPubkey}
                    pending={membershipPending || !canChangeMembership}
                    onMembership={onMembership}
                  />
                ))
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm text-[var(--text-muted)]">
                  No current two-sided product acceptances were found.
                </p>
              )}
            </div>
          </section>

          {organizerOnlyProducts.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Organizer-only entries
                </h3>
                <Badge variant="outline">{organizerOnlyProducts.length}</Badge>
              </div>
              <p className="mb-3 text-sm leading-6 text-[var(--text-muted)]">
                These coordinates remain in the organizer collection, but no
                current merchant request was verified. They are not accepted
                products; remove them to keep the signed catalog current.
              </p>
              <div className="space-y-2">
                {organizerOnlyProducts.map((item) => (
                  <ParticipationRow
                    key={item.productCoordinate}
                    item={item}
                    merchantProfile={
                      item.merchantPubkey
                        ? merchantProfilesQuery.getProfile(item.merchantPubkey)
                        : undefined
                    }
                    merchantProfileState={merchantProfileState(
                      item.merchantPubkey
                    )}
                    organizerPubkey={market.organizerPubkey}
                    pending={membershipPending || !canChangeMembership}
                    onMembership={onMembership}
                  />
                ))}
              </div>
            </section>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
