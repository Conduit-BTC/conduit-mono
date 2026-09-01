// Shared order-status presentation + a flow-aware state model.
//
// Conduit supports two order flows that emit the same NIP-17 messages in a
// different order:
//   - prepaid ("zap-out"): the buyer pays at checkout, then the merchant
//     accepts. Payment precedes acceptance.
//   - invoice ("order-first"): the merchant accepts, sends an invoice, then the
//     buyer pays. Acceptance precedes payment.
// Buyer evidence and merchant-confirmed settlement remain separate gates. Once
// the merchant confirms settlement, acceptance is implied: the remaining
// choice is to fulfill or cancel/refund, not to accept a paid order again.
//
// Types mirror @conduit/ui's StatusPill variant and StatusStepperRow shape
// structurally so callers can pass the output straight through — without core
// depending on @conduit/ui.

import { isKnownOrderStatus, type KnownOrderStatus } from "../schemas"
import type { ParsedOrderMessage } from "./orders"

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

export interface MerchantOrderCancellation {
  /** Immutable id of the currently observed cancellation event. */
  eventId: string
  /** Non-terminal status restored by an explicit correction. */
  resumeStatus: KnownOrderStatus
}

/** Derived merchant-facing order state, independent of message ordering. */
export interface MerchantOrderState {
  status: string | null | undefined
  /** Present only when the effective cancellation can be safely reopened. */
  cancellation?: MerchantOrderCancellation
  /** Merchant-confirmed payment has been observed. */
  paid?: boolean
  /** Buyer payment evidence has been observed, but may still need verification. */
  paymentObserved?: boolean
  /** The buyer specifically reported an external payment. */
  paymentReported?: boolean
  /** Merchant acceptance has been observed anywhere in the trusted history. */
  accepted?: boolean
  /** The merchant has sent a payment request (invoice) for this order. */
  invoiceSent?: boolean
  /** A merchant shipping update has been recorded, with or without tracking. */
  shippingUpdated?: boolean
  /** False only for an explicitly digital-only order. */
  requiresShipping?: boolean
  /** Exact fulfillment lane when the order snapshot is available. */
  fulfillmentMode?: "shipping" | "pickup" | "digital" | "unknown"
  /**
   * Authenticated order and public pricing evidence prove this pickup has no
   * product or fulfillment cost. This is not payment evidence.
   */
  isZeroCostPickup?: boolean
  /** False for a known out-of-band guest; `unknown` for partial identity reads. */
  buyerReplyable?: boolean | "unknown"
}

export type OrderFlow = "prepaid" | "invoice"

// Statuses that imply the order has been accepted-or-beyond / shipped-or-beyond
// / paid, used so a later status backfills earlier gates.
const ACCEPTED_STATUSES = new Set([
  "accepted",
  "processing",
  "shipped",
  "complete",
  "delivered",
])
const SHIPPED_STATUSES = new Set(["shipped", "complete", "delivered"])
const DELIVERED_STATUSES = new Set(["delivered", "complete"])
const PAID_STATUSES = new Set(["paid", "shipped", "complete", "delivered"])
const TERMINAL_ACTION_STATUSES = new Set([
  "cancelled",
  "complete",
  "delivered",
  "refund_requested",
])

type MerchantStatusMessage = Extract<
  ParsedOrderMessage,
  { type: "status_update" }
>

export interface EffectiveMerchantOrderStatus {
  status: string | null
  cancellation?: MerchantOrderCancellation
  /** Exact cancellation proven corrected within this observed event set. */
  reopenedCancellationId?: string
}

export interface MerchantOrderParticipants {
  buyerPubkey: string
  merchantPubkey: string
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "pending").toLowerCase()
}

function safeOperationalStatus(
  status: string | null | undefined
): KnownOrderStatus | null {
  if (status == null) return null
  const normalized = normalizeStatus(status)
  if (!isKnownOrderStatus(normalized)) return null
  return TERMINAL_ACTION_STATUSES.has(normalized) ? null : normalized
}

function hasMerchantOrder(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants
): boolean {
  return messages.some(
    (message) =>
      message.type === "order" &&
      message.senderPubkey === participants.buyerPubkey &&
      message.recipientPubkey === participants.merchantPubkey
  )
}

function merchantStatusMessages(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants
): MerchantStatusMessage[] {
  const unique = new Map<string, MerchantStatusMessage>()
  for (const message of messages) {
    if (
      message.type !== "status_update" ||
      message.senderPubkey !== participants.merchantPubkey ||
      message.recipientPubkey !== participants.buyerPubkey ||
      unique.has(message.id)
    ) {
      continue
    }
    unique.set(message.id, message)
  }

  const ordered = [...unique.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )

  // An exact cancellation reference is stronger causal evidence than either
  // second-granularity timestamps or clock skew. Defer only corrections that
  // would otherwise sort before their referenced cancellation, preserving the
  // ordinary event order everywhere else. This is a projection of the observed
  // set, not a claim that a relay view is globally complete.
  const indexById = new Map(
    ordered.map((message, index) => [message.id, index] as const)
  )
  const deferredByCancellation = new Map<string, MerchantStatusMessage[]>()
  const deferredIds = new Set<string>()

  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index]
    const cancellationId = message?.payload.reopens
    const cancellationIndex = cancellationId
      ? indexById.get(cancellationId)
      : undefined
    if (
      !message ||
      !cancellationId ||
      cancellationIndex === undefined ||
      cancellationIndex <= index ||
      !safeOperationalStatus(message.payload.status) ||
      normalizeStatus(ordered[cancellationIndex]?.payload.status) !==
        "cancelled"
    ) {
      continue
    }
    const bucket = deferredByCancellation.get(cancellationId) ?? []
    bucket.push(message)
    deferredByCancellation.set(cancellationId, bucket)
    deferredIds.add(message.id)
  }

  if (deferredIds.size === 0) return ordered

  const projected: MerchantStatusMessage[] = []
  for (const message of ordered) {
    if (deferredIds.has(message.id)) continue
    projected.push(message)
    projected.push(...(deferredByCancellation.get(message.id) ?? []))
  }
  return projected
}

/**
 * Project the effective merchant status from the currently observed message
 * set. A cancellation remains active until the merchant appends a correction
 * that references that exact cancellation and restores its prior active state.
 */
export function getEffectiveMerchantOrderStatus(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants,
  fallbackStatus: string | null = null
): EffectiveMerchantOrderStatus {
  const statuses = merchantStatusMessages(messages, participants)
  if (statuses.length === 0) return { status: fallbackStatus }
  let status: string | null = hasMerchantOrder(messages, participants)
    ? "pending"
    : fallbackStatus
  let cancellation: MerchantOrderCancellation | undefined
  let reopenedCancellationId: string | undefined

  for (const message of statuses) {
    const { status: messageStatus, reopens } = message.payload
    const nextStatus = normalizeStatus(messageStatus)

    if (cancellation) {
      const correctedStatus =
        reopens === cancellation.eventId
          ? safeOperationalStatus(messageStatus)
          : null
      if (correctedStatus) {
        // The merchant-signed correction is authoritative for the restored
        // active status. Another bounded view may not have observed the same
        // pre-cancellation status that this client did.
        status = correctedStatus
        reopenedCancellationId = cancellation.eventId
        cancellation = undefined
      } else if (!reopens && nextStatus === "cancelled") {
        // A newer independent cancellation supersedes the earlier marker but
        // preserves the same pre-cancellation state for a possible correction.
        cancellation = { ...cancellation, eventId: message.id }
      } else if (!reopens && TERMINAL_ACTION_STATUSES.has(nextStatus)) {
        // A later terminal status remains a terminal progression. It can
        // supersede cancellation without reopening the active workflow.
        status = nextStatus
        cancellation = undefined
      }
      continue
    }

    // A correction marker is never a generic status transition. Stale,
    // unknown, and replayed references leave the current projection unchanged.
    if (reopens) continue

    if (
      TERMINAL_ACTION_STATUSES.has(normalizeStatus(status)) &&
      !TERMINAL_ACTION_STATUSES.has(nextStatus)
    ) {
      continue
    }

    if (nextStatus === "cancelled") {
      const resumeStatus = safeOperationalStatus(status)
      status = "cancelled"
      reopenedCancellationId = undefined
      if (resumeStatus) {
        cancellation = { eventId: message.id, resumeStatus }
      }
      continue
    }

    status = isKnownOrderStatus(nextStatus) ? nextStatus : messageStatus
  }

  return {
    status,
    ...(status === "cancelled" && cancellation ? { cancellation } : {}),
    ...(reopenedCancellationId ? { reopenedCancellationId } : {}),
  }
}

export interface MerchantOrderReopenTransition {
  status: KnownOrderStatus
  tags: string[][]
  payload: { status: KnownOrderStatus; reopens: string }
}

/** Canonical status update for correcting the effective cancellation. */
export function getMerchantOrderReopenTransition(
  state: MerchantOrderState
): MerchantOrderReopenTransition | null {
  if (normalizeStatus(state.status) !== "cancelled" || !state.cancellation) {
    return null
  }
  const { eventId, resumeStatus } = state.cancellation
  return {
    status: resumeStatus,
    tags: [
      ["status", resumeStatus],
      ["reopens", eventId],
    ],
    payload: { status: resumeStatus, reopens: eventId },
  }
}

function toState(
  input: MerchantOrderState | string | null | undefined
): MerchantOrderState {
  if (input == null || typeof input === "string")
    return { status: input ?? null }
  return input
}

export function getMerchantOrderFulfillmentMode(
  state: Pick<MerchantOrderState, "fulfillmentMode" | "requiresShipping">
): "shipping" | "pickup" | "digital" | "unknown" {
  if (state.fulfillmentMode) return state.fulfillmentMode
  if (state.requiresShipping === false) return "digital"
  return "unknown"
}

export function isMerchantOrderPaid(state: MerchantOrderState): boolean {
  return (
    !!state.paid ||
    !!state.shippingUpdated ||
    PAID_STATUSES.has(normalizeStatus(state.status))
  )
}

function isAuthorizedZeroCostPickup(state: MerchantOrderState): boolean {
  return (
    state.isZeroCostPickup === true &&
    state.fulfillmentMode === "pickup" &&
    state.requiresShipping !== true
  )
}

export function isMerchantOrderAccepted(state: MerchantOrderState): boolean {
  return (
    isMerchantOrderPaid(state) ||
    !!state.accepted ||
    ACCEPTED_STATUSES.has(normalizeStatus(state.status))
  )
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
  const normalized = normalizeStatus(status)
  return isKnownOrderStatus(normalized)
    ? ORDER_STATUS_DISPLAYS[normalized]
    : { tone: "neutral", label: titleCase(status ?? "") }
}

const ORDER_STATUS_DISPLAYS: Record<KnownOrderStatus, OrderStatusDisplay> = {
  pending: { tone: "warning", label: "Pending" },
  invoiced: { tone: "info", label: "Invoiced" },
  paid: { tone: "info", label: "Paid" },
  accepted: { tone: "info", label: "Accepted" },
  processing: { tone: "info", label: "Processing" },
  shipped: { tone: "info", label: "Shipped" },
  complete: { tone: "success", label: "Complete" },
  delivered: { tone: "success", label: "Delivered" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  refund_requested: { tone: "warning", label: "Refund requested" },
}

// Infer the flow: the buyer paid without ever being invoiced by the merchant.
// Used merchant-side, where the checkout mode isn't known.
export function deriveOrderFlow(
  input: MerchantOrderState | string | null | undefined
): OrderFlow {
  const state = toState(input)
  return (isMerchantOrderPaid(state) || !!state.paymentObserved) &&
    !state.invoiceSent
    ? "prepaid"
    : "invoice"
}

const PREPAID_CHECKOUT_MODES = new Set([
  "anonymous_public_zap",
  "public_zap_as_shopper",
  "public_zap",
])

// Map a known checkout mode to the flow. Buyers know their flow authoritatively
// from `checkoutMode`; merchants fall back to `deriveOrderFlow`.
export function orderFlowFromCheckoutMode(
  mode: string | null | undefined
): OrderFlow {
  return mode && PREPAID_CHECKOUT_MODES.has(mode) ? "prepaid" : "invoice"
}

interface StageSpec {
  key: string
  done: boolean
  complete: { title: string; subtitle: string }
  active: { title: string; subtitle: string }
  waiting: { title: string; subtitle: string }
}

export function buildOrderStatusTimeline(
  input: MerchantOrderState | string | null | undefined
): OrderTimelineStep[] {
  const state = toState(input)
  const status = normalizeStatus(state.status)
  const stoppedStatus =
    status === "cancelled" || status === "refund_requested" ? status : null
  const paid = isMerchantOrderPaid(state)
  const zeroCostPickup = isAuthorizedZeroCostPickup(state)
  const paymentObserved = paid || !!state.paymentObserved
  const acceptedGate = isMerchantOrderAccepted(state)
  const flow = deriveOrderFlow(state)
  const fulfillmentMode = getMerchantOrderFulfillmentMode(state)

  const placed: StageSpec = {
    key: "placed",
    done: true,
    complete: {
      title: "Order placed",
      subtitle: "Order received from buyer.",
    },
    active: {
      title: "Receiving order",
      subtitle: "Wait for the buyer's order details.",
    },
    waiting: {
      title: "Order",
      subtitle: "The buyer's order will appear here.",
    },
  }
  const payment: StageSpec = {
    key: "payment",
    done: paid || zeroCostPickup,
    complete: zeroCostPickup
      ? {
          title: "No payment required",
          subtitle: "Verified zero-cost pickup order.",
        }
      : {
          title: "Payment confirmed",
          subtitle: "Settlement confirmed by merchant.",
        },
    active: paymentObserved
      ? {
          title: "Confirm payment",
          subtitle: "Verify settlement before fulfilling the order.",
        }
      : flow === "prepaid"
        ? {
            title: "Await payment evidence",
            subtitle: "Verify the checkout payment when evidence arrives.",
          }
        : state.invoiceSent
          ? {
              title: "Await payment",
              subtitle: "Confirm payment after the buyer pays the invoice.",
            }
          : {
              title: "Request payment",
              subtitle:
                state.buyerReplyable === false
                  ? "Contact the buyer outside Nostr to request payment."
                  : state.buyerReplyable === "unknown"
                    ? "Recover the buyer identity before requesting payment."
                    : "Send an invoice to the buyer.",
            },
    waiting: {
      title: "Payment",
      subtitle:
        flow === "prepaid"
          ? "Verify payment evidence when it arrives."
          : "Accept the order before requesting payment.",
    },
  }
  const accepted: StageSpec = {
    key: "accepted",
    done: acceptedGate,
    complete: {
      title: "Order accepted",
      subtitle: "Merchant confirmed the order.",
    },
    active: {
      title: "Review order",
      subtitle:
        flow === "prepaid"
          ? "Accept the order after payment is confirmed."
          : "Accept the order to request payment.",
    },
    waiting: {
      title: "Order review",
      subtitle:
        flow === "prepaid"
          ? "Review the order after payment is verified."
          : "Review the order before requesting payment.",
    },
  }
  const shippedGate = !!state.shippingUpdated || SHIPPED_STATUSES.has(status)
  const shipped: StageSpec = {
    key: "shipped",
    done: shippedGate,
    complete: {
      title: "Shipped",
      subtitle: state.shippingUpdated
        ? "Tracking details recorded."
        : "Order marked shipped.",
    },
    active: {
      title: "Shipping in progress",
      subtitle: "Add tracking details to mark this order shipped.",
    },
    waiting: {
      title: "Shipping",
      subtitle: "Add tracking after payment is confirmed.",
    },
  }
  const delivered: StageSpec = {
    key: "delivered",
    done: DELIVERED_STATUSES.has(status),
    complete: {
      title: fulfillmentMode === "pickup" ? "Picked up" : "Delivered",
      subtitle:
        fulfillmentMode === "pickup" ? "Pickup completed." : "Order completed.",
    },
    active: {
      title:
        fulfillmentMode === "pickup" ? "Complete pickup" : "Confirm delivery",
      subtitle:
        fulfillmentMode === "pickup"
          ? "Mark the order complete after the buyer picks it up."
          : "Mark the order delivered when fulfillment is complete.",
    },
    waiting: {
      title: fulfillmentMode === "pickup" ? "Pickup" : "Delivery",
      subtitle:
        fulfillmentMode === "pickup"
          ? zeroCostPickup
            ? "Complete pickup after accepting the order."
            : "Complete pickup after payment is confirmed."
          : fulfillmentMode === "digital" || state.requiresShipping === false
            ? "Confirm delivery after fulfilling the digital order."
            : "Confirm delivery after shipment.",
    },
  }

  // Payment and acceptance are ordered by the flow; everything else is shared.
  const fulfillmentStages =
    fulfillmentMode === "pickup" ||
    fulfillmentMode === "digital" ||
    state.requiresShipping === false
      ? []
      : [shipped]
  const ordered = zeroCostPickup
    ? [placed, payment, accepted, ...fulfillmentStages, delivered]
    : paymentObserved && !paid
      ? [placed, payment, accepted, ...fulfillmentStages, delivered]
      : flow === "prepaid"
        ? [placed, payment, accepted, ...fulfillmentStages, delivered]
        : [placed, accepted, payment, ...fulfillmentStages, delivered]

  let frontMarked = false
  const rows: OrderTimelineStep[] = []
  for (const stage of ordered) {
    if (stage.done) {
      rows.push({
        key: stage.key,
        title: stage.complete.title,
        subtitle: stage.complete.subtitle,
        status: "complete",
      })
      continue
    }
    if (!frontMarked) {
      frontMarked = true
      if (stoppedStatus) {
        rows.push({
          key: stage.key,
          title:
            stoppedStatus === "cancelled"
              ? "Order cancelled"
              : "Refund requested",
          subtitle:
            stoppedStatus === "cancelled"
              ? "No further order action is required."
              : "Coordinate the Lightning refund outside Conduit.",
          status: stoppedStatus === "cancelled" ? "failed" : "retry_needed",
          label:
            stoppedStatus === "cancelled" ? "Cancelled" : "Refund requested",
        })
        break
      }
      rows.push({
        key: stage.key,
        title: stage.active.title,
        subtitle: stage.active.subtitle,
        status: "in_progress",
      })
      continue
    }
    rows.push({
      key: stage.key,
      title: stage.waiting.title,
      subtitle: stage.waiting.subtitle,
      status: "waiting",
    })
  }
  return rows
}

export type MerchantOrderActionKind = "primary" | "destructive"

export interface MerchantOrderAction {
  action:
    | "accept"
    | "confirm_payment"
    | "record_shipment"
    | "complete"
    | "cancel"
    | "reopen"
  /** Status to publish for state transitions; shipment publishes its domain event. */
  status?: KnownOrderStatus
  /** Button label for the action. */
  label: string
  kind: MerchantOrderActionKind
}

// The merchant's next actions, flow-aware and gate-driven. Shipping is gated on
// confirmed payment, and a shipment event leads to explicit completion rather
// than exposing the raw status vocabulary as a manual console.
export function getMerchantOrderActions(
  input: MerchantOrderState | string | null | undefined
): MerchantOrderAction[] {
  const state = toState(input)
  const status = normalizeStatus(state.status)

  if (!isKnownOrderStatus(status)) return []
  if (status === "cancelled" && state.cancellation) {
    return [
      {
        action: "reopen",
        label: "Reopen order",
        kind: "primary",
      },
    ]
  }
  if (TERMINAL_ACTION_STATUSES.has(status)) return []

  if (isMerchantOrderPaid(state)) {
    if (state.fulfillmentMode === "pickup") {
      return [
        {
          action: "cancel",
          status: "cancelled",
          label: "Cancel order",
          kind: "destructive",
        },
        {
          action: "complete",
          status: "complete",
          label: "Mark picked up / complete",
          kind: "primary",
        },
      ]
    }
    if (state.requiresShipping === false) {
      return [
        {
          action: "cancel",
          status: "cancelled",
          label: "Cancel order",
          kind: "destructive",
        },
        {
          action: "complete",
          status: "complete",
          label: "Confirm delivery",
          kind: "primary",
        },
      ]
    }
    if (!!state.shippingUpdated || status === "shipped") {
      return [
        {
          action: "complete",
          status: "complete",
          label: "Mark delivered",
          kind: "primary",
        },
      ]
    }
    return [
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "record_shipment",
        label: "Add shipping details",
        kind: "primary",
      },
    ]
  }

  if (isAuthorizedZeroCostPickup(state) && isMerchantOrderAccepted(state)) {
    return [
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "complete",
        status: "complete",
        label: "Mark picked up / complete",
        kind: "primary",
      },
    ]
  }

  if (state.paymentObserved) {
    return [
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "confirm_payment",
        status: "paid",
        label: "Confirm payment",
        kind: "primary",
      },
    ]
  }

  if (!isMerchantOrderAccepted(state)) {
    return [
      {
        action: "cancel",
        status: "cancelled",
        label: "Decline order",
        kind: "destructive",
      },
      {
        action: "accept",
        status: "accepted",
        label: "Accept order",
        kind: "primary",
      },
    ]
  }

  // Accepted-or-beyond, but already shipped → nothing left for the merchant.
  if (SHIPPED_STATUSES.has(status)) return []

  if (state.buyerReplyable === false) {
    return [
      {
        action: "cancel",
        status: "cancelled",
        label: "Cancel order",
        kind: "destructive",
      },
      {
        action: "confirm_payment",
        status: "paid",
        label: "Confirm payment received",
        kind: "primary",
      },
    ]
  }

  // Accepted but awaiting payment (invoice flow): shipping is not offered yet.
  return [
    {
      action: "cancel",
      status: "cancelled",
      label: "Cancel order",
      kind: "destructive",
    },
  ]
}
