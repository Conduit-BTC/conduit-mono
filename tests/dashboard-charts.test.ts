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

function offsetDate({
  days = 0,
  months = 0,
}: {
  days?: number
  months?: number
}) {
  const date = new Date(NOW)
  date.setDate(date.getDate() - days)
  date.setMonth(date.getMonth() - months)
  return date.getTime()
}

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

  it("aggregates the past month into four weekly buckets", () => {
    expect(data.ordersOverTime).toHaveLength(4)
    expect(data.ordersOverTime[data.ordersOverTime.length - 1]?.value).toBe(3)
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
    expect(data.revenueOverTime[data.revenueOverTime.length - 1]?.value).toBe(
      50
    )
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
      quarter.revenueOverTime.reduce((sum, point) => sum + point.value, 0)
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

    expect(custom.ordersOverTime).toHaveLength(3)
  })

  it("uses legible bucket counts for each rolling preset", () => {
    expect(DASHBOARD_RANGE_OPTIONS.map((option) => option.value)).toEqual([
      "week",
      "month",
      "quarter",
      "year",
    ])
    const expectedBucketCounts = {
      week: 7,
      month: 4,
      quarter: 3,
      year: 4,
    }
    for (const option of DASHBOARD_RANGE_OPTIONS) {
      const preset = buildDashboardChartData(
        [],
        null,
        resolveDashboardPresetRange(option.value, NOW)
      )
      expect(preset.ordersOverTime).toHaveLength(
        expectedBucketCounts[option.value]
      )
      expect(preset.revenueOverTime).toHaveLength(
        expectedBucketCounts[option.value]
      )
    }
  })

  it("aggregates orders and revenue into every visible preset bucket", () => {
    const cases = [
      {
        preset: "week" as const,
        timestamps: Array.from({ length: 7 }, (_, days) =>
          offsetDate({ days })
        ),
      },
      {
        preset: "month" as const,
        timestamps: [0, 7, 14, 21].map((days) => offsetDate({ days })),
      },
      {
        preset: "quarter" as const,
        timestamps: [0, 1, 2].map((months) => offsetDate({ months })),
      },
      {
        preset: "year" as const,
        timestamps: [0, 3, 6, 9].map((months) => offsetDate({ months })),
      },
    ]

    for (const { preset, timestamps } of cases) {
      const values = timestamps.map((timestamp, index) =>
        conversation(
          `${preset}-${index}`,
          "paid",
          timestamp,
          [{ productId: `${preset}-product`, quantity: 1 }],
          10
        )
      )
      const result = buildDashboardChartData(
        values,
        null,
        resolveDashboardPresetRange(preset, NOW)
      )

      expect(result.ordersOverTime.map((point) => point.value)).toEqual(
        timestamps.map(() => 1)
      )
      expect(result.revenueOverTime.map((point) => point.value)).toEqual(
        timestamps.map(() => 10)
      )
      expect(result.ordersOverTime.every((point) => !!point.axisLabel)).toBe(
        true
      )
    }
  })

  it("keeps rolling month buckets contiguous across different month lengths", () => {
    const monthEnd = new Date("2028-05-31T12:00:00Z").getTime()
    const range = resolveDashboardPresetRange("quarter", monthEnd)
    const dailyOrders: MerchantConversationSummary[] = []
    const cursor = new Date(range.start)
    let index = 0

    while (cursor.getTime() <= range.end) {
      dailyOrders.push(
        conversation(
          `month-end-${index}`,
          "pending",
          cursor.getTime(),
          [{ productId: "month-end-product", quantity: 1 }],
          10
        )
      )
      cursor.setDate(cursor.getDate() + 1)
      index += 1
    }

    const result = buildDashboardChartData(dailyOrders, null, range)
    expect(result.ordersOverTime).toHaveLength(3)
    expect(
      result.ordersOverTime.reduce((sum, point) => sum + point.value, 0)
    ).toBe(dailyOrders.length)
    expect(result.ordersOverTime.every((point) => point.value > 0)).toBe(true)
  })
})
