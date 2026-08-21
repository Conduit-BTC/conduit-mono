import { describe, expect, it } from "bun:test"
import { getMerchantProfileAuthenticatedPubkey } from "../apps/market/src/hooks/useMerchantTrustContext"

describe("merchant profile perspective", () => {
  it("forwards authenticated context only for the exact merchant owner", () => {
    const owner = "A".repeat(64)

    expect(
      getMerchantProfileAuthenticatedPubkey(owner, owner.toLowerCase())
    ).toBe(owner.toLowerCase())
    expect(
      getMerchantProfileAuthenticatedPubkey(owner, "b".repeat(64))
    ).toBeUndefined()
    expect(getMerchantProfileAuthenticatedPubkey(owner, null)).toBeUndefined()
    expect(
      getMerchantProfileAuthenticatedPubkey("not-a-pubkey", "not-a-pubkey")
    ).toBeUndefined()
  })
})
