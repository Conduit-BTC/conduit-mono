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
export interface MerchantOrderState {
  status: string | null | undefined
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
function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "pending").toLowerCase()
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
  const cancelled = status === "cancelled"
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
              subtitle: "Send an invoice to the buyer.",
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
      subtitle: "Tracking details recorded.",
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
    flow === "prepaid"
      ? [placed, payment, accepted, ...fulfillmentStages, delivered]
      : [placed, accepted, payment, ...fulfillmentStages, delivered]

  let frontMarked = false
  return ordered.map((stage): OrderTimelineStep => {
    if (stage.done) {
      return {
        key: stage.key,
        title: stage.complete.title,
        subtitle: stage.complete.subtitle,
        status: "complete",
      }
    }
    if (!frontMarked) {
      frontMarked = true
      if (cancelled) {
        return {
          key: stage.key,
          title: "Order cancelled",
          subtitle: "No further action is required.",
          status: "failed",
          label: "Cancelled",
        }
      }
      return {
        key: stage.key,
        title: stage.active.title,
        subtitle: stage.active.subtitle,
        status: "in_progress",
      }
    }
    return {
      key: stage.key,
      title: stage.waiting.title,
      subtitle: stage.waiting.subtitle,
      status: "waiting",
    }
  })
}

export type MerchantOrderActionKind = "primary" | "destructive"

export interface MerchantOrderAction {
  action:
    "accept" | "confirm_payment" | "record_shipment" | "complete" | "cancel"
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
