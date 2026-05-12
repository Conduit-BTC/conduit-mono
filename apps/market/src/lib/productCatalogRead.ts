import { normalizePubkey } from "@conduit/core"

export type ProductCatalogScope = "marketplace" | "storefront"

export interface ProductCatalogReadInput {
  scope: ProductCatalogScope
  merchantPubkey?: string
  perspectivePubkey?: string | null
  seedAuthorPubkeys?: string[]
  textQuery?: string
  tags?: string[]
  tag?: string
  sort?: string
  limit?: number
}

export type PerspectiveAuthorSource =
  | "refreshed"
  | "seed"
  | "cached"
  | "fallback"
  | "none"

export interface PerspectiveAuthorResolution {
  authorPubkeys: string[] | undefined
  source: PerspectiveAuthorSource
}

export function isPerspectiveMarketplaceRead(
  input: Pick<ProductCatalogReadInput, "scope" | "merchantPubkey">
): boolean {
  return input.scope === "marketplace" && !input.merchantPubkey
}

function uniquePerspectiveAuthors(
  pubkeys: readonly string[] | undefined,
  perspectivePubkey?: string | null
): string[] {
  return Array.from(
    new Set(pubkeys?.map(normalizePubkey).filter(Boolean) as string[])
  )
    .filter((pubkey) => pubkey !== perspectivePubkey)
    .sort()
}

export function resolvePerspectiveAuthorPubkeys(input: {
  usesPerspectiveGraph: boolean
  perspectivePubkey?: string | null
  refreshedAuthorPubkeys?: readonly string[]
  seedAuthorPubkeys?: readonly string[]
  cachedAuthorPubkeys?: readonly string[]
  fallbackAuthorPubkeys?: readonly string[]
  followLookupSettled?: boolean
}): PerspectiveAuthorResolution {
  const refreshed = uniquePerspectiveAuthors(
    input.refreshedAuthorPubkeys,
    input.perspectivePubkey
  )
  if (refreshed.length > 0) {
    return { authorPubkeys: refreshed, source: "refreshed" }
  }

  const seeded = uniquePerspectiveAuthors(
    input.seedAuthorPubkeys,
    input.perspectivePubkey
  )
  if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }

  const cached = uniquePerspectiveAuthors(
    input.cachedAuthorPubkeys,
    input.perspectivePubkey
  )
  if (cached.length > 0) return { authorPubkeys: cached, source: "cached" }

  if (input.usesPerspectiveGraph && input.followLookupSettled) {
    const fallback = uniquePerspectiveAuthors(
      input.fallbackAuthorPubkeys,
      input.perspectivePubkey
    )
    if (fallback.length > 0) {
      return { authorPubkeys: fallback, source: "fallback" }
    }
  }

  if (!input.usesPerspectiveGraph) {
    return { authorPubkeys: undefined, source: "none" }
  }

  return { authorPubkeys: undefined, source: "none" }
}

export function getCatalogAuthorPubkeys(
  input: Pick<ProductCatalogReadInput, "scope" | "merchantPubkey">,
  perspectiveAuthorPubkeys: string[] | undefined
): string[] | undefined {
  if (isPerspectiveMarketplaceRead(input)) return perspectiveAuthorPubkeys
  return perspectiveAuthorPubkeys
}

export function getProductCatalogQueryKey(
  input: ProductCatalogReadInput,
  source: "cache" | "network"
) {
  const perspectiveMarketplace = isPerspectiveMarketplaceRead(input)

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
    perspectiveMarketplace
      ? (input.seedAuthorPubkeys?.join(",") ?? "no-seed")
      : input.scope === "marketplace"
        ? (input.seedAuthorPubkeys?.join(",") ?? "no-seed")
        : "storefront",
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
