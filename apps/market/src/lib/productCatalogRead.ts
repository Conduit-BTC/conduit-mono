import { normalizePubkey } from "@conduit/core"

export type ProductCatalogScope = "marketplace" | "storefront"
export type ProductCatalogSourceMode = "following" | "conduit" | "combined"

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

export type PerspectiveAuthorSource =
  | "refreshed"
  | "seed"
  | "cached"
  | "fallback"
  | "combined"
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
  sourceMode?: ProductCatalogSourceMode
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
  const fallback = uniquePerspectiveAuthors(
    input.fallbackAuthorPubkeys,
    input.perspectivePubkey
  )
  const sourceMode = input.sourceMode ?? "following"

  if (input.usesPerspectiveGraph && sourceMode === "conduit") {
    const seeded = uniquePerspectiveAuthors(
      input.seedAuthorPubkeys,
      input.perspectivePubkey
    )
    if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }

    if (fallback.length > 0) {
      return { authorPubkeys: fallback, source: "fallback" }
    }
    return { authorPubkeys: undefined, source: "none" }
  }

  if (input.usesPerspectiveGraph && sourceMode === "combined") {
    if (refreshed.length > 0) {
      return {
        authorPubkeys: uniquePerspectiveAuthors(
          [...refreshed, ...fallback],
          input.perspectivePubkey
        ),
        source: fallback.length > 0 ? "combined" : "refreshed",
      }
    }

    const seeded = uniquePerspectiveAuthors(
      input.seedAuthorPubkeys,
      input.perspectivePubkey
    )
    if (seeded.length > 0) {
      return {
        authorPubkeys: uniquePerspectiveAuthors(
          [...seeded, ...fallback],
          input.perspectivePubkey
        ),
        source: fallback.length > 0 ? "combined" : "seed",
      }
    }

    const cached = uniquePerspectiveAuthors(
      input.cachedAuthorPubkeys,
      input.perspectivePubkey
    )
    if (cached.length > 0) {
      return {
        authorPubkeys: uniquePerspectiveAuthors(
          [...cached, ...fallback],
          input.perspectivePubkey
        ),
        source: fallback.length > 0 ? "combined" : "cached",
      }
    }

    if (fallback.length > 0) {
      return { authorPubkeys: fallback, source: "fallback" }
    }
  }

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
    return { authorPubkeys: [], source: "none" }
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
  const catalogSource = input.catalogSource ?? "following"

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
