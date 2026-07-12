import { describe, expect, it } from "bun:test"
import {
  buildOrderStatusTimeline,
  deriveOrderFlow,
  getMerchantOrderActions,
  getOrderStatusDisplay,
  KNOWN_ORDER_STATUSES,
  normalizeSafeHttpUrl,
  orderStatusEnum,
  orderStatusSchema,
  type KnownOrderStatus,
  type OrderStatus,
} from "@conduit/core"

describe("canonical order statuses", () => {
  it("keeps schema, domain types, and presentation on one vocabulary", () => {
    const domainStatuses: OrderStatus[] = [...KNOWN_ORDER_STATUSES]
    const expectedLabels: Record<KnownOrderStatus, string> = {
      pending: "Pending",
      invoiced: "Invoiced",
      paid: "Paid",
      accepted: "Accepted",
      processing: "Processing",
      shipped: "Shipped",
      complete: "Complete",
      delivered: "Delivered",
      cancelled: "Cancelled",
      refund_requested: "Refund requested",
    }

    expect(orderStatusEnum.options).toEqual(domainStatuses)
    for (const status of domainStatuses) {
      expect(orderStatusSchema.parse(status)).toBe(status)
      expect(getOrderStatusDisplay(status).label).toBe(expectedLabels[status])
    }
  })

  it("continues to parse unknown incoming statuses for forward compatibility", () => {
    expect(orderStatusSchema.parse("future_merchant_status")).toBe(
      "future_merchant_status"
    )
  })
})

describe("normalizeSafeHttpUrl", () => {
  it("allows web URLs and rejects executable or malformed schemes", () => {
    expect(normalizeSafeHttpUrl("https://carrier.example/track/1")).toBe(
      "https://carrier.example/track/1"
    )
    expect(normalizeSafeHttpUrl("javascript:alert(1)")).toBeNull()
    expect(normalizeSafeHttpUrl("data:text/html,payload")).toBeNull()
    expect(normalizeSafeHttpUrl("not a url")).toBeNull()
  })
})

describe("getOrderStatusDisplay", () => {
  it("maps known statuses to a tone + label", () => {
    expect(getOrderStatusDisplay("pending")).toEqual({
      tone: "warning",
      label: "Pending",
    })
    expect(getOrderStatusDisplay("delivered")).toEqual({
      tone: "success",
      label: "Delivered",
    })
    expect(getOrderStatusDisplay("cancelled")).toEqual({
      tone: "neutral",
      label: "Cancelled",
    })
  })

  it("defaults empty status to pending and title-cases unknown ones", () => {
    expect(getOrderStatusDisplay(null)).toEqual({
      tone: "warning",
      label: "Pending",
    })
    expect(getOrderStatusDisplay("awaiting_fulfillment")).toEqual({
      tone: "neutral",
      label: "Awaiting Fulfillment",
    })
  })
})

describe("buildOrderStatusTimeline", () => {
  const stepStatuses = (
    input: Parameters<typeof buildOrderStatusTimeline>[0]
  ) => buildOrderStatusTimeline(input).map((row) => row.status)
  const stepKeys = (input: Parameters<typeof buildOrderStatusTimeline>[0]) =>
    buildOrderStatusTimeline(input).map((row) => row.key)

  it("completes stages up to the current status and marks the next in progress", () => {
    expect(stepStatuses("pending")).toEqual([
      "complete",
      "in_progress",
      "waiting",
      "waiting",
      "waiting",
    ])
    expect(stepStatuses("shipped")).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "in_progress",
    ])
    expect(stepStatuses("delivered")).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
    ])
  })

  it("treats confirmed prepaid payment as merchant acceptance", () => {
    expect(stepKeys({ status: "pending", paid: true })).toEqual([
      "placed",
      "payment",
      "accepted",
      "shipped",
      "delivered",
    ])
    // A merchant-confirmed payment is already a commitment to fulfill.
    expect(stepStatuses({ status: "pending", paid: true })).toEqual([
      "complete",
      "complete",
      "complete",
      "in_progress",
      "waiting",
    ])
  })

  it("orders acceptance before payment for invoice (order-first) orders", () => {
    expect(stepKeys({ status: "accepted", invoiceSent: true })).toEqual([
      "placed",
      "accepted",
      "payment",
      "shipped",
      "delivered",
    ])
    // Accepted + invoice sent, awaiting the buyer's payment.
    expect(stepStatuses({ status: "accepted", invoiceSent: true })).toEqual([
      "complete",
      "complete",
      "in_progress",
      "waiting",
      "waiting",
    ])
  })

  it("marks the stopped stage failed when cancelled", () => {
    const rows = buildOrderStatusTimeline("cancelled")
    expect(rows.map((row) => row.status)).toEqual(["complete", "failed"])
    expect(rows[1]).toMatchObject({
      title: "Order cancelled",
      subtitle: "No further order action is required.",
    })
    expect(rows[1]?.label).toBe("Cancelled")
  })

  it("stops refund-requested orders without presenting fulfillment as active", () => {
    const rows = buildOrderStatusTimeline({
      status: "refund_requested",
      paid: true,
    })

    expect(rows.at(-1)).toMatchObject({
      title: "Refund requested",
      subtitle: "Coordinate the Lightning refund outside Conduit.",
      status: "retry_needed",
      label: "Refund requested",
    })
    expect(rows.some((row) => row.status === "in_progress")).toBe(false)
    expect(rows.some((row) => row.status === "waiting")).toBe(false)
  })

  it("uses state-aware copy that tells the merchant what happens next", () => {
    const shipping = buildOrderStatusTimeline({ status: "paid", paid: true })
    expect(shipping.find((row) => row.key === "shipped")).toMatchObject({
      title: "Shipping in progress",
      subtitle: "Add tracking details to mark this order shipped.",
      status: "in_progress",
    })
    expect(shipping.find((row) => row.key === "delivered")).toMatchObject({
      title: "Delivery",
      subtitle: "Confirm delivery after shipment.",
      status: "waiting",
    })

    const delivery = buildOrderStatusTimeline({
      status: "paid",
      paid: true,
      shippingUpdated: true,
    })
    expect(delivery.find((row) => row.key === "shipped")).toMatchObject({
      title: "Shipped",
      subtitle: "Tracking details recorded.",
      status: "complete",
    })
    expect(delivery.find((row) => row.key === "delivered")).toMatchObject({
      title: "Confirm delivery",
      subtitle: "Mark the order delivered when fulfillment is complete.",
      status: "in_progress",
    })

    const verification = buildOrderStatusTimeline({
      status: "pending",
      paymentObserved: true,
    })
    expect(verification.find((row) => row.key === "payment")).toMatchObject({
      title: "Confirm payment",
      subtitle: "Verify settlement before fulfilling the order.",
      status: "in_progress",
    })

    const invoicedVerification = buildOrderStatusTimeline({
      status: "pending",
      invoiceSent: true,
      paymentObserved: true,
    })
    expect(invoicedVerification[1]).toMatchObject({
      key: "payment",
      title: "Confirm payment",
      status: "in_progress",
    })

    const guestInvoice = buildOrderStatusTimeline({
      status: "accepted",
      accepted: true,
      buyerReplyable: false,
    })
    expect(guestInvoice.find((row) => row.key === "payment")).toMatchObject({
      title: "Request payment",
      subtitle: "Contact the buyer outside Nostr to request payment.",
      status: "in_progress",
    })

    const unknownBuyer = buildOrderStatusTimeline({
      status: "accepted",
      accepted: true,
      buyerReplyable: "unknown",
    })
    expect(unknownBuyer.find((row) => row.key === "payment")).toMatchObject({
      title: "Request payment",
      subtitle: "Recover the buyer identity before requesting payment.",
      status: "in_progress",
    })

    const legacyShipped = buildOrderStatusTimeline({ status: "shipped" })
    expect(legacyShipped.find((row) => row.key === "shipped")).toMatchObject({
      title: "Shipped",
      subtitle: "Order marked shipped.",
      status: "complete",
    })
  })
})

describe("deriveOrderFlow", () => {
  it("is prepaid when paid without an invoice, invoice otherwise", () => {
    expect(deriveOrderFlow({ status: "pending", paid: true })).toBe("prepaid")
    expect(
      deriveOrderFlow({ status: "paid", paid: true, invoiceSent: true })
    ).toBe("invoice")
    expect(deriveOrderFlow({ status: "pending" })).toBe("invoice")
    expect(deriveOrderFlow({ status: "pending", paymentObserved: true })).toBe(
      "prepaid"
    )
  })
})

describe("getMerchantOrderActions", () => {
  it("offers decline + accept before acceptance", () => {
    expect(getMerchantOrderActions("pending")).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Decline order",
        kind: "destructive",
      },
      {
        action: "accept",
        status: "accepted",
        label: "Accept order",
        kind: "primary",
      },
    ])
  })

  it("offers cancel + ship once accepted and paid", () => {
    expect(getMerchantOrderActions({ status: "accepted", paid: true })).toEqual(
      [
        {
          action: "cancel",
          status: "cancelled",
          label: "Cancel order",
          kind: "destructive",
        },
        {
          action: "record_shipment",
          label: "Add shipping details",
          kind: "primary",
        },
      ]
    )
  })

  it("does not require a separate accept action after confirmed payment", () => {
    expect(getMerchantOrderActions({ status: "pending", paid: true })).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "record_shipment",
        label: "Add shipping details",
        kind: "primary",
      },
    ])
  })

  it("skips shipment and offers delivery confirmation for digital-only orders", () => {
    const state = {
      status: "paid",
      paid: true,
      requiresShipping: false,
    }

    expect(buildOrderStatusTimeline(state).map((step) => step.key)).toEqual([
      "placed",
      "payment",
      "accepted",
      "delivered",
    ])
    expect(getMerchantOrderActions(state)).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "complete",
        status: "complete",
        label: "Confirm delivery",
        kind: "primary",
      },
    ])
  })

  it("routes buyer payment evidence to verification before fulfillment", () => {
    expect(
      getMerchantOrderActions({
        status: "pending",
        paymentObserved: true,
        paymentReported: true,
      })
    ).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "confirm_payment",
        status: "paid",
        label: "Confirm payment",
        kind: "primary",
      },
    ])
  })

  it("treats a shipping update as the shipped lifecycle transition", () => {
    const state = {
      status: "paid",
      paid: true,
      shippingUpdated: true,
    }
    expect(
      buildOrderStatusTimeline(state).find((step) => step.key === "shipped")
    ).toMatchObject({ status: "complete" })
    expect(getMerchantOrderActions(state)).toEqual([
      {
        action: "complete",
        status: "complete",
        label: "Mark delivered",
        kind: "primary",
      },
    ])
  })

  it("backfills confirmed fulfillment gates for legacy shipment-only history", () => {
    const state = { status: "pending", shippingUpdated: true }
    const rows = buildOrderStatusTimeline(state)
    expect(rows.find((step) => step.key === "payment")?.status).toBe("complete")
    expect(rows.find((step) => step.key === "accepted")?.status).toBe(
      "complete"
    )
    expect(getMerchantOrderActions(state)).toEqual([
      {
        action: "complete",
        status: "complete",
        label: "Mark delivered",
        kind: "primary",
      },
    ])
  })

  it("preserves acceptance when a later paid status becomes current", () => {
    expect(
      getMerchantOrderActions({ status: "paid", accepted: true, paid: true })
    ).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "record_shipment",
        label: "Add shipping details",
        kind: "primary",
      },
    ])
  })

  it("gates shipping on payment (accepted but unpaid → cancel only)", () => {
    expect(getMerchantOrderActions({ status: "accepted" })).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
    ])
  })

  it("lets non-replyable accepted orders record verified out-of-band payment", () => {
    expect(
      getMerchantOrderActions({
        status: "accepted",
        accepted: true,
        buyerReplyable: false,
      })
    ).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "confirm_payment",
        status: "paid",
        label: "Confirm payment received",
        kind: "primary",
      },
    ])
    expect(
      getMerchantOrderActions({
        status: "paid",
        paid: true,
        buyerReplyable: false,
      }).map((action) => action.action)
    ).toEqual(["cancel", "record_shipment"])
    expect(
      getMerchantOrderActions({
        status: "accepted",
        accepted: true,
        buyerReplyable: "unknown",
      })
    ).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
    ])
  })

  it("shows buyer payment evidence without unlocking shipping", () => {
    const state = {
      status: "accepted",
      accepted: true,
      paymentObserved: true,
      paid: false,
    }
    expect(
      buildOrderStatusTimeline(state).find((step) => step.key === "payment")
    ).toMatchObject({
      title: "Confirm payment",
      status: "in_progress",
    })
    expect(getMerchantOrderActions(state)).toEqual([
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "confirm_payment",
        status: "paid",
        label: "Confirm payment",
        kind: "primary",
      },
    ])
  })

  it("offers completion once shipped and nothing once terminal", () => {
    expect(getMerchantOrderActions("shipped")).toEqual([
      {
        action: "complete",
        status: "complete",
        label: "Mark delivered",
        kind: "primary",
      },
    ])
    expect(getMerchantOrderActions("delivered")).toEqual([])
    expect(getMerchantOrderActions("cancelled")).toEqual([])
    expect(getMerchantOrderActions("refund_requested")).toEqual([])
    expect(getMerchantOrderActions("future_terminal_status")).toEqual([])
  })
})
