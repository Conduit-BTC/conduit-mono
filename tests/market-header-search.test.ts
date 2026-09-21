import { describe, expect, it } from "bun:test"
import type {
  ProfileSearchMatch,
  ProfileSearchResult,
} from "../packages/core/src/protocol/profile-search"
import {
  buildMarketHeaderSuggestionModel,
  describeMarketHeaderSearchEmptyState,
  describeMarketHeaderSearchEvidence,
  getCategoryBrowseSearch,
} from "../apps/market/src/lib/marketHeaderSearch"
import { isSellerCatalogEvidenceIncomplete } from "../apps/market/src/lib/sellerDirectory"

const SELLER = "1".repeat(64)
const ACCOUNT = "2".repeat(64)

function match(input: {
  pubkey: string
  name: string
  isSeller?: boolean
}): ProfileSearchMatch {
  return {
    pubkey: input.pubkey,
    profile: { pubkey: input.pubkey, displayName: input.name },
    isSeller: input.isSeller ?? false,
    source: "device",
    score: 1,
    frontier: {},
  } as ProfileSearchMatch
}

describe("Market header suggestion model", () => {
  it("stacks categories above merchants and accounts with stable targets", () => {
    const model = buildMarketHeaderSuggestionModel({
      listboxId: "market-search-suggestions",
      categories: [
        {
          value: "art",
          label: "art",
          count: 3,
          selected: false,
        },
      ],
      accounts: [
        match({ pubkey: SELLER, name: "Art", isSeller: true }),
        match({ pubkey: ACCOUNT, name: "Art fan" }),
      ],
    })

    expect(model.groups.map((group) => group.heading)).toEqual([
      "Categories",
      "Merchants",
      "Accounts",
    ])
    expect(model.items.map((item) => item.id)).toEqual([
      "category:art",
      SELLER,
      ACCOUNT,
    ])
    expect(model.targetById.get("category:art")).toEqual({
      kind: "category",
      tag: "art",
    })
    expect(model.targetById.get(SELLER)).toMatchObject({
      kind: "account",
      target: { to: "/store/$pubkey" },
    })
    expect(model.targetById.get(ACCOUNT)).toMatchObject({
      kind: "account",
      target: { to: "/u/$profileRef" },
    })
  })

  it("preserves the current browse scope while replacing text with a category", () => {
    const previous = {
      source: "combined",
      merchant: [SELLER],
      sort: "price_asc",
      q: "art",
      tag: ["old"],
      authRequired: true,
      futureFilter: "preserved",
    }

    expect(getCategoryBrowseSearch(previous, "fine art")).toEqual({
      source: "combined",
      merchant: [SELLER],
      sort: "price_asc",
      tag: ["fine art"],
      futureFilter: "preserved",
    })
    expect(previous).toHaveProperty("q", "art")
  })
})

describe("Market header suggestion evidence", () => {
  const partialResult = {
    query: "art",
    matches: [],
    evidence: "lookup_partial",
    relaysPlanned: 2,
    relaysCompleted: 1,
    relaysDegraded: 1,
    verified: false,
    device: {
      profileCache: "read",
      sellerFlags: "read",
      cachedFrontiers: "read",
    },
    superseded: [],
  } as ProfileSearchResult

  it("keeps incomplete catalog and account coverage visible", () => {
    const evidence = describeMarketHeaderSearchEvidence(
      partialResult,
      "partial",
      false
    )

    expect(evidence).toContain(
      "categories, merchants, or accounts may be missing"
    )
    expect(evidence).toContain("Search relay results are incomplete")
  })

  it("keeps retained category suggestions visible with incomplete catalog evidence", () => {
    const model = buildMarketHeaderSuggestionModel({
      listboxId: "market-search-suggestions",
      categories: [
        {
          value: "art",
          label: "art",
          count: 3,
          selected: false,
        },
      ],
      accounts: [],
    })
    const incompleteReads = [
      {
        label: "stale",
        meta: { stale: true, degraded: false, capped: false },
      },
      {
        label: "degraded",
        meta: { stale: false, degraded: true, capped: false },
      },
      {
        label: "capped",
        meta: { stale: false, degraded: false, capped: true },
      },
      {
        label: "failed",
        meta: { stale: false, degraded: false, capped: false },
        error: new Error("offline"),
      },
      {
        label: "paused",
        meta: { stale: false, degraded: false, capped: false },
        isRefreshPaused: true,
      },
    ]

    expect(model.items.map((item) => item.id)).toEqual(["category:art"])
    for (const incompleteRead of incompleteReads) {
      const catalogIncomplete = isSellerCatalogEvidenceIncomplete({
        error: incompleteRead.error ?? null,
        meta: incompleteRead.meta,
        isRefreshPaused: incompleteRead.isRefreshPaused ?? false,
        discoveryStale: false,
      })
      expect(
        describeMarketHeaderSearchEvidence(
          undefined,
          "ready",
          catalogIncomplete
        ),
        incompleteRead.label
      ).toContain("catalog is incomplete")
    }

    expect(
      describeMarketHeaderSearchEvidence(
        undefined,
        "ready",
        isSellerCatalogEvidenceIncomplete({
          error: null,
          meta: { stale: false, degraded: false, capped: false },
          isRefreshPaused: false,
          discoveryStale: false,
        })
      )
    ).toBeNull()
  })

  it("uses generalized cold and unavailable empty states", () => {
    expect(
      describeMarketHeaderSearchEmptyState({
        eligibilityState: "loading",
        catalogUnavailable: false,
        loading: true,
      })
    ).toBe("Searching categories, merchants, and accounts...")
    expect(
      describeMarketHeaderSearchEmptyState({
        eligibilityState: "unavailable",
        catalogUnavailable: true,
        loading: false,
      })
    ).toContain("could not be fully loaded")
  })
})
