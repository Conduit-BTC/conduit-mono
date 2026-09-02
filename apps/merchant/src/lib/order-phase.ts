import {
  extractOrderSummary,
  formatNpub,
  getOrderStatusDisplay,
  getProfileName,
  isExternalPaymentReportMessage,
  isMerchantOrderAccepted,
  isMerchantOrderPaid,
  isPaymentProofEvidenceMessage,
  type MerchantConversationSummary,
  type MerchantOrderState,
  type OrderSummary,
  type OrderStatusDisplay,
  type Profile,
} from "@conduit/core"
import { hasExactZeroCostPickupTerms } from "./order-action-view"

export type OrderPhaseTab = "all" | "pending" | "in_progress" | "completed"

export type OrderQueueTab =
  | "all"
  | "paid_fulfill"
  | "verify_payment"
  | "unpaid_review"
  | "shipped"
  | "closed"

export type MerchantOrderSort = "priority" | "recent"

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

export const ORDER_SORT_OPTIONS: Array<{
  value: MerchantOrderSort
  label: string
}> = [
  { value: "priority", label: "Priority" },
  { value: "recent", label: "Recent activity" },
]

export function isOrderQueueTab(value: unknown): value is OrderQueueTab {
  return ORDER_PHASE_OPTIONS.some((option) => option.value === value)
}

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

export function isMerchantGuestOrder(
  conversation: MerchantConversationSummary
): boolean {
  return (
    getMerchantOrderSummary(conversation).buyerIdentityKind ===
    "guest_ephemeral"
  )
}

export function getMerchantBuyerDisplayName(
  conversation: MerchantConversationSummary,
  profile?: Profile
): string {
  if (isMerchantGuestOrder(conversation)) return "Guest shopper"
  return getProfileName(profile) || formatNpub(conversation.buyerPubkey, 8)
}

export function getMerchantOrderRequiresShipping(
  items: Array<{
    productId: string
    format?: "physical" | "digital"
  }>,
  productLookup: Map<
    string,
    { format: "physical" | "digital" | null | undefined }
  >
): boolean | undefined {
  if (items.length === 0) return undefined

  let hasUnresolvedItem = false
  for (const item of items) {
    if (item.format === "physical") return true

    const format = productLookup.get(item.productId)?.format
    if (format === "physical") return true
    if (format !== "digital") hasUnresolvedItem = true
  }

  return hasUnresolvedItem ? undefined : false
}

export type MerchantOrderFulfillmentMode =
  "digital" | "shipping" | "pickup" | "unknown"

type PickupFulfillment = Extract<
  NonNullable<OrderSummary["items"][number]["fulfillment"]>,
  { type: "pickup" }
>

export interface MerchantOrderPickupContext {
  organizerPubkey: PickupFulfillment["organizerPubkey"]
  calendar: PickupFulfillment["calendar"]
  collection: PickupFulfillment["collection"]
  option: PickupFulfillment["option"]
}

export interface MerchantOrderFulfillment {
  mode: MerchantOrderFulfillmentMode
  requiresShipping: boolean
  pickup: MerchantOrderPickupContext | null
  /** Any buyer-authored pickup claim restricts shipping actions until verified. */
  hasPickupClaim: boolean
}

function getOrderItemFulfillmentMode(
  item: OrderSummary["items"][number]
): MerchantOrderFulfillmentMode {
  if (item.fulfillment) return item.fulfillment.type
  // The listing format is part of the signed order snapshot. Legacy digital
  // orders can therefore skip shipping; a legacy physical item cannot prove
  // whether the buyer selected shipment or pickup.
  return item.format === "digital" ? "digital" : "unknown"
}

function hasSamePickupContext(
  left: PickupFulfillment,
  right: PickupFulfillment
): boolean {
  return (
    left.organizerPubkey === right.organizerPubkey &&
    left.calendar.coordinate === right.calendar.coordinate &&
    left.calendar.eventId === right.calendar.eventId &&
    left.calendar.createdAt === right.calendar.createdAt &&
    left.collection.coordinate === right.collection.coordinate &&
    left.collection.eventId === right.collection.eventId &&
    left.collection.createdAt === right.collection.createdAt &&
    left.option.coordinate === right.option.coordinate &&
    left.option.eventId === right.option.eventId &&
    left.option.createdAt === right.option.createdAt &&
    left.option.title === right.option.title &&
    left.option.location === right.option.location &&
    left.option.geohash === right.option.geohash
  )
}

/**
 * Derive fulfillment only from the immutable order snapshot. Mixed,
 * unsupported, or conflicting pickup evidence stays action-restricted instead
 * of being reinterpreted as a shipment. Legacy physical evidence without a
 * pickup claim remains compatible with the shipping workflow.
 */
export function getMerchantOrderFulfillment(
  items: OrderSummary["items"]
): MerchantOrderFulfillment {
  const hasPickupClaim = items.some(
    (item) => item.fulfillment?.type === "pickup"
  )
  if (items.length === 0) {
    return {
      mode: "unknown",
      requiresShipping: true,
      pickup: null,
      hasPickupClaim: false,
    }
  }

  const itemModes = items.map(getOrderItemFulfillmentMode)
  const physicalModes = new Set(
    itemModes.filter((mode) => mode !== "digital" && mode !== "unknown")
  )
  const invalidPickupFormat = items.some(
    (item) => item.fulfillment?.type === "pickup" && item.format !== "physical"
  )
  if (
    invalidPickupFormat ||
    itemModes.includes("unknown") ||
    physicalModes.size > 1
  ) {
    return {
      mode: "unknown",
      requiresShipping: !hasPickupClaim,
      pickup: null,
      hasPickupClaim,
    }
  }

  // Digital lines need no separate handoff. A cart may therefore contain
  // downloads alongside one coherent physical lane without becoming mixed.
  const mode = physicalModes.values().next().value ?? "digital"

  if (mode !== "pickup") {
    return {
      mode,
      requiresShipping: mode === "shipping",
      pickup: null,
      hasPickupClaim,
    }
  }

  const pickupFulfillments = items.flatMap((item) =>
    item.fulfillment?.type === "pickup" ? [item.fulfillment] : []
  )
  const firstPickup = pickupFulfillments[0]
  if (
    !firstPickup ||
    (!firstPickup.option.location && !firstPickup.option.geohash) ||
    pickupFulfillments.some(
      (fulfillment) => !hasSamePickupContext(firstPickup, fulfillment)
    )
  ) {
    return {
      mode: "unknown",
      requiresShipping: false,
      pickup: null,
      hasPickupClaim: true,
    }
  }

  return {
    mode: "pickup",
    requiresShipping: false,
    pickup: {
      organizerPubkey: firstPickup.organizerPubkey,
      calendar: firstPickup.calendar,
      collection: firstPickup.collection,
      option: firstPickup.option,
    },
    hasPickupClaim: true,
  }
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
  const summary = getMerchantOrderSummary(conversation)
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
  const fulfillment = getMerchantOrderFulfillment(summary.items)
  const acceptedZeroCostPickup =
    isMerchantOrderAccepted(state) &&
    hasExactZeroCostPickupTerms({
      order: {
        items: summary.items,
        subtotal: summary.subtotal,
        shippingCostSats: summary.shippingCostSats ?? undefined,
      },
      fulfillmentMode: fulfillment.mode,
      requiresShipping: fulfillment.requiresShipping,
    })
  // This queue placement keeps a free pickup visible so selecting it can run
  // the live public-authorization gate. It is workflow classification, not
  // synthetic payment evidence; fulfillment stays blocked until verification.
  if (state.paid || status === "paid" || acceptedZeroCostPickup) {
    return "paid_fulfill"
  }
  if (state.paymentObserved) return "verify_payment"
  return "unpaid_review"
}

type MerchantConversationPriority = {
  rank: number
  attentionAt: number
}

type MerchantOrderMessage = NonNullable<
  MerchantConversationSummary["messages"]
>[number]

function getEarliestMessageAt(
  messages: MerchantOrderMessage[],
  matches: (message: MerchantOrderMessage) => boolean
): number | undefined {
  let earliestAt: number | undefined
  for (const message of messages) {
    if (!Number.isFinite(message.createdAt) || !matches(message)) continue
    earliestAt =
      earliestAt === undefined
        ? message.createdAt
        : Math.min(earliestAt, message.createdAt)
  }
  return earliestAt
}

function getMerchantConversationPriority(
  conversation: MerchantConversationSummary
): MerchantConversationPriority {
  const state = getMerchantConversationState(conversation)
  const status = (state.status ?? "pending").toLowerCase()
  const queue = getMerchantConversationQueue(conversation)
  const observedAt = Number.isFinite(conversation.latestAt)
    ? conversation.latestAt
    : 0
  const messages = conversation.messages ?? []
  const fromBuyer = (message: MerchantOrderMessage): boolean =>
    message.senderPubkey === conversation.buyerPubkey &&
    message.recipientPubkey === conversation.merchantPubkey
  const fromMerchant = (message: MerchantOrderMessage): boolean =>
    message.senderPubkey === conversation.merchantPubkey &&
    message.recipientPubkey === conversation.buyerPubkey
  const hasMerchantStatus = (
    message: MerchantOrderMessage,
    ...statuses: string[]
  ): boolean =>
    fromMerchant(message) &&
    message.type === "status_update" &&
    statuses.includes(message.payload.status.toLowerCase())
  let rank = 3
  let matchesTask: ((message: MerchantOrderMessage) => boolean) | null = (
    message
  ) => fromBuyer(message) && message.type === "order"

  if (status === "refund_requested") {
    rank = 0
    matchesTask = (message) => hasMerchantStatus(message, "refund_requested")
  } else if (
    queue === "shipped" ||
    status === "processing" ||
    status === "shipped"
  ) {
    rank = 4
    matchesTask = (message) =>
      (fromMerchant(message) && message.type === "shipping_update") ||
      hasMerchantStatus(message, "processing", "shipped")
  } else if (queue === "paid_fulfill") {
    rank = 1
    const taskStatus = messages.some(
      (message) =>
        Number.isFinite(message.createdAt) && hasMerchantStatus(message, "paid")
    )
      ? "paid"
      : "accepted"
    matchesTask = (message) => hasMerchantStatus(message, taskStatus)
  } else if (queue === "verify_payment") {
    rank = 2
    matchesTask = (message) =>
      fromBuyer(message) &&
      message.type === "payment_proof" &&
      (isPaymentProofEvidenceMessage(message) ||
        isExternalPaymentReportMessage(message))
  } else if (
    queue === "unpaid_review" &&
    (status === "accepted" ||
      status === "invoiced" ||
      state.accepted ||
      state.invoiceSent)
  ) {
    rank = 5
    matchesTask = (message) =>
      (fromMerchant(message) && message.type === "payment_request") ||
      hasMerchantStatus(message, "accepted", "invoiced")
  } else if (queue === "closed") {
    rank = 6
    matchesTask = null
  }

  return {
    rank,
    attentionAt:
      (matchesTask && getEarliestMessageAt(messages, matchesTask)) ??
      observedAt,
  }
}

function compareOrderIds(
  left: MerchantConversationSummary,
  right: MerchantConversationSummary
): number {
  if (left.orderId === right.orderId) return 0
  return left.orderId < right.orderId ? -1 : 1
}

export function sortMerchantConversations(
  conversations: MerchantConversationSummary[],
  sort: MerchantOrderSort
): MerchantConversationSummary[] {
  if (sort === "recent") {
    return [...conversations].sort(
      (left, right) =>
        right.latestAt - left.latestAt || compareOrderIds(left, right)
    )
  }

  return conversations
    .map((conversation) => ({
      conversation,
      priority: getMerchantConversationPriority(conversation),
    }))
    .sort((left, right) => {
      const rankDelta = left.priority.rank - right.priority.rank
      if (rankDelta !== 0) return rankDelta

      const activityDelta =
        left.priority.rank === 6
          ? right.priority.attentionAt - left.priority.attentionAt
          : left.priority.attentionAt - right.priority.attentionAt
      return (
        activityDelta || compareOrderIds(left.conversation, right.conversation)
      )
    })
    .map(({ conversation }) => conversation)
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
