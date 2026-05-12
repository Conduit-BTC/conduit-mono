import { describe, expect, it } from "bun:test"
import {
  getCatalogAuthorPubkeys,
  getProductCatalogQueryKey,
  isPerspectiveMarketplaceRead,
  resolvePerspectiveAuthorPubkeys,
} from "../apps/market/src/lib/productCatalogRead"

describe("product catalog read planning", () => {
  const viewerPubkey = "a".repeat(64)
  const merchantAPubkey = "b".repeat(64)
  const merchantBPubkey = "c".repeat(64)

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

  it("falls back to the default perspective after an empty signed-in follow lookup settles", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [],
      fallbackAuthorPubkeys: [merchantBPubkey, merchantAPubkey, viewerPubkey],
      followLookupSettled: true,
    })

    expect(resolved).toEqual({
      authorPubkeys: [merchantAPubkey, merchantBPubkey],
      source: "fallback",
    })
  })

  it("waits for signed-in follow lookup before using fallback perspective authors", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [],
      fallbackAuthorPubkeys: [merchantAPubkey],
      followLookupSettled: false,
    })

    expect(resolved).toEqual({
      authorPubkeys: undefined,
      source: "none",
    })
  })

  it("prefers signed-in follows over fallback perspective authors", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [merchantAPubkey],
      fallbackAuthorPubkeys: [merchantBPubkey],
      followLookupSettled: true,
    })

    expect(resolved).toEqual({
      authorPubkeys: [merchantAPubkey],
      source: "refreshed",
    })
  })
})
