import {
  calculateCheckoutSparkBuyerPrice,
  calculateCheckoutSparkEventBuyerPrice,
  checkoutSparkConduitFeePolicyForNewPlan,
  isQuantumRouterEnabled,
  isSupportedCommercePriceCurrency,
  getShopperCardPriceDisplay,
  getShopperPriceDisplay,
  getShopperSatsDisplay,
  type BtcUsdRateQuote,
  type CommercePriceLike,
  type CheckoutSparkBuyerPrice,
  type PricingRateInput,
  type ShopperPriceDisplay,
  type ShopperPriceDisplayOptions,
  type ShopperPricePreference,
} from "@conduit/core"
import type { CartItem } from "../hooks/useCart"
import { groupCartPurchases } from "./cart-model"
import { buildCheckoutPricingIntent } from "./checkout-payment"
import { isCheckoutSparkSettledCart } from "./checkout-spark-settled-cart"

/** Price estimates follow the same deployment capability as checkout. */
export function coordinationPricingEnabled(): boolean {
  return isQuantumRouterEnabled()
}

export type FeeInclusiveListingPriceDisplay = ShopperPriceDisplay & {
  feeEstimateIncluded: boolean
}

type RouterListingPrice = CommercePriceLike & {
  type?: string
  format?: string
}

/** Physical fulfillment must be resolved in the cart before estimating fees. */
export function canEstimateCheckoutCoordinationListing(
  price: RouterListingPrice
): boolean {
  return (
    isSupportedCommercePriceCurrency(
      price.sourcePrice?.currency ?? price.currency
    ) &&
    price.format === "digital" &&
    (price.type === undefined ||
      price.type === "simple" ||
      price.type === "variation")
  )
}

/** Invalid prices stay unavailable in the preview, never a render-time crash. */
export function getCheckoutCoordinationPriceEstimate(input: {
  itemSubtotalSats: number
  shippingSubtotalSats: number
  /** Explicit fee from verified signed event terms; never add it to the Conduit base. */
  organizerFeeSats?: number
}): (CheckoutSparkBuyerPrice & { readonly organizerFeeSats?: number }) | null {
  try {
    const conduitFeePolicy = checkoutSparkConduitFeePolicyForNewPlan(
      input.itemSubtotalSats + input.shippingSubtotalSats,
      input.organizerFeeSats
    )
    return input.organizerFeeSats === undefined
      ? calculateCheckoutSparkBuyerPrice({ ...input, conduitFeePolicy })
      : calculateCheckoutSparkEventBuyerPrice({
          ...input,
          organizerFeeSats: input.organizerFeeSats,
          conduitFeePolicy,
        })
  } catch {
    return null
  }
}

/** One rounded percentage per actual compatible purchase, including known shipping. */
export function getCartCoordinationEstimate(
  items: CartItem[],
  quote: PricingRateInput,
  /** Exact already-verified fee per purchase ID; absent event evidence has no fee estimate. */
  eventOrganizerFees?: ReadonlyMap<string, number>
): {
  totalSats: number
  coordinationFeeSats: number
  shippingPending: boolean
  organizerFeeSats?: number
} | null {
  const groups = groupCartPurchases(items)
  if (
    groups.reduce((count, group) => count + group.items.length, 0) !==
    items.length
  )
    return null
  let totalSats = 0
  let coordinationFeeSats = 0
  let shippingPending = false
  let hasRoutedPurchase = false
  let organizerFeeSats = 0
  let hasEventPurchase = false
  try {
    for (const group of groups) {
      const pricing = buildCheckoutPricingIntent(group.items, quote)
      if (pricing.status !== "ok") return null
      const isEvent = group.items.some(
        (item) => item.fulfillment?.type === "event_market_pickup"
      )
      if (isEvent && !eventOrganizerFees?.has(group.id)) return null
      const organizerFee = isEvent ? eventOrganizerFees!.get(group.id)! : 0
      if (!Number.isSafeInteger(organizerFee) || organizerFee < 0) return null
      if (
        (!pricing.paymentRequired && organizerFee === 0) ||
        !isCheckoutSparkSettledCart(group.items)
      ) {
        totalSats += pricing.totalSats
        shippingPending ||= pricing.shippingCost.status === "manual"
        continue
      }
      hasRoutedPurchase = true
      const priceInput = {
        itemSubtotalSats: pricing.itemSubtotalSats,
        shippingSubtotalSats: pricing.shippingCost.totalSats,
        conduitFeePolicy: checkoutSparkConduitFeePolicyForNewPlan(
          pricing.itemSubtotalSats + pricing.shippingCost.totalSats,
          organizerFee
        ),
      }
      const price = isEvent
        ? calculateCheckoutSparkEventBuyerPrice({
            ...priceInput,
            organizerFeeSats: organizerFee,
          })
        : calculateCheckoutSparkBuyerPrice(priceInput)
      totalSats += price.totalSats
      coordinationFeeSats += price.coordinationFeeSats
      organizerFeeSats += organizerFee
      hasEventPurchase ||= isEvent
      shippingPending ||= pricing.shippingCost.status === "manual"
    }
    return hasRoutedPurchase &&
      Number.isSafeInteger(totalSats) &&
      Number.isSafeInteger(organizerFeeSats) &&
      Number.isSafeInteger(coordinationFeeSats)
      ? {
          totalSats,
          coordinationFeeSats,
          shippingPending,
          ...(hasEventPurchase ? { organizerFeeSats } : {}),
        }
      : null
  } catch {
    return null
  }
}

/** Display only. Never write these estimated totals into a listing or cart line. */
export function getFeeInclusiveListingPriceDisplay(
  price: RouterListingPrice,
  preference: ShopperPricePreference | undefined,
  quote: BtcUsdRateQuote | null,
  enabled: boolean,
  options: ShopperPriceDisplayOptions = {}
): FeeInclusiveListingPriceDisplay {
  const base = getShopperPriceDisplay(price, preference, quote, options)
  if (
    !enabled ||
    !canEstimateCheckoutCoordinationListing(price) ||
    base.state !== "ready" ||
    base.sats === null ||
    base.sats === 0
  ) {
    return { ...base, feeEstimateIncluded: false }
  }
  try {
    const total = calculateCheckoutSparkBuyerPrice({
      itemSubtotalSats: base.sats,
      shippingSubtotalSats: 0,
      conduitFeePolicy: checkoutSparkConduitFeePolicyForNewPlan(base.sats),
    })
    const display = getShopperSatsDisplay(
      total.totalSats,
      preference,
      quote,
      options
    )
    if (display.state !== "ready")
      return { ...display, feeEstimateIncluded: false }
    return {
      ...display,
      primary: display.primary.startsWith("~ ")
        ? display.primary
        : `~ ${display.primary}`,
      approximate: true,
      feeEstimateIncluded: true,
    }
  } catch {
    return { ...base, feeEstimateIncluded: false }
  }
}

/** Catalog-only labels; the exact display and listing amount stay unchanged. */
export function getFeeInclusiveListingCardPriceDisplay(
  price: RouterListingPrice,
  preference: ShopperPricePreference | undefined,
  quote: BtcUsdRateQuote | null,
  enabled: boolean,
  options: ShopperPriceDisplayOptions = {}
) {
  const displayOptions = { ...options, nowMs: options.nowMs ?? Date.now() }
  const full = getFeeInclusiveListingPriceDisplay(
    price,
    preference,
    quote,
    enabled,
    displayOptions
  )
  if (!full.feeEstimateIncluded || full.sats === null) {
    return {
      ...getShopperCardPriceDisplay(price, preference, quote, displayOptions),
      feeEstimateIncluded: false,
    }
  }
  const compact = getShopperCardPriceDisplay(
    { price: full.sats, currency: "SATS", priceSats: full.sats },
    preference,
    quote,
    displayOptions
  )
  return {
    ...compact,
    primary: {
      text: compact.primary.text.startsWith("~ ")
        ? compact.primary.text
        : `~ ${compact.primary.text}`,
      fullText: full.primary,
    },
    approximate: true,
    feeEstimateIncluded: true,
  }
}
