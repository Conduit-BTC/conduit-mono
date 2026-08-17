import { describe, expect, it } from "bun:test"

import { EVENT_KINDS } from "@conduit/core"

import {
  buildOrderCompanionNotificationRumor,
  buildPaymentProofRumor,
  getDeliveryNotice,
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

  it("recreates the same companion rumor id from the authoritative order", () => {
    const authoritativeOrder = orderRumor({
      tags: [
        ["p", "merchant-pubkey"],
        ["type", "order"],
        ["order", "order /?#% ünicode"],
        [
          "client",
          "Conduit Market",
          "31990:market-pubkey:conduit-market",
          "wss://relay.conduit.market",
        ],
      ],
    })
    const first = buildOrderCompanionNotificationRumor(
      authoritativeOrder,
      "buyer-pubkey",
      "merchant-pubkey"
    )
    const retry = buildOrderCompanionNotificationRumor(
      authoritativeOrder,
      "buyer-pubkey",
      "merchant-pubkey"
    )

    expect(first.created_at).toBe(authoritativeOrder.created_at)
    expect(retry.id).toBe(first.id)
  })
})

function orderRumor(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-rumor",
    kind: EVENT_KINDS.ORDER,
    pubkey: "",
    created_at: 100,
    content: JSON.stringify({
      id: "guest-order",
      merchantPubkey: "merchant-pubkey",
      buyerPubkey: "buyer-pubkey",
      items: [
        {
          productId: "product-id",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      createdAt: 100_000,
    }),
    tags: [
      ["p", "merchant-pubkey"],
      ["type", "order"],
      ["order", "guest-order"],
      [
        "client",
        "Conduit Market",
        "31990:market-pubkey:conduit-market",
        "wss://relay.conduit.market",
      ],
    ],
    ...overrides,
  } as never
}

function guestOrderRumor(overrides: Record<string, unknown> = {}) {
  return orderRumor({
    content: JSON.stringify({
      id: "guest-order",
      merchantPubkey: "merchant-pubkey",
      buyerPubkey: "guest-pubkey",
      buyerIdentityKind: "guest_ephemeral",
      items: [
        {
          productId: "guest-product-id",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      guestContact: {
        email: "guest-private@example.com",
        phone: "+1-555-0100",
      },
      createdAt: 100_000,
    }),
    ...overrides,
  })
}

describe("buyer order publishing", () => {
  it("publishes a recipient-only kind-14 companion after signed-in order delivery", async () => {
    const signer = { id: "connected-signer" }
    const calls: Array<Record<string, unknown>> = []
    let cached = false
    let authoritativeOrderSucceeded = false
    let releaseAuthoritativeOrder = () => {}
    const authoritativeOrderAck = new Promise<void>((resolve) => {
      releaseAuthoritativeOrder = resolve
    })
    const authoritativeOrder = orderRumor()
    const authoritativeContent = authoritativeOrder.content
    const authoritativeTags = structuredClone(authoritativeOrder.tags)

    const publishing = publishBuyerOrderMessage(
      authoritativeOrder,
      { signer } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async (input) => {
          calls.push(input as unknown as Record<string, unknown>)
          if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
            expect(authoritativeOrderSucceeded).toBe(true)
          } else {
            await authoritativeOrderAck
            authoritativeOrderSucceeded = true
          }
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf:
              input.rumorKind === EVENT_KINDS.ORDER
                ? ({ id: "self-wrap" } as never)
                : null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cached = true
          return null
        },
      }
    )

    await Promise.resolve()
    expect(calls.map((call) => call.rumorKind)).toEqual([EVENT_KINDS.ORDER])
    releaseAuthoritativeOrder()
    const result = await publishing

    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.rumorKind)).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])

    const orderCall = calls[0]
    expect(orderCall?.senderPubkey).toBe("buyer-pubkey")
    expect(orderCall?.recipientPubkey).toBe("merchant-pubkey")
    expect(orderCall?.signer).toBe(signer)
    expect(orderCall?.selfCopy).toBe(true)
    expect(orderCall?.validatedOrderScope).toMatchObject({
      rumorId: "order-rumor",
      orderId: "guest-order",
      senderPubkey: "buyer-pubkey",
      recipientPubkey: "merchant-pubkey",
    })

    const companionCall = calls[1]
    expect(companionCall?.senderPubkey).toBe("buyer-pubkey")
    expect(companionCall?.recipientPubkey).toBe("merchant-pubkey")
    expect(companionCall?.signer).toBe(signer)
    expect(companionCall?.selfCopy).toBe(false)
    expect(companionCall?.validatedOrderScope).toBeUndefined()

    const companion = companionCall?.rumor as {
      kind: number
      pubkey: string
      created_at: number
      content: string
      tags: string[][]
    }
    expect(companion.kind).toBe(EVENT_KINDS.DIRECT_MESSAGE)
    expect(companion.pubkey).toBe("buyer-pubkey")
    expect(companion.created_at).toBe(100)
    expect(companion.tags).toEqual([
      ["p", "merchant-pubkey"],
      ["subject", "conduit-order-notification"],
      ["order", "guest-order"],
      [
        "client",
        "Conduit Market",
        "31990:market-pubkey:conduit-market",
        "wss://relay.conduit.market",
      ],
    ])
    expect(companion.content).toBe(
      "A new order was sent to you through Conduit Market.\n" +
        "Review it at: https://sell.conduit.market/orders?order=guest-order"
    )
    expect(companion.content).not.toContain("[")
    expect(companion.content).not.toContain("](")
    expect(authoritativeOrder.kind).toBe(EVENT_KINDS.ORDER)
    expect(authoritativeOrder.content).toBe(authoritativeContent)
    expect(authoritativeOrder.tags).toEqual(authoritativeTags)
    expect(cached).toBe(true)
    expect(result).toEqual({
      buyerSelfCopyError: null,
      localCacheError: null,
      deliveryRoute: "declared_inbox",
      companionNotificationStatus: "sent",
    })
  })

  it("URL-encodes the order id and excludes sensitive order payload fields", async () => {
    const orderId = "order /?&=✓"
    const calls: Array<{ rumor: { content?: string; tags?: string[][] } }> = []
    const sensitiveRumor = orderRumor({
      content: JSON.stringify({
        id: orderId,
        merchantPubkey: "merchant-pubkey",
        buyerPubkey: "buyer-pubkey",
        items: [
          {
            productId: "sensitive-product-id",
            title: "Sensitive Product",
            quantity: 1,
            priceAtPurchase: 21_000,
            currency: "SATS",
          },
        ],
        subtotal: 21_000,
        currency: "SATS",
        shippingAddress: {
          name: "Private Buyer",
          street: "123 Private Street",
          city: "Private City",
          postalCode: "12345",
          country: "US",
        },
        note: "private@example.com lnbc-sensitive",
        createdAt: 100_000,
      }),
      tags: [
        ["p", "merchant-pubkey"],
        ["type", "order"],
        ["order", orderId],
        ["amount", "21000"],
        ["item", "sensitive-product-id", "1"],
        [
          "client",
          "Conduit Market",
          "31990:market-pubkey:conduit-market",
          "wss://relay.conduit.market",
        ],
      ],
    })

    await publishBuyerOrderMessage(
      sensitiveRumor,
      { signer: { id: "connected-signer" } } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async (input) => {
          calls.push(input as never)
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    const companion = calls[1]?.rumor
    expect(companion?.content).toBe(
      "A new order was sent to you through Conduit Market.\n" +
        `Review it at: https://sell.conduit.market/orders?order=${encodeURIComponent(orderId)}`
    )
    expect(companion?.tags?.map((tag) => tag[0])).toEqual([
      "p",
      "subject",
      "order",
      "client",
    ])
    for (const sensitiveValue of [
      "Sensitive Product",
      "21000",
      "123 Private Street",
      "private@example.com",
      "lnbc-sensitive",
      "sensitive-product-id",
    ]) {
      expect(companion?.content).not.toContain(sensitiveValue)
      expect(JSON.stringify(companion?.tags)).not.toContain(sensitiveValue)
    }
  })

  it("publishes a one-way guest companion without contact data, self-copy, or durable cache", async () => {
    const guestSigner = { id: "guest-signer" }
    const calls: Array<Record<string, unknown>> = []
    let cacheAttempts = 0

    const result = await publishBuyerOrderMessage(
      guestOrderRumor(),
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
          calls.push(input as unknown as Record<string, unknown>)
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => {
          cacheAttempts += 1
          return null
        },
      }
    )

    expect(calls.map((call) => call.rumorKind)).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])
    const orderCall = calls[0]
    expect(orderCall?.senderPubkey).toBe("guest-pubkey")
    expect(orderCall?.signer).toBe(guestSigner)
    expect(orderCall?.selfCopy).toBe(false)
    expect(orderCall?.validatedOrderScope).toMatchObject({
      rumorId: "order-rumor",
      orderId: "guest-order",
      senderPubkey: "guest-pubkey",
      recipientPubkey: "merchant-pubkey",
    })

    const companionCall = calls[1]
    expect(companionCall?.senderPubkey).toBe("guest-pubkey")
    expect(companionCall?.recipientPubkey).toBe("merchant-pubkey")
    expect(companionCall?.signer).toBe(guestSigner)
    expect(companionCall?.selfCopy).toBe(false)
    expect(companionCall?.validatedOrderScope).toBeUndefined()
    const companion = companionCall?.rumor as { content: string }
    expect(companion.content).toBe(
      "A new guest order was sent to you through Conduit Market.\n" +
        "This buyer does not receive Nostr replies. Review the order and follow up using the email or phone provided there.\n" +
        "Review it at: https://sell.conduit.market/orders?order=guest-order"
    )
    expect(companion.content).not.toContain("guest-private@example.com")
    expect(companion.content).not.toContain("+1-555-0100")
    expect(cacheAttempts).toBe(0)
    expect(result.companionNotificationStatus).toBe("sent")
  })

  it("does not route a guest companion through compatibility order relays", async () => {
    const guestSigner = { id: "guest-signer" }
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      guestOrderRumor(),
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
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "compatibility_order" as const,
          }
        },
      }
    )

    expect(publishAttempts).toBe(1)
    expect(result.companionNotificationStatus).toBe(
      "skipped_non_declared_route"
    )
  })

  it("skips the companion when the authoritative order used compatibility routing", async () => {
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      orderRumor(),
      { signer: { id: "connected-signer" } } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "compatibility_order" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
    expect(result.deliveryRoute).toBe("compatibility_order")
    expect(result.companionNotificationStatus).toBe(
      "skipped_non_declared_route"
    )
  })

  it("does not publish a companion for payment proofs", async () => {
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      orderRumor({
        tags: [
          ["p", "merchant-pubkey"],
          ["type", "payment_proof"],
          ["order", "guest-order"],
        ],
      }),
      { signer: { id: "connected-signer" } } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
    expect(result.companionNotificationStatus).toBe("skipped_non_order")
  })

  it("does not publish a companion for order-thread replies", async () => {
    let publishAttempts = 0
    const result = await publishBuyerOrderMessage(
      orderRumor({
        content: JSON.stringify({
          note: "Order reply",
          orderId: "guest-order",
          merchantPubkey: "merchant-pubkey",
          buyerPubkey: "buyer-pubkey",
          createdAt: 100_000,
        }),
        tags: [
          ["p", "merchant-pubkey"],
          ["type", "message"],
          ["order", "guest-order"],
        ],
      }),
      { signer: { id: "connected-signer" } } as never,
      "merchant-pubkey",
      "buyer-pubkey",
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
    expect(result.companionNotificationStatus).toBe("skipped_non_order")
  })

  it("does not attempt the companion after authoritative order failure", async () => {
    let publishAttempts = 0
    let cacheAttempts = 0
    await expect(
      publishBuyerOrderMessage(
        orderRumor(),
        { signer: { id: "connected-signer" } } as never,
        "merchant-pubkey",
        "buyer-pubkey",
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("Recipient delivery completed without a relay ACK.")
          },
          cacheBuyerOrderRumorFn: async () => {
            cacheAttempts += 1
            return null
          },
        }
      )
    ).rejects.toThrow("Recipient delivery completed without a relay ACK.")
    expect(publishAttempts).toBe(1)
    expect(cacheAttempts).toBe(0)
  })

  for (const failure of [
    "Signer rejected companion operation",
    "Recipient has not declared NIP-17 inbox relays.",
    "Recipient delivery completed without a relay ACK.",
  ]) {
    it(`keeps successful order delivery after advisory failure: ${failure}`, async () => {
      const orderRelayDelivery = { wrappedEventId: "recipient-wrap" }
      let publishAttempts = 0
      const result = await publishBuyerOrderMessage(
        orderRumor(),
        { signer: { id: "connected-signer" } } as never,
        "merchant-pubkey",
        "buyer-pubkey",
        {
          publishPrivateMessageFn: async (input) => {
            publishAttempts += 1
            if (input.rumorKind === EVENT_KINDS.DIRECT_MESSAGE) {
              throw new Error(failure)
            }
            return {
              wrappedToRecipient: { id: "recipient-wrap" } as never,
              wrappedToSelf: null,
              selfCopyError: null,
              deliveryRoute: "declared_inbox" as const,
              orderRelayDelivery: orderRelayDelivery as never,
            }
          },
          cacheBuyerOrderRumorFn: async () => null,
        }
      )

      expect(publishAttempts).toBe(2)
      expect(result).toMatchObject({
        buyerSelfCopyError: null,
        localCacheError: null,
        deliveryRoute: "declared_inbox",
        orderRelayDelivery,
        companionNotificationStatus: "failed",
      })
      expect(getDeliveryNotice(result, "Order")).toBeNull()
    })
  }

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
