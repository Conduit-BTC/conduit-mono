import { describe, expect, it } from "bun:test"
import {
  getEffectiveMerchantOrderStatus,
  getMerchantOrderActions,
  getMerchantOrderReopenTransition,
  parseOrderMessageRumorEvent,
  type MerchantConversationSummary,
  type OrderLifecycle,
  type ParsedOrderMessage,
} from "@conduit/core"
import { buildOrderViewModel } from "../apps/market/src/lib/order-view"
import { getMerchantConversationState } from "../apps/merchant/src/lib/order-phase"

const buyerPubkey = "b".repeat(64)
const merchantPubkey = "c".repeat(64)
const orderId = "order-reopen"
const cancellationId = "a".repeat(64)

const order: ParsedOrderMessage = {
  id: "1".repeat(64),
  orderId,
  type: "order",
  createdAt: 1_000,
  senderPubkey: buyerPubkey,
  recipientPubkey: merchantPubkey,
  rawContent: "{}",
  payload: {
    id: orderId,
    buyerPubkey,
    merchantPubkey,
    items: [],
    subtotal: 100,
    currency: "SATS",
    createdAt: 1_000,
  },
} as ParsedOrderMessage

function merchantStatus(
  id: string,
  status: string,
  createdAt: number,
  reopens?: string
): ParsedOrderMessage {
  return {
    id,
    orderId,
    type: "status_update",
    createdAt,
    senderPubkey: merchantPubkey,
    recipientPubkey: buyerPubkey,
    rawContent: "{}",
    payload: { status, ...(reopens ? { reopens } : {}) },
  } as ParsedOrderMessage
}

const paid = merchantStatus("9".repeat(64), "paid", 2_000)
const cancelled = merchantStatus(cancellationId, "cancelled", 3_000)
// The lower id would sort before the cancellation without the causal reference.
const reopened = merchantStatus("0".repeat(64), "paid", 3_000, cancellationId)
const shipping: ParsedOrderMessage = {
  id: "d".repeat(64),
  orderId,
  type: "shipping_update",
  createdAt: 4_000,
  senderPubkey: merchantPubkey,
  recipientPubkey: buyerPubkey,
  rawContent: "{}",
  payload: { carrier: "USPS", trackingNumber: "9234" },
}

const cancelledLifecycle: OrderLifecycle = {
  orderId,
  buyerPubkey,
  merchantPubkey,
  checkoutMode: "public_zap",
  items: [],
  itemSubtotalSats: 100,
  shippingCostSats: 0,
  totalSats: 100,
  totalMsats: 100_000,
  currency: "SATS",
  addressValidity: "valid",
  shippingZoneEligibility: "eligible",
  orderDeliveryStatus: "sent",
  invoiceStatus: "received",
  paymentStatus: "paid",
  proofDeliveryStatus: "sent",
  zapReceiptStatus: "waiting",
  phase: "cancelled",
  createdAt: 1_000,
  updatedAt: 3_000,
}

function conversation(
  messages: ParsedOrderMessage[]
): MerchantConversationSummary {
  return {
    id: orderId,
    orderId,
    buyerPubkey,
    merchantPubkey,
    latestAt: Math.max(...messages.map((message) => message.createdAt)),
    latestType: messages.at(-1)?.type ?? "order",
    status: "cancelled",
    totalSummary: "100 SATS",
    preview: "Order update",
    messageCount: messages.length,
    messages,
    context: "complete",
  }
}

describe("merchant cancellation correction", () => {
  it("uses the explicit reference for same-second cancel and reopen events", () => {
    const messages = [order, paid, cancelled, reopened]
    const participants = { buyerPubkey, merchantPubkey }

    expect(getEffectiveMerchantOrderStatus(messages, participants)).toEqual({
      status: "paid",
      knownStatus: "paid",
      reopenedCancellationId: cancellationId,
    })
    expect(
      getEffectiveMerchantOrderStatus([...messages].reverse(), participants)
    ).toEqual({
      status: "paid",
      knownStatus: "paid",
      reopenedCancellationId: cancellationId,
    })
  })

  it("honors the causal reference when signer clocks put the correction first", () => {
    const skewedReopen = merchantStatus(
      "0".repeat(64),
      "paid",
      cancelled.createdAt - 60,
      cancellationId
    )

    expect(
      getEffectiveMerchantOrderStatus([order, paid, cancelled, skewedReopen], {
        buyerPubkey,
        merchantPubkey,
      })
    ).toMatchObject({
      status: "paid",
      reopenedCancellationId: cancellationId,
    })
  })

  it("ignores stale corrections and lets a later cancellation win", () => {
    const laterCancellationId = "f".repeat(64)
    const laterCancellation = merchantStatus(
      laterCancellationId,
      "cancelled",
      4_000
    )
    const staleCorrection = merchantStatus(
      "e".repeat(64),
      "paid",
      5_000,
      cancellationId
    )

    expect(
      getEffectiveMerchantOrderStatus(
        [order, paid, cancelled, reopened, laterCancellation, staleCorrection],
        { buyerPubkey, merchantPubkey }
      )
    ).toEqual({
      status: "cancelled",
      knownStatus: "cancelled",
      cancellation: {
        eventId: laterCancellationId,
        resumeStatus: "paid",
      },
    })
  })

  it("accepts the merchant's safe correction when a partial view missed the prior status", () => {
    expect(
      getEffectiveMerchantOrderStatus([order, cancelled, reopened], {
        buyerPubkey,
        merchantPubkey,
      })
    ).toEqual({
      status: "paid",
      knownStatus: "paid",
      reopenedCancellationId: cancellationId,
    })

    for (const unsafeStatus of ["complete", "future_terminal_state"]) {
      expect(
        getEffectiveMerchantOrderStatus(
          [
            order,
            cancelled,
            merchantStatus("8".repeat(64), unsafeStatus, 4_000, cancellationId),
          ],
          { buyerPubkey, merchantPubkey }
        ).status
      ).toBe("cancelled")
    }
  })

  it("keeps terminal states closed against ordinary non-terminal updates", () => {
    const terminalCases = [
      ["complete", "3".repeat(64)],
      ["delivered", "4".repeat(64)],
      ["refund_requested", "5".repeat(64)],
    ] as const

    for (const [terminalStatus, eventId] of terminalCases) {
      const terminal = merchantStatus(eventId, terminalStatus, 3_000)
      const processing = merchantStatus("7".repeat(64), "processing", 4_000)

      expect(
        getEffectiveMerchantOrderStatus([order, paid, terminal, processing], {
          buyerPubkey,
          merchantPubkey,
        }).status
      ).toBe(terminalStatus)
    }
  })

  it("allows a later terminal status to supersede cancellation without reopening", () => {
    for (const [laterStatus, eventId] of [
      ["complete", "6".repeat(64)],
      ["refund_requested", "5".repeat(64)],
    ] as const) {
      const laterTerminal = merchantStatus(eventId, laterStatus, 4_000)

      expect(
        getEffectiveMerchantOrderStatus(
          [order, paid, cancelled, laterTerminal],
          { buyerPubkey, merchantPubkey }
        )
      ).toEqual({ status: laterStatus, knownStatus: laterStatus })
    }
  })

  it("does not invent a reopen target from an orderless partial view", () => {
    expect(
      getEffectiveMerchantOrderStatus([cancelled], {
        buyerPubkey,
        merchantPubkey,
      })
    ).toEqual({ status: "cancelled", knownStatus: "cancelled" })
  })

  it("projects the same restored status in Merchant and Market without hiding shipping", () => {
    const messages = [order, paid, cancelled, reopened, shipping]
    const merchantState = getMerchantConversationState(conversation(messages))
    const marketView = buildOrderViewModel({
      orderId,
      merchantPubkey,
      messages,
    })

    expect(merchantState).toMatchObject({
      status: "paid",
      paid: true,
      shippingUpdated: true,
    })
    expect(merchantState.cancellation).toBeUndefined()
    expect(marketView.merchantStatus).toBe("paid")
    expect(marketView.tracking).toEqual({
      carrier: "USPS",
      number: "9234",
      url: null,
    })
  })

  it("overrides a cancelled buyer lifecycle only with positive correction evidence", () => {
    expect(
      buildOrderViewModel({
        orderId,
        merchantPubkey,
        lifecycle: cancelledLifecycle,
        messages: [order, paid],
      }).phase
    ).toBe("cancelled")

    expect(
      buildOrderViewModel({
        orderId,
        merchantPubkey,
        lifecycle: cancelledLifecycle,
        messages: [order, paid, cancelled, reopened],
      }).phase
    ).toBe("in_progress")
  })

  it("builds one canonical correction and offers it only for a safe cancellation", () => {
    const transition = getMerchantOrderReopenTransition({
      status: "cancelled",
      cancellation: { eventId: cancellationId, resumeStatus: "paid" },
    })

    expect(transition).toEqual({
      status: "paid",
      tags: [
        ["status", "paid"],
        ["reopens", cancellationId],
      ],
      payload: { status: "paid", reopens: cancellationId },
    })
    expect(
      getMerchantOrderActions({
        status: "cancelled",
        cancellation: { eventId: cancellationId, resumeStatus: "paid" },
      })
    ).toEqual([{ action: "reopen", label: "Reopen order", kind: "primary" }])
    expect(getMerchantOrderActions({ status: "cancelled" })).toEqual([])
  })
})

describe("status correction wire format", () => {
  function parse(tags: string[][], content: Record<string, unknown>) {
    return parseOrderMessageRumorEvent({
      id: "7".repeat(64),
      created_at: 1,
      pubkey: merchantPubkey,
      tags: [
        ["p", buyerPubkey],
        ["type", "status_update"],
        ["order", orderId],
        ["status", "paid"],
        ...tags,
      ],
      content: JSON.stringify({ status: "paid", ...content }),
    })
  }

  it("accepts a valid tag, payload, or matching canonical pair", () => {
    expect(parse([["reopens", cancellationId]], {}).payload).toMatchObject({
      reopens: cancellationId,
    })
    expect(parse([], { reopens: cancellationId }).payload).toMatchObject({
      reopens: cancellationId,
    })
    expect(
      parse([["reopens", cancellationId]], { reopens: cancellationId }).payload
    ).toMatchObject({ reopens: cancellationId })
  })

  it("rejects conflicting or malformed correction references", () => {
    expect(() =>
      parse([["reopens", cancellationId]], { reopens: "2".repeat(64) })
    ).toThrow("Conflicting order status correction markers")
    expect(() => parse([], { reopens: "not-an-event-id" })).toThrow()
  })
})

describe("guest reopen presentation", () => {
  it("does not claim that a guest is notified", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("It does not notify the guest")
    expect(source).toContain("delivery: operationalDelivery")
    expect(source).toContain("communication: communicationState")
    expect(source).toContain("reopenOrderMutation.mutate(reopenConfirmation)")
    expect(source).toContain("reopenOrderMutation.reset()")
    expect(source).toContain("Couldn&apos;t reopen the order")
  })
})
