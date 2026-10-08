import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import type {
  CheckoutSparkMerchantOrderWitness,
  CheckoutSparkMerchantSettlementRecord,
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import { orderSchema } from "@conduit/core"
import type { MerchantOrderSettlementBinding } from "../apps/merchant/src/lib/checkout-spark-order-overlay"
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

const ROUTER_BUYER = "a".repeat(64)
const ROUTER_MERCHANT = "b".repeat(64)
const MERCHANT_LEG = "1".repeat(64)
const SUPPLIER_LEG = "2".repeat(64)
const FEE_LEG = "3".repeat(64)
const PLAN_DIGEST = "4".repeat(64)
const RUMOR_ID = "5".repeat(64)

function routedOrder(
  id: string,
  createdAt: number,
  status: string | null = "paid"
): {
  conversation: MerchantConversationSummary
  witness: CheckoutSparkMerchantOrderWitness
} {
  const payload = orderSchema.parse({
    id,
    buyerPubkey: ROUTER_BUYER,
    merchantPubkey: ROUTER_MERCHANT,
    items: [
      {
        productId: `30402:${ROUTER_MERCHANT}:digital-item`,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1_000,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 1_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt,
  })
  const rawContent = JSON.stringify(payload)
  const order: ParsedOrderMessage = {
    id: RUMOR_ID,
    orderId: id,
    type: "order",
    createdAt,
    senderPubkey: ROUTER_BUYER,
    recipientPubkey: ROUTER_MERCHANT,
    rawContent,
    payload,
    checkoutPaymentRoute: "spark_router_v1",
  }
  const statusMessage: ParsedOrderMessage | null = status
    ? ({
        id: `${id}-status`,
        orderId: id,
        type: "status_update",
        createdAt: createdAt + 1_000,
        senderPubkey: ROUTER_MERCHANT,
        recipientPubkey: ROUTER_BUYER,
        rawContent: "",
        payload: { status },
      } as ParsedOrderMessage)
    : null
  const messages = statusMessage ? [order, statusMessage] : [order]
  return {
    conversation: {
      id,
      orderId: id,
      buyerPubkey: ROUTER_BUYER,
      merchantPubkey: ROUTER_MERCHANT,
      latestAt: statusMessage?.createdAt ?? createdAt,
      latestType: statusMessage?.type ?? "order",
      status,
      totalSummary: "1,000 SATS",
      preview: "Digital item",
      messageCount: messages.length,
      messages,
    },
    witness: {
      schemaVersion: 1,
      merchantPubkey: ROUTER_MERCHANT,
      buyerPubkey: ROUTER_BUYER,
      orderId: id,
      rumorId: RUMOR_ID,
      contentHash: createHash("sha256")
        .update(
          `conduit:checkout-spark-merchant-order-content:v1\0${rawContent}`
        )
        .digest("hex"),
      checkoutId: `checkout-${id}`,
      planDigest: PLAN_DIGEST,
    },
  }
}

function routedBinding(
  witness: CheckoutSparkMerchantOrderWitness,
  paid: readonly { legId: string; observedAt: number }[],
  creditAt: number | null = NOW - 3 * 86_400_000
): MerchantOrderSettlementBinding {
  const settlement: CheckoutSparkMerchantSettlementRecord = {
    schemaVersion: 1,
    merchantPubkey: ROUTER_MERCHANT,
    orderId: witness.orderId,
    checkoutId: witness.checkoutId,
    planDigest: PLAN_DIGEST,
    merchantLegId: MERCHANT_LEG,
    requiredCommerceLegIds: [MERCHANT_LEG, SUPPLIER_LEG],
    feeLegId: FEE_LEG,
    credit:
      creditAt === null
        ? null
        : {
            transferId: "credit-transfer",
            creditedSats: 1_113,
            observedAt: creditAt,
          },
    paidLegs: paid.map(({ legId, observedAt }) => ({
      legId,
      transferId: `transfer-${legId}`,
      allocationSats: 500,
      finalDebitSats: 500,
      finalFeeSats: 0,
      recipientVerified: true,
      observedAt,
    })),
  }
  return { witness, settlement }
}

describe("buildDashboardChartData", () => {
  it("keeps historical BGN paid revenue readable with its available conversion", () => {
    const historical = withPaymentProof(
      conversation(
        "historical-bgn",
        "paid",
        NOW - 86_400_000,
        [{ productId: "historical-product", quantity: 1 }],
        1
      )
    )
    const order = historical.messages!.find(
      (message) => message.type === "order"
    )!
    if (order.type !== "order") throw new Error("Missing historical order")
    order.payload.currency = "BGN"
    order.payload.items[0]!.currency = "BGN"
    order.payload.items[0]!.priceAtPurchase = 1
    const data = buildDashboardChartData(
      [historical],
      {
        rate: 100_000,
        fetchedAt: NOW,
        source: "env",
        fiatUsdRates: { BGN: 0.5 },
      },
      resolveDashboardPresetRange("30d", NOW)
    )
    expect(data.hasRevenue).toBe(true)
    expect(
      data.revenueOverTime.reduce((sum, bucket) => sum + bucket.value, 0)
    ).toBe(500)
  })

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

  it("keeps routed funding and generic paid claims out of sales alongside direct orders", () => {
    const { conversation: routed, witness } = routedOrder("funding-only", NOW)
    const direct = conversation(
      "direct-paid",
      "paid",
      NOW,
      [{ productId: "p:direct", title: "Direct", quantity: 1 }],
      40
    )
    const range = resolveDashboardPresetRange("week", NOW)
    const result = buildDashboardChartData([direct, routed], null, range, [
      routedBinding(witness, []),
    ])

    expect(result.totalOrders).toBe(2)
    expect(result.statusSlices).toEqual([
      { key: "in_progress", label: "In Progress", count: 2 },
    ])
    expect(result.revenueOverTime.at(-1)?.value).toBe(40)
    expect(result.topProducts.map((item) => item.productId)).toEqual([
      "p:direct",
    ])
    expect(buildDashboardChartData([routed], null, range).hasRevenue).toBe(
      false
    )
  })

  it("waits for every required commerce leg, then dates the sale by the last verified leg", () => {
    const { conversation: routed, witness } = routedOrder("split", NOW)
    const range = resolveDashboardPresetRange("week", NOW)
    const merchantAt = NOW - 2 * 86_400_000
    const supplierAt = NOW - 86_400_000
    const feeAt = NOW
    const merchantOnly = buildDashboardChartData([routed], null, range, [
      routedBinding(witness, [{ legId: MERCHANT_LEG, observedAt: merchantAt }]),
    ])
    expect(merchantOnly.hasRevenue).toBe(false)
    expect(merchantOnly.topProducts).toEqual([])

    const required = [
      { legId: MERCHANT_LEG, observedAt: merchantAt },
      { legId: SUPPLIER_LEG, observedAt: supplierAt },
    ]
    // A retained record after wallet retirement has the same immutable witness.
    const retiredRecord = routedBinding(witness, required)
    const paid = buildDashboardChartData([routed], null, range, [retiredRecord])
    const feePaid = buildDashboardChartData([routed], null, range, [
      routedBinding(witness, [
        ...required,
        { legId: FEE_LEG, observedAt: feeAt },
      ]),
    ])
    expect(paid.hasRevenue).toBe(true)
    expect(paid.revenueOverTime.at(-2)?.value).toBe(1_000)
    expect(paid.revenueOverTime.at(-1)?.value).toBe(0)
    expect(paid.topProducts).toHaveLength(1)
    expect(feePaid.revenueOverTime).toEqual(paid.revenueOverTime)
    expect(feePaid.topProducts).toEqual(paid.topProducts)
    expect(feePaid.statusSlices).toEqual(paid.statusSlices)
  })

  it("does not count provider-paid invoices without local recipient verification as sales", () => {
    const { conversation: routed, witness } = routedOrder("origin-pending", NOW)
    const local = routedBinding(witness, [
      { legId: MERCHANT_LEG, observedAt: NOW },
      { legId: SUPPLIER_LEG, observedAt: NOW },
    ])
    const imported = {
      witness,
      settlement: {
        ...local.settlement,
        paidLegs: local.settlement.paidLegs.map((leg) => {
          const providerOnly = { ...leg }
          delete providerOnly.recipientVerified
          return providerOnly
        }),
      },
    }
    const data = buildDashboardChartData(
      [routed],
      null,
      resolveDashboardPresetRange("week", NOW),
      [imported]
    )
    expect(data.hasRevenue).toBe(false)
    expect(data.topProducts).toEqual([])
  })

  it("uses exact provider projection when assigning routed order phases", () => {
    const { conversation: routed, witness } = routedOrder("phase", NOW, null)
    const range = resolveDashboardPresetRange("week", NOW)
    const unverified = buildDashboardChartData([routed], null, range, [
      routedBinding(witness, []),
    ])
    const verified = buildDashboardChartData([routed], null, range, [
      routedBinding(witness, [
        { legId: MERCHANT_LEG, observedAt: NOW },
        { legId: SUPPLIER_LEG, observedAt: NOW },
      ]),
    ])
    expect(unverified.statusSlices).toEqual([
      { key: "pending", label: "Pending", count: 1 },
    ])
    expect(verified.statusSlices).toEqual([
      { key: "in_progress", label: "In Progress", count: 1 },
    ])
  })

  it("requires exact order binding and settled credit even when all payouts appear paid", () => {
    const { conversation: routed, witness } = routedOrder("bound", NOW)
    const required = [
      { legId: MERCHANT_LEG, observedAt: NOW },
      { legId: SUPPLIER_LEG, observedAt: NOW },
    ]
    const valid = routedBinding(witness, required)
    const cases: readonly MerchantOrderSettlementBinding[][] = [
      [routedBinding(witness, required, null)],
      [valid, valid],
      [{ ...valid, witness: { ...witness, buyerPubkey: "c".repeat(64) } }],
      [
        {
          ...valid,
          settlement: { ...valid.settlement, planDigest: "d".repeat(64) },
        },
      ],
    ]
    for (const bindings of cases) {
      const result = buildDashboardChartData(
        [routed],
        null,
        resolveDashboardPresetRange("week", NOW),
        bindings
      )
      expect(result.hasRevenue).toBe(false)
      expect(result.topProducts).toEqual([])
    }
  })

  it("uses the provider verification date, not the order or funding date, for range inclusion", () => {
    const oldOrder = routedOrder("old-order", NOW - 40 * 86_400_000)
    const paidNow = routedBinding(oldOrder.witness, [
      { legId: MERCHANT_LEG, observedAt: NOW - 86_400_000 },
      { legId: SUPPLIER_LEG, observedAt: NOW },
    ])
    const range = resolveDashboardPresetRange("week", NOW)
    const result = buildDashboardChartData(
      [oldOrder.conversation],
      null,
      range,
      [paidNow]
    )
    expect(result.totalOrders).toBe(0)
    expect(result.revenueOverTime.at(-1)?.value).toBe(1_000)
    expect(result.topProducts[0]?.quantity).toBe(1)

    const recentOrder = routedOrder("recent-order", NOW)
    const paidLongAgo = routedBinding(recentOrder.witness, [
      { legId: MERCHANT_LEG, observedAt: NOW - 40 * 86_400_000 },
      { legId: SUPPLIER_LEG, observedAt: NOW - 39 * 86_400_000 },
    ])
    const olderResult = buildDashboardChartData(
      [recentOrder.conversation],
      null,
      range,
      [paidLongAgo]
    )
    expect(olderResult.totalOrders).toBe(1)
    expect(olderResult.hasRevenue).toBe(false)
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
