import { useMemo, useState } from "react"
import { ExternalLink, RefreshCw } from "lucide-react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  buildMarketEventCatalogUrl,
  buildMerchantEventParticipationUrl,
  createEventMarketPickupSnapshot,
  encodeEventMarketNaddr,
  inferConduitAppOrigin,
  readEventMarketCatalog,
  useConduitSession,
  useProfile,
  type EventMarketProductReadResult,
  type Product,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Combobox,
  EventPageHeader,
  Input,
  QRCodeSVG,
} from "@conduit/ui"
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
  onMerchantChange: (pubkey: string | undefined) => void
}

function FutureEventProductCard({
  entry,
  merchantName,
  marketCoordinate,
  canPurchase,
  quote,
  preference,
  onAdd,
  onMerchantChange,
}: {
  entry: EventMarketProductReadResult
  merchantName: string
  marketCoordinate: string
  canPurchase: boolean
  quote: ReturnType<typeof useShopperPricing>["quote"]
  preference: ReturnType<typeof useShopperPricing>["preference"]
  onAdd: (entry: EventMarketProductReadResult, selected: Product) => void
  onMerchantChange: (pubkey: string) => void
}) {
  const navigate = useNavigate()
  const [selectedProductId, setSelectedProductId] = useState("")
  if (entry.resolution.state !== "eligible") return null
  const { product, merchant } = entry.resolution
  const activeProductId = selectedProductId || product.id
  return (
    <ProductGridCard
      product={product}
      merchantName={merchantName}
      selectedProductId={activeProductId}
      onSelectedProductChange={(selected) => setSelectedProductId(selected.id)}
      notice={
        <span>
          {merchant.mode === "merchant_present"
            ? "Merchant booth"
            : "Organizer pickup"}
          : {merchant.assignment}
        </span>
      }
      onMerchantActivate={() => onMerchantChange(merchant.pubkey)}
      onProductActivate={() =>
        void navigate({
          to: "/products/$productId",
          params: { productId: activeProductId },
          search: { event: marketCoordinate },
        })
      }
      onAddToCart={
        entry.actionable && canPurchase
          ? (selected) => onAdd(entry, selected)
          : undefined
      }
      cartActionDisabled={!entry.actionable || !canPurchase}
      cartActionDisabledLabel="Refresh event evidence"
      btcUsdRate={quote}
      pricePreference={preference}
    />
  )
}

/** Future commerce is derived only from the current signed roster and product reads. */
export function FutureEventMarketPage({
  reference,
  selectedMerchant,
  onMerchantChange,
}: FutureEventMarketPageProps) {
  const session = useConduitSession()
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const [search, setSearch] = useState("")
  const cart = useCart()
  const navigate = useNavigate()
  const pricing = useShopperPricing()
  const query = useQuery({
    queryKey: [
      "future-event-market",
      reference,
      session.relayScope,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      readEventMarketCatalog({ reference, authenticatedPubkey, signal }),
    enabled: session.relaySettingsReady,
    retry: false,
  })
  const catalog = query.data
  const marketResolution = catalog?.marketRead.resolution
  const market =
    marketResolution?.state === "current" ? marketResolution.market : null
  const calendar = catalog?.marketRead.calendar
  const organizerPubkey = market?.organizerPubkey ?? ""
  const organizerProfile = useProfile(organizerPubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    maxUnresolvedRefetches: 2,
  }).data
  const merchantPubkeys = useMemo(
    () => market?.merchants.map((row) => row.pubkey) ?? [],
    [market?.merchants]
  )
  const identities = useMerchantIdentities({
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    allMerchantPubkeys: merchantPubkeys,
    visibleMerchantPubkeys: merchantPubkeys,
    relayHintsByPubkey: {},
  })
  const eligible = useMemo(
    () =>
      catalog?.products.filter(
        (entry) => entry.resolution.state === "eligible"
      ) ?? [],
    [catalog?.products]
  )
  const merchants = useMemo(
    () =>
      merchantPubkeys.map((pubkey) => ({
        pubkey,
        name: identities.getIdentity(pubkey).displayName,
        count: eligible.filter(
          (entry) =>
            entry.resolution.state === "eligible" &&
            entry.resolution.merchant.pubkey === pubkey
        ).length,
      })),
    [eligible, identities, merchantPubkeys]
  )
  const shown = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return eligible.filter((entry) => {
      if (entry.resolution.state !== "eligible") return false
      const merchant = entry.resolution.merchant.pubkey
      return (
        (!selectedMerchant || merchant === selectedMerchant) &&
        (!needle ||
          `${entry.resolution.product.title} ${identities.getIdentity(merchant).displayName}`
            .toLocaleLowerCase()
            .includes(needle))
      )
    })
  }, [eligible, identities, search, selectedMerchant])
  const naddr = market
    ? encodeEventMarketNaddr(
        market.coordinate,
        catalog?.marketRead.observedRelayUrls ?? []
      )
    : null
  const shareUrl =
    naddr && typeof window !== "undefined"
      ? buildMarketEventCatalogUrl(
          window.location.origin,
          naddr,
          selectedMerchant ? { merchantPubkey: selectedMerchant } : undefined
        )
      : undefined
  const qrUrl =
    shareUrl && new TextEncoder().encode(shareUrl).length <= 2_200
      ? shareUrl
      : market && typeof window !== "undefined"
        ? buildMarketEventCatalogUrl(
            window.location.origin,
            encodeEventMarketNaddr(market.coordinate),
            selectedMerchant ? { merchantPubkey: selectedMerchant } : undefined
          )
        : undefined
  const canPurchase =
    !!market &&
    market.state === "open" &&
    catalog?.coverage === "complete" &&
    catalog.marketRead.coverage === "complete" &&
    catalog.marketRead.calendarCoverage === "complete" &&
    !!calendar

  async function addProduct(
    entry: (typeof eligible)[number],
    selected: Product
  ): Promise<void> {
    if (
      !canPurchase ||
      !catalog ||
      entry.resolution.state !== "eligible" ||
      !entry.actionable
    )
      return
    // A variable child needs its own exact signed read before entering the cart.
    if (selected.id !== entry.productCoordinate) {
      void navigateToProduct(selected.id)
      return
    }
    try {
      const fulfillment = createEventMarketPickupSnapshot({
        marketRead: catalog.marketRead,
        productRead: entry,
      })
      await cart.addItem(
        cartItemInputFromProductSelection(
          entry.resolution.product,
          entry.resolution.product,
          fulfillment
        ),
        1
      )
    } catch {
      void query.refetch()
    }
  }

  function navigateToProduct(productId: string): void {
    if (!market) return
    void navigate({
      to: "/products/$productId",
      params: { productId },
      search: { event: market.coordinate },
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
          <p className="text-sm text-[var(--text-secondary)]">
            {market.state === "open" ? "Open" : "Closed"} ·{" "}
            {market.merchants.length} approved{" "}
            {market.merchants.length === 1 ? "merchant" : "merchants"}
          </p>
        </EventPageHeader>
      ) : (
        <h1 className="text-3xl font-semibold">Event Market</h1>
      )}
      {query.isPending ? (
        <p role="status">Checking signed event and merchant records…</p>
      ) : null}
      {query.isError ? (
        <p role="alert">Event records could not be checked. Try again.</p>
      ) : null}
      {catalog &&
      (catalog.coverage !== "complete" ||
        catalog.marketRead.coverage !== "complete") ? (
        <p role="status" className="rounded-lg border border-amber-500/50 p-4">
          Relay evidence is incomplete. Refresh before purchasing; more current
          products or participation changes may exist.
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
      {market && eligible.length === 0 && !query.isPending ? (
        <p>No eligible products were found in the checked relay evidence.</p>
      ) : null}
      {market && eligible.length > 0 ? (
        <section className="space-y-5" aria-label="Event products">
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
                  meta: String(eligible.length),
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
            <ul className={PRODUCT_GRID_CLASS_NAME}>
              {shown.map((entry) => {
                if (entry.resolution.state !== "eligible") return null
                return (
                  <li key={entry.productCoordinate}>
                    <FutureEventProductCard
                      entry={entry}
                      merchantName={
                        identities.getIdentity(entry.resolution.merchant.pubkey)
                          .displayName
                      }
                      marketCoordinate={market.coordinate}
                      canPurchase={canPurchase}
                      quote={pricing.quote}
                      preference={pricing.preference}
                      onAdd={(item, selected) =>
                        void addProduct(item, selected)
                      }
                      onMerchantChange={(pubkey) => onMerchantChange(pubkey)}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
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
