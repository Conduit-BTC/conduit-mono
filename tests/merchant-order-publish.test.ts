import { describe, expect, it, spyOn } from "bun:test"
import { NDKEvent, type NDK, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  buildMerchantOrderRumorTags,
  cachePublishedMerchantOrderMessage,
  EVENT_KINDS,
  getMerchantOrderPublishTarget,
  publishMerchantOrderMessage,
  publishPrivateMessage,
  type ParsedOrderMessage,
  type PublishPrivateMessageInput,
} from "@conduit/core"
import {
  parseAuthenticatedInboundOrderRumor,
  parseValidatedCachedOrderMessageEnvelope,
} from "@conduit/core/protocol/inbound-order-provenance"

const merchantPubkey = "merchant"
const buyerPubkey = "buyer"
const orderId = "order-id"
const compatibilityRelay = "wss://compatibility.conduit.example"

const signer = {
  user: async () => ({ pubkey: merchantPubkey }),
} as unknown as NDKSigner

function wrap(id: string): NDKEvent {
  return { id } as unknown as NDKEvent
}

function fabricatedInboundOrder(
  buyerIdentityKind: "guest_ephemeral" | "signed_in" = "guest_ephemeral"
): Extract<ParsedOrderMessage, { type: "order" }> {
  return {
    id: `inbound-${buyerIdentityKind}`,
    orderId,
    type: "order",
    createdAt: 500,
    senderPubkey: buyerPubkey,
    recipientPubkey: merchantPubkey,
    rawContent: "{}",
    payload: {
      id: orderId,
      merchantPubkey,
      buyerPubkey,
      buyerIdentityKind,
      ...(buyerIdentityKind === "guest_ephemeral"
        ? { guestContact: { email: "buyer@example.com", phone: "555-0100" } }
        : {}),
      items: [
        {
          productId: "product-id",
          format: "physical",
          quantity: 1,
          priceAtPurchase: 1,
          currency: "SATS",
        },
      ],
      subtotal: 1,
      currency: "SATS",
      createdAt: 500,
    },
  }
}

function inboundOrder(
  buyerIdentityKind: "guest_ephemeral" | "signed_in" = "guest_ephemeral"
): Extract<ParsedOrderMessage, { type: "order" }> {
  const order = fabricatedInboundOrder(buyerIdentityKind)
  return validatedInboundOrder(order)
}

function validatedInboundOrder(
  order: Extract<ParsedOrderMessage, { type: "order" }>
): Extract<ParsedOrderMessage, { type: "order" }> {
  const rumor = new NDKEvent()
  rumor.id = order.id
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = order.senderPubkey
  rumor.created_at = Math.floor(order.createdAt / 1_000)
  rumor.tags = [
    ["p", order.recipientPubkey],
    ["type", "order"],
    ["order", order.orderId],
  ]
  rumor.content = JSON.stringify(order.payload)
  const validated = parseAuthenticatedInboundOrderRumor(rumor)
  if (!validated || validated.type !== "order") {
    throw new Error("Expected an authenticated inbound order")
  }
  return validated
}

async function publishThroughTestTransport(
  input: PublishPrivateMessageInput,
  observations: {
    recipients: string[]
    rumors: NDKEvent[]
  }
) {
  return publishPrivateMessage({
    ...input,
    recipientInboxRelays: [],
    senderInboxRelays: ["wss://merchant.inbox.example"],
    compatibilityOrderRoute: {
      enabled: true,
      relayUrls: [compatibilityRelay],
    },
    resolveCompatibilityRecipientReadRelays: async () => [],
    giftWrapFn: (async (rumor, recipient) => {
      observations.rumors.push(rumor)
      observations.recipients.push(recipient.pubkey)
      return wrap(`wrap-${recipient.pubkey}`)
    }) as never,
    publishFn: (async () => ({})) as never,
  })
}

describe("publishMerchantOrderMessage", () => {
  it("publishes a guest self-only status record to the merchant while preserving the buyer p tag", async () => {
    const observations = {
      recipients: [] as string[],
      rumors: [] as NDKEvent[],
    }
    const cached: ParsedOrderMessage[] = []

    const result = await publishMerchantOrderMessage(
      {
        merchantPubkey,
        buyerPubkey,
        orderId,
        type: "status_update",
        tags: [["status", "paid"]],
        payload: { status: "paid" },
        delivery: "self_only",
        inboundOrder: inboundOrder(),
      },
      {
        getNdk: () => ({ signer }) as unknown as NDK,
        now: () => 1_000,
        publishPrivateMessage: (input) =>
          publishThroughTestTransport(input, observations),
        cacheParsedOrderMessage: async (message) => {
          cached.push(message)
        },
      }
    )

    expect(result.deliveryRoute).toBe("compatibility_order")
    expect(observations.recipients).toEqual([merchantPubkey])
    expect(observations.rumors).toHaveLength(1)
    expect(
      observations.rumors[0]?.tags.find((tag) => tag[0] === "p")?.[1]
    ).toBe(buyerPubkey)
    expect(cached).toHaveLength(1)
    expect(cached[0]).toMatchObject({
      orderId,
      type: "status_update",
      senderPubkey: merchantPubkey,
      recipientPubkey: buyerPubkey,
      payload: { status: "paid" },
    })
  })

  it("allows a signed-in inbound order to anchor self-only compatibility delivery", async () => {
    const observations = {
      recipients: [] as string[],
      rumors: [] as NDKEvent[],
    }

    await expect(
      publishMerchantOrderMessage(
        {
          merchantPubkey,
          buyerPubkey,
          orderId,
          type: "status_update",
          tags: [["status", "paid"]],
          payload: { status: "paid" },
          delivery: "self_only",
          inboundOrder: inboundOrder("signed_in"),
        },
        {
          getNdk: () => ({ signer }) as unknown as NDK,
          now: () => 1_000,
          publishPrivateMessage: (input) =>
            publishThroughTestTransport(input, observations),
          cacheParsedOrderMessage: async () => {},
        }
      )
    ).resolves.toMatchObject({ deliveryRoute: "compatibility_order" })
    expect(observations.recipients).toEqual([merchantPubkey])
  })

  it("rejects self-only delivery without a matching inbound order before transport", async () => {
    let transported = false
    const dependencies = {
      getNdk: () => ({ signer }) as unknown as NDK,
      now: () => 1_000,
      publishPrivateMessage: async () => {
        transported = true
        throw new Error("unexpected transport")
      },
      cacheParsedOrderMessage: async () => {},
    }

    await expect(
      publishMerchantOrderMessage(
        {
          merchantPubkey,
          buyerPubkey,
          orderId,
          type: "status_update",
          payload: { status: "paid" },
          delivery: "self_only",
        },
        dependencies
      )
    ).rejects.toThrow("without an inbound order")
    await expect(
      publishMerchantOrderMessage(
        {
          merchantPubkey,
          buyerPubkey,
          orderId: "other-order",
          type: "status_update",
          payload: { status: "paid" },
          delivery: "self_only",
          inboundOrder: inboundOrder(),
        },
        dependencies
      )
    ).rejects.toThrow("without a validated inbound order")
    await expect(
      publishMerchantOrderMessage(
        {
          merchantPubkey,
          buyerPubkey,
          orderId,
          type: "status_update",
          payload: { status: "paid" },
          delivery: "self_only",
          inboundOrder: fabricatedInboundOrder(),
        },
        dependencies
      )
    ).rejects.toThrow("without a validated inbound order")
    const fabricated = fabricatedInboundOrder()
    const envelopeConsistentCached = parseValidatedCachedOrderMessageEnvelope({
      id: fabricated.id,
      orderId: fabricated.orderId,
      type: fabricated.type,
      senderPubkey: fabricated.senderPubkey,
      recipientPubkey: fabricated.recipientPubkey,
      createdAt: fabricated.createdAt,
      rawContent: JSON.stringify(fabricated),
      cachedAt: fabricated.createdAt,
    })
    if (
      !envelopeConsistentCached ||
      envelopeConsistentCached.type !== "order"
    ) {
      throw new Error("Expected a displayable cached order")
    }
    await expect(
      publishMerchantOrderMessage(
        {
          merchantPubkey,
          buyerPubkey,
          orderId,
          type: "status_update",
          payload: { status: "paid" },
          delivery: "self_only",
          inboundOrder: envelopeConsistentCached,
        },
        dependencies
      )
    ).rejects.toThrow("without a validated inbound order")
    expect(transported).toBe(false)
  })

  it("keeps signed-in buyer delivery on the normal recipient scope and adds a merchant self-copy", async () => {
    const observations = {
      recipients: [] as string[],
      rumors: [] as NDKEvent[],
    }

    const result = await publishMerchantOrderMessage(
      {
        merchantPubkey,
        buyerPubkey,
        orderId,
        type: "status_update",
        tags: [["status", "paid"]],
        payload: { status: "paid" },
        delivery: "buyer_and_self",
      },
      {
        getNdk: () => ({ signer }) as unknown as NDK,
        now: () => 1_000,
        publishPrivateMessage: (input) =>
          publishThroughTestTransport(input, observations),
        cacheParsedOrderMessage: async () => {},
      }
    )

    expect(result.deliveryRoute).toBe("compatibility_order")
    expect(observations.recipients).toEqual([buyerPubkey, merchantPubkey])
    expect(
      observations.rumors[0]?.tags.find((tag) => tag[0] === "p")?.[1]
    ).toBe(buyerPubkey)
  })
})

describe("merchant order publish", () => {
  it("targets the merchant for a guest-only operational record", () => {
    const rumor = new NDKEvent()
    rumor.id = "guest-status-rumor"
    rumor.kind = EVENT_KINDS.ORDER
    rumor.pubkey = "merchant"
    rumor.tags = buildMerchantOrderRumorTags({
      buyerPubkey: "guest",
      orderId: "guest-order",
      type: "status_update",
      tags: [["status", "paid"]],
    })
    rumor.content = JSON.stringify({
      orderId: "guest-order",
      merchantPubkey: "merchant",
      buyerPubkey: "guest",
      status: "paid",
    })

    const target = getMerchantOrderPublishTarget(
      {
        merchantPubkey: "merchant",
        buyerPubkey: "guest",
        orderId: "guest-order",
        delivery: "self_only",
        inboundOrder: validatedInboundOrder({
          ...fabricatedInboundOrder(),
          id: "guest-order-rumor",
          orderId: "guest-order",
          senderPubkey: "guest",
          recipientPubkey: "merchant",
          payload: {
            ...fabricatedInboundOrder().payload,
            id: "guest-order",
            buyerPubkey: "guest",
            merchantPubkey: "merchant",
          },
        }),
      },
      rumor
    )

    expect(rumor.tags).toContainEqual(["p", "guest"])
    expect(target.recipientPubkey).toBe("merchant")
    expect(target.selfCopy).toBe(false)
  })

  it("does not turn a post-delivery cache failure into a publish retry", async () => {
    const message = {} as ParsedOrderMessage
    const warning = spyOn(console, "warn").mockImplementation(() => {})

    expect(
      await cachePublishedMerchantOrderMessage(message, async () => {})
    ).toBe(true)
    expect(
      await cachePublishedMerchantOrderMessage(message, async () => {
        throw new Error("storage unavailable")
      })
    ).toBe(false)
    expect(warning).toHaveBeenCalledTimes(1)
    warning.mockRestore()
  })
})
