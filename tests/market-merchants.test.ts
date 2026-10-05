import { describe, expect, it } from "bun:test"
import { MARKET_MERCHANT_PUBKEYS } from "../apps/market/src/lib/marketMerchants"
import {
  getCatalogAuthorKey,
  resolvePerspectiveAuthorPubkeys,
} from "../apps/market/src/lib/productCatalogRead"

describe("repository-owned Market merchant scope", () => {
  it("contains only unique sorted public keys", () => {
    expect(MARKET_MERCHANT_PUBKEYS.length).toBeGreaterThan(0)
    expect(
      MARKET_MERCHANT_PUBKEYS.every((key) => /^[0-9a-f]{64}$/.test(key))
    ).toBe(true)
    expect(new Set(MARKET_MERCHANT_PUBKEYS).size).toBe(
      MARKET_MERCHANT_PUBKEYS.length
    )
    expect(MARKET_MERCHANT_PUBKEYS).toEqual([...MARKET_MERCHANT_PUBKEYS].sort())
  })

  it("resolves guest discovery with no perspective identity or follow lookup", () => {
    const result = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: false,
      sourceMode: "conduit",
      seedAuthorPubkeys: MARKET_MERCHANT_PUBKEYS,
    })
    expect(result.source).toBe("seed")
    expect(result.authorPubkeys).toEqual(MARKET_MERCHANT_PUBKEYS)
  })

  it("keeps personal follows distinct and combines only when requested", () => {
    const own = "a".repeat(64)
    const followed = "b".repeat(64)
    const following = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "following",
      perspectivePubkey: own,
      refreshedAuthorPubkeys: [followed],
      fallbackAuthorPubkeys: MARKET_MERCHANT_PUBKEYS,
    })
    expect(following.authorPubkeys).toEqual([followed])
    const combined = resolvePerspectiveAuthorPubkeys({
      usesPerspectiveGraph: true,
      sourceMode: "combined",
      perspectivePubkey: own,
      refreshedAuthorPubkeys: [followed],
      fallbackAuthorPubkeys: MARKET_MERCHANT_PUBKEYS,
    })
    expect(new Set(combined.authorPubkeys)).toEqual(
      new Set([...MARKET_MERCHANT_PUBKEYS, own, followed])
    )
  })

  it("changes catalog cache identity when an entry is added or removed", () => {
    const original = getCatalogAuthorKey(MARKET_MERCHANT_PUBKEYS)
    expect(getCatalogAuthorKey(MARKET_MERCHANT_PUBKEYS.slice(1))).not.toBe(
      original
    )
    expect(
      getCatalogAuthorKey([...MARKET_MERCHANT_PUBKEYS, "a".repeat(64)])
    ).not.toBe(original)
  })
})
