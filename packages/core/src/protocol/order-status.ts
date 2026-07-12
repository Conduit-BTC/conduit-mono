// Shared order-status presentation + a flow-aware state model.
//
// Conduit supports two order flows that emit the same NIP-17 messages in a
// different order:
//   - prepaid ("zap-out"): the buyer pays at checkout, then the merchant
//     accepts. Payment precedes acceptance.
//   - invoice ("order-first"): the merchant accepts, sends an invoice, then the
//     buyer pays. Acceptance precedes payment.
// So "paid" and "accepted" are treated as two independent gates rather than a
// fixed linear sequence. The flow is inferred from message presence (was the
// buyer's payment proof received without a merchant invoice?).
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
  /** Merchant acceptance has been observed anywhere in the trusted history. */
  accepted?: boolean
  /** The merchant has sent a payment request (invoice) for this order. */
  invoiceSent?: boolean
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
  return !!state.paid || PAID_STATUSES.has(normalizeStatus(state.status))
}

export function isMerchantOrderAccepted(state: MerchantOrderState): boolean {
  return (
    !!state.accepted || ACCEPTED_STATUSES.has(normalizeStatus(state.status))
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
  title: string
  subtitle: string
  done: boolean
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
    title: "Order placed",
    subtitle: "Order received from buyer",
    done: true,
  }
  const payment: StageSpec = {
    key: "payment",
    title: paid
      ? "Payment confirmed"
      : paymentObserved
        ? "Payment proof received"
        : "Payment",
    subtitle: paid
      ? "Confirmed by merchant"
      : paymentObserved
        ? "Buyer evidence received; verify settlement"
        : flow === "prepaid"
          ? "Awaiting checkout payment evidence"
          : state.invoiceSent
            ? "Invoice sent to buyer"
            : "Lightning payment",
    done: paymentObserved,
  }
  const accepted: StageSpec = {
    key: "accepted",
    title: "Merchant accepted",
    subtitle: "Order confirmed",
    done: acceptedGate,
  }
  const shipped: StageSpec = {
    key: "shipped",
    title: "Shipped",
    subtitle: "Sent to buyer",
    done: SHIPPED_STATUSES.has(status),
  }
  const delivered: StageSpec = {
    key: "delivered",
    title: "Delivered",
    subtitle: "Order completed",
    done: DELIVERED_STATUSES.has(status),
  }

  // Payment and acceptance are ordered by the flow; everything else is shared.
  const ordered =
    flow === "prepaid"
      ? [placed, payment, accepted, shipped, delivered]
      : [placed, accepted, payment, shipped, delivered]

  let frontMarked = false
  return ordered.map((stage): OrderTimelineStep => {
    if (stage.done) {
      return {
        key: stage.key,
        title: stage.title,
        subtitle: stage.subtitle,
        status: "complete",
      }
    }
    if (!frontMarked) {
      frontMarked = true
      if (cancelled) {
        return {
          key: stage.key,
          title: stage.title,
          subtitle: "Order cancelled",
          status: "failed",
          label: "Cancelled",
        }
      }
      return {
        key: stage.key,
        title: stage.title,
        subtitle: stage.subtitle,
        status: "in_progress",
      }
    }
    return {
      key: stage.key,
      title: stage.title,
      subtitle: stage.subtitle,
      status: "waiting",
    }
  })
}

export type MerchantOrderActionKind = "primary" | "destructive"

export interface MerchantOrderAction {
  /** Status to publish when the action is taken. */
  status: KnownOrderStatus
  /** Button label for the action. */
  label: string
  kind: MerchantOrderActionKind
}

// The merchant's next actions, flow-aware and gate-driven. Destructive action
// (decline / cancel) is ordered before the primary one. Shipping is gated on
// payment so an unpaid order can't be shipped; delivery is buyer-confirmed, so
// once shipped the merchant has none.
export function getMerchantOrderActions(
  input: MerchantOrderState | string | null | undefined
): MerchantOrderAction[] {
  const state = toState(input)
  const status = normalizeStatus(state.status)

  if (!isKnownOrderStatus(status)) return []
  if (TERMINAL_ACTION_STATUSES.has(status)) return []

  if (!isMerchantOrderAccepted(state)) {
    return [
      { status: "cancelled", label: "Decline order", kind: "destructive" },
      { status: "accepted", label: "Accept order", kind: "primary" },
    ]
  }

  // Accepted-or-beyond, but already shipped → nothing left for the merchant.
  if (SHIPPED_STATUSES.has(status)) return []

  if (isMerchantOrderPaid(state)) {
    return [
      { status: "cancelled", label: "Cancel order", kind: "destructive" },
      { status: "shipped", label: "Mark as shipped", kind: "primary" },
    ]
  }

  // Accepted but awaiting payment (invoice flow): shipping is not offered yet.
  return [{ status: "cancelled", label: "Cancel order", kind: "destructive" }]
}
