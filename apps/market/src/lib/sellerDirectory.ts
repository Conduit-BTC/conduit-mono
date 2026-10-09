import {
  isCommerceReadIncomplete,
  normalizeProfileSearchText,
  scoreProfileSearchMatch,
  type CommerceFreshnessMeta,
  type Product,
  type ProfileSearchMatch,
  type ProfileSearchEvidence,
} from "@conduit/core"
import type { MerchantIdentityView } from "./marketBrowseModel"
import type { ProductCatalogSourceMode } from "./productCatalogRead"

export interface DiscoveredSeller {
  pubkey: string
  listingCount: number
  latestListingAt: number
}

export type SellerEligibilityState =
  "loading" | "ready" | "partial" | "unavailable"

/** Search absence is bounded to the completed relay scope, not the catalog. */
export function getMerchantNameSearchFeedback(input: {
  evidence: ProfileSearchEvidence | undefined
  isFetching: boolean
  matchCount: number
}): { incomplete: boolean; message: string | undefined } {
  const incomplete =
    input.evidence === undefined ||
    input.evidence === "not_queried" ||
    input.evidence === "lookup_partial" ||
    input.evidence === "lookup_unavailable"
  if (input.isFetching) {
    return { incomplete, message: "Searching merchant names..." }
  }
  switch (input.evidence) {
    case "absent_within_scope":
      return {
        incomplete: false,
        message: "No matching merchant names found on the searched relays.",
      }
    case "present_current":
      return {
        incomplete: false,
        message:
          input.matchCount === 0
            ? "No matching merchants found in this catalog."
            : undefined,
      }
    case "lookup_unavailable":
      return {
        incomplete: true,
        message:
          "Search relays are unavailable. Merchant name results may be incomplete.",
      }
    case "lookup_partial":
      return {
        incomplete: true,
        message: "Merchant name results may be incomplete.",
      }
    case "not_queried":
      return {
        incomplete: true,
        message:
          "Only names on this device have been searched. Merchant name results may be incomplete.",
      }
    default:
      return {
        incomplete: true,
        message: "Merchant name results may be incomplete.",
      }
  }
}

export function getSellerEligibilityState(input: {
  authorPubkeys: readonly string[] | undefined
  source: ProductCatalogSourceMode
  followLookupStatus: "idle" | "loading" | "ready" | "error"
  discoveryStale: boolean
}): SellerEligibilityState {
  if (input.authorPubkeys === undefined) {
    return input.followLookupStatus === "error" ? "unavailable" : "loading"
  }
  if (input.source === "conduit") {
    return input.discoveryStale ? "partial" : "ready"
  }
  if (input.followLookupStatus === "error") {
    return input.authorPubkeys.length > 0 ? "partial" : "unavailable"
  }
  if (input.discoveryStale || input.followLookupStatus === "loading") {
    return "partial"
  }
  return "ready"
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
  return isSellerCatalogEvidenceIncomplete(input)
}

/**
 * Retained sellers stay usable while this signal preserves evidence that the
 * active catalog read is stale, partial, paused, or unavailable.
 */
export function isSellerCatalogEvidenceIncomplete(input: {
  error: unknown
  meta: CommerceFreshnessMeta | null
  isRefreshPaused: boolean
  discoveryStale: boolean
}): boolean {
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
  return sellers
    .map((seller, catalogIndex) => {
      const identity = getIdentity(seller.pubkey)
      if (identity.status !== "resolved") return null
      const score = scoreProfileSearchMatch(
        identity.searchProfile ?? {
          pubkey: seller.pubkey,
          displayName: identity.displayName,
        },
        normalizedQuery
      )
      return Number.isFinite(score) ? { seller, score, catalogIndex } : null
    })
    .filter(
      (
        match
      ): match is {
        seller: DiscoveredSeller
        score: number
        catalogIndex: number
      } => match !== null
    )
    .sort(
      (left, right) =>
        left.score - right.score || left.catalogIndex - right.catalogIndex
    )
    .map((match) => match.seller)
}

/** Network account matches that are not already shown as discovered sellers. */
export function excludeDiscoveredSellers(
  matches: readonly ProfileSearchMatch[],
  sellers: readonly DiscoveredSeller[]
): ProfileSearchMatch[] {
  const known = new Set(sellers.map((seller) => seller.pubkey))
  return matches.filter((match) => !known.has(match.pubkey))
}
