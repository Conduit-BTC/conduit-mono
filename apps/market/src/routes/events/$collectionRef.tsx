import {
  AlertCircle,
  Archive,
  CalendarDays,
  Check,
  ChevronDown,
  MapPin,
  RefreshCw,
} from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  formatNpub,
  buildMarketEventCatalogUrl,
  useAuth,
  useConduitSession,
  useProfile,
  type Product,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  ShareLinkButton,
  eventMarketRequiredRecordsResolved,
  formatEventRelayReadCoverage,
  getEventActionabilityPresentation,
} from "@conduit/ui"
import { EventCatalogBrowser } from "../../components/EventCatalogBrowser"
import { CopyButton } from "../../components/CopyButton"
import {
  EventActorName,
  EventActorProvenance,
} from "../../components/EventActorIdentity"
import {
  getEventActorIdentityView,
  selectEventHandoffIdentity,
  type EventActorIdentityView,
} from "../../lib/event-actor-identity"
import {
  MerchantAvatarFallback,
  Nip05TrustIndicator,
  getMerchantDisplayName,
  getProfileNip05,
} from "../../components/MerchantIdentity"
import {
  PRODUCT_GRID_CLASS_NAME,
  ProductGridCard,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import { useCart } from "../../hooks/useCart"
import { useEventMarket } from "../../hooks/useEventMarket"
import { useMerchantIdentities } from "../../hooks/useMerchantIdentities"
import { useShopperPricing } from "../../hooks/useShopperPricing"
import { isSameCartFulfillment } from "../../lib/cart-model"
import {
  cartItemInputFromProductSelection,
  getDefaultProductSelection,
  getProductSelection,
} from "../../lib/productVariations"
import { getEventCatalogAuthorizedFamily } from "../../lib/event-catalog-browse"
import { getEventCatalogCartAction } from "../../lib/event-market-cart-action"
import {
  getEventCatalogProductAvailability,
  type EventCatalog,
} from "../../lib/event-market-adapter"
import {
  getPickupHandoffPrivacyCopy,
  getPickupHandoffSummary,
} from "../../lib/pickup-handoff"

export const Route = createFileRoute("/events/$collectionRef")({
  component: EventCatalogPage,
})

type CatalogStateCopy = {
  title: string
  message: string
  variant: "success" | "secondary" | "warning" | "destructive"
}

function EventCatalogProductCard({
  entry,
  catalog,
  purchaseReady,
  identity,
  organizerIdentity,
  imageLoading,
  btcUsdRate,
  pricePreference,
  onCartNotice,
  onMerchantActivate,
}: {
  entry: EventCatalog["products"][number]
  catalog: EventCatalog
  purchaseReady: boolean
  identity: ReturnType<ReturnType<typeof useMerchantIdentities>["getIdentity"]>
  organizerIdentity: EventActorIdentityView
  imageLoading: "eager" | "lazy"
  btcUsdRate: ReturnType<typeof useShopperPricing>["quote"]
  pricePreference: ReturnType<typeof useShopperPricing>["preference"]
  onMerchantActivate: () => void
  onCartNotice: (message: string) => void
}) {
  const cart = useCart()
  const { product } = entry
  const family = useMemo(() => getEventCatalogAuthorizedFamily(entry), [entry])
  const defaultSelection = useMemo(
    () => getDefaultProductSelection(product, family),
    [family, product]
  )
  const [selectedProductId, setSelectedProductId] = useState(
    defaultSelection.id
  )
  const selectedProduct = getProductSelection(
    product,
    family,
    selectedProductId
  )
  const pickupFulfillment =
    selectedProduct.id === product.id && product.type !== "variable"
      ? entry.pickupFulfillment
      : (entry.familyPickupFulfillments?.[selectedProduct.id] ?? null)
  const handoff = pickupFulfillment
    ? getPickupHandoffSummary(pickupFulfillment)
    : null
  const handlerIdentity = handoff
    ? selectEventHandoffIdentity({
        mode: handoff.mode,
        handlerPubkey: handoff.handlerPubkey,
        merchant: { pubkey: identity.pubkey, identity },
        organizer: {
          pubkey: catalog.organizerPubkey ?? "",
          identity: organizerIdentity,
        },
      })
    : null
  const candidate = pickupFulfillment
    ? cartItemInputFromProductSelection(
        product,
        selectedProduct,
        pickupFulfillment
      )
    : null
  const existing = cart.items.find(
    (item) => item.productId === selectedProduct.id
  )
  const sameFulfillment =
    !!existing && !!candidate
      ? isSameCartFulfillment(existing, candidate)
      : false
  const cartQuantity = sameFulfillment ? (existing?.quantity ?? 0) : 0
  const cartAction = getEventCatalogCartAction({
    state: catalog.state,
    purchaseReady,
    hasPickupFulfillment: pickupFulfillment !== null,
  })
  const canAdd = cartAction.enabled

  useEffect(() => {
    setSelectedProductId(defaultSelection.id)
  }, [defaultSelection.id])

  const add = (selection: Product) => {
    if (selection.id !== selectedProduct.id || !canAdd || !candidate) return
    if (existing && !sameFulfillment) {
      onCartNotice(
        "This product is already in your cart with different fulfillment. Remove that line before adding event pickup."
      )
      return
    }
    cart.addItem(candidate, 1)
    onCartNotice(
      `${product.title} was added for ${handoff?.label.toLowerCase() ?? "event pickup"}.`
    )
  }

  const decrement = (selection: Product) => {
    if (selection.id !== selectedProduct.id || !existing || !sameFulfillment) {
      return
    }
    const identity = {
      merchantPubkey: selectedProduct.pubkey,
      productId: selectedProduct.id,
    }
    if (existing.quantity <= 1) {
      cart.removeItem(identity)
      return
    }
    cart.setQuantity(identity, existing.quantity - 1)
  }

  return (
    <>
      <ProductGridCard
        product={product}
        family={family}
        className="h-auto"
        selectedProductId={selectedProduct.id}
        onSelectedProductChange={(selection) =>
          setSelectedProductId(selection.id)
        }
        merchantName={identity.displayName}
        merchantNamePending={identity.status === "pending"}
        imageLoading={imageLoading}
        btcUsdRate={btcUsdRate}
        pricePreference={pricePreference}
        allowZeroPrice={pickupFulfillment !== null}
        cartQuantity={cartQuantity}
        onProductActivate={null}
        onMerchantActivate={onMerchantActivate}
        onAddToCart={add}
        onIncrement={canAdd ? add : undefined}
        onDecrement={canAdd ? decrement : undefined}
        cartActionDisabled={!cartAction.enabled}
        cartActionDisabledLabel={cartAction.disabledLabel ?? undefined}
      />
      {!pickupFulfillment ? (
        <div className="rounded-lg border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
          {entry.evidenceState === "retained" ? (
            <>
              Previously verified product details are shown while current relay
              evidence is unavailable. Checkout is disabled until the exact
              product and pickup terms are confirmed again.
            </>
          ) : (
            <>
              Organizer accepted; this selected product or option has no current
              exact merchant pickup link. Checkout is disabled.
            </>
          )}
        </div>
      ) : handoff && handlerIdentity ? (
        <details className="group/pickup rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] text-xs leading-5 text-[var(--text-secondary)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block font-medium text-[var(--text-primary)]">
                {handoff.label}
              </span>
              <span className="block break-words">
                Handled by <EventActorName identity={handlerIdentity} />
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 font-medium text-[var(--text-primary)]">
              <span className="sr-only sm:not-sr-only">Details</span>
              <ChevronDown
                className="h-3.5 w-3.5 transition-transform duration-200 group-open/pickup:rotate-180"
                aria-hidden="true"
              />
            </span>
          </summary>
          <div className="border-t border-[var(--border)] px-3 py-2">
            <p className="font-medium text-[var(--text-primary)]">
              {pickupFulfillment.option.title}
            </p>
            {pickupFulfillment.option.location ? (
              <p className="mt-1">{pickupFulfillment.option.location}</p>
            ) : null}
            <p className="mt-2">{getPickupHandoffPrivacyCopy(handoff)}</p>
            <div className="mt-2 flex justify-end">
              <EventActorProvenance
                pubkey={handoff.handlerPubkey}
                copyLabel="Copy pickup handler npub"
              />
            </div>
          </div>
        </details>
      ) : null}
    </>
  )
}

export function getEventCatalogStateCopy(
  state: EventCatalog["state"],
  requiredEventRecordsResolved = true,
  availableProductCount = 0,
  unresolvedProductCount = 0
): CatalogStateCopy | null {
  const presentation = getEventActionabilityPresentation({
    state,
    availableProductCount,
    unresolvedProductCount,
    requiredEventRecordsResolved,
  })
  if (!presentation.prominent) return null
  return {
    title: presentation.label,
    message: presentation.message,
    variant: presentation.tone,
  }
}

function formatCalendarSchedule(
  calendar: NonNullable<EventCatalog["calendar"]>
): string {
  if (calendar.kind === 31922 && calendar.startDate) {
    return calendar.endDate
      ? `${calendar.startDate} to ${calendar.endDate} (end date exclusive)`
      : calendar.startDate
  }

  const timeZone = calendar.startTzid || undefined
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }
  try {
    const formatter = new Intl.DateTimeFormat(undefined, options)
    const start = formatter.format(new Date(calendar.start))
    const end = Number.isFinite(calendar.end)
      ? formatter.format(new Date(calendar.end))
      : null
    return `${start}${end ? ` – ${end}` : ""}${timeZone ? ` (${timeZone})` : ""}`
  } catch {
    const start = new Date(calendar.start).toLocaleString()
    const end = Number.isFinite(calendar.end)
      ? new Date(calendar.end).toLocaleString()
      : null
    return end ? `${start} – ${end}` : start
  }
}

function shortEventId(eventId: string): string {
  return eventId.length > 18
    ? `${eventId.slice(0, 9)}…${eventId.slice(-7)}`
    : eventId
}

function EvidenceRow({ label, eventId }: { label: string; eventId: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-t border-[var(--border)] py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {label}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-[var(--text-secondary)]">
          {shortEventId(eventId)}
        </div>
      </div>
      <CopyButton
        value={eventId}
        npub={false}
        label={`Copy ${label} event id`}
      />
    </div>
  )
}

function StatePanel({
  copy,
  retrying,
  onRetry,
}: {
  copy: CatalogStateCopy
  retrying: boolean
  onRetry: () => void
}) {
  const Icon = copy.variant === "secondary" ? Archive : AlertCircle
  return (
    <section
      className="mx-auto max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8"
      role="alert"
    >
      <Badge variant={copy.variant}>{copy.title}</Badge>
      <div className="mt-5 flex items-start gap-4">
        <Icon className="mt-0.5 h-6 w-6 shrink-0 text-[var(--text-secondary)]" />
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
            {copy.title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
            {copy.message}
          </p>
          {copy.variant !== "secondary" ? (
            <Button
              variant="outline"
              className="mt-5"
              disabled={retrying}
              onClick={onRetry}
            >
              <RefreshCw
                className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`}
              />
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function EventCatalogPage() {
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const shouldContinueAccountRead = () =>
    authGenerationRef.current === authGeneration
  const { collectionRef } = Route.useParams()
  const shopperPricing = useShopperPricing()
  const session = useConduitSession()
  const [cartNotice, setCartNotice] = useState<string | null>(null)
  const query = useEventMarket(collectionRef, shopperPricing.quote)
  const catalog = query.data
  const organizerPubkey = catalog?.organizerPubkey ?? ""
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const accountPubkey = authenticatedPubkey
  const { data: organizerProfile } = useProfile(organizerPubkey, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    maxUnresolvedRefetches: 2,
  })
  const organizerName = organizerPubkey
    ? getMerchantDisplayName(organizerProfile, organizerPubkey, {
        prefix: "Organizer",
      })
    : "Event organizer"
  const organizerNip05 = getProfileNip05(organizerProfile)
  const organizerIdentity: EventActorIdentityView = organizerPubkey
    ? getEventActorIdentityView({
        pubkey: organizerPubkey,
        profile: organizerProfile,
      })
    : { displayName: "Event organizer" }
  const merchantPubkeys = useMemo(
    () =>
      Array.from(
        new Set(catalog?.products.map(({ product }) => product.pubkey) ?? [])
      ),
    [catalog?.products]
  )
  const merchantIdentities = useMerchantIdentities({
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    allMerchantPubkeys: merchantPubkeys,
    visibleMerchantPubkeys: merchantPubkeys,
    relayHintsByPubkey: {},
  })

  if (!session.relaySettingsReady || query.isLoading) {
    return (
      <div className="mx-auto max-w-6xl animate-pulse space-y-5">
        <div className="h-8 w-48 rounded bg-[var(--surface-elevated)]" />
        <div className="h-56 rounded-2xl bg-[var(--surface)]" />
        <div className={PRODUCT_GRID_CLASS_NAME}>
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-full">
              <ProductGridCardSkeleton />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (query.isError || !catalog) {
    return (
      <StatePanel
        copy={getEventCatalogStateCopy("unavailable")!}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const requiredEventRecordsResolved =
    eventMarketRequiredRecordsResolved(catalog)
  const productAvailability = getEventCatalogProductAvailability(catalog)
  const stateCopy = getEventCatalogStateCopy(
    catalog.state,
    requiredEventRecordsResolved,
    productAvailability.availableProductCount,
    productAvailability.unresolvedProductCount
  )
  const canRenderRetainedEvidence =
    catalog.state === "ended" ||
    catalog.state === "partial" ||
    catalog.state === "stale"
  if (stateCopy && !canRenderRetainedEvidence) {
    return (
      <StatePanel
        copy={stateCopy}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const { calendar, collection, pickups } = catalog
  if (!calendar || !collection || !organizerPubkey) {
    return (
      <StatePanel
        copy={getEventCatalogStateCopy("unavailable")!}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const eventLocations = calendar.locations.filter(Boolean)
  const calendarLocation = eventLocations.join(" · ")
  const archived = catalog.state === "ended"
  const actionability = getEventActionabilityPresentation({
    state: catalog.state,
    ...productAvailability,
    requiredEventRecordsResolved,
  })
  const relayCoverage = formatEventRelayReadCoverage(catalog.coverage)

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {stateCopy ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div role={actionability.role}>
            <Badge variant={stateCopy.variant}>{stateCopy.title}</Badge>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              {stateCopy.message}
            </p>
          </div>
          {stateCopy.variant !== "secondary" ? (
            <Button
              variant="outline"
              className="shrink-0 self-start sm:self-auto"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw
                className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              />
              Refresh evidence
            </Button>
          ) : null}
        </div>
      ) : null}

      <header className="space-y-3">
        {calendar.image || collection.image ? (
          <img
            src={calendar.image ?? collection.image}
            alt={`${calendar.title} banner`}
            className="h-28 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] object-contain sm:h-44"
          />
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 break-words text-balance text-3xl font-semibold text-[var(--text-primary)] sm:text-4xl">
            {calendar.title}
          </h1>
          {catalog.canonicalNaddr ? (
            <ShareLinkButton
              url={buildMarketEventCatalogUrl(
                window.location.origin,
                catalog.canonicalNaddr
              )}
              shareTitle={calendar.title}
              idleLabel="Share event"
              className="shrink-0"
            />
          ) : null}
        </div>
        <dl className="flex flex-col gap-x-6 gap-y-2 text-sm text-[var(--text-secondary)] sm:flex-row sm:flex-wrap">
          <div className="flex min-w-0 items-start gap-2">
            <CalendarDays
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-secondary-400"
            />
            <dt className="sr-only">Date and time</dt>
            <dd className="text-pretty">{formatCalendarSchedule(calendar)}</dd>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <MapPin
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-secondary-400"
            />
            <dt className="sr-only">Location</dt>
            <dd className="break-words text-pretty">
              {calendarLocation || calendar.geohash || "Location not published"}
            </dd>
          </div>
        </dl>
        <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Avatar className="size-7 shrink-0 border border-[var(--border)]">
            <AvatarImage
              src={organizerProfile?.picture}
              alt=""
              referrerPolicy="no-referrer"
            />
            <AvatarFallback>
              <MerchantAvatarFallback iconClassName="size-4" />
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 break-words">
            Organized by{" "}
            <span className="font-medium text-[var(--text-primary)]">
              {organizerName}
            </span>
          </span>
          {organizerNip05 ? (
            <Nip05TrustIndicator
              pubkey={organizerPubkey}
              nip05={organizerNip05}
              className="shrink-0"
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-secondary)]">
          <p>Pickup details are shown on each product.</p>
          {calendar.summary || collection.summary ? (
            <details className="group/about basis-full">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] [&::-webkit-details-marker]:hidden">
                About this event{" "}
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 group-open/about:rotate-180"
                />
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-pretty leading-6">
                {calendar.summary ?? collection.summary}
              </p>
            </details>
          ) : null}
        </div>
        {!actionability.prominent ? (
          <p
            className="text-pretty text-sm text-[var(--text-secondary)]"
            role={actionability.role}
            aria-live="polite"
            data-testid="event-actionability-status"
          >
            {actionability.message}
          </p>
        ) : null}
        {catalog.pickupCoordinate && !catalog.pickup ? (
          <p role="status" className="text-sm text-[var(--warning)]">
            Organizer handoff details are unresolved.
          </p>
        ) : null}
      </header>

      <EventCatalogBrowser
        key={collection.coordinate}
        products={catalog.products}
        identities={merchantIdentities.identitiesByPubkey}
        btcUsdRate={shopperPricing.quote}
        renderProduct={(entry, index, onMerchantActivate) => (
          <EventCatalogProductCard
            entry={entry}
            catalog={catalog}
            purchaseReady={!archived && catalog.purchaseReady}
            identity={merchantIdentities.getIdentity(entry.product.pubkey)}
            organizerIdentity={organizerIdentity}
            imageLoading={index < 4 ? "eager" : "lazy"}
            btcUsdRate={shopperPricing.quote}
            pricePreference={shopperPricing.preference}
            onCartNotice={setCartNotice}
            onMerchantActivate={onMerchantActivate}
          />
        )}
      >
        {catalog.productReadState !== "ready" ? (
          <div
            role="status"
            className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4 text-sm leading-6 text-[var(--text-secondary)]"
          >
            Some accepted products are unresolved. Previously verified product
            details remain visible. Products that cannot be confirmed are
            unavailable for checkout.
          </div>
        ) : null}
        {cartNotice ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]"
          >
            <Check
              className="mt-0.5 size-4 shrink-0 text-[var(--success)]"
              aria-hidden="true"
            />
            {cartNotice}
          </div>
        ) : null}
        {catalog.acceptedProductCount === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-secondary)]">
            The organizer has not accepted any products for this event.
          </p>
        ) : null}
      </EventCatalogBrowser>

      {catalog.unresolvedProductCoordinates.length > 0 ? (
        <details className="rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]">
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
            Accepted product details temporarily unavailable (
            {catalog.unresolvedProductCoordinates.length})
          </summary>
          <p className="mt-2 text-pretty">
            These products remain accepted for this event, but their details
            cannot be loaded yet. They are not included in search, merchant
            counts, or sorting. Checkout remains disabled for these items.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh products
          </Button>
        </details>
      ) : null}

      <details className="group/technical border-t border-[var(--border)] pt-4 text-sm text-[var(--text-secondary)]">
        <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] [&::-webkit-details-marker]:hidden">
          Technical details{" "}
          <ChevronDown
            aria-hidden="true"
            className="size-4 group-open/technical:rotate-180"
          />
        </summary>
        <div className="mt-4 space-y-4">
          <div>
            <h2 className="text-balance font-medium text-[var(--text-primary)]">
              Organizer identity
            </h2>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-xs">
                {formatNpub(organizerPubkey, 10)}
              </span>
              <CopyButton value={organizerPubkey} label="Copy organizer npub" />
            </div>
            <p className="mt-2 max-w-3xl text-pretty text-xs leading-5">
              This is the account that published the event. Each pickup option
              names the account responsible for handoff. Conduit does not
              operate an organizer registry or endorse the organizer.
            </p>
          </div>
          {relayCoverage ? (
            <p
              className="text-pretty text-xs tabular-nums"
              role="status"
              aria-label={`Relay read coverage: ${relayCoverage}`}
              data-testid="event-relay-read-coverage"
            >
              {relayCoverage}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh evidence
          </Button>
          <div
            className="max-h-80 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4"
            tabIndex={0}
            role="region"
            aria-label="Published event records"
          >
            <EvidenceRow label="Event details" eventId={calendar.eventId} />
            <EvidenceRow label="Product list" eventId={collection.eventId} />
            {pickups.map((pickup) => (
              <EvidenceRow
                key={pickup.coordinate}
                label={`Pickup: ${pickup.title}`}
                eventId={pickup.eventId}
              />
            ))}
          </div>
          {catalog.canonicalNaddr ? (
            <CopyButton
              value={catalog.canonicalNaddr}
              npub={false}
              label="Copy canonical event link"
            />
          ) : null}
        </div>
      </details>
    </div>
  )
}
