import {
  convertCommerceAmountToSats,
  isPaymentProofEvidenceMessage,
  type MerchantConversationSummary,
  type ParsedOrderMessage,
  type PricingRateInput,
} from "@conduit/core"
import { getMerchantOrderPhase, type OrderPhaseTab } from "./order-phase"

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

const DAY_MS = 24 * 60 * 60 * 1000
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

function isPaid(conversation: MerchantConversationSummary): boolean {
  if (PAID_STATUSES.has((conversation.status ?? "").toLowerCase())) return true
  return (conversation.messages ?? []).some(isPaymentProofEvidenceMessage)
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
  const windowStart = today - (days - 1) * DAY_MS

  const orderCountByDay = new Map<number, number>()
  const revenueByDay = new Map<number, number>()
  const statusCounts = new Map<StatusSlice["key"], number>()
  const productQty = new Map<string, { title: string; quantity: number }>()
  let hasRevenue = false

  for (const conversation of conversations) {
    const orderMessage = orderMessageOf(conversation)
    if (!orderMessage) continue

    const phase = getMerchantOrderPhase(conversation.status)
    statusCounts.set(phase, (statusCounts.get(phase) ?? 0) + 1)

    const day = startOfDay(orderMessage.createdAt)
    if (day >= windowStart && day <= today) {
      orderCountByDay.set(day, (orderCountByDay.get(day) ?? 0) + 1)

      if (isPaid(conversation)) {
        const sats = convertCommerceAmountToSats(
          orderMessage.payload.subtotal,
          orderMessage.payload.currency,
          rate
        )
        if (sats != null) {
          hasRevenue = true
          revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + sats)
        }
      }
    }

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

  const ordersByDay: TimeBucketPoint[] = []
  const revenuePoints: TimeBucketPoint[] = []
  for (let day = windowStart; day <= today; day += DAY_MS) {
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
