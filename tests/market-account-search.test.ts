import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import type { ProfileSearchMatch } from "../packages/core/src/protocol/profile-search"
import {
  describeAccountSearchDeviceEvidence,
  describeAccountSearchEvidence,
  describeAccountSearchEligibility,
  describeScopedAccountSearchEvidence,
  getAccountSuggestionDescription,
  getAccountSuggestionTarget,
  resolveActiveSuggestionIndex,
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
    frontier: {},
    ...overrides,
  } as ProfileSearchMatch
}

describe("account suggestion items", () => {
  it("labels by profile name, describes by npub, and badges sellers", () => {
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
      badge: "Merchant",
      imageUrl: "https://cdn.conduit.market/alice.png",
    })
    expect(items[0]?.description).toMatch(/^npub1/)
    expect(items[1]?.label).toMatch(/^npub1/)
    expect(items[1]?.badge).toBeUndefined()
  })

  it("never shows an unverified NIP-05 claim as the account identifier", async () => {
    const impostor = toAccountSuggestionItems([
      match({
        pubkey: BUYER,
        profile: {
          pubkey: BUYER,
          displayName: "Alice Store",
          nip05: "alice@alice.example",
        },
      }),
    ])
    expect(impostor[0]?.description).toBe(
      getAccountSuggestionDescription(match({ pubkey: BUYER }))
    )
    expect(JSON.stringify(impostor)).not.toContain("alice.example")

    const route = await readFile("apps/market/src/routes/merchants.tsx", "utf8")
    expect(route).toContain("getAccountSuggestionDescription(match)")
    expect(route).not.toContain("nip05")
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
      relaysDegraded: 0,
      verified: true,
      device: {
        profileCache: "read",
        sellerFlags: "read",
        cachedFrontiers: "read",
      },
      superseded: [],
    } as const
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
    ).toContain("incomplete")
    expect(
      describeAccountSearchEvidence({
        ...base,
        evidence: "lookup_partial",
        relaysDegraded: 1,
        verified: false,
        matches: [match({ pubkey: BUYER })],
      })
    ).toBe("Search relay results are incomplete. More accounts may exist.")
    expect(
      describeAccountSearchEvidence({
        ...base,
        evidence: "lookup_unavailable",
        relaysCompleted: 0,
        matches: [match({ pubkey: BUYER })],
      })
    ).toContain("seen on this device")
  })

  it("names a failed device read instead of showing a confident empty list", () => {
    const base = {
      query: "ali",
      matches: [],
      evidence: "absent_within_scope" as const,
      relaysPlanned: 1,
      relaysCompleted: 1,
      relaysDegraded: 0,
      verified: true,
      superseded: [],
    }
    expect(
      describeAccountSearchDeviceEvidence({
        ...base,
        device: {
          profileCache: "unavailable",
          sellerFlags: "read",
          cachedFrontiers: "read",
        },
      })
    ).toBe("Accounts saved on this device could not be read.")
    expect(
      describeAccountSearchEvidence({
        ...base,
        device: {
          profileCache: "unavailable",
          sellerFlags: "read",
          cachedFrontiers: "read",
        },
      })
    ).toBe(
      "Accounts saved on this device could not be read. No accounts matched on 1 search relay."
    )
    expect(
      describeAccountSearchDeviceEvidence({
        ...base,
        device: {
          profileCache: "read",
          sellerFlags: "unavailable",
          cachedFrontiers: "read",
        },
      })
    ).toBe("Merchant badges could not be checked on this device.")
    expect(
      describeAccountSearchDeviceEvidence({
        ...base,
        device: {
          profileCache: "read",
          sellerFlags: "partial",
          cachedFrontiers: "read",
        },
      })
    ).toBeNull()
  })

  it("keeps an incomplete eligibility boundary visible beside relay evidence", () => {
    expect(describeAccountSearchEligibility("ready")).toBeNull()
    expect(describeAccountSearchEligibility("loading")).toContain("Checking")
    expect(describeAccountSearchEligibility("partial")).toContain("incomplete")
    expect(describeAccountSearchEligibility("unavailable")).toContain(
      "unavailable"
    )
    expect(describeScopedAccountSearchEvidence(undefined, "partial")).toContain(
      "followed accounts may be missing"
    )
  })
})

describe("highlighted suggestion", () => {
  const cached = toAccountSuggestionItems([
    match({ pubkey: SELLER, profile: { pubkey: SELLER, name: "Alice One" } }),
    match({ pubkey: BUYER, profile: { pubkey: BUYER, name: "Alice Two" } }),
  ])

  it("follows the highlighted account when relay results reorder the list", async () => {
    const active = cached[1]!.id
    expect(resolveActiveSuggestionIndex(cached, active)).toBe(1)

    const reordered = [cached[1]!, cached[0]!]
    expect(resolveActiveSuggestionIndex(reordered, active)).toBe(0)
    expect(resolveActiveSuggestionIndex([cached[0]!], active)).toBe(-1)
    expect(resolveActiveSuggestionIndex(cached, null)).toBe(-1)

    const header = await readFile(
      "apps/market/src/components/MarketHeader.tsx",
      "utf8"
    )
    expect(header).toContain("resolveActiveSuggestionIndex(")
    expect(header).toContain("useState<string | null>(")
    expect(header).not.toContain("useState(-1)")
  })

  it("does not open an empty cache-only suggestion panel", async () => {
    const suggestionsHook = await readFile(
      "apps/market/src/hooks/useMarketHeaderSuggestions.ts",
      "utf8"
    )

    expect(suggestionsHook).toContain("!!evidence || loading")
    expect(suggestionsHook).not.toContain("!!accountSearch.data")
  })
})
