import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getCachedBuyerConversationList,
  getCachedMerchantConversationList,
  getMerchantConversationList,
  type CachedOrderMessage,
  type ParsedOrderMessage,
} from "@conduit/core"

const MERCHANT_PUBKEY = "merchant"

function orderMessage(
  orderId: string,
  createdAt: number,
  options: { guest?: boolean } = {}
): ParsedOrderMessage {
  const buyerPubkey = `buyer-${orderId}`
  return {
    id: `${orderId}-order`,
    orderId,
    type: "order",
    createdAt,
    senderPubkey: buyerPubkey,
    recipientPubkey: MERCHANT_PUBKEY,
    rawContent: "",
    payload: {
      id: orderId,
      buyerPubkey,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerIdentityKind: options.guest ? "guest_ephemeral" : "signed_in",
      ...(options.guest
        ? {
            guestContact: {
              email: "guest@example.com",
              phone: "+15555550100",
            },
          }
        : {}),
      items: [
        {
          productId: `30402:${MERCHANT_PUBKEY}:coffee`,
          quantity: 1,
          priceAtPurchase: 100,
          currency: "SATS",
        },
      ],
      subtotal: 100,
      currency: "SATS",
      createdAt,
    },
  } as ParsedOrderMessage
}

function merchantStatus(
  orderId: string,
  status: string,
  createdAt: number,
  options: { id?: string; reopens?: string; authoredAt?: number } = {}
): ParsedOrderMessage {
  return {
    id: options.id ?? `${orderId}-${status}-${createdAt}`,
    orderId,
    type: "status_update",
    createdAt,
    ...(options.authoredAt !== undefined
      ? { authoredAt: options.authoredAt }
      : {}),
    senderPubkey: MERCHANT_PUBKEY,
    recipientPubkey: `buyer-${orderId}`,
    rawContent: "",
    payload: { orderId, status, reopens: options.reopens },
  } as ParsedOrderMessage
}

function paymentRequest(
  orderId: string,
  createdAt: number
): ParsedOrderMessage {
  return {
    id: `${orderId}-invoice-${createdAt}`,
    orderId,
    type: "payment_request",
    createdAt,
    senderPubkey: MERCHANT_PUBKEY,
    recipientPubkey: `buyer-${orderId}`,
    rawContent: "",
    payload: { invoice: "lnbc1fixture", amount: 100, currency: "SATS" },
  } as ParsedOrderMessage
}

function paymentReport(orderId: string, createdAt: number): ParsedOrderMessage {
  return {
    id: `${orderId}-report-${createdAt}`,
    orderId,
    type: "payment_proof",
    createdAt,
    senderPubkey: `buyer-${orderId}`,
    recipientPubkey: MERCHANT_PUBKEY,
    rawContent: "",
    payload: {
      orderId,
      rail: "lightning",
      action: "external_invoice",
      source: "external",
      amount: 100,
      currency: "SATS",
      invoice: "lnbc1fixture",
      verification: {
        state: "needs_merchant_verification",
        checks: [],
      },
    },
  } as ParsedOrderMessage
}

function shippingUpdate(
  orderId: string,
  createdAt: number
): ParsedOrderMessage {
  return {
    id: `${orderId}-shipping-${createdAt}`,
    orderId,
    type: "shipping_update",
    createdAt,
    senderPubkey: MERCHANT_PUBKEY,
    recipientPubkey: `buyer-${orderId}`,
    rawContent: "",
    payload: { orderId, carrier: "UPS", trackingNumber: "1Z" },
  } as ParsedOrderMessage
}

function conversationMessage(
  orderId: string,
  createdAt: number
): ParsedOrderMessage {
  return {
    id: `${orderId}-message-${createdAt}`,
    orderId,
    type: "message",
    createdAt,
    senderPubkey: `buyer-${orderId}`,
    recipientPubkey: MERCHANT_PUBKEY,
    rawContent: "",
    payload: { note: "Recent message" },
  } as ParsedOrderMessage
}

function cachedRow(message: ParsedOrderMessage): CachedOrderMessage {
  return {
    id: message.id,
    orderId: message.orderId,
    type: message.type,
    senderPubkey: message.senderPubkey,
    recipientPubkey: message.recipientPubkey,
    createdAt: message.createdAt,
    rawContent: JSON.stringify(message),
    cachedAt: 10_000,
  }
}

function useCachedMessages(messages: ParsedOrderMessage[]): void {
  const rows = messages.map(cachedRow)
  __setCommerceTestOverrides({
    getCachedOrderMessages: async () => rows,
  })
}

afterEach(() => {
  __resetCommerceTestOverrides()
})

describe("merchant conversation priority", () => {
  it("ranks the all-orders work queue by operational relevance", async () => {
    useCachedMessages([
      orderMessage("closed", 60),
      merchantStatus("closed", "complete", 1_000),
      orderMessage("waiting", 50),
      merchantStatus("waiting", "accepted", 600),
      paymentRequest("waiting", 650),
      orderMessage("shipped", 40),
      merchantStatus("shipped", "paid", 500),
      shippingUpdate("shipped", 700),
      orderMessage("unpaid", 30),
      orderMessage("verify-guest", 20, { guest: true }),
      paymentReport("verify-guest", 800),
      orderMessage("paid", 10),
      merchantStatus("paid", "paid", 400),
    ])

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
    })

    expect(result.data.map(({ orderId }) => orderId)).toEqual([
      "paid",
      "verify-guest",
      "unpaid",
      "shipped",
      "waiting",
      "closed",
    ])
    expect(
      result.data.find(({ orderId }) => orderId === "verify-guest")?.preview
    ).toBe("Payment reported")
    expect(result.meta.capabilities.sortModes).toContain("merchant_priority")
  })

  it("filters operational queues before sorting and preserves the aggregate unpaid queue", async () => {
    useCachedMessages([
      orderMessage("waiting", 50),
      merchantStatus("waiting", "accepted", 600),
      paymentRequest("waiting", 650),
      orderMessage("unpaid", 30),
      orderMessage("verify", 20),
      paymentReport("verify", 800),
      orderMessage("paid", 10),
      merchantStatus("paid", "paid", 400),
    ])

    const [paid, verify, unpaid, waiting] = await Promise.all([
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
        queue: "paid_fulfill",
      }),
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
        queue: "verify_payment",
      }),
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
        sort: "merchant_priority",
        queue: "unpaid_review",
      }),
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
        queue: "waiting_payment",
      }),
    ])

    expect(paid.data.map(({ orderId }) => orderId)).toEqual(["paid"])
    expect(verify.data.map(({ orderId }) => orderId)).toEqual(["verify"])
    expect(unpaid.data.map(({ orderId }) => orderId)).toEqual([
      "unpaid",
      "waiting",
    ])
    expect(waiting.data.map(({ orderId }) => orderId)).toEqual(["waiting"])
  })

  it("uses task age, order age, and order id as deterministic ties", async () => {
    useCachedMessages([
      orderMessage("paid-zeta", 20),
      merchantStatus("paid-zeta", "paid", 100),
      orderMessage("paid-beta", 10),
      merchantStatus("paid-beta", "paid", 100),
      conversationMessage("paid-beta", 2_000),
      orderMessage("paid-alpha", 10),
      merchantStatus("paid-alpha", "paid", 100),
      orderMessage("closed-older", 30),
      merchantStatus("closed-older", "complete", 900),
      orderMessage("closed-newer", 40),
      merchantStatus("closed-newer", "complete", 1_000),
    ])

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
    })

    expect(result.data.map(({ orderId }) => orderId)).toEqual([
      "paid-alpha",
      "paid-beta",
      "paid-zeta",
      "closed-newer",
      "closed-older",
    ])
  })

  it("recognizes guest self records whose inner recipient remains the buyer", async () => {
    useCachedMessages([
      orderMessage("guest-shipped", 30, { guest: true }),
      merchantStatus("guest-shipped", "paid", 300),
      shippingUpdate("guest-shipped", 400),
      orderMessage("guest-verify", 20, { guest: true }),
      paymentReport("guest-verify", 200),
      orderMessage("guest-paid", 10, { guest: true }),
      merchantStatus("guest-paid", "paid", 100),
    ])

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
    })

    expect(result.data.map(({ orderId }) => orderId)).toEqual([
      "guest-paid",
      "guest-verify",
      "guest-shipped",
    ])
  })

  it("applies the same explicit sort to live and cached list entrypoints", async () => {
    useCachedMessages([
      orderMessage("paid", 10),
      merchantStatus("paid", "paid", 100),
      orderMessage("closed", 20),
      merchantStatus("closed", "complete", 200),
    ])
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: undefined }) as never,
    })

    const query = {
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority" as const,
    }
    const [live, cached, recent, defaultSort] = await Promise.all([
      getMerchantConversationList(query),
      getCachedMerchantConversationList(query),
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
        sort: "recent_activity",
      }),
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
      }),
    ])

    expect(live.data.map(({ orderId }) => orderId)).toEqual(["paid", "closed"])
    expect(live.data.map(({ orderId }) => orderId)).toEqual(
      cached.data.map(({ orderId }) => orderId)
    )
    expect(recent.data.map(({ orderId }) => orderId)).toEqual([
      "closed",
      "paid",
    ])
    expect(defaultSort.data.map(({ orderId }) => orderId)).toEqual(
      recent.data.map(({ orderId }) => orderId)
    )
  })

  it("drops a cache row whose envelope does not match its parsed event id", async () => {
    const order = orderMessage("cache-integrity", 10)
    const paid = merchantStatus("cache-integrity", "paid", 20, {
      id: "cache-integrity-status",
    })
    const forgedDuplicate = merchantStatus("cache-integrity", "cancelled", 30, {
      id: paid.id,
    })
    const mismatchedRow = {
      ...cachedRow(forgedDuplicate),
      id: "different-cache-row-id",
    }
    __setCommerceTestOverrides({
      getCachedOrderMessages: async () => [
        cachedRow(order),
        mismatchedRow,
        cachedRow(paid),
      ],
    })

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
    })

    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.status).toBe("paid")
  })

  it("prioritizes actionable work before applying the conversation limit", async () => {
    const messages: ParsedOrderMessage[] = [
      orderMessage("old-paid", 1),
      merchantStatus("old-paid", "paid", 2),
    ]
    for (let index = 0; index < 200; index += 1) {
      const orderId = `closed-${String(index).padStart(3, "0")}`
      messages.push(
        orderMessage(orderId, 1_000 + index * 2),
        merchantStatus(orderId, "complete", 1_001 + index * 2)
      )
    }
    useCachedMessages(messages)
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: undefined }) as never,
    })

    const recent = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
    })
    const priority = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
    })
    const filteredQuery = {
      principalPubkey: MERCHANT_PUBKEY,
      sort: "recent_activity" as const,
      queue: "paid_fulfill" as const,
    }
    const [filteredLive, filteredCached] = await Promise.all([
      getMerchantConversationList(filteredQuery),
      getCachedMerchantConversationList(filteredQuery),
    ])

    expect(recent.data).toHaveLength(200)
    expect(recent.data.some(({ orderId }) => orderId === "old-paid")).toBe(
      false
    )
    expect(priority.data).toHaveLength(200)
    expect(priority.data[0]?.orderId).toBe("old-paid")
    expect(
      priority.data.filter(({ orderId }) => orderId === "old-paid")
    ).toHaveLength(1)
    expect(filteredCached.data.map(({ orderId }) => orderId)).toEqual([
      "old-paid",
    ])
    expect(filteredLive.data.map(({ orderId }) => orderId)).toEqual(
      filteredCached.data.map(({ orderId }) => orderId)
    )
  })

  it("re-ranks an explicit reopen and ignores ordinary statuses behind cancellation", async () => {
    useCachedMessages([
      orderMessage("reopened", 10),
      merchantStatus("reopened", "cancelled", 20, { id: "cancel-reopened" }),
      merchantStatus("reopened", "complete", 30),
      shippingUpdate("reopened", 35),
      merchantStatus("reopened", "pending", 40, {
        id: "reopen-reopened",
        reopens: "cancel-reopened",
      }),
      orderMessage("closed", 50),
      merchantStatus("closed", "cancelled", 60),
    ])

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
    })

    expect(result.data.map(({ orderId }) => orderId)).toEqual([
      "reopened",
      "closed",
    ])
  })

  it("starts a later task clock at the transition after reopen", async () => {
    useCachedMessages([
      orderMessage("reopened-then-paid", 10),
      merchantStatus("reopened-then-paid", "accepted", 20),
      merchantStatus("reopened-then-paid", "cancelled", 30, {
        id: "reopened-then-paid-cancel",
      }),
      merchantStatus("reopened-then-paid", "accepted", 40, {
        id: "reopened-then-paid-reopen",
        reopens: "reopened-then-paid-cancel",
      }),
      merchantStatus("reopened-then-paid", "paid", 100),
      orderMessage("paid-earlier", 11),
      merchantStatus("paid-earlier", "paid", 80),
    ])

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
      sort: "merchant_priority",
      queue: "paid_fulfill",
    })

    expect(result.data.map(({ orderId }) => orderId)).toEqual([
      "paid-earlier",
      "reopened-then-paid",
    ])
  })

  it("projects both list roles in authored replay order", async () => {
    useCachedMessages([
      orderMessage("same-second", 1_000),
      merchantStatus("same-second", "accepted", 1_000, {
        id: "accepted-before",
        authoredAt: 1_500,
      }),
      merchantStatus("same-second", "cancelled", 2_000, {
        id: "z-cancel",
        authoredAt: 2_000,
      }),
      merchantStatus("same-second", "accepted", 2_000, {
        id: "a-reopen",
        reopens: "z-cancel",
        authoredAt: 2_999,
      }),
    ])

    const [merchant, buyer] = await Promise.all([
      getCachedMerchantConversationList({
        principalPubkey: MERCHANT_PUBKEY,
      }),
      getCachedBuyerConversationList({
        principalPubkey: "buyer-same-second",
      }),
    ])

    for (const result of [merchant, buyer]) {
      expect(result.data[0]).toMatchObject({
        status: "accepted",
        latestAt: 2_999,
        latestType: "status_update",
        preview: "Status updated to accepted",
      })
      expect(result.data[0]?.messages.map(({ id }) => id)).toEqual([
        "same-second-order",
        "accepted-before",
        "z-cancel",
        "a-reopen",
      ])
    }
  })

  it("projects merchant list metadata from applied history", async () => {
    useCachedMessages([
      orderMessage("cancelled-proof", 10),
      merchantStatus("cancelled-proof", "cancelled", 20, {
        id: "cancelled-proof-cancel",
      }),
      paymentReport("cancelled-proof", 30),
    ])

    const result = await getCachedMerchantConversationList({
      principalPubkey: MERCHANT_PUBKEY,
    })

    expect(result.data[0]).toMatchObject({
      status: "cancelled",
      latestAt: 20,
      latestType: "status_update",
      preview: "Status updated to cancelled",
      totalSummary: "100 SATS",
      messageCount: 3,
    })
    expect(result.data[0]?.messages).toHaveLength(3)
  })
})
