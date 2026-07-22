import { describe, expect, it } from "bun:test"

import { EVENT_KINDS } from "@conduit/core"

import {
  buildPaymentProofRumor,
  prepareBuyerRumor,
  publishBuyerOrderMessage,
} from "../apps/market/src/lib/order-publish"

describe("buyer order rumor preparation", () => {
  it("recreates the same payment-proof rumor id for receipt retries", () => {
    const params = {
      merchantPubkey: "merchant-pubkey",
      orderId: "guest-order",
      amountSats: 12,
      currency: "SATS",
      content: '{"zapReceiptId":"receipt-id"}',
      createdAt: 1_700_000_000,
    }
    const first = buildPaymentProofRumor(params)
    const retry = buildPaymentProofRumor(params)

    prepareBuyerRumor(first, "guest-pubkey")
    prepareBuyerRumor(retry, "guest-pubkey")

    expect(first.created_at).toBe(params.createdAt)
    expect(retry.id).toBe(first.id)
  })
})

function orderRumor(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-rumor",
    kind: EVENT_KINDS.ORDER,
    pubkey: "",
    created_at: 100,
    content: "{}",
    tags: [
      ["p", "merchant-pubkey"],
      ["type", "order"],
      ["order", "guest-order"],
    ],
    ...overrides,
  } as never
}

describe("buyer order publishing", () => {
  it("delegates signed-in delivery and self-copy to the shared boundary", async () => {
    const signer = { id: "connected-signer" }
    let captured: Record<string, unknown> | undefined
    let cached = false

    const result = await publishBuyerOrderMessage(
      orderRumor(),
      { signer } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async (input) => {
          captured = input as unknown as Record<string, unknown>
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: { id: "self-wrap" } as never,
            selfCopyError: null,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cached = true
          return null
        },
      }
    )

    expect(captured?.senderPubkey).toBe("buyer-pubkey")
    expect(captured?.recipientPubkey).toBe("merchant-pubkey")
    expect(captured?.signer).toBe(signer)
    expect(captured?.rumorKind).toBe(EVENT_KINDS.ORDER)
    expect(captured?.selfCopy).toBe(true)
    expect(cached).toBe(true)
    expect(result).toEqual({ buyerSelfCopyError: null, localCacheError: null })
  })

  it("uses the scoped guest signer without a self-copy or durable cache", async () => {
    const guestSigner = { id: "guest-signer" }
    let captured: Record<string, unknown> | undefined
    let cacheAttempts = 0

    await publishBuyerOrderMessage(
      orderRumor(),
      { signer: { id: "connected-signer" } } as never,
      "merchant-pubkey",
      {
        kind: "guest_ephemeral",
        pubkey: "guest-pubkey",
        signer: guestSigner as never,
        orderId: "guest-order",
        merchantPubkey: "merchant-pubkey",
      },
      {
        publishPrivateMessageFn: async (input) => {
          captured = input as unknown as Record<string, unknown>
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cacheAttempts += 1
          return null
        },
      }
    )

    expect(captured?.senderPubkey).toBe("guest-pubkey")
    expect(captured?.signer).toBe(guestSigner)
    expect(captured?.selfCopy).toBe(false)
    expect(cacheAttempts).toBe(0)
  })

  it("rejects guest messages outside the bound order", async () => {
    let publishAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor({
          tags: [
            ["p", "merchant-pubkey"],
            ["type", "payment_proof"],
            ["order", "other-order"],
          ],
        }),
        {} as never,
        "merchant-pubkey",
        {
          kind: "guest_ephemeral",
          pubkey: "guest-pubkey",
          signer: {} as never,
          orderId: "expected-order",
          merchantPubkey: "merchant-pubkey",
        },
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("Guest order message is outside its signer scope.")
    expect(publishAttempts).toBe(0)
  })

  it("fails before publishing when no buyer signer is available", async () => {
    let publishAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor(),
        {} as never,
        "merchant-pubkey",
        "buyer-pubkey",
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("Buyer order signer is not connected.")
    expect(publishAttempts).toBe(0)
  })
})
