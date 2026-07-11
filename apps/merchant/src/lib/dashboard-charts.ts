import {
  convertCommerceAmountToSats,
  type MerchantConversationSummary,
  type ParsedOrderMessage,
  type PricingRateInput,
} from "@conduit/core"
import { getMerchantConversationPhase, type OrderPhaseTab } from "./order-phase"

export interface TimeBucketPoint {
  /** Day start (ms). */
  date: number
  /** Short axis label, e.g. "Jul 9". */
  label: string
  value: number
}

export interface StatusSlice {
  key: Exclude<OrderPhaseTab, "all"> | "cancelled"
  label: string
  count: number
}

export interface TopProduct {
  productId: string
  title: string
  quantity: number
}

export interface DashboardChartData {
  ordersByDay: TimeBucketPoint[]
  revenueByDay: TimeBucketPoint[]
  statusSlices: StatusSlice[]
  topProducts: TopProduct[]
  /** Any paid order whose amount could be normalized to sats. */
  hasRevenue: boolean
  totalOrders: number
}

const PAID_STATUSES = new Set(["paid", "shipped", "complete", "delivered"])

const STATUS_ORDER: StatusSlice["key"][] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]
const STATUS_LABELS: Record<StatusSlice["key"], string> = {
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

function orderMessageOf(
  conversation: MerchantConversationSummary
): Extract<ParsedOrderMessage, { type: "order" }> | undefined {
  return (conversation.messages ?? []).find(
    (message): message is Extract<ParsedOrderMessage, { type: "order" }> =>
      message.type === "order"
  )
}

function paymentConfirmationOf(
  conversation: MerchantConversationSummary,
  orderMessage: Extract<ParsedOrderMessage, { type: "order" }>
): Extract<ParsedOrderMessage, { type: "status_update" }> | undefined {
  return (conversation.messages ?? []).find(
    (
      message
    ): message is Extract<ParsedOrderMessage, { type: "status_update" }> =>
      message.type === "status_update" &&
      message.senderPubkey === orderMessage.recipientPubkey &&
      message.recipientPubkey === orderMessage.senderPubkey &&
      PAID_STATUSES.has(message.payload.status.toLowerCase())
  )
}

/**
 * Aggregate merchant conversations into the home-dashboard chart datasets.
 * Pure so it can be unit-tested. `now` is injectable for deterministic tests.
 */
export function buildDashboardChartData(
  conversations: MerchantConversationSummary[],
  rate: PricingRateInput,
  now: number,
  days = 30
): DashboardChartData {
  const today = startOfDay(now)
  const windowStartDate = new Date(today)
  windowStartDate.setDate(windowStartDate.getDate() - (days - 1))
  const windowStart = windowStartDate.getTime()

  const orderCountByDay = new Map<number, number>()
  const revenueByDay = new Map<number, number>()
  const statusCounts = new Map<StatusSlice["key"], number>()
  const productQty = new Map<string, { title: string; quantity: number }>()
  let hasRevenue = false

  for (const conversation of conversations) {
    const orderMessage = orderMessageOf(conversation)
    if (!orderMessage) continue
    const paymentConfirmation = paymentConfirmationOf(
      conversation,
      orderMessage
    )

    const phase = getMerchantConversationPhase(conversation)
    statusCounts.set(phase, (statusCounts.get(phase) ?? 0) + 1)

    const day = startOfDay(orderMessage.createdAt)
    if (day >= windowStart && day <= today) {
      orderCountByDay.set(day, (orderCountByDay.get(day) ?? 0) + 1)
    }

    if (paymentConfirmation) {
      const sats = convertCommerceAmountToSats(
        orderMessage.payload.subtotal,
        orderMessage.payload.currency,
        rate
      )
      if (sats != null) {
        const paymentDay = startOfDay(paymentConfirmation.createdAt)
        if (paymentDay >= windowStart && paymentDay <= today) {
          hasRevenue = true
          revenueByDay.set(
            paymentDay,
            (revenueByDay.get(paymentDay) ?? 0) + sats
          )
        }
      }
    }

    if (paymentConfirmation) {
      for (const item of orderMessage.payload.items) {
        const existing = productQty.get(item.productId)
        const title =
          item.title?.trim() ||
          existing?.title ||
          item.productId.split(":").at(-1) ||
          "Product"
        productQty.set(item.productId, {
          title,
          quantity: (existing?.quantity ?? 0) + item.quantity,
        })
      }
    }
  }

  const ordersByDay: TimeBucketPoint[] = []
  const revenuePoints: TimeBucketPoint[] = []
  for (
    let cursor = new Date(windowStart);
    cursor.getTime() <= today;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const day = cursor.getTime()
    ordersByDay.push({
      date: day,
      label: dayLabel(day),
      value: orderCountByDay.get(day) ?? 0,
    })
    revenuePoints.push({
      date: day,
      label: dayLabel(day),
      value: revenueByDay.get(day) ?? 0,
    })
  }

  const statusSlices: StatusSlice[] = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_LABELS[key],
    count: statusCounts.get(key) ?? 0,
  })).filter((slice) => slice.count > 0)

  const topProducts: TopProduct[] = [...productQty.entries()]
    .map(([productId, value]) => ({
      productId,
      title: value.title,
      quantity: value.quantity,
    }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5)

  return {
    ordersByDay,
    revenueByDay: revenuePoints,
    statusSlices,
    topProducts,
    hasRevenue,
    totalOrders: conversations.length,
  }
}
