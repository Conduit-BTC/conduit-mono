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

function offsetDate({ days = 0 }: { days?: number }) {
  const date = new Date(NOW)
  date.setDate(date.getDate() - days)
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
    resolveDashboardPresetRange("30d", NOW)
  )

  it("keeps daily bars across the full past 30 days", () => {
    expect(data.ordersOverTime).toHaveLength(30)
    expect(data.ordersOverTime[data.ordersOverTime.length - 1]?.value).toBe(2)
    expect(data.ordersOverTime[data.ordersOverTime.length - 4]?.value).toBe(1)
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
        resolveDashboardPresetRange("30d", NOW)
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
    const thirtyDays = buildDashboardChartData(
      [delayedConfirmation],
      null,
      resolveDashboardPresetRange("30d", NOW)
    )
    const ninetyDays = buildDashboardChartData(
      [delayedConfirmation],
      null,
      resolveDashboardPresetRange("90d", NOW)
    )

    expect(thirtyDays.hasRevenue).toBe(false)
    expect(thirtyDays.topProducts).toEqual([])
    expect(
      ninetyDays.revenueOverTime.reduce((sum, point) => sum + point.value, 0)
    ).toBe(100)
    expect(ninetyDays.topProducts[0]?.productId).toBe("p:delayed")
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
    const thirtyDays = buildDashboardChartData(
      all,
      null,
      resolveDashboardPresetRange("30d", NOW)
    )
    const ninetyDays = buildDashboardChartData(
      all,
      null,
      resolveDashboardPresetRange("90d", NOW)
    )

    expect(thirtyDays.totalOrders).toBe(3)
    expect(
      thirtyDays.topProducts.some((item) => item.productId === "p:old")
    ).toBe(false)
    expect(ninetyDays.totalOrders).toBe(4)
    expect(ninetyDays.topProducts[0]).toMatchObject({
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

  it("uses exact windows, bar intervals, and label cadences per preset", () => {
    expect(
      DASHBOARD_RANGE_OPTIONS.map(({ value, label }) => ({ value, label }))
    ).toEqual([
      { value: "week", label: "Past Week" },
      { value: "30d", label: "Past 30 days" },
      { value: "90d", label: "Past 90 days" },
      { value: "year", label: "Past Year" },
    ])
    const expectations = {
      week: { bars: 7, labels: 7 },
      "30d": { bars: 30, labels: 10 },
      "90d": { bars: 90, labels: 10 },
      year: { bars: 53, labels: 12 },
    }

    for (const option of DASHBOARD_RANGE_OPTIONS) {
      const result = buildDashboardChartData(
        [],
        null,
        resolveDashboardPresetRange(option.value, NOW)
      )
      const expected = expectations[option.value]
      expect(result.ordersOverTime).toHaveLength(expected.bars)
      expect(result.revenueOverTime).toHaveLength(expected.bars)
      expect(
        result.ordersOverTime.filter((point) => point.showAxisLabel).length
      ).toBe(expected.labels)
    }
  })

  it("preserves the full left edge of the exact 30 and 90 day windows", () => {
    const withinThirtyDays = conversation(
      "day-30",
      "pending",
      offsetDate({ days: 29 }),
      [{ productId: "p:30", quantity: 1 }],
      10
    )
    const outsideThirtyDays = conversation(
      "day-31",
      "pending",
      offsetDate({ days: 30 }),
      [{ productId: "p:31", quantity: 1 }],
      10
    )
    const withinNinetyDays = conversation(
      "day-90",
      "pending",
      offsetDate({ days: 89 }),
      [{ productId: "p:90", quantity: 1 }],
      10
    )
    const outsideNinetyDays = conversation(
      "day-91",
      "pending",
      offsetDate({ days: 90 }),
      [{ productId: "p:91", quantity: 1 }],
      10
    )

    const thirtyDays = buildDashboardChartData(
      [withinThirtyDays, outsideThirtyDays],
      null,
      resolveDashboardPresetRange("30d", NOW)
    )
    const ninetyDays = buildDashboardChartData(
      [withinNinetyDays, outsideNinetyDays],
      null,
      resolveDashboardPresetRange("90d", NOW)
    )

    expect(thirtyDays.totalOrders).toBe(1)
    expect(thirtyDays.ordersOverTime[0]?.value).toBe(1)
    expect(ninetyDays.totalOrders).toBe(1)
    expect(ninetyDays.ordersOverTime[0]?.value).toBe(1)
  })

  it("keeps every day in the year window while rolling into weekly bars", () => {
    const range = resolveDashboardPresetRange("year", NOW)
    const dailyOrders: MerchantConversationSummary[] = []
    const cursor = new Date(range.start)
    let index = 0

    while (cursor.getTime() <= range.end) {
      dailyOrders.push(
        conversation(
          `year-${index}`,
          "pending",
          cursor.getTime(),
          [{ productId: "year-product", quantity: 1 }],
          10
        )
      )
      cursor.setDate(cursor.getDate() + 1)
      index += 1
    }

    const result = buildDashboardChartData(dailyOrders, null, range)
    expect(dailyOrders).toHaveLength(365)
    expect(result.ordersOverTime).toHaveLength(53)
    expect(
      result.ordersOverTime.reduce((sum, point) => sum + point.value, 0)
    ).toBe(365)
    expect(result.ordersOverTime[0]?.value).toBe(1)
    expect(result.ordersOverTime.at(-1)?.value).toBe(7)
  })
})
