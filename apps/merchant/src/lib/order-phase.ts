import {
  extractOrderSummary,
  getOrderStatusDisplay,
  isMerchantOrderPaid,
  type MerchantConversationSummary,
  type MerchantOrderState,
  type OrderSummary,
  type OrderStatusDisplay,
} from "@conduit/core"

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
  input: MerchantOrderState | string | null | undefined
): "pending" | "in_progress" | "completed" | "cancelled" {
  const state =
    input == null || typeof input === "string"
      ? { status: input ?? null }
      : input
  switch ((state.status ?? "pending").toLowerCase()) {
    case "complete":
    case "delivered":
      return "completed"
    case "cancelled":
      return "cancelled"
    case "pending":
      return state.paid ||
        state.paymentObserved ||
        state.accepted ||
        state.invoiceSent
        ? "in_progress"
        : "pending"
    default:
      return "in_progress"
  }
}

export function getMerchantOrderSummary(
  conversation: MerchantConversationSummary
): OrderSummary {
  return extractOrderSummary(conversation.messages ?? [], {
    buyerPubkey: conversation.buyerPubkey,
    merchantPubkey: conversation.merchantPubkey,
  })
}

export function getMerchantConversationState(
  conversation: MerchantConversationSummary
): MerchantOrderState {
  const summary = getMerchantOrderSummary(conversation)
  return {
    status: conversation.status,
    paid: summary.paymentConfirmed,
    paymentObserved: summary.paymentProofReceived,
    accepted: summary.accepted,
    invoiceSent: summary.invoiceSent,
  }
}

export function getMerchantConversationPhase(
  conversation: MerchantConversationSummary
): "pending" | "in_progress" | "completed" | "cancelled" {
  return getMerchantOrderPhase(getMerchantConversationState(conversation))
}

export function getMerchantConversationStatusDisplay(
  conversation: MerchantConversationSummary
): OrderStatusDisplay {
  const state = getMerchantConversationState(conversation)
  const status = (state.status ?? "pending").toLowerCase()
  if (status !== "pending") return getOrderStatusDisplay(state.status)
  if (state.paid) return getOrderStatusDisplay("paid")
  if (state.paymentObserved) {
    return { tone: "info", label: "Payment proof received" }
  }
  if (state.accepted) return getOrderStatusDisplay("accepted")
  if (state.invoiceSent) return getOrderStatusDisplay("invoiced")
  return getOrderStatusDisplay(state.status)
}

export function isMerchantConversationActiveFulfillment(
  conversation: MerchantConversationSummary
): boolean {
  const state = getMerchantConversationState(conversation)
  const phase = getMerchantOrderPhase(state)
  if (phase === "completed" || phase === "cancelled") return false
  const status = (state.status ?? "pending").toLowerCase()
  return (
    isMerchantOrderPaid(state) ||
    !!state.paymentObserved ||
    status === "processing" ||
    status === "shipped"
  )
}
