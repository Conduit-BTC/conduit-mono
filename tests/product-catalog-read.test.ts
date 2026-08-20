import { describe, expect, it } from "bun:test"
import {
  getCatalogAuthorKey,
  getCatalogAuthorPubkeys,
  getProductCatalogQueryKey,
  isProductDiscoveryReadIncomplete,
  isPerspectiveMarketplaceRead,
  parseFollowListSnapshot,
  refreshProductCatalogSources,
  resolvePerspectiveAuthorPubkeys,
  selectStrongestFollowListSnapshot,
} from "../apps/market/src/lib/productCatalogRead"

describe("product catalog read planning", () => {
  const viewerPubkey = "a".repeat(64)
  const merchantAPubkey = "b".repeat(64)
  const merchantBPubkey = "c".repeat(64)

  function runRefresh(input: {
    queryEnabled?: boolean
    catalogReady?: boolean
    streamsNetwork?: boolean
    usesPerspectiveGraph?: boolean
    catalogSource?: "following" | "conduit" | "combined"
    authorSetChanged?: boolean
  }): Promise<string[]> {
    const refreshes: string[] = []
    return refreshProductCatalogSources({
      queryEnabled: input.queryEnabled ?? true,
      catalogReady: input.catalogReady ?? true,
      streamsNetwork: input.streamsNetwork ?? true,
      usesPerspectiveGraph: input.usesPerspectiveGraph ?? true,
      catalogSource: input.catalogSource ?? "following",
      refreshPerspectiveAuthors: async () => {
        refreshes.push("authors")
        return input.authorSetChanged ?? false
      },
      restartNetworkStream: () => refreshes.push("stream"),
      refreshNetwork: () => refreshes.push("network"),
      refreshCache: () => refreshes.push("cache"),
    }).then(() => refreshes)
  }

  it("refreshes perspective authors before signed-in catalog sources", async () => {
    expect(await runRefresh({ catalogSource: "following" })).toEqual([
      "authors",
      "stream",
      "cache",
    ])
    expect(await runRefresh({ catalogSource: "combined" })).toEqual([
      "authors",
      "stream",
      "cache",
    ])
  })

  it("lets an author-set change rekey the catalog without a second read", async () => {
    expect(await runRefresh({ authorSetChanged: true })).toEqual(["authors"])
  })

  it("refreshes discovery even while a perspective catalog is not ready", async () => {
    expect(await runRefresh({ catalogReady: false })).toEqual(["authors"])
  })

  it("does not fetch perspective authors for Conduit or storefront reads", async () => {
    expect(await runRefresh({ catalogSource: "conduit" })).toEqual([
      "stream",
      "cache",
    ])
    expect(
      await runRefresh({
        streamsNetwork: false,
        usesPerspectiveGraph: false,
      })
    ).toEqual(["network", "cache"])
  })

  it("does not refresh disabled catalog queries", async () => {
    expect(await runRefresh({ queryEnabled: false })).toEqual([])
  })

  it("keeps all-store marketplace reads scoped to the market perspective", () => {
    expect(isPerspectiveMarketplaceRead({ scope: "marketplace" })).toBe(true)
    expect(getCatalogAuthorPubkeys(["merchant-a"])).toEqual(["merchant-a"])
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

  it("keeps perspective keys stable across equivalent seed ordering", () => {
    const first = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        perspectivePubkey: viewerPubkey,
        seedAuthorPubkeys: [merchantAPubkey, merchantBPubkey],
      },
      "network"
    )
    const reordered = getProductCatalogQueryKey(
      {
        scope: "marketplace",
        perspectivePubkey: viewerPubkey,
        seedAuthorPubkeys: [merchantBPubkey, merchantAPubkey, merchantAPubkey],
      },
      "network"
    )

    expect(reordered).toEqual(first)
    expect(
      getCatalogAuthorKey([merchantBPubkey, merchantAPubkey, merchantAPubkey])
    ).toBe(getCatalogAuthorKey([merchantAPubkey, merchantBPubkey]))
    expect(getCatalogAuthorKey(undefined)).not.toBe(getCatalogAuthorKey([]))
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

  it("returns an empty author set after an empty following-only lookup settles", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "following",
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [],
      fallbackAuthorPubkeys: [merchantBPubkey, merchantAPubkey, viewerPubkey],
      followLookupSettled: true,
    })

    expect(resolved).toEqual({
      authorPubkeys: [],
      source: "none",
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

  it("recognizes incomplete follow discovery metadata", () => {
    expect(
      isProductDiscoveryReadIncomplete({
        stale: false,
        degraded: true,
        capped: false,
      })
    ).toBe(true)
    expect(
      isProductDiscoveryReadIncomplete({
        stale: false,
        degraded: false,
        capped: true,
      })
    ).toBe(true)
    expect(
      isProductDiscoveryReadIncomplete({
        stale: false,
        degraded: false,
        capped: false,
      })
    ).toBe(false)
  })

  it("keeps a newer signed-empty follow snapshot over older relay views", () => {
    const newerEmpty = {
      pubkeys: [],
      eventCreatedAt: 200,
      eventId: "2".repeat(64),
    }
    const retained = selectStrongestFollowListSnapshot(newerEmpty, {
      pubkeys: [merchantAPubkey],
      eventCreatedAt: 100,
      eventId: "1".repeat(64),
    })

    expect(retained).toEqual(newerEmpty)
    expect(
      parseFollowListSnapshot(JSON.parse(JSON.stringify(retained)), {
        excludePubkey: viewerPubkey,
        requireEventId: true,
        sortPubkeys: true,
      })
    ).toEqual(newerEmpty)
  })

  it("replaces older follow snapshots atomically without merging authors", () => {
    expect(
      selectStrongestFollowListSnapshot(
        {
          pubkeys: [],
          eventCreatedAt: 100,
          eventId: "1".repeat(64),
        },
        {
          pubkeys: [merchantAPubkey],
          eventCreatedAt: 200,
          eventId: "2".repeat(64),
        }
      )
    ).toEqual({
      pubkeys: [merchantAPubkey],
      eventCreatedAt: 200,
      eventId: "2".repeat(64),
    })
  })

  it("uses the lower event id for equal-timestamp follow snapshots", () => {
    expect(
      selectStrongestFollowListSnapshot(
        {
          pubkeys: [merchantBPubkey],
          eventCreatedAt: 200,
          eventId: "2".repeat(64),
        },
        {
          pubkeys: [merchantAPubkey],
          eventCreatedAt: 200,
          eventId: "1".repeat(64),
        }
      )
    ).toEqual({
      pubkeys: [merchantAPubkey],
      eventCreatedAt: 200,
      eventId: "1".repeat(64),
    })
  })

  it("upgrades an id-less bundled projection with a signed snapshot", () => {
    expect(
      selectStrongestFollowListSnapshot(
        {
          pubkeys: [merchantBPubkey],
          eventCreatedAt: 200,
        },
        {
          pubkeys: [merchantAPubkey],
          eventCreatedAt: 200,
          eventId: "1".repeat(64),
        }
      )
    ).toEqual({
      pubkeys: [merchantAPubkey],
      eventCreatedAt: 200,
      eventId: "1".repeat(64),
    })
  })

  it("repairs a cached projection from the verified copy of the same event", () => {
    expect(
      selectStrongestFollowListSnapshot(
        {
          pubkeys: [merchantBPubkey],
          eventCreatedAt: 200,
          eventId: "1".repeat(64),
        },
        {
          pubkeys: [merchantAPubkey],
          eventCreatedAt: 200,
          eventId: "1".repeat(64),
        }
      )
    ).toEqual({
      pubkeys: [merchantAPubkey],
      eventCreatedAt: 200,
      eventId: "1".repeat(64),
    })
  })

  it("repairs corrupted cached timing from the verified copy of the same event", () => {
    expect(
      selectStrongestFollowListSnapshot(
        {
          pubkeys: [merchantBPubkey],
          eventCreatedAt: 300,
          eventId: "1".repeat(64),
        },
        {
          pubkeys: [merchantAPubkey],
          eventCreatedAt: 200,
          eventId: "1".repeat(64),
        }
      )
    ).toEqual({
      pubkeys: [merchantAPubkey],
      eventCreatedAt: 200,
      eventId: "1".repeat(64),
    })
  })

  it("normalizes cached follow snapshots before comparing frontiers", () => {
    expect(
      parseFollowListSnapshot(
        {
          pubkeys: [merchantBPubkey, viewerPubkey, merchantBPubkey],
          eventCreatedAt: 200,
          eventId: "2".repeat(64),
        },
        {
          excludePubkey: viewerPubkey,
          requireEventId: true,
          sortPubkeys: true,
        }
      )
    ).toEqual({
      pubkeys: [merchantBPubkey],
      eventCreatedAt: 200,
      eventId: "2".repeat(64),
    })
  })

  it("can start from fallback authors while signed-in follows are still loading", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "combined",
      perspectivePubkey: viewerPubkey,
      fallbackAuthorPubkeys: [merchantBPubkey, merchantAPubkey, viewerPubkey],
      followLookupSettled: false,
    })

    expect(resolved).toEqual({
      authorPubkeys: [viewerPubkey, merchantAPubkey, merchantBPubkey],
      source: "fallback",
    })
  })

  it("merges signed-in follows with fallback authors in combined mode", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "combined",
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [merchantAPubkey, viewerPubkey],
      fallbackAuthorPubkeys: [merchantBPubkey, merchantAPubkey],
      followLookupSettled: true,
    })

    expect(resolved).toEqual({
      authorPubkeys: [viewerPubkey, merchantAPubkey, merchantBPubkey],
      source: "combined",
    })
  })

  it("includes the connected merchant's own listings in combined mode", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "combined",
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [merchantAPubkey],
      fallbackAuthorPubkeys: [merchantBPubkey],
      followLookupSettled: true,
    })

    expect(resolved).toEqual({
      authorPubkeys: [viewerPubkey, merchantAPubkey, merchantBPubkey],
      source: "combined",
    })
  })

  it("lets users choose Conduit-only source without waiting on follow lookup", () => {
    const resolved = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "conduit",
      perspectivePubkey: viewerPubkey,
      refreshedAuthorPubkeys: [merchantAPubkey],
      fallbackAuthorPubkeys: [merchantBPubkey],
      followLookupSettled: false,
    })

    expect(resolved).toEqual({
      authorPubkeys: [merchantBPubkey],
      source: "fallback",
    })
  })
})
