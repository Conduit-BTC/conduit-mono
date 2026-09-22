import {
  AlertCircle,
  Archive,
  ChevronDown,
  ExternalLink,
  RefreshCw,
} from "lucide-react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  buildMarketEventCatalogUrl,
  buildMerchantEventParticipationUrl,
  inferConduitAppOrigin,
  normalizePubkey,
  pubkeyToNpub,
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
  EventPageHeader,
  eventMarketRequiredRecordsResolved,
  formatEventRelayReadCoverage,
  getEventActionabilityPresentation,
  useTimeBoundaryNow,
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
import {
  createPendingEventPickupFulfillment,
  isPendingEventPickupCartItem,
  selectCartLine,
} from "../../lib/cart-model"
import {
  cartItemInputFromProductSelection,
  getDefaultProductSelection,
  getProductSelection,
} from "../../lib/productVariations"
import {
  getEventCatalogCartAction,
  getEventCatalogPickupGate,
} from "../../lib/event-market-cart-action"
import {
  getEventCatalogProductAvailability,
  type EventCatalog,
} from "../../lib/event-market-adapter"
import { parseEventCatalogSearch } from "../../lib/event-catalog-search"
import {
  getPickupHandoffPrivacyCopy,
  getPickupHandoffSummary,
} from "../../lib/pickup-handoff"

export const Route = createFileRoute("/events/$collectionRef")({
  component: EventCatalogPage,
  validateSearch: parseEventCatalogSearch,
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
  isChecking,
  identity,
  organizerIdentity,
  imageLoading,
  btcUsdRate,
  pricePreference,
  onMerchantActivate,
}: {
  entry: EventCatalog["products"][number]
  catalog: EventCatalog
  purchaseReady: boolean
  isChecking: boolean
  identity: ReturnType<ReturnType<typeof useMerchantIdentities>["getIdentity"]>
  organizerIdentity: EventActorIdentityView
  imageLoading: "eager" | "lazy"
  btcUsdRate: ReturnType<typeof useShopperPricing>["quote"]
  pricePreference: ReturnType<typeof useShopperPricing>["preference"]
  onMerchantActivate: () => void
}) {
  const cart = useCart()
  const { upgradePendingEventPickupItem } = cart
  const { product } = entry
  // The adapter has already applied listing and membership safety. Keep the
  // display family intact while exact child pickup authorization is checked.
  const family = entry.family
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
  const pickupReadiness =
    selectedProduct.id === product.id && product.type !== "variable"
      ? entry.pickupReadiness
      : (entry.familyPickupReadiness?.[selectedProduct.id] ?? "terminal")
  const pickupLocation =
    pickupFulfillment?.option.location ?? pickupFulfillment?.option.geohash
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
  const exactCandidate = pickupFulfillment
    ? cartItemInputFromProductSelection(
        product,
        selectedProduct,
        pickupFulfillment
      )
    : null
  const pendingFulfillment =
    catalog.collection && selectedProduct.format !== "digital"
      ? createPendingEventPickupFulfillment(catalog.collection.coordinate)
      : null
  const pendingCandidate = pendingFulfillment
    ? cartItemInputFromProductSelection(
        product,
        selectedProduct,
        pendingFulfillment
      )
    : null
  const exactExisting = exactCandidate
    ? selectCartLine(cart.items, exactCandidate)
    : undefined
  const pendingExisting = pendingCandidate
    ? selectCartLine(cart.items, pendingCandidate)
    : undefined
  const existing = exactExisting ?? pendingExisting
  const cartQuantity = existing?.quantity ?? 0
  const pickupGate = getEventCatalogPickupGate({
    pickupReadiness,
    hasPickupFulfillment: pickupFulfillment !== null,
    hasPendingCandidate: pendingCandidate !== null,
    isChecking,
  })
  const pendingEvidenceMayRecover = pickupGate.allowPendingCart
  const cartAction = getEventCatalogCartAction({
    state: catalog.state,
    orderAcceptance: catalog.collection?.orderAcceptance,
    purchaseReady,
    hasPickupFulfillment: pickupFulfillment !== null,
    allowPendingCart: pendingEvidenceMayRecover,
    isChecking: pickupGate.isChecking,
  })
  const canAdd = cartAction.enabled

  useEffect(() => {
    setSelectedProductId((previous) =>
      previous === product.id ||
      family?.children.some((child) => child.product.id === previous)
        ? previous
        : defaultSelection.id
    )
  }, [defaultSelection.id, family, product.id])

  useEffect(() => {
    if (
      !canAdd ||
      !pendingExisting ||
      !exactCandidate ||
      !pickupFulfillment ||
      !selectedProduct.sourceEventId
    ) {
      return
    }
    void upgradePendingEventPickupItem(pendingExisting, {
      ...exactCandidate,
      fulfillment: pickupFulfillment,
      productUpdatedAt: selectedProduct.updatedAt,
      productEventId: selectedProduct.sourceEventId,
    })
  }, [
    canAdd,
    exactCandidate,
    pendingExisting,
    pickupFulfillment,
    selectedProduct.sourceEventId,
    selectedProduct.updatedAt,
    upgradePendingEventPickupItem,
  ])

  const add = async (selection: Product) => {
    const candidate = exactCandidate ?? pendingCandidate
    if (selection.id !== selectedProduct.id || !canAdd || !candidate) return
    await cart.addItem(candidate, 1)
  }
  const increment = async (selection: Product) => {
    const candidate = exactCandidate ?? pendingCandidate
    if (selection.id !== selectedProduct.id || !existing || !candidate) return
    if (
      isPendingEventPickupCartItem(existing) &&
      exactCandidate &&
      pickupFulfillment &&
      selectedProduct.sourceEventId
    ) {
      const upgraded = await upgradePendingEventPickupItem(existing, {
        ...exactCandidate,
        fulfillment: pickupFulfillment,
        productUpdatedAt: selectedProduct.updatedAt,
        productEventId: selectedProduct.sourceEventId,
      })
      if (!upgraded.changed) return
      await cart.addItem(exactCandidate, 1)
      return
    }
    await cart.refreshAndIncrementItem(existing, candidate, 1)
  }

  const decrement = (selection: Product) => {
    if (selection.id !== selectedProduct.id || !existing) {
      return
    }
    if (existing.quantity <= 1) {
      cart.removeItem(existing)
      return
    }
    cart.decrementItem(existing)
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
        allowZeroPrice={pickupFulfillment !== null || pendingEvidenceMayRecover}
        cartQuantity={cartQuantity}
        onProductActivate={null}
        onMerchantActivate={onMerchantActivate}
        onAddToCart={add}
        onIncrement={canAdd ? increment : undefined}
        onDecrement={canAdd ? decrement : undefined}
        cartActionDisabled={!cartAction.enabled}
        cartActionDisabledLabel={cartAction.disabledLabel ?? undefined}
      />
      {!pickupFulfillment ? (
        <div className="rounded-lg border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
          {pendingEvidenceMayRecover ? (
            <>
              Current pickup terms are being verified. You can add this item
              now; checkout stays locked until this exact product is confirmed.
            </>
          ) : entry.evidenceState === "retained" ? (
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
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-[var(--text-primary)]">
                {handoff.label}
              </span>
              <span
                className="block truncate"
                title={`Handled by ${handlerIdentity.displayName}`}
              >
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
            {pickupLocation ? <p className="mt-1">{pickupLocation}</p> : null}
            <p className="mt-2 break-words">
              Handled by <EventActorName identity={handlerIdentity} />
            </p>
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
  if (presentation.visibility !== "prominent") return null
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

function shortTechnicalValue(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value
}

function TechnicalValueRow({
  label,
  value,
  copyLabel,
}: {
  label: string
  value: string
  copyLabel: string
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-t border-[var(--border)] py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {label}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-[var(--text-secondary)]">
          {shortTechnicalValue(value)}
        </div>
      </div>
      <CopyButton value={value} npub={false} label={copyLabel} />
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
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [catalogSearch, setCatalogSearch] = useState("")
  useEffect(() => setCatalogSearch(""), [collectionRef])
  const selectedMerchantPubkey = normalizePubkey(search.merchant) ?? ""
  const updateMerchantFilter = (merchantPubkey: string) => {
    const normalized = merchantPubkey ? normalizePubkey(merchantPubkey) : null
    navigate({
      search: (previous) => {
        const next = { ...previous }
        if (normalized) next.merchant = pubkeyToNpub(normalized)
        else delete next.merchant
        return next
      },
      replace: true,
    })
  }
  const shopperPricing = useShopperPricing()
  const session = useConduitSession()
  const query = useEventMarket(collectionRef, shopperPricing.quote, {
    selectedMerchantPubkey: selectedMerchantPubkey || undefined,
  })
  // A booth QR gets exclusive foreground transport until its merchant-scoped
  // graph settles. The complete event catalog then warms quietly for filter
  // removal and later navigation without delaying the first cart action.
  useEventMarket(collectionRef, shopperPricing.quote, {
    enabled: !!selectedMerchantPubkey && !!query.data && !query.isHydrating,
  })
  const catalog = query.data
  const scheduleBoundaries = useMemo(
    () =>
      catalog?.calendar ? [catalog.calendar.start, catalog.calendar.end] : [],
    [catalog?.calendar]
  )
  const scheduleNow = useTimeBoundaryNow(scheduleBoundaries)
  const isChecking = query.isHydrating
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
        new Set([
          ...(catalog?.products.map(({ product }) => product.pubkey) ?? []),
          ...(selectedMerchantPubkey ? [selectedMerchantPubkey] : []),
        ])
      ),
    [catalog?.products, selectedMerchantPubkey]
  )
  const merchantIdentities = useMerchantIdentities({
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    allMerchantPubkeys: merchantPubkeys,
    visibleMerchantPubkeys: merchantPubkeys,
    relayHintsByPubkey: {},
  })
  const selectedMerchantName = selectedMerchantPubkey
    ? merchantIdentities.getIdentity(selectedMerchantPubkey).displayName
    : undefined

  const awaitingHeader =
    isChecking &&
    catalog &&
    ["partial", "stale", "unavailable"].includes(catalog.state) &&
    (!catalog.calendar || !catalog.collection)
  if (
    !session.relaySettingsReady ||
    (!catalog && query.isInitialLoading) ||
    awaitingHeader
  ) {
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

  if (!catalog) {
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
    orderAcceptance: catalog.collection?.orderAcceptance,
    ...productAvailability,
    requiredEventRecordsResolved,
  })
  const relayCoverage = formatEventRelayReadCoverage(catalog.coverage)

  return (
    <div className="mx-auto max-w-6xl space-y-5 sm:space-y-8">
      {stateCopy && !isChecking ? (
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

      <EventPageHeader
        key={`event-header:${collection.coordinate}`}
        title={calendar.title}
        summary={calendar.summary ?? collection.summary}
        imageUrl={calendar.image ?? collection.image}
        schedule={formatCalendarSchedule(calendar)}
        location={
          calendarLocation || calendar.geohash || "Location not published"
        }
        organizer={
          <div className="flex min-w-0 items-center gap-2">
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
                display="icon"
              />
            ) : null}
          </div>
        }
        actions={
          catalog.canonicalNaddr ? (
            <Button asChild variant="outline" size="sm">
              <a
                href={buildMerchantEventParticipationUrl(
                  inferConduitAppOrigin(
                    "merchant",
                    window.location,
                    import.meta.env.VITE_BUILD_BRANCH
                  ),
                  catalog.canonicalNaddr
                )}
              >
                Sell here
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </Button>
          ) : null
        }
        shareUrl={
          catalog.canonicalNaddr
            ? buildMarketEventCatalogUrl(
                window.location.origin,
                catalog.canonicalNaddr,
                selectedMerchantPubkey
                  ? { merchantPubkey: selectedMerchantPubkey }
                  : undefined
              )
            : undefined
        }
        shareTitle={
          selectedMerchantName
            ? `${selectedMerchantName} at ${calendar.title}`
            : calendar.title
        }
        shareLabel={selectedMerchantPubkey ? "Share this view" : "Share event"}
      >
        {collection.orderAcceptance === "open" &&
        calendar.end <= scheduleNow ? (
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            Scheduled time has passed.{" "}
            {catalog.state === "stale" || isChecking
              ? "Refresh to confirm whether the event is still open."
              : "This event remains open until the organizer closes it."}
          </p>
        ) : null}
        {!isChecking && actionability.visibility === "inline" ? (
          <p
            className="text-pretty text-sm text-[var(--text-secondary)]"
            data-testid="event-actionability-status"
          >
            {actionability.message}
          </p>
        ) : null}
        {!isChecking && catalog.pickupCoordinate && !catalog.pickup ? (
          <p className="text-sm text-[var(--warning)]">
            Organizer handoff details are unresolved.
          </p>
        ) : null}
      </EventPageHeader>

      <EventCatalogBrowser
        key={collection.coordinate}
        products={catalog.products}
        identities={merchantIdentities.identitiesByPubkey}
        search={catalogSearch}
        merchant={selectedMerchantPubkey}
        selectedMerchantName={selectedMerchantName}
        onSearchChange={setCatalogSearch}
        onMerchantChange={updateMerchantFilter}
        renderProduct={(entry, index, onMerchantActivate) => (
          <EventCatalogProductCard
            entry={entry}
            catalog={catalog}
            purchaseReady={!archived && catalog.purchaseReady}
            isChecking={isChecking}
            identity={merchantIdentities.getIdentity(entry.product.pubkey)}
            organizerIdentity={organizerIdentity}
            imageLoading={index < 4 ? "eager" : "lazy"}
            btcUsdRate={shopperPricing.quote}
            pricePreference={shopperPricing.preference}
            onMerchantActivate={onMerchantActivate}
          />
        )}
      >
        {!isChecking && catalog.productReadState !== "ready" ? (
          <div className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
            Some accepted products are unresolved. Previously verified product
            details remain visible. Products that cannot be confirmed are
            unavailable for checkout.
          </div>
        ) : null}
        {isChecking && catalog.products.length === 0 ? (
          <div
            className={PRODUCT_GRID_CLASS_NAME}
            aria-label="Loading event products"
            aria-busy="true"
          >
            {[0, 1, 2, 3].map((index) => (
              <ProductGridCardSkeleton key={index} />
            ))}
          </div>
        ) : !isChecking &&
          catalog.acceptedProductCount === 0 &&
          catalog.products.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-secondary)]">
            {selectedMerchantPubkey
              ? "This merchant has no organizer-accepted products for this event."
              : "The organizer has not accepted any products for this event."}
          </p>
        ) : null}
      </EventCatalogBrowser>

      {!isChecking && catalog.unresolvedProductCoordinates.length > 0 ? (
        <details className="rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]">
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
            Accepted product details temporarily unavailable (
            {catalog.unresolvedProductCoordinates.length})
          </summary>
          <p className="mt-2 text-pretty">
            These products remain accepted for this event, but their details
            cannot be loaded yet. They are not included in search results,
            merchant counts, or merchant groups. Checkout remains disabled for
            these items.
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
            <div className="mt-2 min-w-0">
              <EventActorName identity={organizerIdentity} className="block" />
              <EventActorProvenance
                pubkey={organizerPubkey}
                copyLabel="Copy organizer npub"
                className="mt-1 flex text-xs"
              />
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
            aria-label="Published event records and catalog reference"
          >
            <TechnicalValueRow
              label="Event details"
              value={calendar.eventId}
              copyLabel="Copy Event details event id"
            />
            <TechnicalValueRow
              label="Product list"
              value={collection.eventId}
              copyLabel="Copy Product list event id"
            />
            {pickups.map((pickup) => (
              <TechnicalValueRow
                key={pickup.coordinate}
                label={`Pickup: ${pickup.title}`}
                value={pickup.eventId}
                copyLabel={`Copy Pickup: ${pickup.title} event id`}
              />
            ))}
            {catalog.canonicalNaddr ? (
              <TechnicalValueRow
                label="Event catalog naddr"
                value={catalog.canonicalNaddr}
                copyLabel="Copy event catalog naddr"
              />
            ) : null}
          </div>
        </div>
      </details>
    </div>
  )
}
