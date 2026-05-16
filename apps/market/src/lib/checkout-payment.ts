import {
  getPriceSats,
  isBtcLikeCurrency,
  isMsatsLikeCurrency,
  isSatsLikeCurrency,
  normalizeCommercePrice,
  type BtcUsdRateQuote,
  type PricingRateInput,
  type SourcePriceQuote,
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

function getKnownShippingCostSats(item: CartItem): number | null {
  const value = item.shippingCostSats
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  return null
}

export function getCheckoutShippingCost(
  items: CartItem[]
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
    .filter((item) => getKnownShippingCostSats(item) === null)
    .map((item) => item.productId)

  if (missingProductIds.length > 0) {
    return {
      status: "manual",
      totalSats: 0,
      missingProductIds,
    }
  }

  const totalSats = physicalItems.reduce(
    (sum, item) => sum + (getKnownShippingCostSats(item) ?? 0) * item.quantity,
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

    itemSubtotalSats += itemSats * item.quantity
    pricedItems.push({
      productId: item.productId,
      quantity: item.quantity,
      priceAtPurchase: itemSats,
      currency: "SATS",
      shippingCostSats: getKnownShippingCostSats(item) ?? undefined,
      sourcePrice: item.sourcePrice,
    })
  }

  const shippingCost = getCheckoutShippingCost(items)
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

export function buildDefaultZapContent(params: {
  items: CartItem[]
  merchantName: string
}): string {
  const itemCount = params.items.reduce((sum, item) => sum + item.quantity, 0)
  if (params.items.length === 1 && itemCount === 1) {
    return `Paid for ${params.items[0]!.title} from ${params.merchantName} on Conduit.`
  }
  return `Paid for ${itemCount} items from ${params.merchantName} on Conduit.`
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
