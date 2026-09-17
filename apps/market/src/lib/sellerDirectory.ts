import {
  isCommerceReadIncomplete,
  normalizeProfileSearchText,
  type CommerceFreshnessMeta,
  type Product,
  type ProfileSearchMatch,
} from "@conduit/core"
import type { MerchantIdentityView } from "./marketBrowseModel"

export interface DiscoveredSeller {
  pubkey: string
  listingCount: number
  latestListingAt: number
}

/**
 * An empty directory is authoritative only after a completed catalog read.
 * Existing sellers remain useful during a degraded refresh, while a cold
 * unavailable read must not be presented as confirmed absence.
 */
export function isSellerDirectoryUnavailable(input: {
  hasSellers: boolean
  isFetching: boolean
  error: unknown
  meta: CommerceFreshnessMeta | null
  isRefreshPaused: boolean
  discoveryStale: boolean
}): boolean {
  if (input.hasSellers || input.isFetching) return false
  return (
    !!input.error ||
    !input.meta ||
    input.isRefreshPaused ||
    input.discoveryStale ||
    isCommerceReadIncomplete(input.meta)
  )
}

/** Groups discovered listings by author. Variations count toward the parent. */
export function groupDiscoveredSellers(
  products: readonly Product[]
): DiscoveredSeller[] {
  const sellers = new Map<string, DiscoveredSeller>()
  for (const product of products) {
    if (!product.pubkey) continue
    if (product.type === "variation") continue
    const current = sellers.get(product.pubkey)
    const createdAt = product.createdAt ?? 0
    if (!current) {
      sellers.set(product.pubkey, {
        pubkey: product.pubkey,
        listingCount: 1,
        latestListingAt: createdAt,
      })
      continue
    }
    current.listingCount += 1
    current.latestListingAt = Math.max(current.latestListingAt, createdAt)
  }
  return Array.from(sellers.values()).sort(
    (left, right) =>
      right.listingCount - left.listingCount ||
      right.latestListingAt - left.latestListingAt ||
      left.pubkey.localeCompare(right.pubkey)
  )
}

export function filterSellersByName(
  sellers: readonly DiscoveredSeller[],
  getIdentity: (pubkey: string) => MerchantIdentityView,
  query: string
): DiscoveredSeller[] {
  const normalizedQuery = normalizeProfileSearchText(query)
  if (!normalizedQuery) return [...sellers]
  return sellers.filter((seller) => {
    const identity = getIdentity(seller.pubkey)
    if (identity.status !== "resolved") return false
    return normalizeProfileSearchText(identity.displayName).includes(
      normalizedQuery
    )
  })
}

/** Network account matches that are not already shown as discovered sellers. */
export function excludeDiscoveredSellers(
  matches: readonly ProfileSearchMatch[],
  sellers: readonly DiscoveredSeller[]
): ProfileSearchMatch[] {
  const known = new Set(sellers.map((seller) => seller.pubkey))
  return matches.filter((match) => !known.has(match.pubkey))
}
