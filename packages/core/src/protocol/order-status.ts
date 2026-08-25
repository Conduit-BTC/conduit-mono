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

/** Derived merchant-facing order state, independent of message ordering. */
export interface MerchantOrderCancellation {
  /** Immutable id of the cancellation event currently closing the order. */
  eventId: string
  /** Non-terminal status an explicit correction must restore. */
  resumeStatus: KnownOrderStatus
}

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
const NON_REOPENABLE_TERMINAL_STATUSES = new Set([
  "complete",
  "delivered",
  "refund_requested",
])
function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "pending").toLowerCase()
}

export interface MerchantOrderParticipants {
  buyerPubkey: string
  merchantPubkey: string
}

export interface EffectiveMerchantOrderStatus {
  status: string | null
  /** Merchant status events accepted by the lifecycle reducer. */
  appliedStatusEventIds: string[]
  /** Omitted for non-cancelled or non-safely-reopenable terminal states. */
  cancellation?: MerchantOrderCancellation
}

type MerchantStatusMessage = Extract<
  ParsedOrderMessage,
  { type: "status_update" }
>

interface SameSecondReopenPair {
  positionAt: number
  cancellationId: string
  reopenId: string
  lowerId: string
  upperId: string
}

function messagePositionTime(
  message: Pick<ParsedOrderMessage, "createdAt" | "authoredAt">
): number {
  return message.authoredAt ?? message.createdAt
}

function sameSecondReopenPair(
  cancellation: Pick<ParsedOrderMessage, "id" | "createdAt" | "authoredAt">,
  reopen: Pick<ParsedOrderMessage, "id" | "createdAt" | "authoredAt">
): SameSecondReopenPair | null {
  const cancellationAt = messagePositionTime(cancellation)
  if (cancellationAt !== messagePositionTime(reopen)) return null
  return {
    positionAt: cancellationAt,
    cancellationId: cancellation.id,
    reopenId: reopen.id,
    lowerId: cancellation.id < reopen.id ? cancellation.id : reopen.id,
    upperId: cancellation.id < reopen.id ? reopen.id : cancellation.id,
  }
}

function messagePositionId(
  message: Pick<ParsedOrderMessage, "id" | "createdAt" | "authoredAt">,
  reopenPairs: readonly SameSecondReopenPair[]
): string {
  let positionId = message.id
  for (const pair of reopenPairs) {
    if (pair.positionAt !== messagePositionTime(message)) continue
    if (message.id === pair.cancellationId && pair.lowerId < positionId) {
      positionId = pair.lowerId
    }
    if (message.id === pair.reopenId && pair.upperId > positionId) {
      positionId = pair.upperId
    }
  }
  return positionId
}

function compareMerchantOrderMessagePosition(
  left: Pick<ParsedOrderMessage, "id" | "createdAt" | "authoredAt">,
  right: Pick<ParsedOrderMessage, "id" | "createdAt" | "authoredAt">,
  reopenPairs: readonly SameSecondReopenPair[]
): number {
  const timeDifference = messagePositionTime(left) - messagePositionTime(right)
  if (timeDifference !== 0) return timeDifference
  return (
    messagePositionId(left, reopenPairs).localeCompare(
      messagePositionId(right, reopenPairs)
    ) || left.id.localeCompare(right.id)
  )
}

function candidateSameSecondReopenPairs(
  messages: readonly MerchantStatusMessage[]
): SameSecondReopenPair[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  return messages
    .flatMap((reopen) => {
      const cancellation = reopen.payload.reopens
        ? byId.get(reopen.payload.reopens)
        : undefined
      if (
        !cancellation ||
        normalizeStatus(cancellation.payload.status) !== "cancelled" ||
        normalizeStatus(reopen.payload.status) === "cancelled"
      ) {
        return []
      }
      const pair = sameSecondReopenPair(cancellation, reopen)
      return pair ? [pair] : []
    })
    .sort(
      (left, right) =>
        left.positionAt - right.positionAt ||
        left.lowerId.localeCompare(right.lowerId) ||
        left.upperId.localeCompare(right.upperId) ||
        left.cancellationId.localeCompare(right.cancellationId) ||
        left.reopenId.localeCompare(right.reopenId)
    )
}

function reduceSortedMerchantStatusMessages(
  statuses: readonly MerchantStatusMessage[],
  initialStatus: string | null
): EffectiveMerchantOrderStatus {
  let status = initialStatus
  const appliedStatusEventIds: string[] = []
  let cancellation:
    { eventId: string; resumeStatus: KnownOrderStatus | null } | undefined
  let terminalLocked = false

  for (const message of statuses) {
    const nextStatus = normalizeStatus(message.payload.status)
    const reopens = message.payload.reopens

    if (cancellation) {
      if (
        reopens === cancellation.eventId &&
        cancellation.resumeStatus !== null &&
        nextStatus === cancellation.resumeStatus
      ) {
        status = cancellation.resumeStatus
        appliedStatusEventIds.push(message.id)
        cancellation = undefined
        terminalLocked = false
      }
      continue
    }

    // A correction marker is never a generic transition. Unknown, stale, or
    // replayed references cannot move an active or terminal order.
    if (reopens) continue

    // Complete, delivered, and refund-requested histories are not correctable
    // through this narrow cancellation-reopen mechanism. The first such
    // terminal event remains authoritative.
    if (terminalLocked) continue

    if (nextStatus === "cancelled") {
      cancellation = {
        eventId: message.id,
        resumeStatus: terminalLocked ? null : safeOperationalStatus(status),
      }
      status = "cancelled"
      appliedStatusEventIds.push(message.id)
      terminalLocked = true
      continue
    }

    if (NON_REOPENABLE_TERMINAL_STATUSES.has(nextStatus)) {
      status = nextStatus
      appliedStatusEventIds.push(message.id)
      terminalLocked = true
      continue
    }

    status = isKnownOrderStatus(nextStatus)
      ? nextStatus
      : message.payload.status
    appliedStatusEventIds.push(message.id)
  }

  return {
    status,
    appliedStatusEventIds,
    ...(status === "cancelled" && cancellation?.resumeStatus
      ? {
          cancellation: {
            eventId: cancellation.eventId,
            resumeStatus: cancellation.resumeStatus,
          },
        }
      : {}),
  }
}

function sameSecondReopenPairs(
  messages: readonly MerchantStatusMessage[],
  initialStatus: string | null
): SameSecondReopenPair[] {
  const accepted: SameSecondReopenPair[] = []
  for (const candidate of candidateSameSecondReopenPairs(messages)) {
    const proposed = [...accepted, candidate]
    const ordered = [...messages].sort((left, right) =>
      compareMerchantOrderMessagePosition(left, right, proposed)
    )
    const appliedIds = new Set(
      reduceSortedMerchantStatusMessages(ordered, initialStatus)
        .appliedStatusEventIds
    )
    if (proposed.every((pair) => appliedIds.has(pair.reopenId))) {
      accepted.push(candidate)
    }
  }
  return accepted
}

function uniqueMerchantStatusMessages(
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

  return [...unique.values()]
}

function orderStatusMessages(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants
): MerchantStatusMessage[] {
  const statuses = uniqueMerchantStatusMessages(messages, participants)
  const reopenPairs = sameSecondReopenPairs(
    statuses,
    hasMerchantOrder(messages, participants) ? "pending" : null
  )
  return statuses.sort((left, right) =>
    compareMerchantOrderMessagePosition(left, right, reopenPairs)
  )
}

/** Order a raw conversation by the same deterministic position as replay. */
export function sortMerchantOrderMessagesForReplay(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants
): ParsedOrderMessage[] {
  const reopenPairs = sameSecondReopenPairs(
    uniqueMerchantStatusMessages(messages, participants),
    hasMerchantOrder(messages, participants) ? "pending" : null
  )
  return [...messages].sort((left, right) =>
    compareMerchantOrderMessagePosition(left, right, reopenPairs)
  )
}

function safeOperationalStatus(status: string | null): KnownOrderStatus | null {
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

/**
 * Resolve immutable merchant status history. A cancellation remains effective
 * until a merchant-authored correction explicitly references that exact event.
 */
export function getEffectiveMerchantOrderStatus(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants,
  fallbackStatus: string | null = null
): EffectiveMerchantOrderStatus {
  const statuses = orderStatusMessages(messages, participants)
  const hasOrder = hasMerchantOrder(messages, participants)
  if (statuses.length === 0) {
    return {
      status: fallbackStatus ?? (hasOrder ? "pending" : null),
      appliedStatusEventIds: [],
    }
  }

  return reduceSortedMerchantStatusMessages(
    statuses,
    hasOrder ? "pending" : null
  )
}

const MERCHANT_OPERATIONAL_MESSAGE_TYPES = new Set([
  "payment_request",
  "shipping_update",
  "receipt",
])

function isCancellationBarrierEvidence(
  message: ParsedOrderMessage,
  participants: MerchantOrderParticipants
): boolean {
  const isMerchantEvidence =
    message.senderPubkey === participants.merchantPubkey &&
    message.recipientPubkey === participants.buyerPubkey &&
    MERCHANT_OPERATIONAL_MESSAGE_TYPES.has(message.type)
  const isBuyerPaymentEvidence =
    message.senderPubkey === participants.buyerPubkey &&
    message.recipientPubkey === participants.merchantPubkey &&
    message.type === "payment_proof"
  return isMerchantEvidence || isBuyerPaymentEvidence
}

/**
 * Keep durable history visible while excluding lifecycle evidence recorded by
 * either participant during an effective cancellation barrier.
 */
export function getAppliedMerchantOrderMessages(
  messages: readonly ParsedOrderMessage[],
  participants: MerchantOrderParticipants,
  fallbackStatus: string | null = null
): ParsedOrderMessage[] {
  const replayMessages = sortMerchantOrderMessagesForReplay(
    messages,
    participants
  )
  const effective = getEffectiveMerchantOrderStatus(
    replayMessages,
    participants,
    fallbackStatus
  )
  const appliedStatusEventIds = new Set(effective.appliedStatusEventIds)
  const appliedStatuses = orderStatusMessages(messages, participants).filter(
    (message) => appliedStatusEventIds.has(message.id)
  )
  const cancellations = appliedStatuses
    .filter(
      (message) => normalizeStatus(message.payload.status) === "cancelled"
    )
    .map((cancellation) => {
      const reopen = appliedStatuses.find(
        (message) => message.payload.reopens === cancellation.id
      )
      return {
        cancellation,
        reopen,
        sameSecondPair: reopen
          ? sameSecondReopenPair(cancellation, reopen)
          : null,
      }
    })

  return replayMessages.filter((message) => {
    if (
      message.type === "status_update" &&
      message.senderPubkey === participants.merchantPubkey &&
      message.recipientPubkey === participants.buyerPubkey
    ) {
      return appliedStatusEventIds.has(message.id)
    }
    if (!isCancellationBarrierEvidence(message, participants)) {
      return true
    }
    return !cancellations.some((barrier) => {
      const reopenPairs = barrier.sameSecondPair ? [barrier.sameSecondPair] : []
      return (
        compareMerchantOrderMessagePosition(
          message,
          barrier.cancellation,
          reopenPairs
        ) >= 0 &&
        (!barrier.reopen ||
          compareMerchantOrderMessagePosition(
            message,
            barrier.reopen,
            reopenPairs
          ) <= 0)
      )
    })
  })
}

function toState(
  input: MerchantOrderState | string | null | undefined
): MerchantOrderState {
  if (input == null || typeof input === "string")
    return { status: input ?? null }
  return input
}

export function isMerchantOrderPaid(state: MerchantOrderState): boolean {
  return (
    !!state.paid ||
    !!state.shippingUpdated ||
    PAID_STATUSES.has(normalizeStatus(state.status))
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
  const paymentObserved = paid || !!state.paymentObserved
  const acceptedGate = isMerchantOrderAccepted(state)
  const flow = deriveOrderFlow(state)

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
    done: paid,
    complete: {
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
      title: "Delivered",
      subtitle: "Order completed.",
    },
    active: {
      title: "Confirm delivery",
      subtitle: "Mark the order delivered when fulfillment is complete.",
    },
    waiting: {
      title: "Delivery",
      subtitle:
        state.requiresShipping === false
          ? "Confirm delivery after fulfilling the digital order."
          : "Confirm delivery after shipment.",
    },
  }

  // Payment and acceptance are ordered by the flow; everything else is shared.
  const fulfillmentStages = state.requiresShipping === false ? [] : [shipped]
  const ordered =
    paymentObserved && !paid
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

export interface MerchantOrderReopenTransition {
  cancellationEventId: string
  status: KnownOrderStatus
  tags: [["status", KnownOrderStatus], ["reopens", string]]
  payload: {
    status: KnownOrderStatus
    reopens: string
  }
}

/** Prepare the complete protocol marker for a safe explicit reopen. */
export function getMerchantOrderReopenTransition(
  state: MerchantOrderState
): MerchantOrderReopenTransition | null {
  if (normalizeStatus(state.status) !== "cancelled" || !state.cancellation) {
    return null
  }
  const { eventId, resumeStatus } = state.cancellation
  if (!eventId || TERMINAL_ACTION_STATUSES.has(resumeStatus)) return null
  return {
    cancellationEventId: eventId,
    status: resumeStatus,
    tags: [
      ["status", resumeStatus],
      ["reopens", eventId],
    ],
    payload: { status: resumeStatus, reopens: eventId },
  }
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
  if (status === "cancelled") {
    const reopen = getMerchantOrderReopenTransition(state)
    return reopen
      ? [
          {
            action: "reopen",
            status: reopen.status,
            label: "Reopen order",
            kind: "primary",
          },
        ]
      : []
  }
  if (TERMINAL_ACTION_STATUSES.has(status)) return []

  if (isMerchantOrderPaid(state)) {
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
