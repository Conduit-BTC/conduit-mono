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
    expect(rows.map((row) => row.status)).toEqual([
      "complete",
      "failed",
      "waiting",
      "waiting",
      "waiting",
    ])
    expect(rows[1]?.label).toBe("Cancelled")
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
      title: "Payment proof received",
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
