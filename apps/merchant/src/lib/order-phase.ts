export type OrderPhaseTab = "all" | "pending" | "in_progress" | "completed"

export const ORDER_PHASE_OPTIONS: Array<{
  value: OrderPhaseTab
  label: string
}> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
]

// Coarse bucket for an order status. Cancelled belongs to no active tab, so it
// only surfaces under "All".
export function getMerchantOrderPhase(
  status: string | null | undefined
): "pending" | "in_progress" | "completed" | "cancelled" {
  switch ((status ?? "pending").toLowerCase()) {
    case "complete":
    case "delivered":
      return "completed"
    case "cancelled":
      return "cancelled"
    case "pending":
      return "pending"
    default:
      return "in_progress"
  }
}
