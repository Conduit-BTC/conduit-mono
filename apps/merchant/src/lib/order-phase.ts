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

export type OrderQueueTab =
  | "all"
  | "paid_fulfill"
  | "verify_payment"
  | "unpaid_review"
  | "shipped"
  | "closed"

export const ORDER_PHASE_OPTIONS: Array<{
  value: OrderQueueTab
  label: string
}> = [
  { value: "all", label: "All" },
  { value: "paid_fulfill", label: "Paid — fulfill" },
  { value: "verify_payment", label: "Payment reported — verify" },
  { value: "unpaid_review", label: "Unpaid — review" },
  { value: "shipped", label: "Shipped" },
  { value: "closed", label: "Closed" },
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
  const terminalStatus = [...(conversation.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.type === "status_update" &&
        message.senderPubkey === conversation.merchantPubkey &&
        ["cancelled", "complete", "delivered", "refund_requested"].includes(
          message.payload.status
        )
    )
  return {
    status:
      terminalStatus?.type === "status_update"
        ? terminalStatus.payload.status
        : conversation.status,
    paid: summary.paymentConfirmed,
    paymentObserved:
      summary.paymentProofReceived || summary.paymentReportReceived,
    paymentReported: summary.externalPaymentReportReceived,
    accepted: summary.accepted,
    invoiceSent: summary.invoiceSent,
    shippingUpdated: summary.shippingUpdateReceived,
  }
}

export type MerchantOrderQueue = Exclude<OrderQueueTab, "all">
export type MerchantOrderCommunication =
  "nostr_replyable" | "guest_out_of_band" | "unknown"

export function getMerchantConversationCommunication(
  conversation: MerchantConversationSummary
): MerchantOrderCommunication {
  const summary = getMerchantOrderSummary(conversation)
  if (summary.buyerIdentityKind === "guest_ephemeral") {
    return "guest_out_of_band"
  }
  if (
    summary.buyerIdentityKind === "signed_in" ||
    (conversation.messages ?? []).some((message) => message.type === "order")
  ) {
    return "nostr_replyable"
  }
  return "unknown"
}

export function getMerchantConversationQueue(
  conversation: MerchantConversationSummary
): MerchantOrderQueue {
  const state = getMerchantConversationState(conversation)
  const status = (state.status ?? "pending").toLowerCase()
  if (
    status === "cancelled" ||
    status === "complete" ||
    status === "delivered" ||
    status === "refund_requested"
  ) {
    return "closed"
  }
  if (state.shippingUpdated || status === "shipped") return "shipped"
  if (state.paid || status === "paid") return "paid_fulfill"
  if (state.paymentObserved) return "verify_payment"
  return "unpaid_review"
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
  if (
    status === "cancelled" ||
    status === "complete" ||
    status === "delivered" ||
    status === "refund_requested"
  ) {
    return getOrderStatusDisplay(state.status)
  }
  if (state.shippingUpdated || status === "shipped") {
    return getOrderStatusDisplay("shipped")
  }
  if (isMerchantOrderPaid(state)) return getOrderStatusDisplay("paid")
  if (state.paymentReported) {
    return { tone: "warning", label: "Payment reported — verify" }
  }
  if (state.paymentObserved) {
    return { tone: "info", label: "Payment proof received" }
  }
  if (state.accepted) return getOrderStatusDisplay("accepted")
  if (state.invoiceSent) return getOrderStatusDisplay("invoiced")
  if (status !== "pending") return getOrderStatusDisplay(state.status)
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
