import { describe, expect, it } from "bun:test"
import {
  getCatalogAuthorPubkeys,
  getProductCatalogQueryKey,
  isPerspectiveMarketplaceRead,
} from "../apps/market/src/lib/productCatalogRead"

describe("product catalog read planning", () => {
  it("keeps all-store marketplace reads scoped to the market perspective", () => {
    expect(isPerspectiveMarketplaceRead({ scope: "marketplace" })).toBe(true)
    expect(
      getCatalogAuthorPubkeys({ scope: "marketplace" }, ["merchant-a"])
    ).toEqual(["merchant-a"])
  })

  it("keeps the perspective catalog key stable across local facet and sort changes", () => {
    const base = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        perspectivePubkey: "viewer-a",
        seedAuthorPubkeys: ["merchant-a"],
        textQuery: "soap",
        tags: ["health"],
        sort: "price_asc",
      },
      "network"
    )
    const changedLocalView = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        perspectivePubkey: "viewer-a",
        seedAuthorPubkeys: ["merchant-a"],
        textQuery: "candles",
        tags: ["home"],
        sort: "price_desc",
      },
      "network"
    )

    expect(changedLocalView).toEqual(base)
  })

  it("changes perspective catalog keys when the market perspective changes", () => {
    const viewerA = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        perspectivePubkey: "viewer-a",
        seedAuthorPubkeys: ["merchant-a"],
      },
      "network"
    )
    const viewerB = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        perspectivePubkey: "viewer-b",
        seedAuthorPubkeys: ["merchant-b"],
      },
      "network"
    )

    expect(viewerA).not.toEqual(viewerB)
  })

  it("keeps scoped catalog keys specific to the selected merchant", () => {
    const merchantA = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        merchantPubkey: "merchant-a",
        sort: "newest",
      },
      "network"
    )
    const merchantB = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        merchantPubkey: "merchant-b",
        sort: "newest",
      },
      "network"
    )

    expect(merchantA).not.toEqual(merchantB)
  })
})
