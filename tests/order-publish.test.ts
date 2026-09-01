import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"

import {
  disconnectNdk,
  EVENT_KINDS,
  GUEST_ORDER_LOCAL_RETENTION_MS,
  getNdk,
  getOrderRelayDeliveryStatus,
  publishPrivateMessage,
  removeSigner,
  setSigner,
  type OrderLifecycle,
  type OrderRelayDeliveryRecord,
  type SignedPublicNostrEvent,
  unwrapGiftWrap,
} from "@conduit/core"

import { createGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  DEFAULT_CHECKOUT_SHIPPING,
  readCheckoutShippingInitialization,
  reconcileCheckoutShippingSessionForOrderDelivery,
} from "../apps/market/src/lib/checkout-session"
import {
  buildOrderCompanionNotificationRumor,
  buildPaymentProofRumor,
  getDeliveryNotice,
  prepareBuyerRumor,
  publishBuyerOrderMessage,
  submitBuyerOrderMessage,
} from "../apps/market/src/lib/order-publish"

let activeSignerLease: ReturnType<typeof setSigner> | null = null

function checkoutSessionStorage(): Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe("queued guest checkout recovery", () => {
  it("retains the same-tab shipping draft until relay acceptance or bounded expiry", () => {
    const storage = checkoutSessionStorage()
    const draft = {
      ...DEFAULT_CHECKOUT_SHIPPING,
      street: "Guest recovery street",
      email: "guest-recovery@example.com",
    }
    const checkpointedAt = 1_700_000_000_000

    expect(
      reconcileCheckoutShippingSessionForOrderDelivery(
        {
          orderId: "guest-order",
          buyerIdentityKind: "guest_ephemeral",
          orderDeliveryStatus: "pending",
          value: draft,
        },
        storage,
        checkpointedAt
      )
    ).toBe("retained")
    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        checkpointedAt + 1,
        null
      )
    ).toEqual({ value: draft, hasActiveDraft: true })

    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        checkpointedAt + GUEST_ORDER_LOCAL_RETENTION_MS,
        null
      )
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })

    reconcileCheckoutShippingSessionForOrderDelivery(
      {
        orderId: "guest-order",
        buyerIdentityKind: "guest_ephemeral",
        orderDeliveryStatus: "pending",
        value: draft,
      },
      storage,
      checkpointedAt + 10
    )
    expect(
      reconcileCheckoutShippingSessionForOrderDelivery(
        {
          orderId: "guest-order",
          buyerIdentityKind: "guest_ephemeral",
          orderDeliveryStatus: "sent",
          value: draft,
        },
        storage,
        checkpointedAt + 11
      )
    ).toBe("cleared")
    expect(
      readCheckoutShippingInitialization(
        null,
        storage,
        checkpointedAt + 12,
        null
      )
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })
  })
})

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

  it("uses the selected Merchant deployment for signed-in companions", () => {
    const companion = buildOrderCompanionNotificationRumor(
      orderRumor(),
      "buyer-pubkey",
      "merchant-pubkey",
      "https://fix-293.conduit-merchant-33n.pages.dev"
    )

    expect(companion.content).toContain(
      "https://fix-293.conduit-merchant-33n.pages.dev/orders?order=guest-order"
    )
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
  afterEach(() => {
    if (activeSignerLease) {
      removeSigner(activeSignerLease)
      activeSignerLease = null
    }
    disconnectNdk()
  })

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
    expect(orderCall?.signerInteraction).toBe("external")
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
    expect(companionCall?.signerInteraction).toBe("background_external")
    expect(companionCall?.validatedOrderScope).toBeUndefined()
    expect(companionCall?.validatedGuestOrderCompanionScope).toBeUndefined()

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
      ["conduit", "order-companion", "1", "order-rumor"],
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
    expect(result).toMatchObject({
      buyerSelfCopyError: null,
      localCacheError: null,
      deliveryRoute: "declared_inbox",
    })
    expect(await result.companionNotification).toBe("sent")
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
        "Review it at: https://sell.conduit.market/orders?order=order+%2F%3F%26%3D%E2%9C%93"
    )
    expect(companion?.tags?.map((tag) => tag[0])).toEqual([
      "p",
      "subject",
      "order",
      "conduit",
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
    expect(orderCall?.signerInteraction).toBe("application_owned")
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
    expect(companionCall?.signerInteraction).toBe("application_owned")
    expect(companionCall?.validatedOrderScope).toBeUndefined()
    expect(companionCall?.validatedGuestOrderCompanionScope).toMatchObject({
      rumorId: (companionCall?.rumor as { id: string }).id,
      orderRumorId: "order-rumor",
      orderId: "guest-order",
      subject: "conduit-order-notification",
      senderPubkey: "guest-pubkey",
      recipientPubkey: "merchant-pubkey",
    })
    const companion = companionCall?.rumor as { content: string }
    expect(companion.content).toBe(
      "A new guest order was sent to you through Conduit Market.\n" +
        "This buyer does not receive Nostr replies. Review the order and follow up using the email or phone provided there.\n" +
        "Review it at: https://sell.conduit.market/orders?order=guest-order"
    )
    expect(companion.content).not.toContain("guest-private@example.com")
    expect(companion.content).not.toContain("+1-555-0100")
    expect(cacheAttempts).toBe(0)
    expect(await result.companionNotification).toBe("sent")
  })

  it("uses the real transport boundary without requiring a guest inbox", async () => {
    const wrappedRecipients: string[] = []
    const publishedKinds: number[] = []
    let guestInboxChecks = 0
    const merchantInboxRelay = "wss://merchant.inbox.conduit.market"
    const guestSigner = {
      user: async () => ({ pubkey: "guest-pubkey" }),
    }

    const result = await publishBuyerOrderMessage(
      guestOrderRumor(),
      {} as never,
      "merchant-pubkey",
      {
        kind: "guest_ephemeral",
        pubkey: "guest-pubkey",
        signer: guestSigner as never,
        orderId: "guest-order",
        merchantPubkey: "merchant-pubkey",
      },
      {
        publishPrivateMessageFn: async (input) =>
          await publishPrivateMessage({
            ...input,
            recipientInboxRelays: [merchantInboxRelay],
            inspectOwnInboxReadiness: async () => {
              guestInboxChecks += 1
              return { state: "lookup_unavailable" }
            },
            giftWrapFn: (async (rumor, recipient) => {
              publishedKinds.push(rumor.kind)
              wrappedRecipients.push(recipient.pubkey)
              return { id: `wrap-${rumor.kind}-${recipient.pubkey}` } as never
            }) as never,
            publishFn: (async (_event, options) => ({
              successfulRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
              failedRelayUrls: [],
            })) as never,
          }),
      }
    )

    expect(await result.companionNotification).toBe("sent")
    expect(publishedKinds).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])
    expect(wrappedRecipients).toEqual(["merchant-pubkey", "merchant-pubkey"])
    expect(guestInboxChecks).toBe(0)
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(result.buyerSelfCopyError).toBeNull()
    expect(result.localCacheError).toBeNull()
  })

  it("gift-wraps a guest order and PII-free companion only to the merchant", async () => {
    const merchantSigner = NDKPrivateKeySigner.generate()
    const merchant = await merchantSigner.user()
    const guestIdentity = createGuestOrderSigningIdentity(
      "guest-order",
      merchant.pubkey
    )
    const authoritativeOrder = new NDKEvent()
    authoritativeOrder.kind = EVENT_KINDS.ORDER
    authoritativeOrder.created_at = 100
    authoritativeOrder.tags = [
      ["p", merchant.pubkey],
      ["type", "order"],
      ["order", "guest-order"],
    ]
    authoritativeOrder.content = JSON.stringify({
      id: "guest-order",
      merchantPubkey: merchant.pubkey,
      buyerPubkey: guestIdentity.pubkey,
      buyerIdentityKind: "guest_ephemeral",
      items: [
        {
          productId: "private-product-id",
          quantity: 1,
          priceAtPurchase: 21_000,
          currency: "SATS",
        },
      ],
      subtotal: 21_000,
      currency: "SATS",
      guestContact: {
        email: "guest-private@example.com",
        phone: "+1-555-0100",
      },
      createdAt: 100_000,
    })

    const wraps: Array<{
      rumorKind: number
      event: NDKEvent
      recipients: string[]
    }> = []
    let guestInboxChecks = 0
    const merchantInboxRelay = "wss://merchant.inbox.conduit.market"
    const result = await publishBuyerOrderMessage(
      authoritativeOrder,
      {} as never,
      merchant.pubkey,
      guestIdentity,
      {
        publishPrivateMessageFn: async (input) =>
          await publishPrivateMessage({
            ...input,
            recipientInboxRelays: [merchantInboxRelay],
            inspectOwnInboxReadiness: async () => {
              guestInboxChecks += 1
              return { state: "lookup_unavailable" }
            },
            publishFn: (async (event, options) => {
              wraps.push({
                rumorKind: input.rumorKind,
                event,
                recipients: [...(options.recipientPubkeys ?? [])],
              })
              return {
                successfulRelayUrls: [merchantInboxRelay],
                failedRelayUrls: [],
              }
            }) as never,
          }),
      }
    )

    expect(await result.companionNotification).toBe("sent")
    expect(guestInboxChecks).toBe(0)
    expect(wraps.map((wrap) => wrap.rumorKind)).toEqual([
      EVENT_KINDS.ORDER,
      EVENT_KINDS.DIRECT_MESSAGE,
    ])
    expect(wraps.map((wrap) => wrap.recipients)).toEqual([
      [merchant.pubkey],
      [merchant.pubkey],
    ])

    const orderOutcome = await unwrapGiftWrap(wraps[0]!.event, merchantSigner)
    const companionOutcome = await unwrapGiftWrap(
      wraps[1]!.event,
      merchantSigner
    )
    expect(orderOutcome.status).toBe("ok")
    expect(companionOutcome.status).toBe("ok")
    if (orderOutcome.status !== "ok" || companionOutcome.status !== "ok") {
      throw new Error("Expected both guest order wraps to decrypt.")
    }
    expect(orderOutcome.rumor.kind).toBe(EVENT_KINDS.ORDER)
    expect(orderOutcome.rumor.content).toContain("guest-private@example.com")
    expect(companionOutcome.rumor.kind).toBe(EVENT_KINDS.DIRECT_MESSAGE)
    expect(companionOutcome.rumor.tags).toContainEqual([
      "subject",
      "conduit-order-notification",
    ])
    expect(companionOutcome.rumor.tags).toContainEqual([
      "conduit",
      "order-companion",
      "1",
      orderOutcome.rumor.id,
    ])
    for (const sensitiveValue of [
      "guest-private@example.com",
      "+1-555-0100",
      "private-product-id",
      "21000",
    ]) {
      expect(companionOutcome.rumor.content).not.toContain(sensitiveValue)
      expect(JSON.stringify(companionOutcome.rumor.tags)).not.toContain(
        sensitiveValue
      )
    }
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
    expect(await result.companionNotification).toBe(
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
    expect(await result.companionNotification).toBe(
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
    expect(await result.companionNotification).toBe("skipped_non_order")
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
    expect(await result.companionNotification).toBe("skipped_non_order")
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

  it("does not delay an accepted order while the advisory companion is stalled", async () => {
    let releaseCompanion: (() => void) | undefined
    const companionGate = new Promise<void>((resolve) => {
      releaseCompanion = resolve
    })
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
            await companionGate
          }
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

    expect(publishAttempts).toBe(2)
    let companionSettled = false
    void result.companionNotification.then(() => {
      companionSettled = true
    })
    await Promise.resolve()
    expect(companionSettled).toBe(false)

    releaseCompanion?.()
    expect(await result.companionNotification).toBe("sent")
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
      })
      expect(await result.companionNotification).toBe("failed")
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

  it("preserves connected buyer signing across an NDK transport reset", async () => {
    const buyerPubkey = "b".repeat(64)
    const signer = {
      pubkey: buyerPubkey,
      user: async () => ({ pubkey: buyerPubkey }),
    }
    let publishAttempts = 0

    activeSignerLease = setSigner(signer as never)
    const originalNdk = getNdk()
    disconnectNdk()
    const replacementNdk = getNdk()

    expect(replacementNdk).not.toBe(originalNdk)
    expect(replacementNdk.signer).toBe(signer)

    await publishBuyerOrderMessage(
      orderRumor(),
      replacementNdk,
      "merchant-pubkey",
      {
        kind: "signed_in",
        pubkey: buyerPubkey,
        signer: signer as never,
      },
      {
        publishPrivateMessageFn: async () => {
          publishAttempts += 1
          return {
            wrappedToRecipient: { id: "recipient-wrap" } as never,
            wrappedToSelf: { id: "self-wrap" } as never,
            selfCopyError: null,
          }
        },
        cacheBuyerOrderRumorFn: async () => null,
      }
    )

    expect(publishAttempts).toBe(1)
  })
})

const signedRecipientWrap: SignedPublicNostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: EVENT_KINDS.GIFT_WRAP,
  tags: [["p", "merchant-pubkey"]],
  content: "encrypted-gift-wrap",
  sig: "c".repeat(128),
}

function stagedDelivery(): OrderRelayDeliveryRecord {
  return {
    signedRecipientWrap,
    route: "declared_inbox",
    relayDelivery: [
      {
        relayUrl: "wss://merchant.inbox.conduit.market",
        source: "declared",
        status: "pending",
        attemptCount: 0,
      },
    ],
    deliveryAttemptCount: 0,
    retryCount: 0,
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 86_400_100,
  }
}

function lifecycleDraft() {
  return {
    orderId: "guest-order",
    createdAt: 100_000,
    buyerPubkey: "buyer-pubkey",
    buyerIdentityKind: "signed_in" as const,
    merchantPubkey: "merchant-pubkey",
    checkoutMode: "pay_later" as const,
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required" as const,
    shippingZoneEligibility: "not_required" as const,
    invoiceStatus: "not_requested" as const,
    paymentStatus: "not_started" as const,
    proofDeliveryStatus: "not_started" as const,
    zapReceiptStatus: "not_applicable" as const,
  }
}

function lifecycleStore() {
  let value: OrderLifecycle | undefined
  return {
    create: async (input: Record<string, unknown>) => {
      value = {
        ...input,
        phase: "pending",
        updatedAt: 100,
      } as OrderLifecycle
      return structuredClone(value)
    },
    record: async (_orderId: string, delivery: OrderRelayDeliveryRecord) => {
      if (!value) throw new Error("missing staged lifecycle")
      const orderDeliveryStatus = getOrderRelayDeliveryStatus(delivery)
      value = {
        ...value,
        orderDeliveryStatus,
        phase:
          orderDeliveryStatus === "sent" ? "in_progress" : orderDeliveryStatus,
        orderRelayDelivery: structuredClone(delivery),
      }
      return structuredClone(value)
    },
    read: () => structuredClone(value),
  }
}

describe("durable buyer order submission", () => {
  it("retires the submitted cart when the checkpoint commits before relay delivery settles", async () => {
    const store = lifecycleStore()
    const staged = stagedDelivery()
    let cartRetirementCount = 0
    let releaseRetirement!: () => void
    const retirementRelease = new Promise<void>((resolve) => {
      releaseRetirement = resolve
    })
    let markRetirementStarted!: () => void
    const retirementStarted = new Promise<void>((resolve) => {
      markRetirementStarted = resolve
    })
    let publishHasStarted = false
    let releasePublish!: () => void
    const publishRelease = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    let markPublishStarted!: () => void
    const publishStarted = new Promise<void>((resolve) => {
      markPublishStarted = resolve
    })

    const input: Parameters<typeof submitBuyerOrderMessage>[0] = {
      rumor: orderRumor(),
      ndk: { signer: { id: "connected-signer" } } as never,
      merchantPubkey: "merchant-pubkey",
      buyer: "buyer-pubkey",
      lifecycle: lifecycleDraft(),
      onLifecycleCheckpointed: async () => {
        cartRetirementCount += 1
        markRetirementStarted()
        await retirementRelease
      },
    }

    const submission = submitBuyerOrderMessage(input, {
      createOrderLifecycleFn: store.create as never,
      recordOrderRelayDeliveryUpdateFn: store.record as never,
      publishPrivateMessageFn: async (publishInput) => {
        await publishInput.onWrapped?.({
          rumorId: "order-rumor",
          wrappedToRecipient: { id: signedRecipientWrap.id } as never,
          wrappedToSelf: null,
          orderRelayDelivery: staged,
        })
        publishHasStarted = true
        markPublishStarted()
        await publishRelease
        throw new Error("interrupted first relay delivery")
      },
    })

    await retirementStarted
    expect(publishHasStarted).toBe(false)
    releaseRetirement()
    await publishStarted
    const cartRetirementCountBeforePublishSettled = cartRetirementCount
    releasePublish()
    const result = await submission

    expect(cartRetirementCountBeforePublishSettled).toBe(1)
    expect(cartRetirementCount).toBe(1)
    expect(result.orderDeliveryStatus).toBe("pending")
    expect(store.read()?.orderDeliveryStatus).toBe("pending")
  })

  it("stores the lifecycle checkpoint before the first network call", async () => {
    const store = lifecycleStore()
    const steps: string[] = []
    const staged = stagedDelivery()
    const settled: OrderRelayDeliveryRecord = {
      ...staged,
      relayDelivery: [
        {
          ...staged.relayDelivery[0]!,
          status: "acked",
          attemptCount: 1,
          acknowledgedAt: 110,
        },
      ],
      deliveryAttemptCount: 1,
      updatedAt: 110,
    }

    const result = await submitBuyerOrderMessage(
      {
        rumor: orderRumor(),
        ndk: { signer: { id: "connected-signer" } } as never,
        merchantPubkey: "merchant-pubkey",
        buyer: "buyer-pubkey",
        lifecycle: lifecycleDraft(),
        onOrderDeliveryCommitted: ({ orderDeliveryStatus }) => {
          expect(orderDeliveryStatus).toBe("sent")
          expect(store.read()?.orderDeliveryStatus).toBe("sent")
          steps.push("commit-ack")
        },
      },
      {
        createOrderLifecycleFn: async (input) => {
          steps.push("persist")
          return store.create(input)
        },
        recordOrderRelayDeliveryUpdateFn: store.record as never,
        cacheBuyerOrderRumorFn: async () => null,
        publishPrivateMessageFn: async (input) => {
          await input.onWrapped?.({
            rumorId: "order-rumor",
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            orderRelayDelivery: staged,
          })
          steps.push(
            input.rumorKind === EVENT_KINDS.ORDER
              ? "publish-order"
              : "publish-companion"
          )
          expect(store.read()?.orderRelayDelivery).toEqual(staged)
          await input.onOrderRelayDeliveryUpdated?.(settled)
          return {
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            selfCopyError: null,
            deliveryRoute: "declared_inbox" as const,
            orderRelayDelivery: settled,
          } as never
        },
      }
    )

    expect(steps).toEqual([
      "persist",
      "publish-order",
      "commit-ack",
      "publish-companion",
    ])
    expect(result.orderDeliveryStatus).toBe("sent")
    expect(store.read()?.orderDeliveryStatus).toBe("sent")
  })

  it("returns a restart-safe queued order after zero ACK", async () => {
    const store = lifecycleStore()
    const staged = stagedDelivery()
    const timedOut: OrderRelayDeliveryRecord = {
      ...staged,
      relayDelivery: [
        {
          ...staged.relayDelivery[0]!,
          status: "timed_out",
          attemptCount: 1,
          timedOutAt: 110,
        },
      ],
      deliveryAttemptCount: 1,
      nextRetryAt: 1_000,
      updatedAt: 110,
    }

    const result = await submitBuyerOrderMessage(
      {
        rumor: orderRumor(),
        ndk: { signer: { id: "connected-signer" } } as never,
        merchantPubkey: "merchant-pubkey",
        buyer: "buyer-pubkey",
        lifecycle: lifecycleDraft(),
      },
      {
        createOrderLifecycleFn: store.create as never,
        recordOrderRelayDeliveryUpdateFn: store.record as never,
        publishPrivateMessageFn: async (input) => {
          await input.onWrapped?.({
            rumorId: "order-rumor",
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            orderRelayDelivery: staged,
          })
          await input.onOrderRelayDeliveryUpdated?.(timedOut)
          throw new Error("No relay accepted the order")
        },
      }
    )

    expect(result.orderDeliveryStatus).toBe("pending")
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(await result.companionNotification).toBe("skipped_order_pending")
    expect(store.read()?.orderDeliveryStatus).toBe("pending")
    expect(store.read()?.orderRelayDelivery).toEqual(timedOut)
  })

  it("returns a durable failed order when every immutable target is terminal", async () => {
    const store = lifecycleStore()
    const staged = stagedDelivery()
    const terminal: OrderRelayDeliveryRecord = {
      ...staged,
      relayDelivery: [
        {
          ...staged.relayDelivery[0]!,
          status: "rejected",
          retryable: false,
          attemptCount: 1,
          rejectedAt: 110,
        },
      ],
      deliveryAttemptCount: 1,
      updatedAt: 110,
    }

    const result = await submitBuyerOrderMessage(
      {
        rumor: orderRumor(),
        ndk: { signer: { id: "connected-signer" } } as never,
        merchantPubkey: "merchant-pubkey",
        buyer: "buyer-pubkey",
        lifecycle: lifecycleDraft(),
      },
      {
        createOrderLifecycleFn: store.create as never,
        recordOrderRelayDeliveryUpdateFn: store.record as never,
        publishPrivateMessageFn: async (input) => {
          await input.onWrapped?.({
            rumorId: "order-rumor",
            wrappedToRecipient: { id: signedRecipientWrap.id } as never,
            wrappedToSelf: null,
            orderRelayDelivery: staged,
          })
          await input.onOrderRelayDeliveryUpdated?.(terminal)
          throw new Error("Every relay rejected the immutable order")
        },
      }
    )

    expect(result.orderDeliveryStatus).toBe("failed")
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(await result.companionNotification).toBe("skipped_order_pending")
    expect(store.read()?.orderDeliveryStatus).toBe("failed")
    expect(store.read()?.phase).toBe("failed")
  })

  it("does no network work when the pre-publish checkpoint fails", async () => {
    let networkCalls = 0
    let checkpointCallbacks = 0
    await expect(
      submitBuyerOrderMessage(
        {
          rumor: orderRumor(),
          ndk: { signer: { id: "connected-signer" } } as never,
          merchantPubkey: "merchant-pubkey",
          buyer: "buyer-pubkey",
          lifecycle: lifecycleDraft(),
          onLifecycleCheckpointed: () => {
            checkpointCallbacks += 1
          },
        },
        {
          createOrderLifecycleFn: async () => {
            throw new Error("IndexedDB unavailable")
          },
          publishPrivateMessageFn: async (input) => {
            await input.onWrapped?.({
              rumorId: "order-rumor",
              wrappedToRecipient: { id: signedRecipientWrap.id } as never,
              wrappedToSelf: null,
              orderRelayDelivery: stagedDelivery(),
            })
            networkCalls += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("IndexedDB unavailable")
    expect(networkCalls).toBe(0)
    expect(checkpointCallbacks).toBe(0)
  })

  it("rejects a guest submission mislabeled as a signed-in lifecycle", async () => {
    let publishAttempts = 0

    await expect(
      submitBuyerOrderMessage(
        {
          rumor: orderRumor(),
          ndk: { signer: undefined } as never,
          merchantPubkey: "merchant-pubkey",
          buyer: {
            kind: "guest_ephemeral",
            pubkey: "buyer-pubkey",
            signer: { id: "guest-signer" } as never,
            orderId: "guest-order",
            merchantPubkey: "merchant-pubkey",
          },
          lifecycle: lifecycleDraft(),
        },
        {
          publishPrivateMessageFn: async () => {
            publishAttempts += 1
            throw new Error("unexpected publish")
          },
        }
      )
    ).rejects.toThrow("identity does not match")
    expect(publishAttempts).toBe(0)
  })
})
