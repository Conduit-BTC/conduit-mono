import {
  deriveOrderFlow,
  extractOrderSummary,
  getPriceSats,
  getOrderPublicZapSigner,
  hasOrderLifecyclePostDeliveryProgress,
  isKnownOrderStatus,
  isMerchantOrderAccepted,
  isMerchantOrderPaid,
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
  type KnownOrderStatus,
  type OrderPaymentStatus,
  type OrderProofDeliveryStatus,
  type OrderPublicZapSigner,
  type OrderSummary,
  type OrderZapReceiptStatus,
  type ParsedOrderMessage,
  type StoredPaymentAttempt,
  type SourcePriceQuote,
} from "@conduit/core"
import type { StatusStepperRow, StatusStepperRowStatus } from "@conduit/ui"
import type { CartItemFulfillment, CartPickupFulfillment } from "./cart-model"
import { getPickupHandoffSummary } from "./pickup-handoff"

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
  familyProductId?: string
  selectedSpecifications?: Array<{ key: string; value: string }>
  displayTitle: string
  format: "physical" | "digital"
  quantity: number
  priceAtPurchase: number
  currency: string
  sourcePrice?: SourcePriceQuote
  shippingCostSats?: number
  sourceShippingCost?: SourcePriceQuote
  fulfillment?: CartItemFulfillment
}

export type OrderDeliveryEvidence =
  "locally_queued" | "relay_accepted" | "recipient_observed" | "confirmed"

export function getOrderDeliveryEvidenceLabel(
  evidence: OrderDeliveryEvidence
): string {
  switch (evidence) {
    case "locally_queued":
      return "Queued locally"
    case "relay_accepted":
      return "Relay accepted"
    case "recipient_observed":
      return "Merchant responded"
    case "confirmed":
      return "Merchant confirmed"
  }
}

export interface OrderViewModel {
  orderId: string
  merchantPubkey: string
  buyerIdentityKind: OrderBuyerIdentityKind | null
  checkoutMode: OrderCheckoutMode | null
  /** prepaid (zap-out) vs invoice (order-first); shared with the merchant. */
  flow: OrderFlow
  publicZapSigner: OrderPublicZapSigner | null
  publicZapFallback: boolean
  createdAt: number
  updatedAt: number

  items: OrderViewItem[]
  /** False only when every item was explicitly snapshotted as digital. */
  requiresShipping: boolean
  requiresPickup: boolean
  pickupFulfillments: CartPickupFulfillment[]
  totalSats: number | null
  currency: string
  shippingAddress: OrderSummary["shippingAddress"]
  contactNote: string | null

  // Buyer-side payment lifecycle (lifecycle record, else derived from messages).
  orderDeliveryStatus: OrderDeliveryStatus
  orderDeliveryEvidence: OrderDeliveryEvidence
  invoiceStatus: OrderInvoiceStatus
  paymentStatus: OrderPaymentStatus
  proofDeliveryStatus: OrderProofDeliveryStatus
  zapReceiptStatus: OrderZapReceiptStatus
  addressValidity: OrderAddressValidity

  // Merchant-driven state, observed from the conversation.
  merchantStatus: KnownOrderStatus | null
  /** Authenticated merchant shipping evidence, even without tracking fields. */
  merchantShippingUpdated: boolean
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

export function isZeroCostPickupOrder(
  vm: Pick<OrderViewModel, "items" | "requiresPickup" | "totalSats">
): boolean {
  return (
    vm.totalSats === 0 &&
    vm.requiresPickup &&
    vm.items.length > 0 &&
    vm.items.every((item) => {
      const fulfillment = item.fulfillment
      if (fulfillment?.type !== "pickup") return false
      const productZero = getPriceSats(
        {
          price: item.priceAtPurchase,
          currency: item.currency,
          priceSats: item.priceAtPurchase,
          sourcePrice: item.sourcePrice,
        },
        null,
        { allowZero: true }
      )
      const pickupSourceMatchesSnapshot =
        item.sourceShippingCost?.amount === fulfillment.sourceCost.amount &&
        item.sourceShippingCost.currency === fulfillment.sourceCost.currency &&
        item.sourceShippingCost.normalizedCurrency ===
          fulfillment.sourceCost.normalizedCurrency
      const exactZeroPickupCost =
        item.shippingCostSats === 0 &&
        fulfillment.costSats === 0 &&
        fulfillment.sourceCost.amount === 0 &&
        pickupSourceMatchesSnapshot
      return (
        fulfillment.handoffMode !== undefined &&
        fulfillment.handlerPubkey !== undefined &&
        productZero?.sats === 0 &&
        productZero.approximate === false &&
        exactZeroPickupCost
      )
    })
  )
}

/** Merchant evidence and terminal state must veto every new payment action. */
export function canOfferOrderPaymentAction(
  vm: Pick<
    OrderViewModel,
    "merchantShippingUpdated" | "merchantStatus" | "phase"
  >
): boolean {
  return (
    vm.phase !== "completed" &&
    vm.phase !== "cancelled" &&
    !isMerchantOrderPaid({
      status: vm.merchantStatus,
      shippingUpdated: vm.merchantShippingUpdated,
    }) &&
    vm.merchantStatus !== "cancelled" &&
    vm.merchantStatus !== "refund_requested"
  )
}

/** A recovered pay-now order must offer a fresh user action before payment. */
export function shouldOfferOrderPaymentContinuation(
  vm: Pick<
    OrderViewModel,
    | "checkoutMode"
    | "merchantShippingUpdated"
    | "merchantStatus"
    | "orderDeliveryEvidence"
    | "paymentStatus"
    | "phase"
    | "totalSats"
  >
): boolean {
  const deliveryAdmitsPayment =
    vm.orderDeliveryEvidence === "relay_accepted" ||
    (vm.orderDeliveryEvidence !== "locally_queued" &&
      vm.merchantStatus !== null)
  return (
    vm.checkoutMode !== null &&
    vm.checkoutMode !== "pay_later" &&
    canOfferOrderPaymentAction(vm) &&
    deliveryAdmitsPayment &&
    vm.paymentStatus === "not_started" &&
    (vm.totalSats ?? 0) > 0
  )
}

export function getOrderPaymentContinuationCopy(
  vm: Pick<OrderViewModel, "orderDeliveryEvidence">
): string {
  return vm.orderDeliveryEvidence === "relay_accepted"
    ? "A relay accepted the order. Continue when you are ready to request and pay the Lightning invoice."
    : "Authenticated merchant activity shows the order reached the merchant. Continue when you are ready to request and pay the Lightning invoice."
}

export function shouldOfferOrderDeliveryRetry(
  vm: Pick<OrderViewModel, "orderDeliveryEvidence" | "orderDeliveryStatus">
): boolean {
  return (
    vm.orderDeliveryStatus === "pending" &&
    vm.orderDeliveryEvidence === "locally_queued"
  )
}

export function getOrderPaymentMethodLabel(
  vm: Pick<
    OrderViewModel,
    | "checkoutMode"
    | "items"
    | "publicZapSigner"
    | "requiresPickup"
    | "totalSats"
  >
): string {
  if (isZeroCostPickupOrder(vm)) return "No payment required"
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

function isCompletedMerchantStatus(
  status: OrderViewModel["merchantStatus"]
): boolean {
  return status === "complete" || status === "delivered"
}

/**
 * Payment is complete from the buyer's perspective when either the local
 * payment lifecycle confirms it or the merchant has published a status that
 * confirms settlement. The latter keeps relay-only and partial-read views
 * consistent when the buyer's local payment record is unavailable.
 */
function isBuyerOrderPaid(
  vm: Pick<
    OrderViewModel,
    "merchantShippingUpdated" | "merchantStatus" | "paymentStatus"
  >
): boolean {
  return (
    vm.paymentStatus === "paid" ||
    isMerchantOrderPaid({
      status: vm.merchantStatus,
      shippingUpdated: vm.merchantShippingUpdated,
    })
  )
}

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
  buyerPubkey: string | undefined,
  fallback: string | null
): OrderViewModel["merchantStatus"] {
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.type !== "status_update") continue
      if (merchantPubkey && message.senderPubkey !== merchantPubkey) continue
      if (
        buyerPubkey
          ? message.recipientPubkey !== buyerPubkey
          : message.recipientPubkey === merchantPubkey
      ) {
        continue
      }
      const status = message.payload.status
      if (isKnownOrderStatus(status)) return status
    }
  }
  if (fallback && isKnownOrderStatus(fallback)) return fallback
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
        familyProductId: item.familyProductId,
        selectedSpecifications: item.selectedSpecifications?.map(
          (specification) => ({ ...specification })
        ),
        displayTitle:
          item.title?.trim() || deriveItemDisplayTitle(item.productId),
        format: item.format ?? "physical",
        quantity: item.quantity,
        priceAtPurchase: item.priceAtPurchase,
        currency: item.currency,
        ...(item.sourcePrice ? { sourcePrice: item.sourcePrice } : {}),
        ...(item.shippingCostSats !== undefined
          ? { shippingCostSats: item.shippingCostSats }
          : {}),
        ...(item.sourceShippingCost
          ? { sourceShippingCost: item.sourceShippingCost }
          : {}),
        ...((item as typeof item & { fulfillment?: CartItemFulfillment })
          .fulfillment
          ? {
              fulfillment: (
                item as typeof item & { fulfillment: CartItemFulfillment }
              ).fulfillment,
            }
          : {}),
      }))
    : (summary?.items ?? []).map((item) => ({
        productId: item.productId,
        familyProductId: item.familyProductId,
        selectedSpecifications: item.selectedSpecifications?.map(
          (specification) => ({ ...specification })
        ),
        displayTitle:
          item.title?.trim() || deriveItemDisplayTitle(item.productId),
        format: item.format,
        quantity: item.quantity,
        priceAtPurchase: item.priceAtPurchase,
        currency: item.currency,
        ...(item.sourcePrice ? { sourcePrice: item.sourcePrice } : {}),
        ...(item.shippingCostSats !== undefined
          ? { shippingCostSats: item.shippingCostSats }
          : {}),
        ...(item.sourceShippingCost
          ? { sourceShippingCost: item.sourceShippingCost }
          : {}),
        ...((item as typeof item & { fulfillment?: CartItemFulfillment })
          .fulfillment
          ? {
              fulfillment: (
                item as typeof item & { fulfillment: CartItemFulfillment }
              ).fulfillment,
            }
          : {}),
      }))

  const pickupFulfillments = Array.from(
    new Map(
      items.flatMap((item) =>
        item.fulfillment?.type === "pickup"
          ? [[item.fulfillment.option.coordinate, item.fulfillment] as const]
          : []
      )
    ).values()
  )

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
    lifecycle?.buyerPubkey,
    conversation?.status ?? null
  )
  const merchantShippingUpdated =
    messages?.some(
      (message) =>
        message.type === "shipping_update" &&
        message.senderPubkey === merchantPubkey &&
        (lifecycle
          ? message.recipientPubkey === lifecycle.buyerPubkey
          : message.recipientPubkey !== merchantPubkey)
    ) ?? false
  const merchantMessageObserved =
    messages?.some(
      (message) =>
        message.senderPubkey === merchantPubkey &&
        (lifecycle
          ? message.recipientPubkey === lifecycle.buyerPubkey
          : message.recipientPubkey !== merchantPubkey)
    ) ?? false
  const merchantConfirmedOrder = isMerchantOrderAccepted({
    status: merchantStatus,
    shippingUpdated: merchantShippingUpdated,
  })
  const orderDeliveryEvidence: OrderDeliveryEvidence = merchantConfirmedOrder
    ? "confirmed"
    : merchantMessageObserved || merchantStatus
      ? "recipient_observed"
      : orderDeliveryStatus === "sent"
        ? "relay_accepted"
        : "locally_queued"
  const paymentPaid = isBuyerOrderPaid({
    paymentStatus,
    merchantStatus,
    merchantShippingUpdated,
  })
  const postDeliveryProgress = hasOrderLifecyclePostDeliveryProgress({
    invoiceStatus,
    paymentStatus,
    proofDeliveryStatus,
  })
  const strongerDeliveryEvidence =
    orderDeliveryEvidence !== "locally_queued" || postDeliveryProgress

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
      : isCompletedMerchantStatus(merchantStatus)
        ? "completed"
        : lifecycle?.phase === "completed" || lifecycle?.phase === "cancelled"
          ? lifecycle.phase
          : paymentPaid || strongerDeliveryEvidence
            ? "in_progress"
            : (lifecycle?.phase ??
              (orderDeliveryStatus === "sent" ? "in_progress" : "pending"))

  const publicReceiptNotObserved =
    paymentStatus === "ambiguous" && zapReceiptStatus === "receipt_not_observed"
  const paymentContinuationNeeded = shouldOfferOrderPaymentContinuation({
    checkoutMode: lifecycle?.checkoutMode ?? null,
    merchantShippingUpdated,
    merchantStatus,
    orderDeliveryEvidence,
    paymentStatus,
    phase,
    totalSats,
  })
  const zeroCostPickupOrder = isZeroCostPickupOrder({
    totalSats,
    requiresPickup: pickupFulfillments.length > 0,
    items,
  })
  const paymentActionAllowed = canOfferOrderPaymentAction({
    merchantShippingUpdated,
    merchantStatus,
    phase,
  })
  const actionNeeded =
    (orderDeliveryStatus === "failed" && !strongerDeliveryEvidence) ||
    paymentContinuationNeeded ||
    (!zeroCostPickupOrder &&
      ((paymentActionAllowed &&
        !paymentPaid &&
        (paymentStatus === "manual_required" ||
          paymentStatus === "failed" ||
          (paymentStatus === "ambiguous" && !publicReceiptNotObserved))) ||
        proofDeliveryStatus === "retry_needed" ||
        proofDeliveryStatus === "failed"))

  // Buyer knows the flow authoritatively from checkoutMode; fall back to the
  // merchant-side heuristic when there's no lifecycle record (relay-only view).
  const flow: OrderFlow = lifecycle?.checkoutMode
    ? orderFlowFromCheckoutMode(lifecycle.checkoutMode)
    : deriveOrderFlow({
        status: null,
        paymentObserved: paymentStatus === "paid",
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
    publicZapFallback: lifecycle?.publicZapFallback === true,
    createdAt: lifecycle?.createdAt ?? conversation?.latestAt ?? Date.now(),
    updatedAt: lifecycle?.updatedAt ?? conversation?.latestAt ?? Date.now(),
    items,
    requiresShipping:
      items.length === 0 ||
      items.some(
        (item) =>
          item.format !== "digital" && item.fulfillment?.type !== "pickup"
      ),
    requiresPickup: pickupFulfillments.length > 0,
    pickupFulfillments,
    totalSats,
    currency: lifecycle?.currency ?? summary?.currency ?? "SATS",
    shippingAddress:
      lifecycle?.shippingAddress ?? summary?.shippingAddress ?? null,
    contactNote: lifecycle?.contactNote ?? summary?.orderNote ?? null,
    orderDeliveryStatus,
    orderDeliveryEvidence,
    invoiceStatus,
    paymentStatus,
    proofDeliveryStatus,
    zapReceiptStatus,
    addressValidity: lifecycle?.addressValidity ?? "not_required",
    merchantStatus,
    merchantShippingUpdated,
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
      title: "Relay accepted order",
      subtitle: "A Nostr relay accepted your order for merchant pickup.",
    },
    active: {
      title: "Sending order to relay",
      subtitle: "Waiting for a Nostr relay to accept your order.",
    },
    waiting: {
      title: "Order delivery pending",
      subtitle: "Your order will be sent to a relay for merchant pickup.",
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
  const paid = isBuyerOrderPaid(vm)
  const merchantConfirmed = isMerchantOrderAccepted({
    status: vm.merchantStatus,
    shippingUpdated: vm.merchantShippingUpdated,
  })
  const shipped =
    vm.merchantShippingUpdated ||
    vm.merchantStatus === "shipped" ||
    isCompletedMerchantStatus(vm.merchantStatus) ||
    !!vm.tracking
  const completed = isCompletedMerchantStatus(vm.merchantStatus)

  // 1. Order sent
  let orderSent: StatusStepperRowStatus = "waiting"
  if (vm.orderDeliveryEvidence !== "locally_queued") orderSent = "complete"
  else if (
    hasOrderLifecyclePostDeliveryProgress({
      invoiceStatus: vm.invoiceStatus,
      paymentStatus: vm.paymentStatus,
      proofDeliveryStatus: vm.proofDeliveryStatus,
    })
  ) {
    orderSent = "in_progress"
  } else if (vm.orderDeliveryStatus === "pending") orderSent = "in_progress"
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
  const complete: StatusStepperRowStatus = completed
    ? "complete"
    : !vm.requiresShipping && !vm.requiresPickup && merchantConfirmed
      ? "in_progress"
      : "waiting"

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
  if (
    isCompletedMerchantStatus(vm.merchantStatus) ||
    vm.phase === "completed"
  ) {
    return "completed"
  }
  if (
    isBuyerOrderPaid(vm) ||
    vm.merchantStatus === "accepted" ||
    vm.merchantStatus === "processing" ||
    vm.merchantStatus === "shipped"
  ) {
    return "in_progress"
  }
  return "pending"
}

export function buildOrderTimeline(
  vm: OrderViewModel,
  formatSats: (sats: number) => string = (sats) =>
    `${sats.toLocaleString()} sats`
): StatusStepperRow[] {
  const statuses = computeOrderTimelineStatuses(vm)
  const pickupHandoff = vm.pickupFulfillments[0]
    ? getPickupHandoffSummary(vm.pickupFulfillments[0])
    : null
  const rowOrder: readonly OrderTimelineRowKey[] = isZeroCostPickupOrder(vm)
    ? ["order_sent", "merchant_confirmation", "fulfillment", "complete"]
    : vm.buyerIdentityKind === "guest_ephemeral"
      ? TIMELINE_ROW_ORDER.slice(0, 4)
      : vm.requiresShipping || vm.requiresPickup
        ? TIMELINE_ROW_ORDER
        : TIMELINE_ROW_ORDER.filter((key) => key !== "fulfillment")
  return rowOrder.map((key) => {
    const status = statuses[key]
    const copy = copyFor(key, status)
    let title = copy.title
    let subtitle = copy.subtitle
    if (
      key === "order_sent" &&
      status === "complete" &&
      vm.orderDeliveryStatus !== "sent" &&
      vm.orderDeliveryEvidence !== "locally_queued"
    ) {
      title =
        vm.orderDeliveryEvidence === "confirmed"
          ? "Merchant confirmed order"
          : "Merchant observed order"
      subtitle =
        "Authenticated merchant activity shows the order reached the merchant; no relay acknowledgement was recorded."
    } else if (key === "invoice" && vm.flow === "prepaid") {
      // Prepaid (zap-out) orders have no merchant invoice; reflect direct payment.
      title = status === "complete" ? "Paid directly" : "Direct payment"
      subtitle =
        "Paid the merchant directly over Lightning — no invoice needed."
    } else if (key === "fulfillment" && vm.requiresPickup) {
      title =
        status === "complete"
          ? "Pickup complete"
          : (pickupHandoff?.label ?? "Event pickup")
      subtitle =
        status === "complete"
          ? "The pickup order was marked complete."
          : pickupHandoff?.mode === "organizer_handoff"
            ? isZeroCostPickupOrder(vm)
              ? "No payment is required. The organizer handles pickup after the merchant sends the minimal private pickup receipt."
              : "The organizer handles pickup after the merchant confirms payment and sends the minimal private pickup receipt."
            : "The merchant handles pickup at the signed merchant booth location. No organizer receipt is sent."
    } else if (
      key === "payment" &&
      vm.paymentStatus === "ambiguous" &&
      !isBuyerOrderPaid(vm)
    ) {
      if (vm.zapReceiptStatus === "receipt_not_observed") {
        title = "Payment not confirmed"
        subtitle =
          "A matching receipt was not observed. If your wallet shows payment, do not pay again."
      } else {
        title = "Payment needs review"
        subtitle =
          "We couldn't confirm this payment moved. Check your wallet, then message the merchant before retrying."
      }
    } else if (
      key === "payment" &&
      status === "complete" &&
      typeof vm.totalSats === "number"
    ) {
      subtitle = `Payment of ${formatSats(vm.totalSats)} was sent over Lightning.`
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
  const paid = isBuyerOrderPaid(vm)

  if (vm.merchantStatus === "cancelled" || vm.phase === "cancelled") {
    return {
      tone: "neutral",
      primaryLabel: "Cancelled",
      detailLabel: "Order cancelled",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (vm.merchantStatus === "refund_requested") {
    return {
      tone: "warning",
      primaryLabel: "Refund requested",
      detailLabel: "Awaiting merchant response",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (isCompletedMerchantStatus(vm.merchantStatus)) {
    return {
      tone: "success",
      primaryLabel: "Completed",
      detailLabel: "Delivered",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (
    vm.orderDeliveryStatus === "failed" &&
    vm.orderDeliveryEvidence === "locally_queued" &&
    !hasOrderLifecyclePostDeliveryProgress({
      invoiceStatus: vm.invoiceStatus,
      paymentStatus: vm.paymentStatus,
      proofDeliveryStatus: vm.proofDeliveryStatus,
    })
  ) {
    return {
      tone: "error",
      primaryLabel: "Failed",
      detailLabel: "Order not sent",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (
    vm.orderDeliveryEvidence === "locally_queued" &&
    !hasOrderLifecyclePostDeliveryProgress({
      invoiceStatus: vm.invoiceStatus,
      paymentStatus: vm.paymentStatus,
      proofDeliveryStatus: vm.proofDeliveryStatus,
    })
  ) {
    return {
      tone: "neutral",
      primaryLabel: "Queued",
      detailLabel: "Saved locally; waiting for relay",
      actionNeeded: false,
      showSpinner: true,
    }
  }
  if (isZeroCostPickupOrder(vm)) {
    if (
      vm.merchantStatus === "accepted" ||
      vm.merchantStatus === "processing" ||
      vm.merchantStatus === "shipped"
    ) {
      return {
        tone: "info",
        primaryLabel: "In progress",
        detailLabel:
          vm.merchantStatus === "shipped"
            ? "Pickup ready"
            : "Merchant confirmed",
        actionNeeded: false,
        showSpinner: false,
      }
    }
    if (vm.orderDeliveryStatus === "sent") {
      return {
        tone: "warning",
        primaryLabel: "Pending",
        detailLabel: "Awaiting merchant",
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
  if (vm.paymentStatus === "failed" && !paid) {
    return {
      tone: "error",
      primaryLabel: "Payment failed",
      detailLabel: "Try payment again",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (
    vm.paymentStatus === "ambiguous" &&
    vm.zapReceiptStatus === "receipt_not_observed" &&
    !paid
  ) {
    return {
      tone: "warning",
      primaryLabel: "Payment unclear",
      detailLabel: "Do not pay again",
      actionNeeded: false,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "ambiguous" && !paid) {
    return {
      tone: "warning",
      primaryLabel: "Payment unclear",
      detailLabel: "Check wallet before retrying",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (vm.paymentStatus === "manual_required" && !paid) {
    return {
      tone: "warning",
      primaryLabel: "Action needed",
      detailLabel: "Pay with external wallet",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (shouldOfferOrderPaymentContinuation(vm)) {
    return {
      tone: "warning",
      primaryLabel: "Action needed",
      detailLabel: "Continue payment",
      actionNeeded: true,
      showSpinner: false,
    }
  }
  if (paid) {
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
          detailLabel: vm.requiresPickup
            ? "Merchant recovery uses email or phone"
            : "Merchant follow-up uses phone and email",
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
