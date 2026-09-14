import { describe, expect, it } from "bun:test"
import type { ProfileSearchMatch } from "../packages/core/src/protocol/profile-search"
import {
  excludeDiscoveredSellers,
  filterSellersByName,
  groupDiscoveredSellers,
} from "../apps/market/src/lib/sellerDirectory"
import type { Product } from "../packages/core/src/types"

const SELLER = "1".repeat(64)
const BUYER = "2".repeat(64)

function match(overrides: Partial<ProfileSearchMatch> & { pubkey: string }) {
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
    { id: "p4", pubkey: BUYER, type: "simple", createdAt: 20 },
  ] as unknown as Product[]

  it("groups listings per seller without counting variations", () => {
    expect(groupDiscoveredSellers(products)).toEqual([
      { pubkey: SELLER, listingCount: 2, latestListingAt: 30 },
      { pubkey: BUYER, listingCount: 1, latestListingAt: 20 },
    ])
  })

  it("filters only resolved names and excludes discovered sellers from network results", () => {
    const sellers = groupDiscoveredSellers(products)
    const getIdentity = (pubkey: string) =>
      pubkey === SELLER
        ? {
            pubkey,
            displayName: "Alice Store",
            status: "resolved" as const,
            relayHints: [],
          }
        : {
            pubkey,
            displayName: "npub1...",
            status: "pending" as const,
            relayHints: [],
          }
    expect(
      filterSellersByName(sellers, getIdentity, "ALICE").map((s) => s.pubkey)
    ).toEqual([SELLER])
    expect(filterSellersByName(sellers, getIdentity, "npub")).toEqual([])
    expect(filterSellersByName(sellers, getIdentity, "")).toHaveLength(2)
    expect(
      excludeDiscoveredSellers(
        [match({ pubkey: SELLER }), match({ pubkey: "3".repeat(64) })],
        sellers
      ).map((m) => m.pubkey)
    ).toEqual(["3".repeat(64)])
  })
})
