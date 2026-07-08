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
      { signer: { id: "connected-signer" } } as never,
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
        { signer: { id: "connected-signer" } } as never,
        "merchant-pubkey",
        "buyer-pubkey",
        { giftWrapFn: giftWrapFn as never, retryDelaysMs: [0] }
      )
    ).rejects.toThrow("User rejected access")

    expect(recipients).toEqual(["merchant-pubkey"])
  })

  it("uses an explicit buyer signer for guest order wraps", async () => {
    const explicitSigner = { id: "guest-ephemeral-signer" }
    const connectedSigner = { id: "connected-signer" }
    const signers: unknown[] = []
    const recipients: string[] = []
    const giftWrapFn = async (
      _rumor: unknown,
      recipient: { pubkey: string },
      signer: unknown
    ) => {
      recipients.push(recipient.pubkey)
      signers.push(signer)
      return { id: `wrapped-${recipient.pubkey}` }
    }

    const result = await createBuyerGiftWrapsForMerchantAndSelf(
      {} as never,
      { signer: connectedSigner } as never,
      "merchant-pubkey",
      { pubkey: "guest-pubkey", signer: explicitSigner as never },
      { giftWrapFn: giftWrapFn as never, retryDelaysMs: [0] }
    )

    expect(recipients).toEqual(["merchant-pubkey", "guest-pubkey"])
    expect(signers).toEqual([explicitSigner, explicitSigner])
    expect(result.wrappedToMerchant.id).toBe("wrapped-merchant-pubkey")
    expect(result.wrappedToSelf.id).toBe("wrapped-guest-pubkey")
  })

  it("fails before wrapping when no buyer signer is available", async () => {
    let wrapAttempts = 0
    const giftWrapFn = async () => {
      wrapAttempts += 1
      return { id: "wrapped" }
    }

    await expect(
      createBuyerGiftWrapsForMerchantAndSelf(
        {} as never,
        {} as never,
        "merchant-pubkey",
        "buyer-pubkey",
        { giftWrapFn: giftWrapFn as never, retryDelaysMs: [0] }
      )
    ).rejects.toThrow("Buyer order signer is not connected.")

    expect(wrapAttempts).toBe(0)
  })
})
