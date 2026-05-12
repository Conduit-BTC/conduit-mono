import {
  formatNpub,
  getProfileName,
  type PricingRateInput,
  type Product,
  type Profile,
} from "@conduit/core"
import type { FacetOption } from "./facets"
import { compareCommercePrices, getComparablePriceValue } from "./pricing"
import { diversifyMerchantProductOrder } from "./productFeedDiversity"
import type { ProductCatalogSourceMode } from "./productCatalogRead"

export type MarketBrowseSortOption = "newest" | "price_asc" | "price_desc"

export interface MarketBrowseSearch {
  merchant?: string[]
  q?: string
  source?: ProductCatalogSourceMode
  sort?: MarketBrowseSortOption
  tag?: string[]
  authRequired?: boolean
}

export interface MerchantIdentityView {
  pubkey: string
  displayName: string
  status: "resolved" | "pending"
  relayHints: string[]
}

export interface MarketProductCardView {
  product: Product
  merchant: MerchantIdentityView
}

export function isPriceSort(sort: MarketBrowseSortOption | undefined): boolean {
  return sort === "price_asc" || sort === "price_desc"
}

export function getPendingMerchantName(pubkey: string): string {
  return `Store ${formatNpub(pubkey, 6)}`
}

export function getMerchantIdentityView(
  pubkey: string,
  profile: Profile | undefined,
  relayHints: readonly string[] | undefined
): MerchantIdentityView {
  const profileName = getProfileName(profile)

  return {
    pubkey,
    displayName: profileName ?? getPendingMerchantName(pubkey),
    status: profileName ? "resolved" : "pending",
    relayHints: [...(relayHints ?? [])],
  }
}

export function getMerchantIdentityFromMap(
  pubkey: string,
  profiles: Record<string, Profile | undefined>,
  relayHintsByPubkey: Record<string, string[] | undefined>
): MerchantIdentityView {
  return getMerchantIdentityView(
    pubkey,
    profiles[pubkey],
    relayHintsByPubkey[pubkey]
  )
}

export function sortBrowseProducts(
  products: Product[],
  sort: MarketBrowseSortOption | undefined,
  btcUsdRate: PricingRateInput
): Product[] {
  switch (sort) {
    case "price_asc":
      return Array.from(products).sort(
        (a, b) =>
          compareCommercePrices(a, b, btcUsdRate, "asc") ||
          b.createdAt - a.createdAt
      )
    case "price_desc":
      return Array.from(products).sort(
        (a, b) =>
          compareCommercePrices(a, b, btcUsdRate, "desc") ||
          b.createdAt - a.createdAt
      )
    case "newest":
    default:
      return diversifyMerchantProductOrder(
        Array.from(products).sort((a, b) => b.createdAt - a.createdAt)
      )
  }
}

export function hasUnavailablePriceForBrowseSort(
  products: Product[],
  sort: MarketBrowseSortOption | undefined,
  btcUsdRate: PricingRateInput
): boolean {
  if (!isPriceSort(sort)) return false
  return products.some(
    (product) => getComparablePriceValue(product, btcUsdRate) === null
  )
}

export function getRecentPublisherIndexes(
  products: Product[]
): Map<string, number> {
  const indexes = new Map<string, number>()
  for (const product of products) {
    if (!indexes.has(product.pubkey)) {
      indexes.set(product.pubkey, indexes.size)
    }
  }
  return indexes
}

export function sortStoreFacetOptionsByRecentPublisher(
  options: FacetOption[],
  products: Product[]
): FacetOption[] {
  const recentPublisherIndexes = getRecentPublisherIndexes(products)

  return [...options].sort(
    (a, b) =>
      (recentPublisherIndexes.get(a.value) ?? Number.MAX_SAFE_INTEGER) -
      (recentPublisherIndexes.get(b.value) ?? Number.MAX_SAFE_INTEGER)
  )
}

export function getStoreTriggerLabel(selectedMerchants: readonly string[]) {
  if (selectedMerchants.length === 0) return "All stores"
  if (selectedMerchants.length === 1) return "1 store"
  return `${selectedMerchants.length} stores`
}

export function getBrowseSearchKey(input: {
  q?: string
  source?: ProductCatalogSourceMode
  selectedTags: readonly string[]
  selectedMerchants: readonly string[]
  sort?: MarketBrowseSortOption
}): string {
  return `${input.q}-${input.source}-${input.selectedTags.slice().sort().join(",")}-${input.sort}-${input.selectedMerchants.slice().sort().join(",")}`
}
