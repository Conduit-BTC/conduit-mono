import { describe, expect, it } from "bun:test"
import type { ProfileSearchMatch } from "../packages/core/src/protocol/profile-search"
import {
  describeAccountSearchEvidence,
  getAccountSuggestionTarget,
  toAccountSuggestionItems,
} from "../apps/market/src/lib/accountSearch"

const SELLER = "1".repeat(64)
const BUYER = "2".repeat(64)

function match(overrides: Partial<ProfileSearchMatch> & { pubkey: string }) {
  return {
    profile: { pubkey: overrides.pubkey },
    isSeller: false,
    source: "network",
    score: 1,
    ...overrides,
  } as ProfileSearchMatch
}

describe("account suggestion items", () => {
  it("labels by profile name, describes by nip05 or npub, and badges sellers", () => {
    const items = toAccountSuggestionItems([
      match({
        pubkey: SELLER,
        isSeller: true,
        profile: {
          pubkey: SELLER,
          displayName: "Alice Store",
          nip05: "_@alice.example",
          picture: "https://cdn.conduit.market/alice.png",
        },
      }),
      match({ pubkey: BUYER, profile: { pubkey: BUYER } }),
    ])
    expect(items[0]).toMatchObject({
      id: SELLER,
      label: "Alice Store",
      description: "alice.example",
      badge: "Seller",
      imageUrl: "https://cdn.conduit.market/alice.png",
    })
    expect(items[1]?.label).toMatch(/^npub1/)
    expect(items[1]?.badge).toBeUndefined()
  })

  it("routes sellers to their storefront and other accounts to the profile view", () => {
    expect(
      getAccountSuggestionTarget(match({ pubkey: SELLER, isSeller: true }))
    ).toEqual({
      to: "/store/$pubkey",
      params: { pubkey: expect.stringMatching(/^npub1/) },
    })
    expect(getAccountSuggestionTarget(match({ pubkey: BUYER }))).toEqual({
      to: "/u/$profileRef",
      params: { profileRef: expect.stringMatching(/^npub1/) },
    })
  })

  it("describes bounded evidence without claiming global absence", () => {
    const base = {
      query: "ali",
      matches: [],
      relaysPlanned: 2,
      relaysCompleted: 2,
      verified: true,
    }
    expect(describeAccountSearchEvidence(undefined)).toBeNull()
    expect(
      describeAccountSearchEvidence({ ...base, evidence: "present_current" })
    ).toBeNull()
    expect(
      describeAccountSearchEvidence({
        ...base,
        evidence: "absent_within_scope",
      })
    ).toBe("No accounts matched on 2 search relays.")
    expect(
      describeAccountSearchEvidence({
        ...base,
        evidence: "lookup_partial",
        relaysCompleted: 1,
      })
    ).toContain("did not answer")
    expect(
      describeAccountSearchEvidence({
        ...base,
        evidence: "lookup_unavailable",
        relaysCompleted: 0,
        matches: [match({ pubkey: BUYER })],
      })
    ).toContain("seen on this device")
  })
})
