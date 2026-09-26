import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ProductCard } from "@conduit/ui"
import {
  prepareProductCatalog,
  type CommerceProductRecord,
  type Product,
  type Profile,
} from "@conduit/core"
import {
  filterProductsByFacets,
  getStoreFacetOptions,
} from "../apps/market/src/lib/facets"
import {
  allowsGlobalProductSearch,
  getGlobalProductSearchQueryKey,
  getMarketBrowseSearchCandidates,
  getMerchantIdentityView,
  getProductShippingPresetEligibility,
  isMarketBrowseRefreshStale,
  mergeProductSearchResults,
  refreshMarketBrowseData,
  sortBrowseProducts,
  sortStoreFacetOptionsByRecentPublisher,
} from "../apps/market/src/lib/marketBrowseModel"

function product(
  id: string,
  pubkey: string,
  tags: string[],
  createdAt: number
): Product {
  return {
    id,
    pubkey,
    title: id,
    price: 1,
    currency: "SAT",
    priceSats: 1,
    type: "simple",
    visibility: "public",
    images: [],
    tags,
    createdAt,
    updatedAt: createdAt,
  }
}

const products = [
  product("new-b", "merchant-b", ["bitcoin"], 400),
  product("new-a", "merchant-a", ["bitcoin"], 300),
  product("old-a", "merchant-a", ["art"], 200),
  product("new-c", "merchant-c", ["art"], 100),
]

describe("market browse model helpers", () => {
  const freshMeta = {
    stale: false,
    degraded: false,
    capped: false,
  }

  it("refreshes dependent browse sources after discovery settles", async () => {
    const refreshes: string[] = []
    await refreshMarketBrowseData({
      globalSearchEnabled: false,
      refreshCatalog: () => refreshes.push("catalog"),
      refreshGlobalSearch: () => refreshes.push("global-search"),
    })
    expect(refreshes).toEqual(["catalog"])

    let settleDiscovery: ((changed: boolean) => void) | undefined
    const refresh = refreshMarketBrowseData({
      globalSearchEnabled: true,
      refreshDiscovery: () => {
        refreshes.push("discovery")
        return new Promise<boolean>((resolve) => {
          settleDiscovery = resolve
        })
      },
      refreshCatalog: () => refreshes.push("catalog"),
      refreshGlobalSearch: () => refreshes.push("global-search"),
    })
    expect(refreshes).toEqual(["catalog", "discovery", "global-search"])
    settleDiscovery?.(false)
    await refresh
    expect(refreshes).toEqual([
      "catalog",
      "discovery",
      "global-search",
      "catalog",
    ])

    await refreshMarketBrowseData({
      globalSearchEnabled: false,
      refreshDiscovery: async () => true,
      refreshCatalog: () => refreshes.push("obsolete-catalog"),
      refreshGlobalSearch: () => refreshes.push("global-search"),
    })
    expect(refreshes).not.toContain("obsolete-catalog")
  })

  it("settles only after every directly refreshed browse source", async () => {
    let finishCatalog!: () => void
    let finishGlobalSearch!: () => void
    let settled = false
    const refresh = refreshMarketBrowseData({
      globalSearchEnabled: true,
      refreshCatalog: () =>
        new Promise<void>((resolve) => {
          finishCatalog = resolve
        }),
      refreshGlobalSearch: () =>
        new Promise<void>((resolve) => {
          finishGlobalSearch = resolve
        }),
    })
    void refresh.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finishCatalog()
    await Promise.resolve()
    expect(settled).toBe(false)
    finishGlobalSearch()
    await refresh
    expect(settled).toBe(true)
  })

  it("treats stale or incomplete active browse sources as not updated", () => {
    expect(
      isMarketBrowseRefreshStale({
        catalogMeta: { ...freshMeta, degraded: true },
        catalogError: null,
        catalogPaused: false,
        discoveryStale: false,
        globalSearchEnabled: false,
        globalSearchMeta: null,
        globalSearchError: null,
        globalSearchPaused: false,
      })
    ).toBe(true)
    expect(
      isMarketBrowseRefreshStale({
        catalogMeta: freshMeta,
        catalogError: null,
        catalogPaused: false,
        discoveryStale: false,
        globalSearchEnabled: true,
        globalSearchMeta: { ...freshMeta, stale: true },
        globalSearchError: null,
        globalSearchPaused: false,
      })
    ).toBe(true)
    expect(
      isMarketBrowseRefreshStale({
        catalogMeta: freshMeta,
        catalogError: null,
        catalogPaused: false,
        discoveryStale: false,
        globalSearchEnabled: false,
        globalSearchMeta: { ...freshMeta, stale: true },
        globalSearchError: null,
        globalSearchPaused: true,
      })
    ).toBe(false)
    expect(
      isMarketBrowseRefreshStale({
        catalogMeta: freshMeta,
        catalogError: null,
        catalogPaused: true,
        discoveryStale: false,
        globalSearchEnabled: false,
        globalSearchMeta: null,
        globalSearchError: null,
        globalSearchPaused: false,
      })
    ).toBe(true)
    expect(
      isMarketBrowseRefreshStale({
        catalogMeta: freshMeta,
        catalogError: null,
        catalogPaused: false,
        discoveryStale: false,
        globalSearchEnabled: true,
        globalSearchMeta: freshMeta,
        globalSearchError: null,
        globalSearchPaused: true,
      })
    ).toBe(true)
  })

  it("keeps global search out of explicit connected catalog scopes", () => {
    expect(
      allowsGlobalProductSearch({
        catalogSource: "following",
        anonymous: false,
      })
    ).toBe(false)
    expect(
      allowsGlobalProductSearch({ catalogSource: "conduit", anonymous: false })
    ).toBe(false)
    expect(
      allowsGlobalProductSearch({ catalogSource: "combined", anonymous: false })
    ).toBe(true)
    expect(
      allowsGlobalProductSearch({ catalogSource: "conduit", anonymous: true })
    ).toBe(true)

    const followingKey = getGlobalProductSearchQueryKey({
      query: "soap",
      pubkey: "viewer",
      catalogSource: "following",
      anonymous: false,
      authorPubkeys: ["merchant-a"],
    })
    const combinedKey = getGlobalProductSearchQueryKey({
      query: "soap",
      pubkey: "viewer",
      catalogSource: "combined",
      anonymous: false,
      authorPubkeys: ["merchant-a"],
    })
    expect(followingKey).not.toEqual(combinedKey)

    expect(combinedKey).not.toEqual(
      getGlobalProductSearchQueryKey({
        query: "soap",
        pubkey: "viewer",
        catalogSource: "combined",
        anonymous: false,
        authorPubkeys: ["merchant-b"],
      })
    )
  })

  it("scopes extended product search to the resolved catalog authors", async () => {
    const hook = await readFile(
      "apps/market/src/hooks/useMarketBrowseModel.ts",
      "utf8"
    )
    expect(hook).toContain("catalogAuthorPubkeys !== undefined")
    expect(hook).toContain("authorPubkeys: catalogAuthorPubkeys")
  })

  it("merges relay search results into the perspective catalog by product id", () => {
    const catalogProduct = product("catalog", "merchant-a", [], 100)
    const searchProduct = product("search", "merchant-b", [], 200)
    const updatedCatalogProduct = {
      ...catalogProduct,
      title: "Updated catalog product",
    }

    expect(
      mergeProductSearchResults(
        [catalogProduct],
        [updatedCatalogProduct, searchProduct]
      )
    ).toEqual([updatedCatalogProduct, searchProduct])
  })

  it("keeps a semantic Congee hit through Market facets and renders its card", () => {
    const indexedProduct = {
      ...product("indexed-mug", "merchant-b", ["ceramic"], 200),
      title: "Handmade mug",
    }
    const catalogMatch = {
      ...product("catalog-ceramics", "merchant-a", ["ceramic"], 100),
      title: "Ceramics from the catalog",
    }
    const unrelated = product("unrelated", "merchant-c", ["art"], 300)
    const candidates = getMarketBrowseSearchCandidates(
      [catalogMatch, unrelated],
      [indexedProduct],
      "ceramics"
    )
    const visible = filterProductsByFacets(candidates, {
      merchants: ["merchant-b"],
      tags: ["ceramic"],
    })

    expect(candidates.map((item) => item.id)).toEqual([
      "catalog-ceramics",
      "indexed-mug",
    ])
    expect(visible.map((item) => item.id)).toEqual(["indexed-mug"])
    const html = renderToStaticMarkup(
      createElement(ProductCard, {
        title: visible[0].title,
        merchantName: "Merchant B",
        images: visible[0].images,
        primaryPrice: "1 sat",
      })
    )
    expect(html).toContain("Handmade mug")
  })

  it("sorts store options by recent publisher while preserving counts", () => {
    const storeOptions = getStoreFacetOptions(products, {}, (pubkey) => pubkey)

    expect(storeOptions.map((option) => [option.value, option.count])).toEqual([
      ["merchant-a", 2],
      ["merchant-b", 1],
      ["merchant-c", 1],
    ])

    const sorted = sortStoreFacetOptionsByRecentPublisher(
      storeOptions,
      products
    )

    expect(sorted.map((option) => [option.value, option.count])).toEqual([
      ["merchant-b", 1],
      ["merchant-a", 2],
      ["merchant-c", 1],
    ])
  })

  it("does not let store-menu sorting affect product result counts", () => {
    const filteredProducts = filterProductsByFacets(products, {
      tags: ["bitcoin"],
    })
    const storeOptions = getStoreFacetOptions(
      products,
      { tags: ["bitcoin"] },
      (pubkey) => pubkey
    )
    const sortedStores = sortStoreFacetOptionsByRecentPublisher(
      storeOptions,
      filteredProducts
    )

    expect(filteredProducts.map((item) => item.id)).toEqual(["new-b", "new-a"])
    expect(filteredProducts).toHaveLength(2)
    expect(sortedStores.map((option) => [option.value, option.count])).toEqual([
      ["merchant-b", 1],
      ["merchant-a", 1],
    ])
  })

  it("sorts variable products by the family minimum price shown on cards", () => {
    const family = {
      ...product("shirt", "merchant-a", ["shirt"], 300),
      price: 1_000,
      priceSats: 1_000,
      type: "variable" as const,
    }
    const child = {
      ...product("shirt-s", "merchant-a", ["shirt"], 301),
      price: 3_000,
      priceSats: 3_000,
      type: "variation" as const,
      parentProductId: "shirt",
      specifications: [{ key: "size", value: "S" }],
      stock: 5,
    }
    const sticker = {
      ...product("sticker", "merchant-a", ["sticker"], 200),
      price: 2_000,
      priceSats: 2_000,
    }
    const records: CommerceProductRecord[] = [family, child].map(
      (candidate) => ({
        product: candidate,
        addressId: candidate.id,
        eventId: `${candidate.id}-event`,
        eventCreatedAt: candidate.createdAt,
        dTag: candidate.id,
      })
    )
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      fetchedAt: 302,
      stale: false,
      degraded: false,
      capped: false,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected a family")

    expect(
      sortBrowseProducts([family, sticker], "price_asc", null, {
        [family.id]: prepared.family,
      }).map((item) => item.id)
    ).toEqual(["sticker", "shirt"])
  })

  it("treats pending merchant fallback as unresolved identity", () => {
    const pending = getMerchantIdentityView("merchant-a", undefined, [
      "wss://relay.example",
    ])

    expect(pending.displayName).toBe("Merchant merchant-a")
    expect(pending.status).toBe("pending")
    expect(pending.relayHints).toEqual(["wss://relay.example"])
  })

  it("treats settled empty profile lookup as a fallback identity", () => {
    const fallback = getMerchantIdentityView(
      "merchant-a",
      undefined,
      ["wss://relay.example"],
      { lookupSettled: true }
    )

    expect(fallback.displayName).toBe("Merchant merchant-a")
    expect(fallback.status).toBe("fallback")
    expect(fallback.relayHints).toEqual(["wss://relay.example"])
  })

  it("treats profile names as resolved merchant identity", () => {
    const profile: Profile = {
      pubkey: "merchant-a",
      displayName: "Alice Market",
    }
    const resolved = getMerchantIdentityView("merchant-a", profile, undefined)

    expect(resolved.displayName).toBe("Alice Market")
    expect(resolved.status).toBe("resolved")
    expect(resolved.relayHints).toEqual([])
  })

  it("prioritizes preset-eligible products without hiding unknown coverage", () => {
    const eligible = {
      ...product("eligible", "merchant-a", [], 100),
      shippingCountries: ["US"],
      shippingCountryRules: [
        { code: "US", name: "US", restrictTo: [], exclude: [] },
      ],
    }
    const unknown = {
      ...product("unknown", "merchant-b", [], 300),
      shippingCountries: [],
      shippingCountryRules: [],
    }
    const ineligible = {
      ...product("ineligible", "merchant-c", [], 500),
      shippingCountries: ["CA"],
      shippingCountryRules: [
        { code: "CA", name: "CA", restrictTo: [], exclude: [] },
      ],
    }

    expect(
      getProductShippingPresetEligibility(unknown, {
        country: "US",
        postalCode: "94559",
      })
    ).toBe("unknown")
    expect(
      sortBrowseProducts(
        [ineligible, unknown, eligible],
        "newest",
        null,
        {},
        { country: "US", postalCode: "94559" }
      ).map((item) => item.id)
    ).toEqual(["eligible", "unknown", "ineligible"])
    expect(
      sortBrowseProducts(
        [ineligible, unknown, eligible],
        "price_asc",
        null,
        {},
        { country: "US", postalCode: "94559" }
      ).map((item) => item.id)
    ).toEqual(["ineligible", "unknown", "eligible"])
  })
})
