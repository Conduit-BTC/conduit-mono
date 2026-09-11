import { describe, expect, it } from "bun:test"
import { getMerchantProfileAuthenticatedPubkey } from "../apps/market/src/hooks/useMerchantTrustContext"

describe("merchant profile perspective", () => {
  it("forwards the signed-in viewer for their account-scoped profile read", () => {
    const owner = "A".repeat(64)
    const viewer = "b".repeat(64)

    expect(
      getMerchantProfileAuthenticatedPubkey(owner, owner.toLowerCase())
    ).toBe(owner.toLowerCase())
    expect(getMerchantProfileAuthenticatedPubkey(owner, viewer)).toBe(viewer)
    expect(getMerchantProfileAuthenticatedPubkey(owner, null)).toBeUndefined()
    expect(
      getMerchantProfileAuthenticatedPubkey("not-a-pubkey", "not-a-pubkey")
    ).toBeUndefined()
  })
})
