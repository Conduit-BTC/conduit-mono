import {
  EVENT_KINDS,
  appendConduitClientTag,
  fetchLnurlInvoice,
  fetchZapInvoice,
  getPriceSats,
  getShippingCostSats,
  isBtcLikeCurrency,
  isMsatsLikeCurrency,
  isSatsLikeCurrency,
  normalizeCommercePrice,
  type FetchZapInvoiceResult,
  type BtcUsdRateQuote,
  type NwcDiagnostic,
  type PricingRateInput,
  type SourcePriceQuote,
  type StoredPaymentAttempt,
} from "@conduit/core"
import type { CartItem } from "../hooks/useCart"

export const CHECKOUT_QUOTE_MAX_AGE_MS = 5 * 60_000

export type CheckoutZapVisibility = "public_zap" | "private_checkout"

export type CheckoutPaymentStage =
  | "checking_order_delivery"
  | "requesting_invoice"
  | "paying_invoice"
  | "sending_receipt"
  | "checking_receipt"

export type CheckoutPricingItem = {
  productId: string
  quantity: number
  priceAtPurchase: number
  currency: "SATS"
  shippingCostSats?: number
  sourceShippingCost?: SourcePriceQuote
  shippingOptionId?: string
  shippingOptionDTag?: string
  shippingCountries?: string[]
  shippingCountryRules?: CartItem["shippingCountryRules"]
  sourcePrice?: SourcePriceQuote
}

export type CheckoutShippingCostStatus =
  | "not_required"
  | "included"
  | "priced"
  | "manual"

export type CheckoutShippingCostSummary = {
  status: CheckoutShippingCostStatus
  totalSats: number
  missingProductIds: string[]
}

export type CheckoutPricingIntent =
  | {
      status: "ok"
      itemSubtotalSats: number
      totalSats: number
      totalMsats: number
      items: CheckoutPricingItem[]
      shippingCost: CheckoutShippingCostSummary
      quote?: {
        rate: number
        fetchedAt: number
        source: BtcUsdRateQuote["source"]
        fiatSource?: BtcUsdRateQuote["fiatSource"]
      }
      approximate: boolean
    }
  | {
      status: "error"
      reason: string
      code: "unpriced_items" | "stale_quote" | "invalid_total"
    }

function isQuoteObject(
  rateInput: PricingRateInput
): rateInput is BtcUsdRateQuote {
  return !!rateInput && typeof rateInput === "object"
}

function itemNeedsFreshQuote(item: CartItem, approximate: boolean): boolean {
  const sourceCurrency = item.sourcePrice?.normalizedCurrency ?? item.currency
  return (
    approximate &&
    !isSatsLikeCurrency(sourceCurrency) &&
    !isMsatsLikeCurrency(sourceCurrency) &&
    !isBtcLikeCurrency(sourceCurrency)
  )
}

function shippingCostNeedsFreshQuote(
  item: CartItem,
  approximate: boolean
): boolean {
  const sourceCurrency = item.sourceShippingCost?.normalizedCurrency
  return (
    approximate &&
    !!sourceCurrency &&
    !isSatsLikeCurrency(sourceCurrency) &&
    !isMsatsLikeCurrency(sourceCurrency) &&
    !isBtcLikeCurrency(sourceCurrency)
  )
}

function getKnownShippingCostSats(
  item: CartItem,
  rateInput: PricingRateInput = null
): { sats: number; approximate: boolean } | null {
  return getShippingCostSats(item, rateInput)
}

export function getCheckoutShippingCost(
  items: CartItem[],
  rateInput: PricingRateInput = null
): CheckoutShippingCostSummary {
  const physicalItems = items.filter((item) => item.format !== "digital")
  if (physicalItems.length === 0) {
    return {
      status: "not_required",
      totalSats: 0,
      missingProductIds: [],
    }
  }

  const missingProductIds = physicalItems
    .filter((item) => getKnownShippingCostSats(item, rateInput) === null)
    .map((item) => item.productId)

  if (missingProductIds.length > 0) {
    return {
      status: "manual",
      totalSats: 0,
      missingProductIds,
    }
  }

  const totalSats = physicalItems.reduce(
    (sum, item) =>
      sum +
      (getKnownShippingCostSats(item, rateInput)?.sats ?? 0) * item.quantity,
    0
  )

  return {
    status: totalSats === 0 ? "included" : "priced",
    totalSats,
    missingProductIds: [],
  }
}

export function buildCheckoutPricingIntent(
  items: CartItem[],
  rateInput: PricingRateInput,
  nowMs = Date.now()
): CheckoutPricingIntent {
  const pricedItems: CheckoutPricingItem[] = []
  let itemSubtotalSats = 0
  let needsFreshQuote = false

  for (const item of items) {
    const priced = getPriceSats(item, rateInput)
    if (!priced) {
      return {
        status: "error",
        code: "unpriced_items",
        reason:
          "One or more items cannot be converted to sats right now. Refresh prices before checkout.",
      }
    }

    let itemSats = priced.sats
    if (itemNeedsFreshQuote(item, priced.approximate)) {
      needsFreshQuote = true
      if (!isQuoteObject(rateInput)) {
        return {
          status: "error",
          code: "stale_quote",
          reason: "Refresh price conversion before paying.",
        }
      }

      if (nowMs - rateInput.fetchedAt > CHECKOUT_QUOTE_MAX_AGE_MS) {
        return {
          status: "error",
          code: "stale_quote",
          reason: "Refresh price conversion before paying.",
        }
      }

      const source = item.sourcePrice ?? {
        amount: item.price,
        currency: item.currency,
        normalizedCurrency: item.currency.trim().toUpperCase(),
      }
      const normalized = normalizeCommercePrice(
        source.amount,
        source.normalizedCurrency,
        rateInput
      )
      if (normalized.status !== "ok") {
        return {
          status: "error",
          code: "unpriced_items",
          reason:
            "One or more items cannot be converted to sats right now. Refresh prices before checkout.",
        }
      }
      itemSats = normalized.sats
    }

    const shippingSats = getKnownShippingCostSats(item, rateInput)
    if (!shippingSats && item.sourceShippingCost) {
      return {
        status: "error",
        code: "unpriced_items",
        reason:
          "One or more items cannot be converted to sats right now. Refresh prices before checkout.",
      }
    }
    if (
      shippingSats &&
      shippingCostNeedsFreshQuote(item, shippingSats.approximate)
    ) {
      needsFreshQuote = true
      if (!isQuoteObject(rateInput)) {
        return {
          status: "error",
          code: "stale_quote",
          reason: "Refresh price conversion before paying.",
        }
      }

      if (nowMs - rateInput.fetchedAt > CHECKOUT_QUOTE_MAX_AGE_MS) {
        return {
          status: "error",
          code: "stale_quote",
          reason: "Refresh price conversion before paying.",
        }
      }
    }

    itemSubtotalSats += itemSats * item.quantity
    pricedItems.push({
      productId: item.productId,
      quantity: item.quantity,
      priceAtPurchase: itemSats,
      currency: "SATS",
      shippingCostSats: shippingSats?.sats,
      sourceShippingCost: item.sourceShippingCost,
      shippingOptionId: item.shippingOptionId,
      shippingOptionDTag: item.shippingOptionDTag,
      shippingCountries: item.shippingCountries,
      shippingCountryRules: item.shippingCountryRules,
      sourcePrice: item.sourcePrice,
    })
  }

  const shippingCost = getCheckoutShippingCost(items, rateInput)
  const totalSats = itemSubtotalSats + shippingCost.totalSats

  if (!Number.isSafeInteger(totalSats) || totalSats <= 0) {
    return {
      status: "error",
      code: "invalid_total",
      reason: "Order total could not be converted to sats.",
    }
  }

  return {
    status: "ok",
    itemSubtotalSats,
    totalSats,
    totalMsats: totalSats * 1000,
    items: pricedItems,
    shippingCost,
    approximate: needsFreshQuote,
    quote: isQuoteObject(rateInput)
      ? {
          rate: rateInput.rate,
          fetchedAt: rateInput.fetchedAt,
          source: rateInput.source,
          fiatSource: rateInput.fiatSource,
        }
      : undefined,
  }
}

export function getCheckoutPaymentStageLabel(
  stage: CheckoutPaymentStage | null
): string {
  switch (stage) {
    case "checking_order_delivery":
      return "Checking order delivery"
    case "requesting_invoice":
      return "Requesting invoice"
    case "paying_invoice":
      return "Paying"
    case "sending_receipt":
      return "Sending receipt"
    case "checking_receipt":
      return "Checking receipt"
    case null:
      return "Pay now"
  }
}

// --- Payment tracker row mapping ------------------------------------------
//
// Pure helper: maps the payNow async-boundary state into the four buyer-facing
// rows defined in the CND-2A ticket. Kept side-effect-free so it can be unit
// tested without rendering the route.

export type PaymentTrackerRowKey =
  | "order_delivered"
  | "wallet_connecting"
  | "payment_confirmation"
  | "receipt_sent"

export type PaymentTrackerRowStatus =
  | "waiting"
  | "in_progress"
  | "complete"
  | "failed"
  | "retry_needed"

export type PaymentTrackerOutcome =
  | "in_progress"
  | "succeeded"
  | "failed_pre_delivery"
  | "failed_pre_payment"
  | "proof_retry_needed"

export interface PaymentTrackerInput {
  /** The most recent stage reported by `payNow()`. `null` means not started or finished. */
  stage: CheckoutPaymentStage | null
  /** True after the order rumor publish has resolved. */
  orderDelivered: boolean
  /** True after `nwcPayInvoice` has resolved (funds have moved). */
  paymentMoved: boolean
  /**
   * Payment proof delivery status as persisted by `payment-attempts`.
   * `undefined` while we have not yet attempted proof delivery.
   */
  proofStatus?: "pending" | "sent" | "retry_needed"
  /** Whether `payNow()` has reached a terminal state (success or failure). */
  finished: boolean
  /** The most recent error message (only meaningful when `finished` and not paid). */
  errorMessage?: string | null
}

export type PaymentTrackerRows = Record<
  PaymentTrackerRowKey,
  PaymentTrackerRowStatus
>

/**
 * Map the payNow state machine into the 4 buyer-facing tracker rows.
 *
 * Stage progression (matches `setPaymentStage` calls in `payNow`):
 *
 * | stage                     | order delivered | wallet connecting | payment confirm | receipt sent |
 * | ------------------------- | --------------- | ----------------- | --------------- | ------------ |
 * | checking_order_delivery   | in_progress     | waiting           | waiting         | waiting      |
 * | requesting_invoice        | complete        | in_progress       | waiting         | waiting      |
 * | paying_invoice            | complete        | complete          | in_progress     | waiting      |
 * | sending_receipt           | complete        | complete          | complete        | in_progress  |
 * | checking_receipt / done   | complete        | complete          | complete        | complete     |
 *
 * Failure overlays:
 *  - terminal failure pre-delivery: "order delivered" -> failed
 *  - terminal failure post-delivery, pre-payment: "wallet connecting" or
 *    "payment confirmation" -> failed (whichever was active)
 *  - proof delivery failed after payment moved: "receipt sent" -> retry_needed
 */
export function getPaymentTrackerRows(
  input: PaymentTrackerInput
): PaymentTrackerRows {
  const rows: PaymentTrackerRows = {
    order_delivered: "waiting",
    wallet_connecting: "waiting",
    payment_confirmation: "waiting",
    receipt_sent: "waiting",
  }

  // Active-stage progression
  switch (input.stage) {
    case "checking_order_delivery":
      rows.order_delivered = "in_progress"
      break
    case "requesting_invoice":
      rows.order_delivered = "complete"
      rows.wallet_connecting = "in_progress"
      break
    case "paying_invoice":
      rows.order_delivered = "complete"
      rows.wallet_connecting = "complete"
      rows.payment_confirmation = "in_progress"
      break
    case "sending_receipt":
      rows.order_delivered = "complete"
      rows.wallet_connecting = "complete"
      rows.payment_confirmation = "complete"
      rows.receipt_sent = "in_progress"
      break
    case "checking_receipt":
      rows.order_delivered = "complete"
      rows.wallet_connecting = "complete"
      rows.payment_confirmation = "complete"
      // Receipt row reflects proof status, not the merchant-receipt observer.
      rows.receipt_sent =
        input.proofStatus === "sent"
          ? "complete"
          : input.proofStatus === "retry_needed"
            ? "retry_needed"
            : "in_progress"
      break
    case null:
      // Not started yet, or terminal. Resolved below by `finished`.
      break
  }

  // Force-promote rows when boolean evidence outpaces stage (e.g. once the
  // tracker is finished and payment moved, every prior row must be complete).
  if (input.orderDelivered) rows.order_delivered = "complete"
  if (input.paymentMoved) {
    rows.order_delivered = "complete"
    rows.wallet_connecting = "complete"
    rows.payment_confirmation = "complete"
  }

  if (!input.finished) return rows

  // Terminal: paid + proof delivered
  if (input.paymentMoved) {
    if (input.proofStatus === "sent") {
      rows.receipt_sent = "complete"
    } else if (input.proofStatus === "retry_needed") {
      rows.receipt_sent = "retry_needed"
    } else if (rows.receipt_sent === "waiting") {
      // Payment moved but proof was never attempted (catch unexpected flow).
      rows.receipt_sent = "retry_needed"
    }
    return rows
  }

  // Terminal failure with no funds movement: mark the active row as failed.
  if (rows.payment_confirmation === "in_progress") {
    rows.payment_confirmation = "failed"
  } else if (rows.wallet_connecting === "in_progress") {
    rows.wallet_connecting = "failed"
  } else if (rows.order_delivered === "in_progress") {
    rows.order_delivered = "failed"
  } else if (input.orderDelivered) {
    // Order delivered but later stage failed before reaching `paying_invoice`.
    rows.wallet_connecting = "failed"
  } else {
    rows.order_delivered = "failed"
  }

  return rows
}

/**
 * Coarse outcome derived from the same input. Useful for choosing recovery
 * actions (e.g. only show "Try payment again" when no funds moved).
 */
export function getPaymentTrackerOutcome(
  input: PaymentTrackerInput
): PaymentTrackerOutcome {
  // If payment moved and proof was delivered, treat as succeeded even while
  // waiting for a zap receipt observation (which is a non-blocking tail step).
  if (input.paymentMoved && input.proofStatus === "sent") return "succeeded"
  if (!input.finished) return "in_progress"
  if (input.paymentMoved) {
    if (input.proofStatus === "retry_needed") return "proof_retry_needed"
    return "succeeded"
  }
  if (input.orderDelivered) return "failed_pre_payment"
  return "failed_pre_delivery"
}

/**
 * Which recovery moves are safe given the current tracker state.
 *
 * The critical invariant (CND-89 review): once the order has been delivered to
 * the merchant, recovery must NOT publish a second order. Retrying after a
 * post-delivery / pre-payment failure continues the *existing* order context
 * (retry invoice + payment against the same `orderId`); republishing the full
 * order or falling back to "send order, pay later" is only allowed before the
 * order has been delivered.
 *
 *  - not finished, or funds already moved -> no order/payment recovery
 *  - finished, no funds, order delivered    -> retry payment only
 *  - finished, no funds, nothing delivered  -> republish / pay-later allowed
 */
export interface CheckoutRecoveryPlan {
  /** Retry invoice + payment against the already-delivered order. */
  canRetryPayment: boolean
  /** Re-run the full fast-checkout flow, which publishes a NEW order. */
  canRepublishOrder: boolean
  /** Fall back to the order-first flow, which publishes a NEW order. */
  canSendOrderPayLater: boolean
  /**
   * Let the buyer return to the editable checkout form. Only safe before an
   * order has reached the merchant; after delivery, that form contains actions
   * that would publish a second order.
   */
  canReturnToCheckout: boolean
}

export function getCheckoutRecoveryPlan(
  input: PaymentTrackerInput
): CheckoutRecoveryPlan {
  const none: CheckoutRecoveryPlan = {
    canRetryPayment: false,
    canRepublishOrder: false,
    canSendOrderPayLater: false,
    canReturnToCheckout: false,
  }
  // No terminal failure to recover from, or funds already moved (a paid order
  // must never be re-sent or re-paid from these actions).
  if (!input.finished || input.paymentMoved) return none

  if (input.orderDelivered) {
    // Order is already in the merchant's hands -> only retry the payment.
    return {
      canRetryPayment: true,
      canRepublishOrder: false,
      canSendOrderPayLater: false,
      canReturnToCheckout: false,
    }
  }

  // Nothing was delivered -> safe to publish a fresh order.
  return {
    canRetryPayment: false,
    canRepublishOrder: true,
    canSendOrderPayLater: true,
    canReturnToCheckout: true,
  }
}

/**
 * One-line headline for the tracker. Intentionally never claims funds moved
 * before the payment-confirmation row is complete: the in-progress headline is
 * the neutral "Order in progress" and the success headline only resolves to
 * "Order complete" once the payment has settled.
 */
export function getPaymentTrackerHeadline(input: PaymentTrackerInput): string {
  switch (getPaymentTrackerOutcome(input)) {
    case "in_progress":
      return "Order in progress"
    case "succeeded":
      return "Order complete"
    case "proof_retry_needed":
      // Funds moved; only the best-effort proof DM did not reach the merchant.
      // Phrased as informational (not a buyer to-do) since we don't expose a
      // manual resend and the merchant reconciles via the zap receipt.
      return "Payment sent. Receipt delivery incomplete."
    case "failed_pre_payment":
      return "Order delivered, payment did not complete"
    case "failed_pre_delivery":
    default:
      return "Order could not be sent"
  }
}

/**
 * Build a `PaymentTrackerInput` from a persisted `StoredPaymentAttempt`. Used
 * by views that render the tracker after the original checkout session has
 * ended (e.g. the orders page reopening an in-flight fast-zap order).
 *
 * Persisted attempts are saved AFTER the wallet returns a preimage, so funds
 * are guaranteed to have moved -- the only remaining variance is whether the
 * payment proof DM successfully reached the merchant. The returned input is
 * therefore "finished + paymentMoved", with `proofStatus` mirroring the
 * stored field.
 */
export function getPaymentTrackerInputForStoredAttempt(
  attempt: StoredPaymentAttempt
): PaymentTrackerInput {
  return {
    stage: null,
    orderDelivered: true,
    paymentMoved: true,
    proofStatus: attempt.proofDeliveryStatus,
    finished: true,
  }
}

/**
 * Parsed form of an NDK relay-publish failure message.
 * Used to render the error as a structured relay list instead of a wall of text.
 */
export interface RelayFailureInfo {
  /** Short human-readable summary (omits the raw relay lists). */
  summary: string
  /** Each relay that was attempted and the reason it failed, if parseable. */
  failures: Array<{ url: string; reason: string }>
}

/**
 * Attempt to parse an NDK-style relay failure message into structured info.
 *
 * NDK format (as of 2.x):
 *   "Could not publish because no primary relay accepted the event.
 *    Attempted: wss://a, wss://b, ....
 *    ACKed: none.
 *    Failed: wss://a (Timeout: 15000ms), wss://b (Error: auth-required), ...."
 *
 * Returns `null` when the message does not match the expected pattern so the
 * caller can fall back to displaying the raw string.
 */
export function parseRelayFailureMessage(
  message: string
): RelayFailureInfo | null {
  if (!message) return null

  // Extract the "Failed: ..." section
  const failedMatch = message.match(/Failed:\s*(.+?)(?:\s*$)/s)
  if (!failedMatch) return null

  const failedSection = failedMatch[1]
  // Match each relay entry: wss://host (Reason text)
  const entryRe = /(wss?:\/\/[^\s(,]+)(?:\s*\(([^)]+)\))?/g
  const failures: Array<{ url: string; reason: string }> = []
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(failedSection)) !== null) {
    failures.push({
      url: m[1],
      reason: m[2] ?? "Failed",
    })
  }

  if (failures.length === 0) return null

  // Build a short summary from the preamble (first sentence before "Attempted:")
  const preamble = message.split(/\s+Attempted:/)[0].trim()
  const summary = preamble || "Relay publish failed."

  return { summary, failures }
}

export type PaymentTrackerRowCopyState = "complete" | "active" | "waiting"

export interface PaymentTrackerRowCopy {
  title: string
  subtitle: string
}

/**
 * Per-row, per-state title + subtitle copy.
 *
 * Each row carries three tense-consistent variants so the label never mixes
 * past/present/future across the stepper:
 *  - `complete` -- past tense ("Order sent to merchant")
 *  - `active`   -- present continuous ("Sending order to merchant")
 *  - `waiting`  -- imperative/future ("Send order to merchant")
 *
 * Source of truth: the CND-89 copy table.
 */
export const PAYMENT_TRACKER_ROW_COPY: Record<
  PaymentTrackerRowKey,
  Record<PaymentTrackerRowCopyState, PaymentTrackerRowCopy>
> = {
  order_delivered: {
    complete: {
      title: "Order sent to merchant",
      subtitle: "Encrypted order details were delivered over Nostr.",
    },
    active: {
      title: "Sending order to merchant",
      subtitle: "Delivering encrypted order details over Nostr.",
    },
    waiting: {
      title: "Send order to merchant",
      subtitle: "Encrypted order details will be delivered over Nostr.",
    },
  },
  wallet_connecting: {
    complete: {
      title: "Invoice requested",
      subtitle: "The merchant's wallet returned a Lightning invoice.",
    },
    active: {
      title: "Requesting invoice",
      subtitle:
        "Requesting a Lightning invoice from the merchant's wallet via NWC.",
    },
    waiting: {
      title: "Request invoice",
      subtitle:
        "A Lightning invoice will be requested from the merchant's wallet via NWC.",
    },
  },
  payment_confirmation: {
    complete: {
      title: "Payment sent",
      subtitle: "The invoice was paid over Lightning.",
    },
    active: {
      title: "Sending payment",
      subtitle: "Paying the invoice over Lightning.",
    },
    waiting: {
      title: "Send payment",
      subtitle: "The invoice will be paid over Lightning.",
    },
  },
  receipt_sent: {
    complete: {
      title: "Receipt sent to merchant",
      subtitle: "Payment proof was delivered over Nostr.",
    },
    active: {
      title: "Sending receipt to merchant",
      subtitle: "Delivering payment proof to the merchant over Nostr.",
    },
    waiting: {
      title: "Send receipt to merchant",
      subtitle: "Payment proof will be delivered to the merchant over Nostr.",
    },
  },
}

/**
 * Resolve the tense-correct copy for a row given its current status. `failed`
 * and `retry_needed` reuse the `active` copy (the step that was in flight),
 * with the failure tone surfaced by the status label rather than the title.
 */
export function getPaymentTrackerRowCopy(
  key: PaymentTrackerRowKey,
  status: PaymentTrackerRowStatus
): PaymentTrackerRowCopy {
  const state: PaymentTrackerRowCopyState =
    status === "complete"
      ? "complete"
      : status === "waiting"
        ? "waiting"
        : "active"
  return PAYMENT_TRACKER_ROW_COPY[key][state]
}

export function buildDefaultZapContent(params: {
  items: CartItem[]
  merchantName: string
}): string {
  const itemCount = params.items.reduce((sum, item) => sum + item.quantity, 0)
  const itemLabel = itemCount === 1 ? "item" : "items"
  return `Paid for ${itemCount} ${itemLabel} from ${params.merchantName} on Conduit.`
}

export function sanitizePublicZapContent(content: string): string {
  return content
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280)
}

export function buildZapRequestContent(
  visibility: CheckoutZapVisibility,
  content: string
): string {
  if (visibility === "private_checkout") return ""
  return sanitizePublicZapContent(content)
}

export function getLnurlReadyForCheckoutPayment(params: {
  visibility: CheckoutZapVisibility
  lnurlPayAvailable: boolean
  lnurlAllowsNostr: boolean
}): boolean {
  return params.visibility === "public_zap"
    ? params.lnurlAllowsNostr
    : params.lnurlPayAvailable
}

export type CheckoutZapRequestDraft = {
  kind: number
  createdAt: number
  content: string
  tags: string[][]
}

export type SignedCheckoutZapRequest = {
  id: string
  rawEvent: unknown
}

export type CheckoutInvoiceRequestResult = {
  invoice: string
  zapRelayUrls: string[]
  zapRequestId?: string
  shouldWaitForZapReceipt: boolean
}

export type PendingCheckoutManualInvoice = {
  orderId: string
  merchantPubkey: string
  amountMsats: number
  amountSats: number
  invoice: string
  zapRequestId?: string
  reason: string
  deliveryNotice: string | null
  diagnostics?: NwcDiagnostic[]
}

export function buildPendingCheckoutManualInvoice(
  input: PendingCheckoutManualInvoice
): PendingCheckoutManualInvoice {
  return input
}

type CheckoutInvoiceRequestDependencies = {
  fetchLnurlInvoice: typeof fetchLnurlInvoice
  fetchZapInvoice: typeof fetchZapInvoice
  signZapRequest: (
    draft: CheckoutZapRequestDraft
  ) => Promise<SignedCheckoutZapRequest>
}

const defaultCheckoutInvoiceRequestDependencies: CheckoutInvoiceRequestDependencies =
  {
    fetchLnurlInvoice,
    fetchZapInvoice,
    signZapRequest: async () => {
      throw new Error("Zap signing dependency was not configured.")
    },
  }

export async function requestCheckoutLnurlInvoice(
  params: {
    visibility: CheckoutZapVisibility
    lnurlCallback: string
    amountMsats: number
    lnurl: string
    recipientPubkey: string
    zapContent: string
    explicitRelayUrls: readonly string[]
    publicRelayUrls: readonly string[]
    nowSeconds?: number
  },
  dependencies: CheckoutInvoiceRequestDependencies = defaultCheckoutInvoiceRequestDependencies
): Promise<CheckoutInvoiceRequestResult> {
  if (params.visibility === "private_checkout") {
    const { invoice } = await dependencies.fetchLnurlInvoice(
      params.lnurlCallback,
      params.amountMsats
    )
    return {
      invoice,
      zapRelayUrls: [],
      shouldWaitForZapReceipt: false,
    }
  }

  const zapRelayUrls = Array.from(
    new Set([...params.explicitRelayUrls, ...params.publicRelayUrls])
  )
  const draft: CheckoutZapRequestDraft = {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: params.nowSeconds ?? Math.floor(Date.now() / 1000),
    content: buildZapRequestContent(params.visibility, params.zapContent),
    tags: appendConduitClientTag(
      [
        ["p", params.recipientPubkey],
        ["amount", String(params.amountMsats)],
        ["lnurl", params.lnurl],
        ["relays", ...zapRelayUrls],
      ],
      "market"
    ),
  }
  const signed = await dependencies.signZapRequest(draft)
  const result: FetchZapInvoiceResult = await dependencies.fetchZapInvoice(
    params.lnurlCallback,
    params.amountMsats,
    JSON.stringify(signed.rawEvent),
    params.lnurl
  )

  return {
    invoice: result.invoice,
    zapRelayUrls,
    zapRequestId: signed.id,
    shouldWaitForZapReceipt: true,
  }
}
