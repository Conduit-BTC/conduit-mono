import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import {
  DASHBOARD_RANGE_OPTIONS,
  buildDashboardChartData,
  resolveDashboardPresetRange,
} from "../apps/merchant/src/lib/dashboard-charts"

const NOW = new Date("2026-07-09T12:00:00Z").getTime()

function orderMessage(
  orderId: string,
  createdAt: number,
  items: Array<{ productId: string; title?: string; quantity: number }>,
  subtotal: number
): ParsedOrderMessage {
  return {
    id: `${orderId}-order`,
    orderId,
    type: "order",
    createdAt,
    senderPubkey: "buyer",
    recipientPubkey: "merchant",
    rawContent: "",
    payload: {
      id: orderId,
      merchantPubkey: "merchant",
      buyerPubkey: "buyer",
      items: items.map((item) => ({
        productId: item.productId,
        title: item.title,
        quantity: item.quantity,
        priceAtPurchase: 10,
        currency: "SATS",
      })),
      subtotal,
      currency: "SATS",
      createdAt,
    },
  } as ParsedOrderMessage
}

function conversation(
  orderId: string,
  status: string | null,
  createdAt: number,
  items: Array<{ productId: string; title?: string; quantity: number }>,
  subtotal: number,
  statusCreatedAt = createdAt + 1_000
): MerchantConversationSummary {
  const order = orderMessage(orderId, createdAt, items, subtotal)
  const statusMessage: ParsedOrderMessage | null = status
    ? ({
        id: `${orderId}-status`,
        orderId,
        type: "status_update",
        createdAt: statusCreatedAt,
        senderPubkey: "merchant",
        recipientPubkey: "buyer",
        rawContent: "",
        payload: { status },
      } as ParsedOrderMessage)
    : null
  const messages = statusMessage ? [order, statusMessage] : [order]
  return {
    id: orderId,
    orderId,
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    latestAt: statusMessage?.createdAt ?? createdAt,
    latestType: statusMessage?.type ?? "order",
    status,
    totalSummary: `${subtotal} SATS`,
    preview: "Order",
    messageCount: messages.length,
    messages,
  }
}

function withPaymentProof(
  value: MerchantConversationSummary,
  proofCreatedAt = value.latestAt + 1_000
): MerchantConversationSummary {
  const proof: ParsedOrderMessage = {
    id: `${value.orderId}-proof`,
    orderId: value.orderId,
    type: "payment_proof",
    createdAt: proofCreatedAt,
    senderPubkey: "buyer",
    recipientPubkey: "merchant",
    rawContent: "",
    payload: {
      orderId: value.orderId,
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
  return {
    ...value,
    latestAt: Math.max(value.latestAt, proof.createdAt),
    latestType: proof.type,
    messages: [...(value.messages ?? []), proof],
  }
}

describe("buildDashboardChartData", () => {
  const conversations = [
    conversation(
      "a",
      "pending",
      NOW,
      [{ productId: "p:w", title: "Widget", quantity: 2 }],
      100
    ),
    conversation(
      "b",
      "shipped",
      NOW,
      [{ productId: "p:w", title: "Widget", quantity: 1 }],
      50
    ),
    conversation(
      "c",
      "cancelled",
      NOW - 3 * 86_400_000,
      [{ productId: "p:g", title: "Gadget", quantity: 1 }],
      30
    ),
  ]

  const data = buildDashboardChartData(
    conversations,
    null,
    resolveDashboardPresetRange("month", NOW)
  )

  it("counts orders per day in a 30-bucket window", () => {
    expect(data.ordersByDay).toHaveLength(30)
    expect(data.ordersByDay[data.ordersByDay.length - 1]?.value).toBe(2)
    expect(data.ordersByDay[data.ordersByDay.length - 4]?.value).toBe(1)
  })

  it("buckets status counts (cancelled included)", () => {
    expect(data.statusSlices).toEqual([
      { key: "pending", label: "Pending", count: 1 },
      { key: "in_progress", label: "In Progress", count: 1 },
      { key: "cancelled", label: "Cancelled", count: 1 },
    ])
  })

  it("buckets proof-only prepaid orders as in progress", () => {
    const proofOnly = withPaymentProof(
      conversation(
        "proof-only",
        null,
        NOW,
        [{ productId: "p:w", title: "Widget", quantity: 1 }],
        100
      )
    )

    expect(
      buildDashboardChartData(
        [proofOnly],
        null,
        resolveDashboardPresetRange("month", NOW)
      ).statusSlices
    ).toEqual([{ key: "in_progress", label: "In Progress", count: 1 }])
  })

  it("sums revenue for paid orders only", () => {
    expect(data.hasRevenue).toBe(true)
    // Only the shipped (paid) order counts; pending does not.
    expect(data.revenueByDay[data.revenueByDay.length - 1]?.value).toBe(50)
  })

  it("dates cashflow from payment evidence instead of later confirmation", () => {
    const delayedConfirmation = withPaymentProof(
      conversation(
        "delayed-confirmation",
        "paid",
        NOW - 45 * 86_400_000,
        [{ productId: "p:delayed", title: "Delayed", quantity: 1 }],
        100,
        NOW
      ),
      NOW - 40 * 86_400_000
    )
    const month = buildDashboardChartData(
      [delayedConfirmation],
      null,
      resolveDashboardPresetRange("month", NOW)
    )
    const quarter = buildDashboardChartData(
      [delayedConfirmation],
      null,
      resolveDashboardPresetRange("quarter", NOW)
    )

    expect(month.hasRevenue).toBe(false)
    expect(month.topProducts).toEqual([])
    expect(
      quarter.revenueByDay.reduce((sum, point) => sum + point.value, 0)
    ).toBe(100)
    expect(quarter.topProducts[0]?.productId).toBe("p:delayed")
  })

  it("ranks top products by total quantity", () => {
    expect(data.topProducts[0]).toEqual({
      productId: "p:w",
      title: "Widget",
      quantity: 1,
    })
    expect(data.totalOrders).toBe(3)
  })

  it("applies the selected range to status and paid-product totals", () => {
    const olderPaidOrder = conversation(
      "older",
      "paid",
      NOW - 40 * 86_400_000,
      [{ productId: "p:old", title: "Older product", quantity: 4 }],
      400
    )
    const all = [...conversations, olderPaidOrder]
    const month = buildDashboardChartData(
      all,
      null,
      resolveDashboardPresetRange("month", NOW)
    )
    const quarter = buildDashboardChartData(
      all,
      null,
      resolveDashboardPresetRange("quarter", NOW)
    )

    expect(month.totalOrders).toBe(3)
    expect(month.topProducts.some((item) => item.productId === "p:old")).toBe(
      false
    )
    expect(quarter.totalOrders).toBe(4)
    expect(quarter.topProducts[0]).toMatchObject({
      productId: "p:old",
      quantity: 4,
    })
  })

  it("accepts explicit custom ranges independently of the preset helpers", () => {
    const custom = buildDashboardChartData(conversations, null, {
      start: NOW - 2 * 86_400_000,
      end: NOW,
    })

    expect(custom.ordersByDay).toHaveLength(3)
  })

  it("exposes the four rolling presets with the expected bucket counts", () => {
    expect(DASHBOARD_RANGE_OPTIONS.map((option) => option.value)).toEqual([
      "week",
      "month",
      "quarter",
      "year",
    ])
    for (const option of DASHBOARD_RANGE_OPTIONS) {
      const preset = buildDashboardChartData(
        [],
        null,
        resolveDashboardPresetRange(option.value, NOW)
      )
      expect(preset.ordersByDay).toHaveLength(option.days)
    }
  })
})
