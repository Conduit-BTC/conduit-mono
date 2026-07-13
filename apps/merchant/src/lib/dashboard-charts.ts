import {
  convertCommerceAmountToSats,
  isExternalPaymentReportMessage,
  isMerchantOrderPaid,
  isPaymentProofEvidenceMessage,
  type MerchantConversationSummary,
  type ParsedOrderMessage,
  type PricingRateInput,
} from "@conduit/core"
import { getMerchantConversationPhase, type OrderPhaseTab } from "./order-phase"

export interface TimeBucketPoint {
  /** Bucket start (ms). */
  date: number
  /** Short axis label, e.g. "Jul 9". */
  label: string
  /** Optional compact label used only on the x-axis. */
  axisLabel?: string
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

export interface DashboardDateRange {
  /** Inclusive start timestamp. */
  start: number
  /** Inclusive end timestamp. */
  end: number
}

export type DashboardRangePreset = "week" | "month" | "quarter" | "year"

export const DASHBOARD_RANGE_OPTIONS: Array<{
  value: DashboardRangePreset
  label: string
  days: number
}> = [
  { value: "week", label: "Past week", days: 7 },
  { value: "month", label: "Past month", days: 30 },
  { value: "quarter", label: "Past quarter", days: 90 },
  { value: "year", label: "Past year", days: 365 },
]

export const DEFAULT_DASHBOARD_RANGE: DashboardRangePreset = "month"

export function isDashboardRangePreset(
  value: string
): value is DashboardRangePreset {
  return DASHBOARD_RANGE_OPTIONS.some((option) => option.value === value)
}

export function getDashboardRangeLabel(preset: DashboardRangePreset): string {
  return (
    DASHBOARD_RANGE_OPTIONS.find((option) => option.value === preset)?.label ??
    "Past month"
  )
}

export function resolveDashboardPresetRange(
  preset: DashboardRangePreset,
  now: number
): DashboardDateRange {
  const days =
    DASHBOARD_RANGE_OPTIONS.find((option) => option.value === preset)?.days ??
    30
  const end = startOfDay(now)
  const startDate = new Date(end)
  startDate.setDate(startDate.getDate() - (days - 1))
  return { start: startDate.getTime(), end }
}

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

function axisLabel(ms: number, rangeDays: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    ...(rangeDays > 180 ? { year: "2-digit" } : { day: "numeric" }),
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
      isMerchantOrderPaid({ status: message.payload.status })
  )
}

function paymentCashflowTimestamp(
  conversation: MerchantConversationSummary,
  orderMessage: Extract<ParsedOrderMessage, { type: "order" }>,
  confirmation: Extract<ParsedOrderMessage, { type: "status_update" }>
): number {
  const evidence = (conversation.messages ?? [])
    .filter(
      (message) =>
        message.senderPubkey === orderMessage.senderPubkey &&
        message.recipientPubkey === orderMessage.recipientPubkey &&
        (isPaymentProofEvidenceMessage(message) ||
          isExternalPaymentReportMessage(message))
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0]

  // The merchant confirmation is an operational action, not the cashflow
  // event. Legacy orders without payment evidence retain the old fallback.
  return evidence?.createdAt ?? confirmation.createdAt
}

/**
 * Aggregate merchant conversations into the home-dashboard chart datasets.
 * Pure so it can be unit-tested. The caller supplies an explicit inclusive
 * date range so preset and future custom/historical selectors share one path.
 */
export function buildDashboardChartData(
  conversations: MerchantConversationSummary[],
  rate: PricingRateInput,
  range: DashboardDateRange
): DashboardChartData {
  const windowStart = startOfDay(range.start)
  const windowEnd = startOfDay(range.end)
  if (windowStart > windowEnd) {
    throw new Error("Dashboard date range start must not be after its end")
  }
  const rangeDays = Math.floor((windowEnd - windowStart) / 86_400_000) + 1

  const orderCountByDay = new Map<number, number>()
  const revenueByDay = new Map<number, number>()
  const statusCounts = new Map<StatusSlice["key"], number>()
  const productQty = new Map<string, { title: string; quantity: number }>()
  let hasRevenue = false
  let totalOrders = 0

  for (const conversation of conversations) {
    const orderMessage = orderMessageOf(conversation)
    if (!orderMessage) continue
    const paymentConfirmation = paymentConfirmationOf(
      conversation,
      orderMessage
    )

    const day = startOfDay(orderMessage.createdAt)
    const orderInRange = day >= windowStart && day <= windowEnd
    if (orderInRange) {
      totalOrders += 1
      orderCountByDay.set(day, (orderCountByDay.get(day) ?? 0) + 1)
      const phase = getMerchantConversationPhase(conversation)
      statusCounts.set(phase, (statusCounts.get(phase) ?? 0) + 1)
    }

    if (paymentConfirmation) {
      const paymentDay = startOfDay(
        paymentCashflowTimestamp(
          conversation,
          orderMessage,
          paymentConfirmation
        )
      )
      const paymentInRange =
        paymentDay >= windowStart && paymentDay <= windowEnd
      const sats = convertCommerceAmountToSats(
        orderMessage.payload.subtotal,
        orderMessage.payload.currency,
        rate
      )
      if (sats != null && paymentInRange) {
        hasRevenue = true
        revenueByDay.set(paymentDay, (revenueByDay.get(paymentDay) ?? 0) + sats)
      }

      if (paymentInRange) {
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
  }

  const ordersByDay: TimeBucketPoint[] = []
  const revenuePoints: TimeBucketPoint[] = []
  for (
    let cursor = new Date(windowStart);
    cursor.getTime() <= windowEnd;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    const day = cursor.getTime()
    ordersByDay.push({
      date: day,
      label: dayLabel(day),
      axisLabel: axisLabel(day, rangeDays),
      value: orderCountByDay.get(day) ?? 0,
    })
    revenuePoints.push({
      date: day,
      label: dayLabel(day),
      axisLabel: axisLabel(day, rangeDays),
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
    totalOrders,
  }
}
