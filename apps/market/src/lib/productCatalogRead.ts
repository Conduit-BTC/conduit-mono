import {
  isCommerceReadIncomplete,
  resolveEventMarketPerspectiveAuthorPubkeys,
  selectLatestFollowListEvent,
  type CommerceQueryMeta,
  type EventMarketPerspectiveAuthorSource,
  type SignedPublicNostrEvent,
} from "@conduit/core"

export type ProductCatalogScope = "marketplace" | "storefront"
export type ProductCatalogSourceMode = "following" | "conduit" | "combined"
export const DEFAULT_MARKET_CATALOG_SOURCE: ProductCatalogSourceMode =
  "combined"

export interface ProductCatalogReadInput {
  scope: ProductCatalogScope
  catalogSource?: ProductCatalogSourceMode
  merchantPubkey?: string
  perspectivePubkey?: string | null
  seedAuthorPubkeys?: string[]
  textQuery?: string
  tags?: string[]
  tag?: string
  sort?: string
  limit?: number
}

export type PerspectiveAuthorSource = EventMarketPerspectiveAuthorSource

export interface PerspectiveAuthorResolution {
  authorPubkeys: string[] | undefined
  source: PerspectiveAuthorSource
}

export interface PendingProgressiveRefresh {
  fromDiscoveryKey: string
  resolve: () => void
}

/** A refresh waits for the pass after its starting key, unless canceled. */
export function settlePendingProgressiveRefreshes(
  pending: readonly PendingProgressiveRefresh[],
  settledDiscoveryKey?: string
): PendingProgressiveRefresh[] {
  const remaining: PendingProgressiveRefresh[] = []
  for (const refresh of pending) {
    if (refresh.fromDiscoveryKey === settledDiscoveryKey) {
      remaining.push(refresh)
    } else {
      refresh.resolve()
    }
  }
  return remaining
}

export function retainedFollowSnapshotSupersedesLive(
  live: Pick<SignedPublicNostrEvent, "id" | "created_at"> | null | undefined,
  retained: Pick<SignedPublicNostrEvent, "id" | "created_at"> | null | undefined
): boolean {
  if (!retained) return false
  if (!live) return true
  if (live.id === retained.id) return false
  return selectLatestFollowListEvent([live, retained])?.id === retained.id
}

export async function refreshProductCatalogSources(input: {
  queryEnabled: boolean
  networkEnabled: boolean
  catalogReady: boolean
  streamsNetwork: boolean
  usesPerspectiveGraph: boolean
  catalogSource: ProductCatalogSourceMode
  refreshPerspectiveAuthors: () => boolean | Promise<boolean>
  restartNetworkStream: () => unknown
  refreshNetwork: () => unknown
  refreshCache: () => unknown
}): Promise<void> {
  if (!input.queryEnabled) return

  if (input.usesPerspectiveGraph && input.catalogSource !== "conduit") {
    const authorSetChanged = await input.refreshPerspectiveAuthors()
    if (authorSetChanged) return
  }

  if (!input.catalogReady) return
  const networkRefresh = !input.networkEnabled
    ? undefined
    : input.streamsNetwork
      ? input.restartNetworkStream()
      : input.refreshNetwork()
  await Promise.all([
    Promise.resolve(networkRefresh),
    Promise.resolve(input.refreshCache()),
  ])
}

export function isProductDiscoveryReadIncomplete(
  meta: Pick<CommerceQueryMeta, "stale" | "degraded" | "capped"> | undefined
): boolean {
  return isCommerceReadIncomplete(meta)
}

export function isPerspectiveMarketplaceRead(
  input: Pick<ProductCatalogReadInput, "scope" | "merchantPubkey">
): boolean {
  return input.scope === "marketplace" && !input.merchantPubkey
}

export function resolvePerspectiveAuthorPubkeys(input: {
  usesPerspectiveGraph: boolean
  sourceMode?: ProductCatalogSourceMode
  perspectivePubkey?: string | null
  refreshedAuthorPubkeys?: readonly string[]
  seedAuthorPubkeys?: readonly string[]
  cachedAuthorPubkeys?: readonly string[]
  fallbackAuthorPubkeys?: readonly string[]
  followLookupSettled?: boolean
}): PerspectiveAuthorResolution {
  return resolveEventMarketPerspectiveAuthorPubkeys(input)
}

export function getCatalogAuthorPubkeys(
  perspectiveAuthorPubkeys: string[] | undefined
): string[] | undefined {
  if (!perspectiveAuthorPubkeys) return undefined
  return Array.from(new Set(perspectiveAuthorPubkeys)).sort()
}

export function getCatalogAuthorKey(
  authorPubkeys: readonly string[] | undefined
): string {
  return authorPubkeys === undefined
    ? "unscoped"
    : `authors:${Array.from(new Set(authorPubkeys)).sort().join(",")}`
}

export function getProductCatalogQueryKey(
  input: ProductCatalogReadInput,
  source: "cache" | "network"
) {
  const perspectiveMarketplace = isPerspectiveMarketplaceRead(input)
  const catalogSource = input.catalogSource ?? DEFAULT_MARKET_CATALOG_SOURCE

  return [
    "progressive-products",
    source,
    input.scope,
    input.scope === "marketplace"
      ? (input.merchantPubkey ?? "all")
      : input.merchantPubkey,
    perspectiveMarketplace
      ? (input.perspectivePubkey ?? "market-perspective")
      : input.scope === "marketplace"
        ? (input.perspectivePubkey ?? "market-perspective")
        : "storefront",
    // The caller appends the resolved catalog-author key. Raw seed identity is
    // intentionally excluded: tag order, duplicates, and self-only changes do
    // not alter the actual catalog and must not restart its progressive read.
    perspectiveMarketplace || input.scope === "marketplace"
      ? "resolved-authors-appended"
      : "storefront",
    perspectiveMarketplace ? catalogSource : "scoped",
    perspectiveMarketplace ? "" : (input.textQuery ?? ""),
    perspectiveMarketplace
      ? ""
      : input.scope === "marketplace"
        ? (input.tags ?? []).join(",")
        : (input.tag ?? ""),
    perspectiveMarketplace ? "newest" : (input.sort ?? "newest"),
    input.limit ?? "default",
  ] as const
}
