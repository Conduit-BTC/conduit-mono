import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ExternalLink, RefreshCw } from "lucide-react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  buildMarketEventCatalogUrl,
  buildMerchantEventParticipationUrl,
  createEventMarketPickupSnapshot,
  encodeEventMarketNaddr,
  inferConduitAppOrigin,
  readEventMarketCatalog,
  readEventMarketProduct,
  readEventMarketRoster,
  useAuth,
  useConduitSession,
  useProfile,
  type EventMarketCatalogCandidate,
  type Product,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Combobox,
  EventPageHeader,
  EventFulfillmentChoice,
  type EventFulfillmentSelection,
  Input,
  Label,
  QRCodeSVG,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { hasEventShippingChoice } from "../lib/event-fulfillment-choice"
import { useCart } from "../hooks/useCart"
import { useMerchantIdentities } from "../hooks/useMerchantIdentities"
import { useShopperPricing } from "../hooks/useShopperPricing"
import { cartItemInputFromProductSelection } from "../lib/productVariations"
import { formatEventTimelineSchedule } from "../lib/eventTimeline"
import { getMerchantDisplayName } from "./MerchantIdentity"
import { PRODUCT_GRID_CLASS_NAME, ProductGridCard } from "./ProductGridCard"

type FutureEventMarketPageProps = {
  reference: string
  selectedMerchant?: string
  selectedOccurrence?: string
  onMerchantChange: (pubkey: string | undefined) => void
  onOccurrenceChange: (coordinate: string | undefined) => void
}

function FutureEventProductCard({
  entry,
  merchantName,
  marketCoordinate,
  selectedOccurrence,
  canPurchase,
  quote,
  preference,
  onAdd,
  onMerchantChange,
}: {
  entry: EventMarketCatalogCandidate
  merchantName: string
  marketCoordinate: string
  selectedOccurrence?: string
  canPurchase: boolean
  quote: ReturnType<typeof useShopperPricing>["quote"]
  preference: ReturnType<typeof useShopperPricing>["preference"]
  onAdd: (
    entry: EventMarketCatalogCandidate,
    selected: Product,
    choice: EventFulfillmentSelection
  ) => Promise<void>
  onMerchantChange: (pubkey: string) => void
}) {
  const navigate = useNavigate()
  const [selectedProductId, setSelectedProductId] = useState("")
  const [choice, setChoice] = useState<EventFulfillmentSelection>(
    "event_market_pickup"
  )
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState("")
  if (entry.resolution.state !== "candidate") return null
  const { product, merchant } = entry.resolution
  const activeProductId = selectedProductId || product.id
  return (
    <ProductGridCard
      className="h-auto"
      product={product}
      merchantName={merchantName}
      selectedProductId={activeProductId}
      onSelectedProductChange={(selected) => setSelectedProductId(selected.id)}
      notice={
        <div className="space-y-2">
          <span>
            {merchant.mode === "merchant_present"
              ? "Merchant booth"
              : "Organizer pickup"}
            : {merchant.assignment}
          </span>
          <EventFulfillmentChoice
            value={choice}
            onChange={setChoice}
            shippingAvailable={hasEventShippingChoice(product)}
          />
          {error ? (
            <span role="alert" className="block text-[var(--destructive)]">
              {error}
            </span>
          ) : null}
        </div>
      }
      onMerchantActivate={() => onMerchantChange(merchant.pubkey)}
      onProductActivate={() =>
        void navigate({
          to: "/products/$productId",
          params: { productId: activeProductId },
          search: {
            event: marketCoordinate,
            ...(selectedOccurrence ? { occurrence: selectedOccurrence } : {}),
          },
        })
      }
      onAddToCart={
        canPurchase
          ? async (selected) => {
              if (checking) return
              setChecking(true)
              setError("")
              try {
                await onAdd(entry, selected, choice)
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "This product could not be checked. Try again."
                )
              } finally {
                setChecking(false)
              }
            }
          : undefined
      }
      cartActionDisabled={checking || !canPurchase}
      cartActionDisabledLabel={
        checking ? "Checking product…" : "Event pickup unavailable"
      }
      allowZeroPrice={choice === "event_market_pickup" && canPurchase}
      btcUsdRate={quote}
      pricePreference={preference}
    />
  )
}

/** Browse candidates first; verify exact signed authority only for the selected purchase. */
export function FutureEventMarketPage({
  reference,
  selectedMerchant,
  selectedOccurrence,
  onMerchantChange,
  onOccurrenceChange,
}: FutureEventMarketPageProps) {
  const session = useConduitSession()
  const { accountPubkey, pubkey, signerReadiness, authGeneration } = useAuth()
  const authenticatedPubkey =
    signerReadiness === "ready" && pubkey === accountPubkey ? pubkey : null
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
    return () => {
      authGenerationRef.current = -1
    }
  }, [authGeneration])
  const shouldContinue = () => authGenerationRef.current === authGeneration
  const [search, setSearch] = useState("")
  const [catalogSearch, setCatalogSearch] = useState("")
  const [limit, setLimit] = useState(48)
  useEffect(() => {
    const timer = setTimeout(() => {
      setCatalogSearch(search.trim())
      setLimit(48)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])
  const queryClient = useQueryClient()
  const cart = useCart()
  const navigate = useNavigate()
  const pricing = useShopperPricing()
  const catalogQueryKey = [
    "future-event-market",
    reference,
    session.relayScope,
    authenticatedPubkey,
    authGeneration,
    limit,
    catalogSearch,
  ] as const
  const query = useQuery({
    queryKey: catalogQueryKey,
    queryFn: ({ signal }) =>
      readEventMarketCatalog({
        reference,
        authenticatedPubkey,
        limit,
        search: catalogSearch || undefined,
        signal,
        shouldContinue: () => !signal.aborted && shouldContinue(),
        onProgress: (result) => {
          if (!signal.aborted && shouldContinue())
            queryClient.setQueryData(catalogQueryKey, result)
        },
      }),
    enabled: session.relaySettingsReady,
    retry: false,
  })
  const catalog = query.data
  const marketResolution = catalog?.marketRead.resolution
  const market =
    marketResolution?.state === "current" ? marketResolution.market : null
  const schedule = catalog?.marketRead.schedule
  const series = schedule?.kind === "series" ? schedule : null
  const selectedDate = series?.occurrences.find(
    (entry) => entry.occurrence.coordinate === selectedOccurrence
  )
  const calendar = selectedDate?.occurrence ?? catalog?.marketRead.calendar
  const organizerPubkey = market?.organizerPubkey ?? ""
  const organizerProfile = useProfile(organizerPubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue,
    maxUnresolvedRefetches: 2,
  }).data
  const merchantPubkeys = useMemo(
    () => market?.merchants.map((row) => row.pubkey) ?? [],
    [market?.merchants]
  )
  const identities = useMerchantIdentities({
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue,
    allMerchantPubkeys: merchantPubkeys,
    visibleMerchantPubkeys: merchantPubkeys,
    relayHintsByPubkey: {},
  })
  const candidates = useMemo(
    () =>
      catalog?.products.filter(
        (entry) => entry.resolution.state === "candidate"
      ) ?? [],
    [catalog?.products]
  )
  const merchants = useMemo(
    () =>
      merchantPubkeys.map((pubkey) => ({
        pubkey,
        name: identities.getIdentity(pubkey).displayName,
        count: candidates.filter(
          (entry) =>
            entry.resolution.state === "candidate" &&
            entry.resolution.merchant.pubkey === pubkey
        ).length,
      })),
    [candidates, identities, merchantPubkeys]
  )
  const shown = useMemo(
    () =>
      candidates.filter(
        (entry) =>
          !selectedMerchant ||
          entry.resolution.merchant.pubkey === selectedMerchant
      ),
    [candidates, selectedMerchant]
  )
  const naddr = market
    ? encodeEventMarketNaddr(
        market.coordinate,
        catalog?.marketRead.observedRelayUrls ?? []
      )
    : null
  const shareUrl =
    naddr && typeof window !== "undefined"
      ? buildMarketEventCatalogUrl(window.location.origin, naddr, {
          merchantPubkey: selectedMerchant,
          occurrenceCoordinate: selectedOccurrence,
        })
      : undefined
  const qrUrl =
    shareUrl && new TextEncoder().encode(shareUrl).length <= 2_200
      ? shareUrl
      : market && typeof window !== "undefined"
        ? buildMarketEventCatalogUrl(
            window.location.origin,
            encodeEventMarketNaddr(market.coordinate),
            {
              merchantPubkey: selectedMerchant,
              occurrenceCoordinate: selectedOccurrence,
            }
          )
        : undefined
  const canPurchase =
    !!market &&
    market.state === "open" &&
    !!calendar &&
    (!series || (!!selectedDate && selectedDate.occurrence.end > Date.now()))

  async function addProduct(
    entry: EventMarketCatalogCandidate,
    selected: Product,
    choice: EventFulfillmentSelection
  ): Promise<void> {
    if (!canPurchase || !market || !shouldContinue()) return
    // Choose a purchasable variation on the existing detail surface. The
    // variable parent is a catalog entry and must never enter the cart.
    if (
      selected.type === "variable" ||
      selected.id !== entry.productCoordinate
    ) {
      navigateToProduct(selected.id)
      return
    }
    const marketRead = await readEventMarketRoster({
      reference: market.coordinate,
      authenticatedPubkey,
      shouldContinue,
    })
    if (!shouldContinue()) return
    const productRead = await readEventMarketProduct({
      marketRead,
      productCoordinate: entry.productCoordinate,
      authenticatedPubkey,
      shouldContinue,
    })
    if (!shouldContinue()) return
    if (
      productRead.resolution.state !== "eligible" ||
      !productRead.actionable
    ) {
      void query.refetch()
      throw new Error(
        "This product is not currently available for event pickup."
      )
    }
    if (productRead.resolution.revision.id !== entry.resolution.revision.id) {
      void query.refetch()
      throw new Error(
        "Product details changed. Review the refreshed item before adding it."
      )
    }
    const fulfillment = createEventMarketPickupSnapshot({
      marketRead,
      productRead,
      selectedOccurrenceCoordinate: selectedOccurrence,
    })
    await cart.addItem(
      {
        ...cartItemInputFromProductSelection(
          productRead.resolution.product,
          productRead.resolution.product,
          choice === "shipping" &&
            hasEventShippingChoice(productRead.resolution.product)
            ? { type: "shipping" }
            : fulfillment
        ),
        eventMarketContext: {
          marketCoordinate: fulfillment.market.coordinate,
          calendarCoordinate: fulfillment.calendar.coordinate,
        },
      },
      1
    )
  }

  function navigateToProduct(productId: string): void {
    if (!market) return
    void navigate({
      to: "/products/$productId",
      params: { productId },
      search: {
        event: market.coordinate,
        ...(selectedOccurrence ? { occurrence: selectedOccurrence } : {}),
      },
    })
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {calendar && market ? (
        <EventPageHeader
          title={calendar.title}
          summary={calendar.summary ?? calendar.content}
          imageUrl={calendar.image}
          schedule={formatEventTimelineSchedule(calendar)}
          location={
            calendar.locations.join(", ") ||
            calendar.geohash ||
            "Location not published"
          }
          organizer={
            <div className="flex items-center gap-2">
              <Avatar className="size-7">
                <AvatarImage
                  src={organizerProfile?.picture}
                  alt=""
                  referrerPolicy="no-referrer"
                />
                <AvatarFallback>O</AvatarFallback>
              </Avatar>
              <span>
                Organized by{" "}
                <span className="font-medium text-[var(--text-primary)]">
                  {getMerchantDisplayName(organizerProfile, organizerPubkey, {
                    prefix: "Organizer",
                  })}
                </span>
              </span>
            </div>
          }
          actions={
            naddr ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={buildMerchantEventParticipationUrl(
                    inferConduitAppOrigin(
                      "merchant",
                      window.location,
                      import.meta.env.VITE_BUILD_BRANCH
                    ),
                    naddr
                  )}
                >
                  Sell here{" "}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </Button>
            ) : undefined
          }
          shareUrl={shareUrl}
          shareTitle={
            selectedMerchant
              ? `${identities.getIdentity(selectedMerchant).displayName} at ${calendar.title}`
              : calendar.title
          }
          shareLabel={selectedMerchant ? "Share this view" : "Share event"}
        >
          {series ? (
            <div className="max-w-sm space-y-1">
              <Label htmlFor="event-market-date">Choose date</Label>
              <Select
                value={selectedDate?.occurrence.coordinate ?? ""}
                onValueChange={(coordinate) => onOccurrenceChange(coordinate)}
              >
                <SelectTrigger id="event-market-date" aria-label="Choose date">
                  <SelectValue placeholder="Confirm a pickup date" />
                </SelectTrigger>
                <SelectContent>
                  {series.occurrences.map((entry) => (
                    <SelectItem
                      key={entry.occurrence.coordinate}
                      value={entry.occurrence.coordinate}
                      disabled={
                        (entry.coverage !== "complete" &&
                          entry.coverage !== "partial") ||
                        entry.occurrence.end <= Date.now()
                      }
                    >
                      {formatEventTimelineSchedule(entry.occurrence)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {series.unresolvedCoordinates.length > 0 ? (
                <p
                  role="status"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  Some listed dates could not be verified yet.
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="text-sm text-[var(--text-secondary)]">
            {market.state === "open" ? "Open" : "Closed"} ·{" "}
            {market.merchants.length} listed{" "}
            {market.merchants.length === 1 ? "merchant" : "merchants"}
          </p>
        </EventPageHeader>
      ) : (
        <h1 className="text-3xl font-semibold">Event Market</h1>
      )}
      {query.isPending ? <p role="status">Loading event products…</p> : null}
      {query.isError ? (
        <p role="alert">Event records could not be checked. Try again.</p>
      ) : null}
      {catalog &&
      (catalog.coverage !== "complete" ||
        catalog.marketRead.coverage !== "complete") ? (
        <p
          role="status"
          className="rounded-lg border border-[var(--border)] p-4"
        >
          More products may be available. Item availability is checked when you
          add it to your cart.
        </p>
      ) : null}
      {marketResolution && marketResolution.state !== "current" ? (
        <p role="status">
          The current signed Event Market record is unavailable.
        </p>
      ) : null}
      {market?.state === "closed" ? (
        <p>This Event Market is closed to new purchases.</p>
      ) : null}
      {market && candidates.length === 0 && !query.isPending ? (
        <p>No products found yet.</p>
      ) : null}
      {market && candidates.length > 0 ? (
        <section className="space-y-5" aria-label="Event products">
          <p className="text-sm text-[var(--text-secondary)]">
            Availability and participation are checked when you select a
            product.
          </p>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_15rem]">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search products or merchants"
              placeholder="Search products or merchants"
            />
            <Combobox
              value={selectedMerchant ?? "all"}
              onValueChange={(value) =>
                onMerchantChange(value === "all" ? undefined : value)
              }
              searchPlaceholder="Find a merchant"
              emptyText="No matching merchants"
              selectedLabel={
                selectedMerchant
                  ? identities.getIdentity(selectedMerchant).displayName
                  : "All merchants"
              }
              options={[
                {
                  value: "all",
                  label: "All merchants",
                  meta: String(candidates.length),
                },
                ...merchants.map((entry) => ({
                  value: entry.pubkey,
                  label: entry.name,
                  meta: String(entry.count),
                })),
              ]}
            />
          </div>
          {search || selectedMerchant ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("")
                onMerchantChange(undefined)
              }}
            >
              Clear filters
            </Button>
          ) : null}
          {shown.length === 0 ? (
            <p>No matching products. Try another search or merchant.</p>
          ) : (
            <ul className={`${PRODUCT_GRID_CLASS_NAME} items-start`}>
              {shown.map((entry) => {
                if (entry.resolution.state !== "candidate") return null
                return (
                  <li key={entry.productCoordinate}>
                    <FutureEventProductCard
                      entry={entry}
                      merchantName={
                        identities.getIdentity(entry.resolution.merchant.pubkey)
                          .displayName
                      }
                      marketCoordinate={market.coordinate}
                      selectedOccurrence={selectedOccurrence}
                      canPurchase={canPurchase}
                      quote={pricing.quote}
                      preference={pricing.preference}
                      onAdd={addProduct}
                      onMerchantChange={(pubkey) => onMerchantChange(pubkey)}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : null}
      {market && catalog?.hasMore && limit < 256 ? (
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => setLimit((current) => Math.min(current + 48, 256))}
        >
          {query.isFetching ? "Loading products…" : "Load more products"}
        </Button>
      ) : null}
      {shareUrl && qrUrl && calendar ? (
        <div className="space-y-2 rounded-xl border border-[var(--border)] p-4">
          <h2 className="font-semibold">
            {selectedMerchant ? "Merchant booth QR code" : "Event QR code"}
          </h2>
          <div
            role="img"
            aria-label={
              selectedMerchant
                ? `${identities.getIdentity(selectedMerchant).displayName} booth QR code`
                : `${calendar.title} event QR code`
            }
            className="w-fit bg-white p-2"
          >
            <QRCodeSVG value={qrUrl} size={144} level="M" />
          </div>
          <p className="break-all text-xs text-[var(--text-muted)]">{qrUrl}</p>
        </div>
      ) : null}
      <Button
        variant="outline"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
      >
        <RefreshCw className="size-4" aria-hidden="true" /> Refresh event
        records
      </Button>
    </div>
  )
}
