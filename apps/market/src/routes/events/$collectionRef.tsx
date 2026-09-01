import {
  AlertCircle,
  Archive,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  MapPin,
  Radio,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import {
  formatNpub,
  prepareProductCatalog,
  useConduitSession,
  useProfile,
  type Product,
} from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage, Badge, Button } from "@conduit/ui"
import { CopyButton } from "../../components/CopyButton"
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
import { getEventCatalogCartAction } from "../../lib/event-market-cart-action"
import type { EventCatalog } from "../../lib/event-market-adapter"
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
  variant: "secondary" | "warning" | "destructive"
}

function EventCatalogProductCard({
  entry,
  catalog,
  purchaseReady,
  identity,
  imageLoading,
  btcUsdRate,
  pricePreference,
  onCartNotice,
}: {
  entry: EventCatalog["products"][number]
  catalog: EventCatalog
  purchaseReady: boolean
  identity: ReturnType<ReturnType<typeof useMerchantIdentities>["getIdentity"]>
  imageLoading: "eager" | "lazy"
  btcUsdRate: ReturnType<typeof useShopperPricing>["quote"]
  pricePreference: ReturnType<typeof useShopperPricing>["preference"]
  onCartNotice: (message: string) => void
}) {
  const cart = useCart()
  const { product } = entry
  const authorizedFamily = useMemo(() => {
    if (!entry.family) return undefined
    const authorizedChildren = entry.family.children.filter(
      (child) => entry.familyPickupFulfillments?.[child.product.id]
    )
    const prepared = prepareProductCatalog(
      [entry.family.parent, ...authorizedChildren],
      entry.family.readEvidence
    ).items[0]
    return prepared?.kind === "family" ? prepared.family : undefined
  }, [entry.family, entry.familyPickupFulfillments])
  const family = authorizedFamily
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
      ) : handoff ? (
        <details className="group/pickup rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] text-xs leading-5 text-[var(--text-secondary)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block font-medium text-[var(--text-primary)]">
                {handoff.label}
              </span>
              <span className="block truncate font-mono">
                Handled by {formatNpub(handoff.handlerPubkey, 10)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 font-medium text-[var(--text-primary)]">
              Details
              <ChevronDown
                className="h-3.5 w-3.5 transition-transform duration-200 group-open/pickup:rotate-180"
                aria-hidden="true"
              />
            </span>
          </summary>
          <div className="border-t border-[var(--border)] px-3 py-2">
            <p>{getPickupHandoffPrivacyCopy(handoff)}</p>
            <div className="mt-2 flex justify-end">
              <CopyButton
                value={handoff.handlerPubkey}
                label="Copy pickup handler npub"
              />
            </div>
          </div>
        </details>
      ) : null}
    </>
  )
}

export function getEventCatalogStateCopy(
  state: EventCatalog["state"]
): CatalogStateCopy | null {
  switch (state) {
    case "active":
      return null
    case "ended":
      return {
        title: "Archived event catalog",
        message:
          "This signed event has ended. Its accepted products remain visible as a read-only archive, but checkout is closed.",
        variant: "secondary",
      }
    case "missing":
      return {
        title: "Event catalog not found",
        message:
          "No signed collection was found for this reference. A relay may not have the event yet.",
        variant: "warning",
      }
    case "partial":
      return {
        title: "Event evidence is incomplete",
        message:
          "Some relays could not be confirmed. Products backed by exact live signed evidence may remain available; unresolved products stay closed.",
        variant: "warning",
      }
    case "unavailable":
      return {
        title: "Event relays are unavailable",
        message:
          "Conduit could not confirm the organizer's signed event records. Try again when relay access recovers.",
        variant: "warning",
      }
    case "stale":
      return {
        title: "Event evidence is out of date",
        message:
          "Only stale signed evidence is available. Refresh before relying on the schedule, pickup, or catalog.",
        variant: "warning",
      }
    case "deleted":
      return {
        title: "Event catalog removed",
        message:
          "The organizer's signed deletion is authoritative. Products and checkout are no longer shown here.",
        variant: "destructive",
      }
    case "conflicting":
      return {
        title: "Conflicting event evidence",
        message:
          "The signed records do not agree on this event catalog. Conduit will not choose between them or offer checkout.",
        variant: "destructive",
      }
    case "malformed":
      return {
        title: "Invalid event link",
        message:
          "This link is not a supported event-collection reference. Ask the organizer for the canonical event link.",
        variant: "destructive",
      }
    case "unsupported":
      return {
        title: "Unsupported event catalog",
        message:
          "This catalog uses signed references that this version of Conduit cannot safely interpret.",
        variant: "warning",
      }
    default:
      return {
        title: "Unsupported event catalog",
        message:
          "This catalog state cannot be interpreted safely by this version of Conduit.",
        variant: "warning",
      }
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
    <section className="mx-auto max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8">
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
  const { collectionRef } = Route.useParams()
  const shopperPricing = useShopperPricing()
  const session = useConduitSession()
  const [cartNotice, setCartNotice] = useState<string | null>(null)
  const query = useEventMarket(collectionRef, shopperPricing.quote)
  const catalog = query.data
  const organizerPubkey = catalog?.organizerPubkey ?? ""
  const { data: organizerProfile } = useProfile(organizerPubkey)
  const organizerName = organizerPubkey
    ? getMerchantDisplayName(organizerProfile, organizerPubkey, {
        prefix: "Organizer",
      })
    : "Event organizer"
  const organizerNip05 = getProfileNip05(organizerProfile)
  const merchantPubkeys = useMemo(
    () =>
      Array.from(
        new Set(catalog?.products.map(({ product }) => product.pubkey) ?? [])
      ),
    [catalog?.products]
  )
  const merchantIdentities = useMerchantIdentities({
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

  const stateCopy = getEventCatalogStateCopy(catalog.state)
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
        copy={getEventCatalogStateCopy("partial")!}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const eventPickupSummary =
    pickups.length === 0
      ? "Organizer handoff is not offered. Accepted merchants may provide their own pickup point."
      : pickups.length === 1
        ? [pickups[0]!.title, pickups[0]!.location ?? pickups[0]!.geohash]
            .filter(Boolean)
            .join(" / ")
        : `${pickups.length} pickup options; each product shows who handles it.`
  const eventLocations = calendar.locations.filter(Boolean)
  const calendarLocation = eventLocations.join(" · ")
  const archived = catalog.state === "ended"
  const stateBadge =
    catalog.state === "active"
      ? ({ label: "Active event", variant: "success" } as const)
      : catalog.state === "ended"
        ? ({ label: "Ended", variant: "secondary" } as const)
        : ({ label: "Evidence degraded", variant: "warning" } as const)

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {stateCopy ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
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

      <section className="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)]">
        {calendar.image || collection.image ? (
          <img
            src={calendar.image ?? collection.image}
            alt=""
            className="h-48 w-full border-b border-[var(--border)] object-cover sm:h-64"
          />
        ) : null}
        <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
              <Badge variant="outline" className="gap-1.5">
                <Radio className="h-3.5 w-3.5" /> Published by organizer
              </Badge>
            </div>
            <h1 className="mt-5 text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-5xl">
              {calendar.title}
            </h1>
            {(calendar.summary || collection.summary) && (
              <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--text-secondary)]">
                {calendar.summary ?? collection.summary}
              </p>
            )}

            <dl className="mt-7 grid gap-4 text-sm text-[var(--text-secondary)] sm:grid-cols-2">
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Date and time
                  </dt>
                  <dd className="mt-1 leading-6">
                    {formatCalendarSchedule(calendar)}
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Location
                  </dt>
                  <dd className="mt-1 leading-6">
                    {calendarLocation || calendar.geohash || "Not published"}
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:col-span-2">
                <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-secondary-400" />
                <div>
                  <dt className="font-medium text-[var(--text-primary)]">
                    Pickup
                  </dt>
                  <dd className="mt-1 leading-6">{eventPickupSummary}</dd>
                </div>
              </div>
            </dl>
          </div>

          <aside className="space-y-5">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Organizer identity
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Avatar className="h-11 w-11 border border-[var(--border)]">
                  <AvatarImage
                    src={organizerProfile?.picture}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                  <AvatarFallback>
                    <MerchantAvatarFallback iconClassName="h-5 w-5" />
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="truncate font-medium text-[var(--text-primary)]">
                    {organizerName}
                  </div>
                  {organizerNip05 ? (
                    <Nip05TrustIndicator
                      pubkey={organizerPubkey}
                      nip05={organizerNip05}
                      className="mt-1 max-w-full text-xs text-[var(--text-muted)]"
                    />
                  ) : null}
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <span className="truncate font-mono text-xs text-[var(--text-secondary)]">
                  {formatNpub(organizerPubkey, 10)}
                </span>
                <CopyButton
                  value={organizerPubkey}
                  label="Copy organizer npub"
                />
              </div>
              <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">
                This is the account that published the event. Each pickup option
                names the account responsible for handoff. Conduit does not
                operate an organizer registry or endorse the organizer.
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] px-5 py-2">
              <EvidenceRow label="Event details" eventId={calendar.eventId} />
              <EvidenceRow label="Product list" eventId={collection.eventId} />
              {pickups.map((pickup, index) => (
                <EvidenceRow
                  key={pickup.coordinate}
                  label={
                    pickups.length === 1 ? "Pickup" : `Pickup ${index + 1}`
                  }
                  eventId={pickup.eventId}
                />
              ))}
              {catalog.canonicalNaddr ? (
                <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] py-3">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                      Share link
                    </div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      Portable event address
                    </div>
                  </div>
                  <CopyButton
                    value={catalog.canonicalNaddr}
                    npub={false}
                    label="Copy canonical event link"
                  />
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>

      <section>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-secondary-400" />
              <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
                Accepted products
              </h2>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              The organizer's collection controls acceptance. Each product is
              still authored by its merchant and needs its own exact collection
              and pickup link before checkout opens.
            </p>
          </div>
          <Badge variant="outline">
            {catalog.acceptedProductCount} product
            {catalog.acceptedProductCount === 1 ? "" : "s"}
          </Badge>
        </div>

        {catalog.productReadState !== "ready" ? (
          <div
            role="status"
            className="mt-5 rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4 text-sm leading-6 text-[var(--text-secondary)]"
          >
            Relay coverage is degraded. Previously verified accepted products
            remain visible, while checkout stays closed for anything without
            current exact product and pickup evidence.
          </div>
        ) : null}

        {cartNotice ? (
          <div
            role="status"
            className="mt-5 flex items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]"
          >
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
            {cartNotice}
          </div>
        ) : null}

        {catalog.acceptedProductCount === 0 ? (
          <div className="mt-6 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm leading-6 text-[var(--text-secondary)]">
            The organizer has not accepted any products for this event.
          </div>
        ) : (
          <ul className={`mt-6 ${PRODUCT_GRID_CLASS_NAME}`}>
            {catalog.products.map((entry, index) => {
              const { product } = entry
              const identity = merchantIdentities.getIdentity(product.pubkey)

              return (
                <li key={product.id} className="min-w-0 space-y-2">
                  <EventCatalogProductCard
                    entry={entry}
                    catalog={catalog}
                    purchaseReady={!archived && catalog.purchaseReady}
                    identity={identity}
                    imageLoading={index < 3 ? "eager" : "lazy"}
                    btcUsdRate={shopperPricing.quote}
                    pricePreference={shopperPricing.preference}
                    onCartNotice={setCartNotice}
                  />
                </li>
              )
            })}
            {catalog.unresolvedProductCoordinates.map((coordinate) => (
              <li
                key={coordinate}
                className="min-w-0 rounded-xl border border-dashed border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-5 text-sm leading-6 text-[var(--text-secondary)]"
              >
                <div className="font-medium text-[var(--text-primary)]">
                  Accepted product details temporarily unavailable
                </div>
                <p className="mt-2">
                  The organizer's acceptance is still recorded, but no safe
                  product details are available to show yet. Checkout remains
                  disabled for this item.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
