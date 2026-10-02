import {
  calculateCheckoutSparkBuyerPrice,
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
import { canUseCheckoutSparkLocalRouterCanary } from "./checkout-spark-local-router-canary"
import type { CartItem } from "../hooks/useCart"
import { groupCartPurchases } from "./cart-model"
import { buildCheckoutPricingIntent } from "./checkout-payment"

/** Match the current local router lane; never change production direct prices. */
export function coordinationPricingEnabled(): boolean {
  return (
    import.meta.env.VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL === "true" &&
    canUseCheckoutSparkLocalRouterCanary()
  )
}

export type FeeInclusiveListingPriceDisplay = ShopperPriceDisplay & {
  feeEstimateIncluded: boolean
}

/** Invalid prices stay unavailable in the preview, never a render-time crash. */
export function getCheckoutCoordinationPriceEstimate(input: {
  itemSubtotalSats: number
  shippingSubtotalSats: number
}): CheckoutSparkBuyerPrice | null {
  try {
    return calculateCheckoutSparkBuyerPrice(input)
  } catch {
    return null
  }
}

/** One minimum per actual compatible purchase, including known shipping. */
export function getCartCoordinationEstimate(
  items: CartItem[],
  quote: PricingRateInput
): {
  totalSats: number
  coordinationFeeSats: number
  shippingPending: boolean
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
  try {
    for (const group of groups) {
      const pricing = buildCheckoutPricingIntent(group.items, quote)
      if (pricing.status !== "ok") return null
      const price = calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: pricing.itemSubtotalSats,
        shippingSubtotalSats: pricing.shippingCost.totalSats,
      })
      totalSats += price.totalSats
      coordinationFeeSats += price.coordinationFeeSats
      shippingPending ||= pricing.shippingCost.status === "manual"
    }
    return Number.isSafeInteger(totalSats) &&
      Number.isSafeInteger(coordinationFeeSats)
      ? { totalSats, coordinationFeeSats, shippingPending }
      : null
  } catch {
    return null
  }
}

/** Display only. Never write these estimated totals into a listing or cart line. */
export function getFeeInclusiveListingPriceDisplay(
  price: CommercePriceLike,
  preference: ShopperPricePreference | undefined,
  quote: BtcUsdRateQuote | null,
  enabled: boolean,
  options: ShopperPriceDisplayOptions = {}
): FeeInclusiveListingPriceDisplay {
  const base = getShopperPriceDisplay(price, preference, quote, options)
  if (
    !enabled ||
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
