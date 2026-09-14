import { getShopperPriceDisplay, type PricingRateInput } from "@conduit/core"
import type { EventCatalogProduct } from "./event-market-adapter"
import { getPendingMerchantName } from "./marketBrowseModel"
import { getConfiguredPricingRateQuote } from "./pricing"

export type EventCatalogSort = "name" | "price-asc" | "price-desc" | "merchant"

export type EventCatalogMerchant = {
  pubkey: string
  name: string
  count: number
}

export type EventCatalogMerchantGroup = {
  pubkey: string
  name: string
  products: EventCatalogProduct[]
}

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim()
}

function getDisplayedComparablePrice(
  entry: EventCatalogProduct,
  btcUsdRate: PricingRateInput
): number | null {
  // The adapter prepares safe display choices; pickup readiness only gates
  // purchase. Match the family displayed by the card throughout refresh.
  const family = entry.family
  const displayed = family?.priceSummary.minimum?.product ?? entry.product
  const pickup =
    displayed.id === entry.product.id && entry.product.type !== "variable"
      ? entry.pickupFulfillment
      : entry.familyPickupFulfillments?.[displayed.id]
  // Compare in sats so native prices remain sortable without a fiat quote.
  // Use the card's pricing rules to reject stale quotes and cached conversions.
  return getShopperPriceDisplay(
    displayed,
    { currency: "BITCOIN", bitcoinUnit: "sats" },
    typeof btcUsdRate === "object" ? btcUsdRate : null,
    { allowZero: !!pickup }
  ).sats
}

/** Browse only the event's already-loaded catalog; preserve its evidence objects. */
export function buildEventCatalogBrowse({
  products,
  merchantNames,
  search,
  merchant,
  sort,
  btcUsdRate = getConfiguredPricingRateQuote(),
}: {
  products: readonly EventCatalogProduct[]
  merchantNames: Record<string, string>
  search: string
  merchant: string
  sort: EventCatalogSort
  btcUsdRate?: PricingRateInput
}): {
  products: EventCatalogProduct[]
  groups: EventCatalogMerchantGroup[]
  merchants: EventCatalogMerchant[]
  hasUnavailablePriceForSort: boolean
} {
  const nameFor = (pubkey: string) =>
    merchantNames[pubkey]?.trim() || getPendingMerchantName(pubkey)
  const compareNames = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  const merchantMap = new Map<string, EventCatalogMerchant>()
  for (const entry of products) {
    const pubkey = entry.product.pubkey
    const existing = merchantMap.get(pubkey)
    if (existing) existing.count += 1
    else merchantMap.set(pubkey, { pubkey, name: nameFor(pubkey), count: 1 })
  }
  const merchants = Array.from(merchantMap.values()).sort(
    (a, b) => compareNames(a.name, b.name) || a.pubkey.localeCompare(b.pubkey)
  )
  const query = normalizeSearch(search)
  const visible = products.filter(({ product }) => {
    if (merchant && product.pubkey !== merchant) return false
    return (
      !query ||
      normalizeSearch(product.title).includes(query) ||
      normalizeSearch(nameFor(product.pubkey)).includes(query)
    )
  })
  const priceSort = sort === "price-asc" || sort === "price-desc"
  const prices = new Map(
    priceSort
      ? visible.map(
          (entry) =>
            [entry, getDisplayedComparablePrice(entry, btcUsdRate)] as const
        )
      : []
  )
  const comparePrices = (a: EventCatalogProduct, b: EventCatalogProduct) => {
    const aPrice = prices.get(a) ?? null
    const bPrice = prices.get(b) ?? null
    if (aPrice === null && bPrice === null) return 0
    if (aPrice === null) return 1
    if (bPrice === null) return -1
    return sort === "price-asc" ? aPrice - bPrice : bPrice - aPrice
  }
  visible.sort((a, b) => {
    const primary = priceSort
      ? comparePrices(a, b)
      : sort === "merchant"
        ? compareNames(nameFor(a.product.pubkey), nameFor(b.product.pubkey)) ||
          a.product.pubkey.localeCompare(b.product.pubkey)
        : 0
    return (
      primary ||
      compareNames(a.product.title, b.product.title) ||
      a.product.id.localeCompare(b.product.id)
    )
  })
  const groupMap = new Map<string, EventCatalogProduct[]>()
  for (const entry of visible) {
    const pubkey = entry.product.pubkey
    const group = groupMap.get(pubkey)
    if (group) group.push(entry)
    else groupMap.set(pubkey, [entry])
  }
  return {
    products: visible,
    merchants,
    groups: merchants.flatMap(({ pubkey, name }) => {
      const entries = groupMap.get(pubkey)
      return entries ? [{ pubkey, name, products: entries }] : []
    }),
    hasUnavailablePriceForSort:
      priceSort && visible.some((entry) => prices.get(entry) === null),
  }
}
