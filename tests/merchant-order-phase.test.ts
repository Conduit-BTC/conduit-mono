import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  OrderSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import { orderItemSchema } from "@conduit/core"
import {
  getMerchantConversationCommunication,
  getMerchantConversationQueue,
  getMerchantConversationPhase,
  getMerchantConversationStatusDisplay,
  getMerchantOrderFulfillment,
  getMerchantOrderRequiresShipping,
  getMerchantOrderSummary,
  isOrderQueueTab,
  isMerchantConversationActiveFulfillment,
  sortMerchantConversations,
} from "../apps/merchant/src/lib/order-phase"

const orderId = "proof-only"
const order: ParsedOrderMessage = {
  id: `${orderId}-order`,
  orderId,
  type: "order",
  createdAt: 1,
  senderPubkey: "buyer",
  recipientPubkey: "merchant",
  rawContent: "",
  payload: {
    id: orderId,
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    items: [],
    subtotal: 100,
    currency: "SATS",
    createdAt: 1,
  },
} as ParsedOrderMessage
const proof: ParsedOrderMessage = {
  id: `${orderId}-proof`,
  orderId,
  type: "payment_proof",
  createdAt: 2,
  senderPubkey: "buyer",
  recipientPubkey: "merchant",
  rawContent: "",
  payload: {
    orderId,
    rail: "lightning",
    action: "private_checkout",
    amount: 100,
    currency: "SATS",
    invoice: "lnbc100n1proof",
    preimage: "paid-preimage",
    paymentHash: "paid-hash",
    proofDeliveryStatus: "pending",
  },
} as ParsedOrderMessage

const conversation: MerchantConversationSummary = {
  id: orderId,
  orderId,
  buyerPubkey: "buyer",
  merchantPubkey: "merchant",
  latestAt: 2,
  latestType: "payment_proof",
  status: null,
  totalSummary: "100 SATS",
  preview: "Payment proof",
  messageCount: 2,
  messages: [order, proof],
}

const organizerPubkey = "a".repeat(64)
const merchantPubkey = "b".repeat(64)
const pickupFulfillment = {
  type: "pickup" as const,
  organizerPubkey,
  product: {
    coordinate: `30402:${merchantPubkey}:coffee`,
    eventId: "1".repeat(64),
    createdAt: 10,
    merchantPubkey,
  },
  calendar: {
    coordinate: `31922:${organizerPubkey}:market-day`,
    eventId: "2".repeat(64),
    createdAt: 11,
  },
  collection: {
    coordinate: `30405:${organizerPubkey}:market-day-products`,
    eventId: "3".repeat(64),
    createdAt: 12,
  },
  option: {
    coordinate: `30406:${organizerPubkey}:market-day-pickup`,
    eventId: "4".repeat(64),
    createdAt: 13,
    title: "Market entrance pickup",
    location: "100 Public Square",
  },
  costSats: 0,
  sourceCost: {
    amount: 0,
    currency: "SATS",
    normalizedCurrency: "SATS",
  },
}

function orderItem(
  overrides: Partial<OrderSummary["items"][number]> = {}
): OrderSummary["items"][number] {
  return {
    productId: "coffee",
    format: "physical",
    fulfillment: pickupFulfillment,
    quantity: 1,
    priceAtPurchase: 100,
    currency: "SATS",
    shippingOptionId: pickupFulfillment.option.coordinate,
    shippingOptionDTag: "market-day-pickup",
    shippingCostSats: pickupFulfillment.costSats,
    sourceShippingCost: { ...pickupFulfillment.sourceCost },
    ...overrides,
  }
}

function merchantStatus(status: string, createdAt: number): ParsedOrderMessage {
  return {
    id: `${orderId}-${status}-${createdAt}`,
    orderId,
    type: "status_update",
    createdAt,
    senderPubkey: "merchant",
    recipientPubkey: "buyer",
    rawContent: "",
    payload: { orderId, status },
  } as ParsedOrderMessage
}

function sortableConversation({
  id,
  latestAt,
  taskAt = latestAt,
  status,
  paymentEvidence = false,
}: {
  id: string
  latestAt: number
  taskAt?: number
  status?: string
  paymentEvidence?: boolean
}): MerchantConversationSummary {
  const sortableOrder = {
    ...order,
    id: `${id}-order`,
    orderId: id,
    createdAt: Math.max(0, taskAt - 1),
    payload: {
      ...order.payload,
      id,
      createdAt: Math.max(0, taskAt - 1),
    },
  } as ParsedOrderMessage
  const latestMessage = paymentEvidence
    ? ({
        ...proof,
        id: `${id}-proof`,
        orderId: id,
        createdAt: taskAt,
        payload: { ...proof.payload, orderId: id },
      } as ParsedOrderMessage)
    : status
      ? ({
          ...merchantStatus(status, taskAt),
          id: `${id}-${status}`,
          orderId: id,
          payload: { orderId: id, status },
        } as ParsedOrderMessage)
      : sortableOrder
  const taskMessages =
    latestMessage === sortableOrder
      ? [sortableOrder]
      : [sortableOrder, latestMessage]
  const messages =
    latestAt > taskAt
      ? [
          ...taskMessages,
          {
            id: `${id}-note`,
            orderId: id,
            type: "message",
            createdAt: latestAt,
            senderPubkey: "merchant",
            recipientPubkey: "buyer",
            rawContent: "",
            payload: { note: "Follow-up note" },
          } as ParsedOrderMessage,
        ]
      : taskMessages
  const newestMessage = messages[messages.length - 1]!

  return {
    ...conversation,
    id,
    orderId: id,
    latestAt,
    latestType: newestMessage.type,
    status: status ?? null,
    messages,
  }
}

const externalReport = {
  ...proof,
  id: `${orderId}-external-report`,
  payload: {
    orderId,
    rail: "lightning",
    action: "external_invoice",
    amount: 100,
    currency: "SATS",
    invoice: "lnbc100n1report",
    source: "external",
    verification: {
      state: "needs_merchant_verification",
      checks: [],
    },
  },
} as ParsedOrderMessage

const shippingUpdate = {
  id: `${orderId}-shipping`,
  orderId,
  type: "shipping_update",
  createdAt: 4,
  senderPubkey: "merchant",
  recipientPubkey: "buyer",
  rawContent: "",
  payload: { orderId, carrier: "UPS", trackingNumber: "1Z" },
} as ParsedOrderMessage

describe("merchant order phase", () => {
  it("recognizes only supported order queue search values", () => {
    expect(isOrderQueueTab("all")).toBe(true)
    expect(isOrderQueueTab("unpaid_review")).toBe(true)
    expect(isOrderQueueTab("paid_fulfill")).toBe(true)
    expect(isOrderQueueTab("awaiting_payment")).toBe(false)
    expect(isOrderQueueTab(undefined)).toBe(false)
  })

  it("ranks the observed order set by merchant attention", () => {
    const ranked = sortMerchantConversations(
      [
        sortableConversation({
          id: "closed",
          latestAt: 80,
          status: "complete",
        }),
        sortableConversation({
          id: "waiting",
          latestAt: 70,
          status: "invoiced",
        }),
        sortableConversation({
          id: "follow-up",
          latestAt: 60,
          status: "processing",
        }),
        sortableConversation({ id: "new", latestAt: 50 }),
        sortableConversation({
          id: "verify",
          latestAt: 40,
          paymentEvidence: true,
        }),
        sortableConversation({
          id: "fulfill",
          latestAt: 30,
          status: "paid",
        }),
        sortableConversation({
          id: "refund",
          latestAt: 20,
          status: "refund_requested",
        }),
      ],
      "priority"
    )

    expect(ranked.map((item) => item.id)).toEqual([
      "refund",
      "fulfill",
      "verify",
      "new",
      "follow-up",
      "waiting",
      "closed",
    ])
  })

  it("keeps processing follow-up below currently paid fulfillment", () => {
    const processing = sortableConversation({
      id: "processing-after-paid",
      latestAt: 40,
      status: "processing",
    })
    const processingOrder = processing.messages?.[0]
    if (processingOrder) processingOrder.createdAt = 10
    processing.messages?.splice(1, 0, {
      ...merchantStatus("paid", 20),
      id: "processing-after-paid-paid",
      orderId: processing.orderId,
      payload: { orderId: processing.orderId, status: "paid" },
    } as ParsedOrderMessage)
    const currentlyPaid = sortableConversation({
      id: "currently-paid",
      latestAt: 30,
      status: "paid",
    })

    expect(
      sortMerchantConversations([processing, currentlyPaid], "priority").map(
        (item) => item.id
      )
    ).toEqual(["currently-paid", "processing-after-paid"])
  })

  it("uses age for active ties, recency for closed ties, and order id last", () => {
    const paidNewer = sortableConversation({
      id: "paid-newer",
      latestAt: 30,
      status: "paid",
    })
    const paidOlderB = sortableConversation({
      id: "paid-older-b",
      latestAt: 20,
      status: "paid",
    })
    const paidOlderA = sortableConversation({
      id: "paid-older-a",
      latestAt: 20,
      status: "paid",
    })
    const closedOlder = sortableConversation({
      id: "closed-older",
      latestAt: 10,
      status: "cancelled",
    })
    const closedNewer = sortableConversation({
      id: "closed-newer",
      latestAt: 40,
      status: "complete",
    })

    expect(
      sortMerchantConversations(
        [paidNewer, closedOlder, paidOlderB, closedNewer, paidOlderA],
        "priority"
      ).map((item) => item.id)
    ).toEqual([
      "paid-older-a",
      "paid-older-b",
      "paid-newer",
      "closed-newer",
      "closed-older",
    ])
    expect(
      sortMerchantConversations(
        [paidOlderA, closedOlder, paidNewer, closedNewer],
        "recent"
      ).map((item) => item.id)
    ).toEqual(["closed-newer", "paid-newer", "paid-older-a", "closed-older"])
  })

  it("keeps actionable age anchored when a later note arrives", () => {
    const olderPaidWithNewNote = sortableConversation({
      id: "older-paid",
      taskAt: 10,
      latestAt: 100,
      status: "paid",
    })
    const newerPaid = sortableConversation({
      id: "newer-paid",
      latestAt: 20,
      status: "paid",
    })

    expect(
      sortMerchantConversations(
        [newerPaid, olderPaidWithNewNote],
        "priority"
      ).map((item) => item.id)
    ).toEqual(["older-paid", "newer-paid"])
    expect(
      sortMerchantConversations(
        [newerPaid, olderPaidWithNewNote],
        "recent"
      ).map((item) => item.id)
    ).toEqual(["older-paid", "newer-paid"])
  })

  it("keeps loaded legacy orders replyable but treats orderless reads as unknown", () => {
    expect(getMerchantConversationCommunication(conversation)).toBe(
      "nostr_replyable"
    )
    expect(
      getMerchantConversationCommunication({
        ...conversation,
        messageCount: 1,
        messages: [proof],
      })
    ).toBe("unknown")
    expect(
      getMerchantConversationCommunication({
        ...conversation,
        messages: [
          {
            ...order,
            payload: {
              ...order.payload,
              buyerIdentityKind: "guest_ephemeral",
              guestContact: {
                email: "guest@example.com",
                phone: "+15555550100",
              },
            },
          } as ParsedOrderMessage,
        ],
      })
    ).toBe("guest_out_of_band")
  })

  it("uses observed buyer payment evidence consistently across list surfaces", () => {
    expect(getMerchantConversationPhase(conversation)).toBe("in_progress")
    expect(getMerchantConversationStatusDisplay(conversation)).toEqual({
      tone: "info",
      label: "Payment proof received",
    })
    expect(isMerchantConversationActiveFulfillment(conversation)).toBe(true)
  })

  it("puts buyer payment evidence in the verification queue", () => {
    expect(getMerchantConversationQueue(conversation)).toBe("verify_payment")
  })

  it("distinguishes an external payment report from strict proof evidence", () => {
    const reported = {
      ...conversation,
      messages: [order, externalReport],
      latestType: "payment_proof",
    }
    expect(getMerchantConversationStatusDisplay(reported)).toEqual({
      tone: "warning",
      label: "Payment reported — verify",
    })
    expect(getMerchantConversationQueue(reported)).toBe("verify_payment")
  })

  it("routes confirmed payment directly to fulfillment", () => {
    const paid = merchantStatus("paid", 3)
    const confirmed = {
      ...conversation,
      status: "paid",
      messages: [order, proof, paid],
      latestType: "status_update",
    }
    expect(getMerchantConversationStatusDisplay(confirmed).label).toBe("Paid")
    expect(getMerchantConversationQueue(confirmed)).toBe("paid_fulfill")
    expect(getMerchantOrderSummary(confirmed).accepted).toBe(true)
  })

  it("keeps accepted zero-cost pickup orders visible in the fulfillment queue", () => {
    const zeroCostOrder = {
      ...order,
      payload: {
        ...order.payload,
        items: [
          orderItem({
            priceAtPurchase: 0,
            shippingCostSats: 0,
          }),
        ],
        subtotal: 0,
        shippingCostSats: 0,
      },
    } as ParsedOrderMessage
    const accepted = merchantStatus("accepted", 3)
    const zeroCostPickup = {
      ...conversation,
      status: "accepted",
      messages: [zeroCostOrder, accepted],
      latestType: "status_update",
    }

    expect(getMerchantConversationQueue(zeroCostPickup)).toBe("paid_fulfill")
    expect(getMerchantConversationStatusDisplay(zeroCostPickup).label).toBe(
      "Accepted"
    )
    expect(
      getMerchantConversationQueue({
        ...zeroCostPickup,
        status: null,
        messages: [zeroCostOrder],
        latestType: "order",
      })
    ).toBe("unpaid_review")
    expect(
      getMerchantConversationQueue({
        ...zeroCostPickup,
        messages: [
          {
            ...zeroCostOrder,
            payload: {
              ...zeroCostOrder.payload,
              items: [orderItem()],
              subtotal: 100,
            },
          } as ParsedOrderMessage,
          accepted,
        ],
      })
    ).toBe("unpaid_review")
    expect(
      getMerchantConversationQueue({
        ...zeroCostPickup,
        messages: [
          {
            ...zeroCostOrder,
            payload: {
              ...zeroCostOrder.payload,
              items: [
                ...zeroCostOrder.payload.items,
                orderItem({
                  productId: "download",
                  format: "digital",
                  fulfillment: { type: "digital" },
                  priceAtPurchase: 0,
                  shippingCostSats: undefined,
                  sourceShippingCost: undefined,
                  shippingOptionId: undefined,
                  shippingOptionDTag: undefined,
                }),
              ],
            },
          } as ParsedOrderMessage,
          accepted,
        ],
      })
    ).toBe("unpaid_review")
  })

  it("skips shipment only when every merchant listing resolves as digital", () => {
    const digitalOrder = {
      ...order,
      payload: {
        ...order.payload,
        items: [
          {
            productId: "download",
            format: "digital",
            quantity: 1,
            priceAtPurchase: 100,
            currency: "SATS",
          },
        ],
      },
    } as ParsedOrderMessage
    const mixedOrder = {
      ...digitalOrder,
      payload: {
        ...digitalOrder.payload,
        items: [
          ...digitalOrder.payload.items,
          {
            productId: "shirt",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 100,
            currency: "SATS",
          },
        ],
      },
    } as ParsedOrderMessage

    const digitalItems = getMerchantOrderSummary({
      ...conversation,
      messages: [digitalOrder, proof],
    }).items
    const mixedItems = getMerchantOrderSummary({
      ...conversation,
      messages: [mixedOrder, proof],
    }).items

    expect(
      getMerchantOrderRequiresShipping(
        digitalItems,
        new Map([["download", { format: "digital" }]])
      )
    ).toBe(false)
    expect(
      getMerchantOrderRequiresShipping(
        mixedItems,
        new Map([
          ["download", { format: "digital" }],
          ["shirt", { format: "physical" }],
        ])
      )
    ).toBe(true)
    expect(
      getMerchantOrderRequiresShipping(digitalItems, new Map())
    ).toBeUndefined()
    expect(
      getMerchantOrderRequiresShipping(
        [{ productId: "changed-listing", format: "physical" }],
        new Map([["changed-listing", { format: "digital" }]])
      )
    ).toBe(true)
  })

  it("derives fulfillment from the signed order item snapshot", () => {
    expect(
      getMerchantOrderFulfillment([
        orderItem({ fulfillment: { type: "digital" }, format: "digital" }),
      ])
    ).toEqual({
      mode: "digital",
      requiresShipping: false,
      pickup: null,
      hasPickupClaim: false,
    })
    expect(
      getMerchantOrderFulfillment([
        orderItem({ fulfillment: { type: "shipping" } }),
      ])
    ).toEqual({
      mode: "shipping",
      requiresShipping: true,
      pickup: null,
      hasPickupClaim: false,
    })

    const pickup = getMerchantOrderFulfillment([orderItem()])
    expect(pickup.mode).toBe("pickup")
    expect(pickup.requiresShipping).toBe(false)
    expect(pickup.hasPickupClaim).toBe(true)
    expect(pickup.pickup).toEqual({
      organizerPubkey,
      calendar: pickupFulfillment.calendar,
      collection: pickupFulfillment.collection,
      option: pickupFulfillment.option,
    })

    const digitalItem = orderItem({
      productId: "download",
      format: "digital",
      fulfillment: { type: "digital" },
    })
    expect(getMerchantOrderFulfillment([digitalItem, orderItem()])).toEqual(
      pickup
    )
    expect(
      getMerchantOrderFulfillment([
        digitalItem,
        orderItem({ fulfillment: { type: "shipping" } }),
      ])
    ).toEqual({
      mode: "shipping",
      requiresShipping: true,
      pickup: null,
      hasPickupClaim: false,
    })
  })

  it("keeps legacy physical orders shipping-safe but restricts pickup conflicts", () => {
    expect(
      getMerchantOrderFulfillment([
        orderItem({ fulfillment: undefined, format: "physical" }),
      ])
    ).toEqual({
      mode: "unknown",
      requiresShipping: true,
      pickup: null,
      hasPickupClaim: false,
    })
    expect(
      getMerchantOrderFulfillment([
        orderItem({ fulfillment: undefined, format: "digital" }),
      ])
    ).toEqual({
      mode: "digital",
      requiresShipping: false,
      pickup: null,
      hasPickupClaim: false,
    })
    expect(
      getMerchantOrderFulfillment([
        orderItem(),
        orderItem({ fulfillment: { type: "shipping" } }),
      ])
    ).toEqual({
      mode: "unknown",
      requiresShipping: false,
      pickup: null,
      hasPickupClaim: true,
    })

    const conflictingPickup = {
      ...pickupFulfillment,
      option: {
        ...pickupFulfillment.option,
        eventId: "5".repeat(64),
      },
    }
    expect(
      getMerchantOrderFulfillment([
        orderItem(),
        orderItem({ fulfillment: conflictingPickup }),
      ])
    ).toEqual({
      mode: "unknown",
      requiresShipping: false,
      pickup: null,
      hasPickupClaim: true,
    })
  })

  it("restricts schema-accepted mixed and conflicting pickup claims", () => {
    const base = orderItem({
      productId: pickupFulfillment.product.coordinate,
    })
    const conflictingTitle = orderItem({
      productId: pickupFulfillment.product.coordinate,
      fulfillment: {
        ...pickupFulfillment,
        option: {
          ...pickupFulfillment.option,
          title: "Different pickup title",
        },
      },
    })
    const conflictingPlace = orderItem({
      productId: pickupFulfillment.product.coordinate,
      fulfillment: {
        ...pickupFulfillment,
        option: {
          ...pickupFulfillment.option,
          location: "200 Other Public Square",
        },
      },
    })
    const conflictingGraph = orderItem({
      productId: pickupFulfillment.product.coordinate,
      fulfillment: {
        ...pickupFulfillment,
        collection: {
          coordinate: `30405:${organizerPubkey}:other-products`,
          eventId: "6".repeat(64),
          createdAt: 14,
        },
      },
    })
    const shipping = orderItem({
      productId: `30402:${merchantPubkey}:shirt`,
      fulfillment: { type: "shipping" },
    })

    for (const pair of [
      [base, conflictingTitle],
      [base, conflictingPlace],
      [base, conflictingGraph],
      [base, shipping],
    ]) {
      expect(
        pair.every((item) => orderItemSchema.safeParse(item).success)
      ).toBe(true)
      expect(getMerchantOrderFulfillment(pair)).toEqual({
        mode: "unknown",
        requiresShipping: false,
        pickup: null,
        hasPickupClaim: true,
      })
    }
  })

  it("fails closed when pickup has no public place context", () => {
    const malformedPickup = {
      ...pickupFulfillment,
      option: {
        coordinate: pickupFulfillment.option.coordinate,
        eventId: pickupFulfillment.option.eventId,
        createdAt: pickupFulfillment.option.createdAt,
        title: pickupFulfillment.option.title,
      },
    }
    expect(
      getMerchantOrderFulfillment([orderItem({ fulfillment: malformedPickup })])
    ).toEqual({
      mode: "unknown",
      requiresShipping: false,
      pickup: null,
      hasPickupClaim: true,
    })
  })

  it("treats the shipment event as shipped even without a generic status", () => {
    const shipped = {
      ...conversation,
      status: "paid",
      messages: [order, proof, merchantStatus("paid", 3), shippingUpdate],
      latestType: "shipping_update",
    }
    expect(getMerchantConversationStatusDisplay(shipped).label).toBe("Shipped")
    expect(getMerchantConversationQueue(shipped)).toBe("shipped")
  })

  it("does not let a later generic status resurrect a cancelled order", () => {
    const cancelled = {
      ...conversation,
      status: "processing",
      messages: [
        order,
        merchantStatus("cancelled", 3),
        merchantStatus("processing", 4),
      ],
      latestType: "status_update",
    }
    expect(getMerchantConversationStatusDisplay(cancelled).label).toBe(
      "Cancelled"
    )
    expect(getMerchantConversationQueue(cancelled)).toBe("closed")
  })

  it("preserves the evidence gates when the partial read has no order rumor", () => {
    const partialConversation: MerchantConversationSummary = {
      ...conversation,
      messageCount: 1,
      messages: [proof],
    }

    expect(getMerchantConversationPhase(partialConversation)).toBe(
      "in_progress"
    )
    expect(getMerchantConversationStatusDisplay(partialConversation)).toEqual({
      tone: "info",
      label: "Payment proof received",
    })
    expect(getMerchantOrderSummary(partialConversation)).toMatchObject({
      paymentProofReceived: true,
      invoiceSent: false,
      accepted: false,
    })
    expect(isMerchantConversationActiveFulfillment(partialConversation)).toBe(
      true
    )
  })
})
