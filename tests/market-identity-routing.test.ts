import { describe, expect, it } from "bun:test"
import { nip19 } from "@nostr-dev-kit/ndk"
import { pubkeyToNpub } from "@conduit/core"
import {
  getIdentityPath,
  getRememberedProfileRelayHints,
  rememberProfileRelayHints,
  resolveProfileReference,
} from "../apps/market/src/lib/profileRefs"
import { validateIdentitySearch } from "../apps/market/src/lib/identitySearch"

const pubkey = "a".repeat(64)
const npub = pubkeyToNpub(pubkey)

describe("Market public identity references", () => {
  it("keeps Brainstorm inside the existing identity badge", async () => {
    const identityPage = await Bun.file(
      "apps/market/src/routes/$identityRef.tsx"
    ).text()
    expect(identityPage).toContain("Nip05TrustIndicator")
    expect(identityPage).not.toContain("BrainstormGlobalScoreLink")
    expect(identityPage).not.toContain("BrainstormStatusLink")
    const trustSummary = await Bun.file(
      "apps/market/src/components/MerchantTrustSummary.tsx"
    ).text()
    expect(trustSummary).not.toContain("Brainstorm")
  })

  it("maps npub, hex, and nprofile to one canonical path", () => {
    const nprofile = nip19.nprofileEncode({
      pubkey,
      relays: ["wss://relay.damus.io", "https://invalid.example"],
    })
    expect(getIdentityPath(pubkey)).toBe(`/${npub}`)
    expect(resolveProfileReference(npub)).toEqual({ pubkey, relayHints: [] })
    expect(resolveProfileReference(pubkey.toUpperCase())).toEqual({
      pubkey,
      relayHints: [],
    })
    expect(resolveProfileReference(nprofile)).toEqual({
      pubkey,
      relayHints: ["wss://relay.damus.io"],
    })
  })

  it("carries bounded relay hints through a canonical navigation", () => {
    rememberProfileRelayHints(pubkey, ["wss://relay.damus.io"])
    expect(getRememberedProfileRelayHints(pubkey)).toEqual([
      "wss://relay.damus.io",
    ])
    expect(getRememberedProfileRelayHints("b".repeat(64))).toEqual([])
  })

  it("rejects malformed references and preserves safe legacy storefront filters", () => {
    expect(resolveProfileReference("not-an-identity")).toBeNull()
    expect(resolveProfileReference("nprofile1" + "a".repeat(6_000))).toBeNull()
    expect(
      validateIdentitySearch({
        q: "coffee",
        sort: "price_asc",
        tag: ["LIGHTNING", "lightning"],
        secret: "discard",
      })
    ).toEqual({ q: "coffee", sort: "price_asc", tag: ["lightning"] })
  })
})
