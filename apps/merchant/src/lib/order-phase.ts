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

type MerchantAttentionTimestamps = Partial<
  Record<
    | "refund"
    | "paid"
    | "accepted"
    | "verify"
    | "order"
    | "followUp"
    | "waiting",
    number
  >
>

function earlier(current: number | undefined, candidate: number): number {
  return current === undefined || candidate < current ? candidate : current
}

function getMerchantAttentionTimestamps(
  conversation: MerchantConversationSummary
): MerchantAttentionTimestamps {
  const timestamps: MerchantAttentionTimestamps = {}
  for (const message of conversation.messages ?? []) {
    const observedAt = message.createdAt
    if (!Number.isFinite(observedAt)) continue

    if (message.type === "order") {
      timestamps.order = earlier(timestamps.order, observedAt)
    }
    if (
      message.type === "payment_proof" &&
      message.senderPubkey === conversation.buyerPubkey &&
      (isPaymentProofEvidenceMessage(message) ||
        isExternalPaymentReportMessage(message))
    ) {
      timestamps.verify = earlier(timestamps.verify, observedAt)
    }
    if (message.senderPubkey !== conversation.merchantPubkey) continue

    if (message.type === "shipping_update") {
      timestamps.followUp = earlier(timestamps.followUp, observedAt)
    } else if (message.type === "payment_request") {
      timestamps.waiting = earlier(timestamps.waiting, observedAt)
    } else if (message.type === "status_update") {
      const messageStatus = message.payload.status.toLowerCase()
      if (messageStatus === "refund_requested") {
        timestamps.refund = earlier(timestamps.refund, observedAt)
      } else if (messageStatus === "paid") {
        timestamps.paid = earlier(timestamps.paid, observedAt)
      } else if (messageStatus === "accepted") {
        timestamps.accepted = earlier(timestamps.accepted, observedAt)
        timestamps.waiting = earlier(timestamps.waiting, observedAt)
      } else if (messageStatus === "invoiced") {
        timestamps.waiting = earlier(timestamps.waiting, observedAt)
      } else if (
        messageStatus === "processing" ||
        messageStatus === "shipped"
      ) {
        timestamps.followUp = earlier(timestamps.followUp, observedAt)
      }
    }
  }
  return timestamps
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
  const attention = getMerchantAttentionTimestamps(conversation)

  if (status === "refund_requested") {
    return { rank: 0, attentionAt: attention.refund ?? observedAt }
  }
  if (queue === "shipped" || status === "processing" || status === "shipped") {
    return { rank: 4, attentionAt: attention.followUp ?? observedAt }
  }
  if (queue === "paid_fulfill") {
    return {
      rank: 1,
      attentionAt: attention.paid ?? attention.accepted ?? observedAt,
    }
  }
  if (queue === "verify_payment") {
    return { rank: 2, attentionAt: attention.verify ?? observedAt }
  }
  if (
    queue === "unpaid_review" &&
    status !== "processing" &&
    status !== "accepted" &&
    status !== "invoiced" &&
    !state.accepted &&
    !state.invoiceSent
  ) {
    return { rank: 3, attentionAt: attention.order ?? observedAt }
  }
  if (
    queue === "unpaid_review" &&
    (status === "accepted" ||
      status === "invoiced" ||
      state.accepted ||
      state.invoiceSent)
  ) {
    return { rank: 5, attentionAt: attention.waiting ?? observedAt }
  }
  if (queue === "closed") {
    return { rank: 6, attentionAt: observedAt }
  }

  return { rank: 3, attentionAt: attention.order ?? observedAt }
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
