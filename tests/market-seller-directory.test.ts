import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  ACCOUNT_SEARCH_CANDIDATE_LIMIT,
  ACCOUNT_SUGGESTION_LIMIT,
  describeAccountSearchSource,
  limitAccountMatches,
} from "../apps/market/src/lib/accountSearch"
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

function match(
  overrides: Partial<ProfileSearchMatch> & { pubkey: string }
): ProfileSearchMatch {
  return {
    profile: { pubkey: overrides.pubkey },
    isSeller: false,
    source: "network",
    score: 1,
    frontier: {},
    ...overrides,
  } as ProfileSearchMatch
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
      filterSellersByName(sellers, getIdentity, "ALICE").map(
        (seller) => seller.pubkey
      )
    ).toEqual([SELLER, OTHER_SELLER])
    expect(
      filterSellersByName(sellers, getIdentity, "shop").map(
        (seller) => seller.pubkey
      )
    ).toEqual([SELLER])
    expect(filterSellersByName(sellers, getIdentity, "")).toHaveLength(2)
    expect(
      excludeDiscoveredSellers(
        [match({ pubkey: SELLER }), match({ pubkey: OTHER_ACCOUNT })],
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
    const route = await readFile("apps/market/src/routes/merchants.tsx", "utf8")
    expect(route).toContain("directory.isUnavailable")
    expect(route).toContain(
      "Merchants could not be loaded from this perspective."
    )
    expect(route).toContain("onClick={directory.retry}")
    expect(route).toContain(
      "No merchants have been discovered from this perspective yet."
    )
  })
})

describe("other accounts capping", () => {
  it("describes cache-only account matches without claiming relay provenance", () => {
    expect(
      describeAccountSearchSource(
        {
          query: "a",
          matches: [match({ pubkey: OTHER_ACCOUNT, source: "local_cache" })],
          evidence: "not_queried",
          relaysPlanned: 0,
          relaysCompleted: 0,
          relaysDegraded: 0,
          verified: true,
          device: {
            profileCache: "read",
            sellerFlags: "read",
            cachedFrontiers: "not_read",
          },
          superseded: [],
        },
        { device: false, network: false }
      )
    ).toBe("From this device")
  })

  it("does not describe a delayed device read as relay activity", () => {
    expect(
      describeAccountSearchSource(undefined, { device: true, network: false })
    ).toBe("Searching this device...")
  })

  it("describes an outstanding network phase as relay activity", () => {
    expect(
      describeAccountSearchSource(undefined, { device: true, network: true })
    ).toBe("Searching relays...")
  })

  it("removes discovered sellers before applying the display cap", async () => {
    const sellers = Array.from(
      { length: ACCOUNT_SUGGESTION_LIMIT },
      (_, index) => ({
        pubkey: `a${index}`.padEnd(64, "0"),
        listingCount: 1,
        latestListingAt: 1,
      })
    )
    const others = Array.from({ length: 3 }, (_, index) => ({
      pubkey: `b${index}`.padEnd(64, "0"),
    }))
    const candidates = [
      ...sellers.map((seller) => match({ pubkey: seller.pubkey })),
      ...others.map((other) => match({ pubkey: other.pubkey })),
    ]
    expect(candidates.length).toBeLessThanOrEqual(
      ACCOUNT_SEARCH_CANDIDATE_LIMIT
    )

    const shown = limitAccountMatches(
      excludeDiscoveredSellers(candidates, sellers),
      ACCOUNT_SUGGESTION_LIMIT
    )
    expect(shown.map((entry) => entry.pubkey)).toEqual(
      others.map((other) => other.pubkey)
    )

    const hook = await readFile(
      "apps/market/src/hooks/useSellerDirectory.ts",
      "utf8"
    )
    expect(hook).toContain("limit: ACCOUNT_SEARCH_CANDIDATE_LIMIT")
    expect(hook).toMatch(/limitAccountMatches\(\s*excludeDiscoveredSellers\(/)
  })
})

describe("merchant matches on the product search", () => {
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
    expect(route).toContain('aria-labelledby="matching-merchants-heading"')
    expect(route).toContain("MATCHING_MERCHANT_LIMIT")
    expect(route).toContain('to="/merchants"')
    // The row sits before the result count, and the grid stays product-only.
    expect(route.indexOf("matching-merchants-heading")).toBeLessThan(
      route.indexOf("{filtered.length} {filtered.length === 1")
    )
  })

  it("keeps product submit behavior while restoring scoped account suggestions", async () => {
    const header = await readFile(
      "apps/market/src/components/MarketHeader.tsx",
      "utf8"
    )
    expect(header).not.toContain('"/merchants"')
    expect(header).toContain('const isBrowseRoute = pathname === "/products"')
    expect(header).toContain("useMarketHeaderSuggestions({")
    expect(header).toContain("catalogSource: routeCatalogSource")

    const suggestionsHook = await readFile(
      "apps/market/src/hooks/useMarketHeaderSuggestions.ts",
      "utf8"
    )
    expect(suggestionsHook).toContain("useSellerDirectory({")
    expect(suggestionsHook).toContain("sellerDirectory.accountSearch")

    const suggestionModel = await readFile(
      "apps/market/src/lib/marketHeaderSearch.ts",
      "utf8"
    )
    expect(suggestionModel).toContain('heading: "Categories"')
    expect(suggestionModel).toContain('heading: "Merchants"')
    expect(suggestionModel).toContain('heading: "Accounts"')
    expect(suggestionModel).toContain(
      "Categories, merchants, and accounts could not be fully loaded."
    )

    const merchants = await readFile(
      "apps/market/src/routes/merchants.tsx",
      "utf8"
    )
    expect(merchants).toContain('aria-label="Filter merchants"')
    expect(merchants).toContain("updateSearch({ q: trimmed || undefined })")
    expect(merchants).toContain("describeScopedAccountSearchEvidence")
    expect(merchants).toContain("Other eligible accounts")
    expect(merchants).toContain("directory.eligibilityState")
    expect(merchants).toContain("onClick={directory.retry}")
  })

  it("moves product categories into the same dropdown pattern as merchants", async () => {
    const route = await readFile(
      "apps/market/src/routes/products/index.tsx",
      "utf8"
    )

    expect(route).toContain("open={categoryMenuOpen}")
    expect(route).toContain("All categories")
    expect(route).toContain("All merchants")
    expect(route).not.toContain("Expand categories")
  })
})
