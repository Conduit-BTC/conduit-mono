import { describe, expect, it } from "bun:test"

import { createBuyerGiftWrapsForMerchantAndSelf } from "../apps/market/src/lib/order-publish"

describe("buyer order gift wrapping", () => {
  it("serializes recipient wraps and retries transient signer bridge failures", async () => {
    const recipients: string[] = []
    const giftWrapFn = async (
      _rumor: unknown,
      recipient: { pubkey: string }
    ) => {
      recipients.push(recipient.pubkey)
      if (recipients.length === 1) {
        throw new Error(
          "Could not establish connection. Receiving end does not exist."
        )
      }
      return { id: `wrapped-${recipient.pubkey}` }
    }

    const result = await createBuyerGiftWrapsForMerchantAndSelf(
      {} as never,
      {} as never,
      "merchant-pubkey",
      "buyer-pubkey",
      { giftWrapFn: giftWrapFn as never, retryDelaysMs: [0] }
    )

    expect(recipients).toEqual([
      "merchant-pubkey",
      "merchant-pubkey",
      "buyer-pubkey",
    ])
    expect(result.wrappedToMerchant.id).toBe("wrapped-merchant-pubkey")
    expect(result.wrappedToSelf.id).toBe("wrapped-buyer-pubkey")
  })

  it("does not retry non-transient signer failures", async () => {
    const recipients: string[] = []
    const giftWrapFn = async (
      _rumor: unknown,
      recipient: { pubkey: string }
    ) => {
      recipients.push(recipient.pubkey)
      throw new Error("User rejected access")
    }

    await expect(
      createBuyerGiftWrapsForMerchantAndSelf(
        {} as never,
        {} as never,
        "merchant-pubkey",
        "buyer-pubkey",
        { giftWrapFn: giftWrapFn as never, retryDelaysMs: [0] }
      )
    ).rejects.toThrow("User rejected access")

    expect(recipients).toEqual(["merchant-pubkey"])
  })
})
