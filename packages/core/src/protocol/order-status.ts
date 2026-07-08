// Shared order-status presentation, keyed off the order's `status` string.
// Market /orders derives a richer header pill + timeline from a buyer-side
// OrderViewModel; these helpers cover the common case (both apps, future
// surfaces) from just the status. Types mirror @conduit/ui's StatusPill variant
// and StatusStepperRow shape structurally so callers can pass the output
// straight through — without core depending on @conduit/ui.

export type OrderStatusTone =
  "success" | "info" | "warning" | "error" | "neutral"

export interface OrderStatusDisplay {
  tone: OrderStatusTone
  label: string
}

export type OrderTimelineStepStatus =
  "waiting" | "in_progress" | "complete" | "failed" | "retry_needed"

export interface OrderTimelineStep {
  key: string
  title: string
  subtitle?: string
  status: OrderTimelineStepStatus
  label?: string
}

function titleCase(value: string): string {
  return (
    value
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase()) || "Unknown"
  )
}

export function getOrderStatusDisplay(
  status: string | null | undefined
): OrderStatusDisplay {
  switch ((status ?? "pending").toLowerCase()) {
    case "pending":
      return { tone: "warning", label: "Pending" }
    case "paid":
      return { tone: "info", label: "Paid" }
    case "accepted":
      return { tone: "info", label: "Accepted" }
    case "shipped":
      return { tone: "info", label: "Shipped" }
    case "delivered":
      return { tone: "success", label: "Delivered" }
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" }
    case "refund_requested":
      return { tone: "warning", label: "Refund requested" }
    default:
      return { tone: "neutral", label: titleCase(status ?? "") }
  }
}

const ORDER_TIMELINE_STAGES: Array<{
  key: string
  title: string
  subtitle: string
}> = [
  {
    key: "placed",
    title: "Order placed",
    subtitle: "Order received from buyer",
  },
  { key: "payment", title: "Payment received", subtitle: "Lightning payment" },
  {
    key: "accepted",
    title: "Merchant accepted",
    subtitle: "Order confirmed",
  },
  { key: "shipped", title: "Shipped", subtitle: "Sent to buyer" },
  { key: "delivered", title: "Delivered", subtitle: "Order completed" },
]

const ORDER_STATUS_PROGRESS_INDEX: Record<string, number> = {
  pending: 0,
  paid: 1,
  accepted: 2,
  shipped: 3,
  delivered: 4,
  refund_requested: 4,
}

export function buildOrderStatusTimeline(
  status: string | null | undefined
): OrderTimelineStep[] {
  const normalized = (status ?? "pending").toLowerCase()

  if (normalized === "cancelled") {
    return ORDER_TIMELINE_STAGES.map((stage, index) => {
      const stepStatus: OrderTimelineStepStatus =
        index === 0 ? "complete" : index === 1 ? "failed" : "waiting"
      return {
        key: stage.key,
        title: stage.title,
        subtitle: index === 1 ? "Order cancelled" : stage.subtitle,
        status: stepStatus,
        ...(index === 1 ? { label: "Cancelled" } : {}),
      }
    })
  }

  const currentIndex = ORDER_STATUS_PROGRESS_INDEX[normalized] ?? 0
  return ORDER_TIMELINE_STAGES.map((stage, index) => {
    let stepStatus: OrderTimelineStepStatus
    if (index <= currentIndex) stepStatus = "complete"
    else if (index === currentIndex + 1) stepStatus = "in_progress"
    else stepStatus = "waiting"
    return {
      key: stage.key,
      title: stage.title,
      subtitle: stage.subtitle,
      status: stepStatus,
    }
  })
}
