import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import {
  getEffectiveMerchantOrderStatus,
  getMerchantOrderActions,
  getMerchantOrderReopenTransition,
} from "@conduit/core"
import {
  getMerchantConversationCommunication,
  getMerchantConversationQueue,
  getMerchantConversationPhase,
  getMerchantConversationStatusDisplay,
  getMerchantConversationState,
  getMerchantOrderRequiresShipping,
  getMerchantOrderSummary,
  isOrderQueueTab,
  isMerchantConversationActiveFulfillment,
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

function merchantStatus(
  status: string,
  createdAt: number,
  options: {
    id?: string
    reopens?: string
    senderPubkey?: string
    recipientPubkey?: string
  } = {}
): ParsedOrderMessage {
  return {
    id: options.id ?? `${orderId}-${status}-${createdAt}`,
    orderId,
    type: "status_update",
    createdAt,
    senderPubkey: options.senderPubkey ?? "merchant",
    recipientPubkey: options.recipientPubkey ?? "buyer",
    rawContent: "",
    payload: { orderId, status, reopens: options.reopens },
  } as ParsedOrderMessage
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

  it("reopens only through a correction referencing the effective cancellation", () => {
    const cancelledEvent = merchantStatus("cancelled", 4, {
      id: "cancel-event",
    })
    const corrected = {
      ...conversation,
      status: "accepted",
      messages: [
        order,
        proof,
        merchantStatus("paid", 3),
        cancelledEvent,
        merchantStatus("processing", 5),
        merchantStatus("paid", 6, {
          id: "reopen-event",
          reopens: "cancel-event",
        }),
      ],
      latestAt: 6,
      latestType: "status_update" as const,
    }

    const state = getMerchantConversationState(corrected)
    expect(state).toMatchObject({
      status: "paid",
      paid: true,
      paymentObserved: true,
    })
    expect(state.cancellation).toBeUndefined()
    expect(getMerchantConversationQueue(corrected)).toBe("paid_fulfill")
    expect(getMerchantConversationStatusDisplay(corrected).label).toBe("Paid")
    expect(
      getMerchantOrderActions(state).map((action) => action.action)
    ).toEqual(["cancel", "record_shipment"])
  })

  it("exposes the exact cancellation correction while the order is closed", () => {
    const cancelled = {
      ...conversation,
      status: "processing",
      messages: [
        order,
        proof,
        merchantStatus("paid", 3),
        merchantStatus("cancelled", 4, { id: "cancel-paid" }),
        merchantStatus("processing", 5),
      ],
      latestAt: 5,
      latestType: "status_update" as const,
    }

    const state = getMerchantConversationState(cancelled)
    expect(state).toMatchObject({
      status: "cancelled",
      paid: true,
      cancellation: { eventId: "cancel-paid", resumeStatus: "paid" },
    })
    expect(getMerchantOrderReopenTransition(state)).toEqual({
      cancellationEventId: "cancel-paid",
      status: "paid",
      tags: [
        ["status", "paid"],
        ["reopens", "cancel-paid"],
      ],
      payload: { status: "paid", reopens: "cancel-paid" },
    })
  })

  it("handles repeated cancel-reopen cycles without honoring stale markers", () => {
    const cycled = {
      ...conversation,
      status: "accepted",
      messages: [
        order,
        merchantStatus("accepted", 2),
        merchantStatus("cancelled", 3, { id: "cancel-1" }),
        merchantStatus("accepted", 4, { reopens: "cancel-1" }),
        merchantStatus("processing", 5),
        merchantStatus("cancelled", 6, { id: "cancel-2" }),
        merchantStatus("processing", 7),
        merchantStatus("accepted", 8, { reopens: "cancel-1" }),
        merchantStatus("processing", 9, { reopens: "cancel-2" }),
      ],
      latestAt: 9,
      latestType: "status_update" as const,
    }

    expect(getMerchantConversationState(cycled)).toMatchObject({
      status: "processing",
      cancellation: undefined,
    })
  })

  it("never reopens complete, delivered, or refund-requested histories", () => {
    for (const terminal of ["complete", "delivered", "refund_requested"]) {
      const closed = {
        ...conversation,
        status: "accepted",
        messages: [
          order,
          merchantStatus("accepted", 2),
          merchantStatus(terminal, 3, { id: `${terminal}-event` }),
          merchantStatus("cancelled", 4, { id: "later-cancel" }),
          merchantStatus("accepted", 5, { reopens: "later-cancel" }),
        ],
      }
      const state = getMerchantConversationState(closed)
      expect(state.status).toBe(terminal)
      expect(state.cancellation).toBeUndefined()
      expect(getMerchantOrderActions(state)).toEqual([])
    }
  })

  it("orders equal-time references before corrections and deduplicates events", () => {
    const cancellation = merchantStatus("cancelled", 3, {
      id: "z-cancellation",
    })
    const correction = merchantStatus("accepted", 3, {
      id: "a-correction",
      reopens: "z-cancellation",
    })
    const duplicate = { ...cancellation }
    const participants = { buyerPubkey: "buyer", merchantPubkey: "merchant" }

    const forward = getEffectiveMerchantOrderStatus(
      [
        order,
        merchantStatus("accepted", 2),
        correction,
        cancellation,
        duplicate,
      ],
      participants
    )
    const reverse = getEffectiveMerchantOrderStatus(
      [
        duplicate,
        cancellation,
        correction,
        merchantStatus("accepted", 2),
        order,
      ],
      participants
    )
    expect(forward).toEqual({
      status: "accepted",
      appliedStatusEventIds: [
        `${orderId}-accepted-2`,
        "z-cancellation",
        "a-correction",
      ],
    })
    expect(reverse).toEqual(forward)
  })

  it("keeps same-second work after reopen while rejecting work inside its barrier", () => {
    const staleShipping = {
      ...shippingUpdate,
      id: "zz-stale-shipping",
      createdAt: 3_000,
      authoredAt: 3_200,
      payload: { orderId, carrier: "STALE", trackingNumber: "STALE" },
    } as ParsedOrderMessage
    const liveShipping = {
      ...shippingUpdate,
      id: "0-live-shipping",
      createdAt: 3_000,
      authoredAt: 3_900,
      payload: { orderId, carrier: "LIVE", trackingNumber: "LIVE" },
    } as ParsedOrderMessage
    const livePaid = {
      ...merchantStatus("paid", 3_000, { id: "0-live-paid" }),
      authoredAt: 3_800,
    }
    const reopen = {
      ...merchantStatus("accepted", 3_000, {
        id: "a-reopen",
        reopens: "z-cancel",
      }),
      authoredAt: 3_700,
    }
    const stalePaid = {
      ...merchantStatus("paid", 3_000, { id: "zz-stale-paid" }),
      authoredAt: 3_300,
    }
    const cancellation = {
      ...merchantStatus("cancelled", 3_000, { id: "z-cancel" }),
      authoredAt: 3_100,
    }
    const messages = [
      liveShipping,
      livePaid,
      staleShipping,
      reopen,
      stalePaid,
      cancellation,
      merchantStatus("accepted", 2_000, { id: "accepted-before" }),
      order,
    ]
    const sameSecond = {
      ...conversation,
      status: "paid",
      latestAt: 3_000,
      latestType: "shipping_update" as const,
      messages,
    }

    const participants = { buyerPubkey: "buyer", merchantPubkey: "merchant" }
    const effective = getEffectiveMerchantOrderStatus(messages, participants)
    expect(effective).toEqual({
      status: "paid",
      appliedStatusEventIds: [
        "accepted-before",
        "z-cancel",
        "a-reopen",
        "0-live-paid",
      ],
    })
    expect(
      getEffectiveMerchantOrderStatus([...messages].reverse(), participants)
    ).toEqual(effective)
    expect(getMerchantConversationState(sameSecond)).toMatchObject({
      status: "paid",
      paid: true,
      shippingUpdated: true,
    })
    expect(getMerchantOrderSummary(sameSecond)).toMatchObject({
      trackingCarrier: "LIVE",
      trackingNumber: "LIVE",
    })
  })

  it("ignores correction markers from the buyer or a different recipient", () => {
    const cancelled = merchantStatus("cancelled", 3, { id: "cancel-event" })
    const messages = [
      order,
      merchantStatus("accepted", 2),
      cancelled,
      merchantStatus("accepted", 4, {
        reopens: "cancel-event",
        senderPubkey: "buyer",
        recipientPubkey: "merchant",
      }),
      merchantStatus("accepted", 5, {
        reopens: "cancel-event",
        recipientPubkey: "someone-else",
      }),
    ]

    expect(
      getEffectiveMerchantOrderStatus(messages, {
        buyerPubkey: "buyer",
        merchantPubkey: "merchant",
      })
    ).toEqual({
      status: "cancelled",
      appliedStatusEventIds: [`${orderId}-accepted-2`, "cancel-event"],
      cancellation: { eventId: "cancel-event", resumeStatus: "accepted" },
    })
  })

  it("does not turn an unpaid reopen into paid from a status inside the barrier", () => {
    const reopened = {
      ...conversation,
      status: "pending",
      messages: [
        order,
        merchantStatus("cancelled", 2, { id: "cancel-pending" }),
        merchantStatus("paid", 3, { id: "ignored-paid" }),
        merchantStatus("pending", 4, {
          id: "reopen-pending",
          reopens: "cancel-pending",
        }),
      ],
      latestAt: 4,
      latestType: "status_update" as const,
    }

    const state = getMerchantConversationState(reopened)
    expect(state).toMatchObject({
      status: "pending",
      paid: false,
      accepted: false,
    })
    expect(getMerchantConversationQueue(reopened)).toBe("unpaid_review")
    expect(
      getEffectiveMerchantOrderStatus(reopened.messages, {
        buyerPubkey: "buyer",
        merchantPubkey: "merchant",
      }).appliedStatusEventIds
    ).toEqual(["cancel-pending", "reopen-pending"])
  })

  it("ignores buyer payment evidence recorded inside cancellation", () => {
    const cancelledProof = {
      ...proof,
      id: "proof-inside-cancellation",
      createdAt: 3,
    } as ParsedOrderMessage
    const cancelledReport = {
      ...externalReport,
      id: "report-inside-cancellation",
      createdAt: 3,
    } as ParsedOrderMessage
    const reopened = {
      ...conversation,
      status: "pending",
      messages: [
        order,
        merchantStatus("cancelled", 2, { id: "cancel-pending" }),
        cancelledProof,
        cancelledReport,
        merchantStatus("pending", 4, {
          id: "reopen-pending",
          reopens: "cancel-pending",
        }),
      ],
      latestAt: 4,
      latestType: "status_update" as const,
    }

    expect(getMerchantConversationState(reopened)).toMatchObject({
      status: "pending",
      paymentObserved: false,
      paymentReported: false,
    })
    expect(getMerchantOrderSummary(reopened)).toMatchObject({
      paymentProofReceived: false,
      paymentReportReceived: false,
      externalPaymentReportReceived: false,
    })
    expect(getMerchantConversationQueue(reopened)).toBe("unpaid_review")
  })

  it("preserves payment confirmed before cancellation across a reopen", () => {
    const reopened = {
      ...conversation,
      status: "paid",
      messages: [
        order,
        merchantStatus("paid", 2, { id: "paid-before-cancel" }),
        merchantStatus("cancelled", 3, { id: "cancel-paid" }),
        merchantStatus("processing", 4, { id: "ignored-processing" }),
        merchantStatus("paid", 5, {
          id: "reopen-paid",
          reopens: "cancel-paid",
        }),
      ],
      latestAt: 5,
      latestType: "status_update" as const,
    }

    const state = getMerchantConversationState(reopened)
    expect(state).toMatchObject({ status: "paid", paid: true, accepted: true })
    expect(getMerchantConversationQueue(reopened)).toBe("paid_fulfill")
    expect(
      getEffectiveMerchantOrderStatus(reopened.messages, {
        buyerPubkey: "buyer",
        merchantPubkey: "merchant",
      }).appliedStatusEventIds
    ).toEqual(["paid-before-cancel", "cancel-paid", "reopen-paid"])
  })

  it("ignores stale fulfillment events inside cancellation while preserving earlier shipping", () => {
    const staleShipping = {
      ...shippingUpdate,
      id: "stale-shipping",
      createdAt: 3,
    }
    const reopenedPending = {
      ...conversation,
      messages: [
        order,
        merchantStatus("cancelled", 2, { id: "cancel-pending" }),
        staleShipping,
        merchantStatus("pending", 4, {
          id: "reopen-pending",
          reopens: "cancel-pending",
        }),
      ],
    }
    expect(getMerchantConversationState(reopenedPending)).toMatchObject({
      status: "pending",
      paid: false,
      shippingUpdated: false,
    })

    const shippingBeforeCancellation = {
      ...shippingUpdate,
      id: "shipping-before-cancel",
      createdAt: 2,
    }
    const reopenedShipped = {
      ...conversation,
      messages: [
        order,
        merchantStatus("paid", 1, { id: "paid-before-cancel" }),
        shippingBeforeCancellation,
        merchantStatus("cancelled", 3, { id: "cancel-shipped" }),
        merchantStatus("paid", 4, {
          id: "reopen-shipped",
          reopens: "cancel-shipped",
        }),
      ],
    }
    expect(getMerchantConversationState(reopenedShipped)).toMatchObject({
      status: "paid",
      paid: true,
      shippingUpdated: true,
    })
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
