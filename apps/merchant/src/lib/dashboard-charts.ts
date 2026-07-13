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
  /** Full bucket label used by the bar tooltip. */
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
  ordersOverTime: TimeBucketPoint[]
  revenueOverTime: TimeBucketPoint[]
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
  /** Optional time-series layout. Custom ranges default to daily buckets. */
  bucket?: DashboardTimeBucketLayout
}

export type DashboardRangePreset = "week" | "month" | "quarter" | "year"

export type DashboardTimeBucketUnit = "day" | "week" | "month" | "quarter"

export interface DashboardTimeBucketLayout {
  unit: DashboardTimeBucketUnit
  count: number
}

export const DASHBOARD_RANGE_OPTIONS: Array<{
  value: DashboardRangePreset
  label: string
  bucket: DashboardTimeBucketLayout
}> = [
  { value: "week", label: "Past week", bucket: { unit: "day", count: 7 } },
  {
    value: "month",
    label: "Past month",
    bucket: { unit: "week", count: 4 },
  },
  {
    value: "quarter",
    label: "Past quarter",
    bucket: { unit: "month", count: 3 },
  },
  {
    value: "year",
    label: "Past year",
    bucket: { unit: "quarter", count: 4 },
  },
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
  const end = startOfDay(now)
  const bucket =
    DASHBOARD_RANGE_OPTIONS.find((option) => option.value === preset)?.bucket ??
    DASHBOARD_RANGE_OPTIONS[1]!.bucket
  const windows = createRollingBucketWindows(end, bucket)
  return { start: windows[0]!.start, end, bucket }
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

function shiftDays(ms: number, days: number): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return startOfDay(date.getTime())
}

function shiftMonthsClamped(ms: number, months: number): number {
  const date = new Date(ms)
  const targetDay = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() + months)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(targetDay, lastDay))
  return startOfDay(date.getTime())
}

function shiftBucketBoundary(
  ms: number,
  unit: DashboardTimeBucketUnit,
  amount: number
): number {
  switch (unit) {
    case "day":
      return shiftDays(ms, amount)
    case "week":
      return shiftDays(ms, amount * 7)
    case "month":
      return shiftMonthsClamped(ms, amount)
    case "quarter":
      return shiftMonthsClamped(ms, amount * 3)
  }
}

function shortDateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

function bucketLabel(start: number, end: number): string {
  if (start === end) {
    return new Date(start).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }
  const startDate = new Date(start)
  const endDate = new Date(end)
  const startLabel = startDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(startDate.getFullYear() !== endDate.getFullYear()
      ? { year: "numeric" }
      : {}),
  })
  const endLabel = endDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
  return `${startLabel}–${endLabel}`
}

function bucketAxisLabel(
  start: number,
  end: number,
  unit: DashboardTimeBucketUnit
): string {
  switch (unit) {
    case "day":
      return shortDateLabel(start)
    case "week":
      return shortDateLabel(start)
    case "month":
      return new Date(end).toLocaleDateString(undefined, { month: "short" })
    case "quarter":
      return new Date(end).toLocaleDateString(undefined, {
        month: "short",
        year: "2-digit",
      })
  }
}

interface TimeBucketWindow {
  start: number
  end: number
  label: string
  axisLabel: string
}

function createRollingBucketWindows(
  end: number,
  layout: DashboardTimeBucketLayout
): TimeBucketWindow[] {
  if (!Number.isInteger(layout.count) || layout.count < 1) {
    throw new Error("Dashboard time bucket count must be a positive integer")
  }
  const boundaries = Array.from({ length: layout.count + 1 }, (_, index) =>
    shiftBucketBoundary(end, layout.unit, index - layout.count)
  )
  return Array.from({ length: layout.count }, (_, index) => {
    const start = shiftDays(boundaries[index]!, 1)
    const bucketEnd = boundaries[index + 1]!
    return {
      start,
      end: bucketEnd,
      label: bucketLabel(start, bucketEnd),
      axisLabel: bucketAxisLabel(start, bucketEnd, layout.unit),
    }
  })
}

function createDailyBucketWindows(
  start: number,
  end: number
): TimeBucketWindow[] {
  const windows: TimeBucketWindow[] = []
  for (let cursor = start; cursor <= end; cursor = shiftDays(cursor, 1)) {
    windows.push({
      start: cursor,
      end: cursor,
      label: bucketLabel(cursor, cursor),
      axisLabel: shortDateLabel(cursor),
    })
  }
  return windows
}

function createTimeBucketWindows(
  range: DashboardDateRange,
  windowStart: number,
  windowEnd: number
): TimeBucketWindow[] {
  if (!range.bucket) return createDailyBucketWindows(windowStart, windowEnd)

  return createRollingBucketWindows(windowEnd, range.bucket)
    .map((bucket) => {
      const start = Math.max(bucket.start, windowStart)
      return {
        ...bucket,
        start,
        label: bucketLabel(start, bucket.end),
        axisLabel: bucketAxisLabel(start, bucket.end, range.bucket!.unit),
      }
    })
    .filter((bucket) => bucket.start <= bucket.end)
}

function findTimeBucket(
  buckets: TimeBucketWindow[],
  timestamp: number
): TimeBucketWindow | undefined {
  return buckets.find(
    (bucket) => timestamp >= bucket.start && timestamp <= bucket.end
  )
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
  const timeBuckets = createTimeBucketWindows(range, windowStart, windowEnd)

  const orderCountByBucket = new Map<number, number>()
  const revenueByBucket = new Map<number, number>()
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
      const bucket = findTimeBucket(timeBuckets, day)
      if (bucket) {
        orderCountByBucket.set(
          bucket.start,
          (orderCountByBucket.get(bucket.start) ?? 0) + 1
        )
      }
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
        const bucket = findTimeBucket(timeBuckets, paymentDay)
        if (bucket) {
          revenueByBucket.set(
            bucket.start,
            (revenueByBucket.get(bucket.start) ?? 0) + sats
          )
        }
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

  const ordersOverTime: TimeBucketPoint[] = timeBuckets.map((bucket) => ({
    date: bucket.start,
    label: bucket.label,
    axisLabel: bucket.axisLabel,
    value: orderCountByBucket.get(bucket.start) ?? 0,
  }))
  const revenueOverTime: TimeBucketPoint[] = timeBuckets.map((bucket) => ({
    date: bucket.start,
    label: bucket.label,
    axisLabel: bucket.axisLabel,
    value: revenueByBucket.get(bucket.start) ?? 0,
  }))

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
    ordersOverTime,
    revenueOverTime,
    statusSlices,
    topProducts,
    hasRevenue,
    totalOrders,
  }
}
