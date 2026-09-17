import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  excludeDiscoveredSellers,
  filterSellersByName,
  getSellerEligibilityState,
  groupDiscoveredSellers,
  isSellerDirectoryUnavailable,
} from "../apps/market/src/lib/sellerDirectory"
import type { ProfileSearchMatch } from "../packages/core/src/protocol/profile-search"
import type { Product } from "../packages/core/src/types"

const SELLER = "1".repeat(64)
const OTHER_SELLER = "2".repeat(64)
const OTHER_ACCOUNT = "3".repeat(64)

function match(pubkey: string): ProfileSearchMatch {
  return {
    pubkey,
    profile: { pubkey },
    isSeller: false,
    source: "network",
    score: 1,
    frontier: {},
  }
}

describe("seller directory", () => {
  const products = [
    { id: "p1", pubkey: SELLER, type: "simple", createdAt: 10 },
    { id: "p2", pubkey: SELLER, type: "variable", createdAt: 30 },
    { id: "p3", pubkey: SELLER, type: "variation", createdAt: 40 },
    { id: "p4", pubkey: OTHER_SELLER, type: "simple", createdAt: 20 },
  ] as unknown as Product[]

  it("groups listings per seller without counting variations", () => {
    expect(groupDiscoveredSellers(products)).toEqual([
      { pubkey: SELLER, listingCount: 2, latestListingAt: 30 },
      { pubkey: OTHER_SELLER, listingCount: 1, latestListingAt: 20 },
    ])
  })

  it("matches every public name field and ranks before applying the catalog order", () => {
    const sellers = groupDiscoveredSellers(products)
    const getIdentity = (pubkey: string) =>
      pubkey === SELLER
        ? {
            pubkey,
            displayName: "Wonderland Goods",
            searchProfile: {
              pubkey,
              name: "alice",
              displayName: "Wonderland Goods",
              nip05: "shop@alice.example",
            },
            status: "resolved" as const,
            relayHints: [],
          }
        : {
            pubkey,
            displayName: "Alice Outlet",
            searchProfile: {
              pubkey,
              displayName: "Alice Outlet",
            },
            status: "resolved" as const,
            relayHints: [],
          }
    expect(
      filterSellersByName(sellers, getIdentity, "ALICE").map((s) => s.pubkey)
    ).toEqual([SELLER, OTHER_SELLER])
    expect(
      filterSellersByName(sellers, getIdentity, "shop").map((s) => s.pubkey)
    ).toEqual([SELLER])
    expect(filterSellersByName(sellers, getIdentity, "")).toHaveLength(2)
    expect(
      excludeDiscoveredSellers(
        [match(SELLER), match(OTHER_ACCOUNT)],
        sellers
      ).map((entry) => entry.pubkey)
    ).toEqual([OTHER_ACCOUNT])
  })

  it("keeps incomplete eligibility distinct from a completed author set", () => {
    const ready = {
      authorPubkeys: [SELLER],
      source: "combined" as const,
      followLookupStatus: "ready" as const,
      discoveryStale: false,
    }
    expect(getSellerEligibilityState(ready)).toBe("ready")
    expect(
      getSellerEligibilityState({
        ...ready,
        followLookupStatus: "loading",
      })
    ).toBe("partial")
    expect(
      getSellerEligibilityState({
        ...ready,
        authorPubkeys: [],
        followLookupStatus: "error",
      })
    ).toBe("unavailable")
    expect(
      getSellerEligibilityState({
        ...ready,
        authorPubkeys: undefined,
        followLookupStatus: "loading",
      })
    ).toBe("loading")
  })

  it("distinguishes a cold unavailable read from a completed empty read", () => {
    const completed = {
      stale: false,
      degraded: false,
      capped: false,
    }
    const empty = {
      hasSellers: false,
      isFetching: false,
      error: null,
      meta: completed,
      isRefreshPaused: false,
      discoveryStale: false,
    }

    expect(isSellerDirectoryUnavailable(empty)).toBe(false)
    expect(
      isSellerDirectoryUnavailable({ ...empty, error: new Error("offline") })
    ).toBe(true)
    expect(isSellerDirectoryUnavailable({ ...empty, meta: null })).toBe(true)
    expect(
      isSellerDirectoryUnavailable({
        ...empty,
        meta: { ...completed, degraded: true },
      })
    ).toBe(true)
  })

  it("keeps loading and retained sellers out of the unavailable state", () => {
    const unavailable = {
      hasSellers: false,
      isFetching: false,
      error: new Error("offline"),
      meta: null,
      isRefreshPaused: false,
      discoveryStale: false,
    }

    expect(
      isSellerDirectoryUnavailable({ ...unavailable, isFetching: true })
    ).toBe(false)
    expect(
      isSellerDirectoryUnavailable({ ...unavailable, hasSellers: true })
    ).toBe(false)
  })

  it("offers retry for the unavailable directory without changing empty copy", async () => {
    const route = await readFile("apps/market/src/routes/sellers.tsx", "utf8")
    expect(route).toContain("directory.isUnavailable")
    expect(route).toContain(
      "Sellers could not be loaded from this perspective."
    )
    expect(route).toContain("onClick={directory.retry}")
    expect(route).toContain(
      "No sellers have been discovered from this perspective yet."
    )
  })
})

describe("storefront matches on the product search", () => {
  it("answers the name query from the discovered catalog, above product results", async () => {
    const model = await readFile(
      "apps/market/src/hooks/useMarketBrowseModel.ts",
      "utf8"
    )
    expect(model).toMatch(
      /filterSellersByName\(\s*groupDiscoveredSellers\(productData\),\s*getMerchantIdentity,\s*query\s*\)/
    )
    expect(model).toContain("matchingSellers,")

    const route = await readFile(
      "apps/market/src/routes/products/index.tsx",
      "utf8"
    )
    expect(route).toContain('aria-labelledby="matching-stores-heading"')
    expect(route).toContain("MATCHING_STORE_LIMIT")
    expect(route).toContain('to="/sellers"')
    // The row sits before the result count, and the grid stays product-only.
    expect(route.indexOf("matching-stores-heading")).toBeLessThan(
      route.indexOf("{filtered.length} {filtered.length === 1")
    )
  })

  it("keeps product submit behavior while restoring scoped account suggestions", async () => {
    const header = await readFile(
      "apps/market/src/components/MarketHeader.tsx",
      "utf8"
    )
    expect(header).not.toContain('"/sellers"')
    expect(header).toContain('const isBrowseRoute = pathname === "/products"')
    expect(header).toContain('heading: "Stores"')
    expect(header).toContain('heading: "Accounts"')
    expect(header).toContain("useSellerDirectory({")
    expect(header).toContain("catalogSource: routeCatalogSource")
    expect(header).toContain("sellerDirectory.accountSearch")
    expect(header).toContain("Eligible accounts could not be loaded.")

    const sellers = await readFile("apps/market/src/routes/sellers.tsx", "utf8")
    expect(sellers).toContain('aria-label="Filter sellers"')
    expect(sellers).toContain("updateSearch({ q: trimmed || undefined })")
    expect(sellers).toContain("Other eligible accounts")
    expect(sellers).toContain("search relays")
  })
})
