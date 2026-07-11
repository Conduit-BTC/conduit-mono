import {
  deriveOrderFlow,
  extractOrderSummary,
  getOrderPublicZapSigner,
  orderFlowFromCheckoutMode,
  type BuyerConversationSummary,
  type OrderFlow,
  type OrderAddressValidity,
  type OrderBuyerIdentityKind,
  type OrderCheckoutMode,
  type OrderDeliveryStatus,
  type OrderInvoiceStatus,
  type OrderLifecycle,
  type OrderLifecyclePhase,
  type OrderPaymentStatus,
  type OrderProofDeliveryStatus,
  type OrderPublicZapSigner,
  type OrderSummary,
  type OrderZapReceiptStatus,
  type ParsedOrderMessage,
  type StoredPaymentAttempt,
} from "@conduit/core"
import type { StatusStepperRow, StatusStepperRowStatus } from "@conduit/ui"

/**
 * Interpreted, status-first order view-model (CND-122).
 *
 * Merges the durable local lifecycle record (instant, pre-readback) with cached
 * / relay conversation messages and the stored payment attempt into one model
 * the Orders page renders without re-deriving protocol internals at every call
 * site. Local lifecycle wins for fields it owns; relay messages enrich
 * merchant-driven state (confirmation, shipping, completion).
 */

export interface OrderViewItem {
  productId: string
  displayTitle: string
  quantity: number
  priceAtPurchase: number
  currency: string
}

export interface OrderViewModel {
  orderId: string
  merchantPubkey: string
  buyerIdentityKind: OrderBuyerIdentityKind | null
  checkoutMode: OrderCheckoutMode | null
  /** prepaid (zap-out) vs invoice (order-first); shared with the merchant. */
  flow: OrderFlow
  publicZapSigner: OrderPublicZapSigner | null
  createdAt: number
  updatedAt: number

  items: OrderViewItem[]
  totalSats: number | null
  currency: string
  shippingAddress: OrderSummary["shippingAddress"]
  contactNote: string | null

  // Buyer-side payment lifecycle (lifecycle record, else derived from messages).
  orderDeliveryStatus: OrderDeliveryStatus
  invoiceStatus: OrderInvoiceStatus
  paymentStatus: OrderPaymentStatus
  proofDeliveryStatus: OrderProofDeliveryStatus
  zapReceiptStatus: OrderZapReceiptStatus
  addressValidity: OrderAddressValidity

  // Merchant-driven state, observed from the conversation.
  merchantStatus:
    | "pending"
    | "invoiced"
    | "paid"
    | "accepted"
    | "processing"
    | "shipped"
    | "complete"
    | "cancelled"
    | null
  tracking: {
    carrier: string | null
    number: string | null
    url: string | null
  } | null

  phase: OrderLifecyclePhase

  // Technical details (collapsed by default in the UI).
  invoice?: string
  paymentHash?: string
  preimage?: string
  feeMsats?: number
  zapRequestId?: string
  zapReceiptId?: string

  /** True when the buyer has a concrete next action (drives the list marker). */
  actionNeeded: boolean

  /** Whether any durable lifecycle record backs this model. */
  hasLifecycle: boolean
}

export interface BuildOrderViewModelInput {
  orderId: string
  merchantPubkey?: string
  lifecycle?: OrderLifecycle | null
  conversation?: BuyerConversationSummary | null
  messages?: ParsedOrderMessage[] | null
  paymentAttempt?: StoredPaymentAttempt | null
}

export function getOrderPaymentMethodLabel(
  vm: Pick<OrderViewModel, "checkoutMode" | "publicZapSigner">
): string {
  const signer =
    vm.publicZapSigner ??
    (vm.checkoutMode ? getOrderPublicZapSigner(vm.checkoutMode) : undefined)
  if (signer === "anon") return "Anonymous public zap"
  if (signer === "shopper") return "Public zap as shopper"

  switch (vm.checkoutMode) {
    case "private_checkout":
      return "Private invoice"
    case "external_wallet":
      return "External wallet"
    case "pay_later":
      return "Pay later"
    case "public_zap":
      return "Public zap"
    case "anonymous_public_zap":
      return "Anonymous public zap"
    case "public_zap_as_shopper":
      return "Public zap as shopper"
    case null:
      return "—"
  }
}

const MERCHANT_STATUSES = new Set([
  "pending",
  "invoiced",
  "paid",
  "accepted",
  "processing",
  "shipped",
  "complete",
  "cancelled",
])

/** Best-effort human title from an order item product reference. */
export function deriveItemDisplayTitle(productId: string): string {
  const segments = productId.split(":")
  const tail = segments[segments.length - 1] ?? productId
  const cleaned = tail.replace(/[-_]+/g, " ").trim()
  if (!cleaned) return productId
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function latestMerchantStatus(
  messages: ParsedOrderMessage[] | undefined,
  merchantPubkey: string | undefined,
  fallback: string | null
): OrderViewModel["merchantStatus"] {
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.type !== "status_update") continue
      if (merchantPubkey && message.senderPubkey !== merchantPubkey) continue
      const status = message.payload.status
      if (MERCHANT_STATUSES.has(status)) {
        return status as OrderViewModel["merchantStatus"]
      }
    }
  }
  if (fallback && MERCHANT_STATUSES.has(fallback)) {
    return fallback as OrderViewModel["merchantStatus"]
  }
  return null
}

export function buildOrderViewModel(
  input: BuildOrderViewModelInput
): OrderViewModel {
  const { lifecycle, conversation, paymentAttempt } = input
  const messages = input.messages ?? conversation?.messages ?? undefined
  const summary: OrderSummary | null = messages
    ? extractOrderSummary(messages)
    : null

  const merchantPubkey =
    lifecycle?.merchantPubkey ??
    input.merchantPubkey ??
    conversation?.merchantPubkey ??
    ""

  // --- Items / totals -----------------------------------------------------
  const items: OrderViewItem[] = lifecycle
    ? lifecycle.items.map((item) => ({
        productId: item.productId,
        displayTitle:
          item.title?.trim() || deriveItemDisplayTitle(item.productId),
        quantity: item.quantity,
        priceAtPurchase: item.priceAtPurchase,
        currency: item.currency,
      }))
    : (summary?.items ?? []).map((item) => ({
        productId: item.productId,
        displayTitle:
          item.title?.trim() || deriveItemDisplayTitle(item.productId),
        quantity: item.quantity,
        priceAtPurchase: item.priceAtPurchase,
        currency: item.currency,
      }))

  const totalSats = lifecycle?.totalSats ?? (summary ? summary.subtotal : null)

  // --- Buyer-side statuses (lifecycle wins; else derive from messages) ----
  const hasOrderMessage = !!summary && summary.items.length > 0
  const orderDeliveryStatus: OrderDeliveryStatus =
    lifecycle?.orderDeliveryStatus ?? (hasOrderMessage ? "sent" : "not_started")

  const invoiceFromMessages = summary?.invoiceSent ?? false
  const invoiceStatus: OrderInvoiceStatus =
    lifecycle?.invoiceStatus ??
    (invoiceFromMessages ? "received" : "not_requested")

  const proofFromMessages = summary?.paymentProofReceived ?? false
  const paymentStatus: OrderPaymentStatus =
    lifecycle?.paymentStatus ?? (proofFromMessages ? "paid" : "not_started")

  const proofDeliveryStatus: OrderProofDeliveryStatus =
    lifecycle?.proofDeliveryStatus ??
    paymentAttempt?.proofDeliveryStatus ??
    (proofFromMessages ? "sent" : "not_started")

  const zapReceiptStatus: OrderZapReceiptStatus =
    lifecycle?.zapReceiptStatus ?? "not_applicable"

  const merchantStatus = latestMerchantStatus(
    messages,
    merchantPubkey,
    conversation?.status ?? null
  )

  const tracking =
    summary &&
    (summary.trackingCarrier || summary.trackingNumber || summary.trackingUrl)
      ? {
          carrier: summary.trackingCarrier,
          number: summary.trackingNumber,
          url: summary.trackingUrl,
        }
      : null

  const phase: OrderLifecyclePhase =
    merchantStatus === "cancelled"
      ? "cancelled"
      : merchantStatus === "complete"
        ? "completed"
        : (lifecycle?.phase ??
          (paymentStatus === "paid" || orderDeliveryStatus === "sent"
            ? "in_progress"
            : "pending"))

  const actionNeeded =
    paymentStatus === "manual_required" ||
    paymentStatus === "failed" ||
    paymentStatus === "ambiguous" ||
    orderDeliveryStatus === "failed" ||
    proofDeliveryStatus === "retry_needed" ||
    proofDeliveryStatus === "failed"

  // Buyer knows the flow authoritatively from checkoutMode; fall back to the
  // merchant-side heuristic when there's no lifecycle record (relay-only view).
  const flow: OrderFlow = lifecycle?.checkoutMode
    ? orderFlowFromCheckoutMode(lifecycle.checkoutMode)
    : deriveOrderFlow({
        status: merchantStatus,
        paid: paymentStatus === "paid",
        invoiceSent:
          invoiceStatus === "received" || invoiceStatus === "manual_required",
      })

  return {
    orderId: input.orderId,
    merchantPubkey,
    buyerIdentityKind:
      lifecycle?.buyerIdentityKind ?? summary?.buyerIdentityKind ?? null,
    checkoutMode: lifecycle?.checkoutMode ?? null,
    flow,
    publicZapSigner: lifecycle?.publicZapSigner ?? null,
    createdAt: lifecycle?.createdAt ?? conversation?.latestAt ?? Date.now(),
    updatedAt: lifecycle?.updatedAt ?? conversation?.latestAt ?? Date.now(),
    items,
    totalSats,
    currency: lifecycle?.currency ?? summary?.currency ?? "SATS",
    shippingAddress:
      lifecycle?.shippingAddress ?? summary?.shippingAddress ?? null,
    contactNote: lifecycle?.contactNote ?? summary?.orderNote ?? null,
    orderDeliveryStatus,
    invoiceStatus,
    paymentStatus,
    proofDeliveryStatus,
    zapReceiptStatus,
    addressValidity: lifecycle?.addressValidity ?? "not_required",
    merchantStatus,
    tracking,
    phase,
    invoice: lifecycle?.invoice ?? paymentAttempt?.invoice,
    paymentHash: lifecycle?.paymentHash ?? paymentAttempt?.paymentHash,
    preimage: lifecycle?.preimage ?? paymentAttempt?.preimage,
    feeMsats: lifecycle?.feeMsats ?? paymentAttempt?.feeMsats,
    zapRequestId: lifecycle?.zapRequestId ?? paymentAttempt?.zapRequestId,
    zapReceiptId: lifecycle?.zapReceiptId ?? paymentAttempt?.zapReceiptId,
    actionNeeded,
    hasLifecycle: !!lifecycle,
  }
}

// --- Timeline -------------------------------------------------------------

export type OrderTimelineRowKey =
  | "order_sent"
  | "invoice"
  | "payment"
  | "receipt"
  | "merchant_confirmation"
  | "fulfillment"
  | "complete"

const TIMELINE_ROW_ORDER: readonly OrderTimelineRowKey[] = [
  "order_sent",
  "invoice",
  "payment",
  "receipt",
  "merchant_confirmation",
  "fulfillment",
  "complete",
] as const

type RowCopy = { title: string; subtitle: string }

const TIMELINE_COPY: Record<
  OrderTimelineRowKey,
  Record<"complete" | "active" | "waiting", RowCopy>
> = {
  order_sent: {
    complete: {
      title: "Order sent to merchant",
      subtitle: "Your order details were delivered over Nostr.",
    },
    active: {
      title: "Sending order to merchant",
      subtitle: "Delivering your order details over Nostr.",
    },
    waiting: {
      title: "Order sent to merchant",
      subtitle: "Your order details will be delivered over Nostr.",
    },
  },
  invoice: {
    complete: {
      title: "Invoice received",
      subtitle: "Merchant returned a Lightning invoice.",
    },
    active: {
      title: "Waiting for invoice",
      subtitle: "Waiting for the merchant to return a Lightning invoice.",
    },
    waiting: {
      title: "Invoice",
      subtitle: "The merchant will return a Lightning invoice.",
    },
  },
  payment: {
    complete: {
      title: "Payment sent",
      subtitle: "The invoice was paid over Lightning.",
    },
    active: {
      title: "Sending payment",
      subtitle: "Paying the invoice over Lightning.",
    },
    waiting: {
      title: "Payment",
      subtitle: "The invoice will be paid over Lightning.",
    },
  },
  receipt: {
    complete: {
      title: "Receipt sent to merchant",
      subtitle: "Payment proof was delivered over Nostr.",
    },
    active: {
      title: "Sending receipt to merchant",
      subtitle: "Delivering payment proof to the merchant over Nostr.",
    },
    waiting: {
      title: "Receipt sent to merchant",
      subtitle: "Payment proof will be delivered over Nostr.",
    },
  },
  merchant_confirmation: {
    complete: {
      title: "Merchant confirmation",
      subtitle: "The merchant confirmed your order.",
    },
    active: {
      title: "Merchant confirmation",
      subtitle: "We're waiting for the merchant to confirm your order.",
    },
    waiting: {
      title: "Merchant confirmation",
      subtitle: "The merchant will confirm your order.",
    },
  },
  fulfillment: {
    complete: {
      title: "Fulfillment / Shipping",
      subtitle: "Your order is on its way.",
    },
    active: {
      title: "Fulfillment / Shipping",
      subtitle: "The merchant is preparing your order.",
    },
    waiting: {
      title: "Fulfillment / Shipping",
      subtitle: "Tracking or pickup details will appear here.",
    },
  },
  complete: {
    complete: {
      title: "Complete",
      subtitle: "Your order is complete.",
    },
    active: {
      title: "Complete",
      subtitle: "Your order will be marked complete.",
    },
    waiting: {
      title: "Complete",
      subtitle: "Your order will be marked complete.",
    },
  },
}

function copyFor(
  key: OrderTimelineRowKey,
  status: StatusStepperRowStatus
): RowCopy {
  const state =
    status === "complete"
      ? "complete"
      : status === "waiting"
        ? "waiting"
        : "active"
  return TIMELINE_COPY[key][state]
}

/**
 * Map the merged view-model into the seven timeline row statuses. Pure so it can
 * be unit-tested against each lifecycle/merchant combination.
 */
export function computeOrderTimelineStatuses(
  vm: OrderViewModel
): Record<OrderTimelineRowKey, StatusStepperRowStatus> {
  const paid = vm.paymentStatus === "paid"
  const merchantConfirmed =
    vm.merchantStatus === "accepted" ||
    vm.merchantStatus === "processing" ||
    vm.merchantStatus === "shipped" ||
    vm.merchantStatus === "complete"
  const shipped =
    vm.merchantStatus === "shipped" ||
    vm.merchantStatus === "complete" ||
    !!vm.tracking
  const completed = vm.merchantStatus === "complete"

  // 1. Order sent
  let orderSent: StatusStepperRowStatus = "waiting"
  if (vm.orderDeliveryStatus === "sent") orderSent = "complete"
  else if (vm.orderDeliveryStatus === "pending") orderSent = "in_progress"
  else if (vm.orderDeliveryStatus === "failed") orderSent = "failed"

  // 2. Invoice received
  let invoice: StatusStepperRowStatus = "waiting"
  if (
    vm.invoiceStatus === "received" ||
    vm.invoiceStatus === "manual_required" ||
    paid
  ) {
    invoice = "complete"
  } else if (vm.invoiceStatus === "requesting") {
    invoice = "in_progress"
  } else if (vm.invoiceStatus === "failed") {
    invoice = "failed"
  }

  // 3. Payment sent
  let payment: StatusStepperRowStatus = "waiting"
  if (paid) payment = "complete"
  else if (
    vm.paymentStatus === "paying" ||
    vm.paymentStatus === "manual_required"
  )
    payment = "in_progress"
  else if (vm.paymentStatus === "failed") payment = "failed"
  // Funds may or may not have moved — flag for review, never auto-retry.
  else if (vm.paymentStatus === "ambiguous") payment = "retry_needed"

  // 4. Receipt sent
  let receipt: StatusStepperRowStatus = "waiting"
  if (vm.proofDeliveryStatus === "sent") receipt = "complete"
  else if (vm.proofDeliveryStatus === "pending") receipt = "in_progress"
  else if (
    vm.proofDeliveryStatus === "retry_needed" ||
    vm.proofDeliveryStatus === "failed"
  )
    receipt = "retry_needed"
  else if (paid) receipt = "in_progress"

  // 5. Merchant confirmation
  let merchantConfirmation: StatusStepperRowStatus = "waiting"
  if (merchantConfirmed) merchantConfirmation = "complete"
  else if (paid) merchantConfirmation = "in_progress"

  // 6. Fulfillment / shipping
  let fulfillment: StatusStepperRowStatus = "waiting"
  if (shipped) fulfillment = "complete"
  else if (vm.merchantStatus === "processing") fulfillment = "in_progress"

  // 7. Complete
  const complete: StatusStepperRowStatus = completed ? "complete" : "waiting"

  return {
    order_sent: orderSent,
    invoice,
    payment,
    receipt,
    merchant_confirmation: merchantConfirmation,
    fulfillment,
    complete,
  }
}

/** Build the seven `StatusStepperRow`s for the order detail timeline. */
/**
 * Coarse bucket for the orders-list phase filter, from the buyer's view: an
 * order awaiting invoice/payment is "pending"; once paid (or the merchant is
 * fulfilling) it is "in_progress". Distinct from `vm.phase`, which treats any
 * sent order as in progress.
 */
export function getOrderFilterPhase(
  vm: OrderViewModel
): "pending" | "in_progress" | "completed" | "cancelled" {
  if (vm.merchantStatus === "cancelled" || vm.phase === "cancelled") {
    return "cancelled"
  }
  if (vm.merchantStatus === "complete" || vm.phase === "completed") {
    return "completed"
  }
  if (
    vm.paymentStatus === "paid" ||
    vm.merchantStatus === "accepted" ||
    vm.merchantStatus === "processing" ||
    vm.merchantStatus === "shipped"
  ) {
    return "in_progress"
  }
  return "pending"
}

export function buildOrderTimeline(vm: OrderViewModel): StatusStepperRow[] {
  const statuses = computeOrderTimelineStatuses(vm)
  const rowOrder =
    vm.buyerIdentityKind === "guest_ephemeral"
      ? TIMELINE_ROW_ORDER.slice(0, 4)
      : TIMELINE_ROW_ORDER
  return rowOrder.map((key) => {
    const status = statuses[key]
    const copy = copyFor(key, status)
    let title = copy.title
    let subtitle = copy.subtitle
    // Prepaid (zap-out) orders have no merchant invoice; reflect direct payment.
    if (key === "invoice" && vm.flow === "prepaid") {
      title = status === "complete" ? "Paid directly" : "Direct payment"
      subtitle =
        "Paid the merchant directly over Lightning — no invoice needed."
    } else if (key === "payment" && vm.paymentStatus === "ambiguous") {
      title = "Payment needs review"
      subtitle =
        "We couldn't confirm this payment moved. Check your wallet, then message the merchant before retrying."
    } else if (
      key === "payment" &&
      status === "complete" &&
      typeof vm.totalSats === "number"
    ) {
      subtitle = `Payment of ${vm.totalSats.toLocaleString()} sats was sent over Lightning.`
    }
    if (key === "fulfillment" && vm.tracking?.number) {
      subtitle = `Tracking: ${vm.tracking.number}`
    }
    return { key, title, subtitle, status }
  })
}

// --- Header status pill ---------------------------------------------------

export interface OrderHeaderStatus {
  tone: "success" | "info" | "warning" | "error" | "neutral"
  primaryLabel: string
  detailLabel: string
  actionNeeded: boolean
  showSpinner: boolean
}

/**
 * The interpreted status pill shown in the list and the detail hero
 * (e.g. `Paid · Receipt sent`, `Pending · Awaiting invoice`).
 */
export function deriveOrderHeaderStatus(vm: OrderViewModel): OrderHeaderStatus {
  if (vm.merchantStatus === "cancelled" || vm.phase === "cancelled") {
    return {
      tone: "neutral",
      primaryLabel: "Cancelled",
      detailLabel: "Order cancelled",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (vm.merchantStatus === "complete") {
    return {
      tone: "success",
      primaryLabel: "Completed",
      detailLabel: "Delivered",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (vm.orderDeliveryStatus === "failed") {
    return {
      tone: "error",
      primaryLabel: "Failed",
      detailLabel: "Order not sent",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "failed") {
    return {
      tone: "error",
      primaryLabel: "Payment failed",
      detailLabel: "Try payment again",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "ambiguous") {
    return {
      tone: "warning",
      primaryLabel: "Payment unclear",
      detailLabel: "Check wallet before retrying",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "manual_required") {
    return {
      tone: "warning",
      primaryLabel: "Action needed",
      detailLabel: "Pay with external wallet",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "paid") {
    if (vm.merchantStatus === "shipped") {
      return {
        tone: "info",
        primaryLabel: "In progress",
        detailLabel: "Shipped",
        actionNeeded: false,
        showSpinner: false,
      }
    }
    if (
      vm.merchantStatus === "processing" ||
      vm.merchantStatus === "accepted"
    ) {
      return {
        tone: "info",
        primaryLabel: "In progress",
        detailLabel: "Merchant confirmed",
        actionNeeded: false,
        showSpinner: false,
      }
    }
    if (
      vm.proofDeliveryStatus === "retry_needed" ||
      vm.proofDeliveryStatus === "failed"
    ) {
      return {
        tone: "warning",
        primaryLabel: "Paid",
        detailLabel: "Receipt delivery incomplete",
        actionNeeded: true,
        showSpinner: false,
      }
    }
    if (vm.proofDeliveryStatus === "sent") {
      if (vm.buyerIdentityKind === "guest_ephemeral") {
        return {
          tone: "success",
          primaryLabel: "Receipt sent",
          detailLabel: "Merchant follow-up uses phone and email",
          actionNeeded: false,
          showSpinner: false,
        }
      }
      return {
        tone: "info",
        primaryLabel: "Merchant confirmation",
        detailLabel: "Waiting for merchant",
        actionNeeded: false,
        showSpinner: true,
      }
    }
    return {
      tone: "info",
      primaryLabel: "Merchant confirmation",
      detailLabel: "Waiting for merchant",
      actionNeeded: false,
      showSpinner: true,
    }
  }
  if (vm.merchantStatus === "accepted") {
    return {
      tone: "info",
      primaryLabel: "In progress",
      detailLabel: "Merchant accepted",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "paying") {
    return {
      tone: "info",
      primaryLabel: "In progress",
      detailLabel: "Sending payment",
      actionNeeded: false,
      showSpinner: true,
    }
  }
  if (vm.invoiceStatus === "received") {
    return {
      tone: "info",
      primaryLabel: "In progress",
      detailLabel: "Invoice ready",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (vm.orderDeliveryStatus === "sent") {
    return {
      tone: "warning",
      primaryLabel: "Pending",
      detailLabel: "Awaiting invoice",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  return {
    tone: "neutral",
    primaryLabel: "Pending",
    detailLabel: "Starting order",
    actionNeeded: false,
    showSpinner: false,
  }
}
