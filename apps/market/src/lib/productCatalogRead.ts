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

export function isPerspectiveMarketplaceRead(
  input: Pick<ProductCatalogReadInput, "scope" | "merchantPubkey">
): boolean {
  return input.scope === "marketplace" && !input.merchantPubkey
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
