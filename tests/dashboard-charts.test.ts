import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
} from "@conduit/core"
import { buildDashboardChartData } from "../apps/merchant/src/lib/dashboard-charts"

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
  subtotal: number
): MerchantConversationSummary {
  const order = orderMessage(orderId, createdAt, items, subtotal)
  const statusMessage: ParsedOrderMessage | null = status
    ? ({
        id: `${orderId}-status`,
        orderId,
        type: "status_update",
        createdAt: createdAt + 1_000,
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
    latestAt: statusMessage?.createdAt ?? createdAt,
    latestType: statusMessage?.type ?? "order",
    status,
    totalSummary: `${subtotal} SATS`,
    preview: "Order",
    messageCount: messages.length,
    messages,
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

  const data = buildDashboardChartData(conversations, null, NOW, 30)

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

  it("sums revenue for paid orders only", () => {
    expect(data.hasRevenue).toBe(true)
    // Only the shipped (paid) order counts; pending does not.
    expect(data.revenueByDay[data.revenueByDay.length - 1]?.value).toBe(50)
  })

  it("ranks top products by total quantity", () => {
    expect(data.topProducts[0]).toEqual({
      productId: "p:w",
      title: "Widget",
      quantity: 1,
    })
    expect(data.totalOrders).toBe(3)
  })
})
