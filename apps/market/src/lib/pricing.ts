import {
  getComparablePriceValue as getCoreComparablePriceValue,
  getConfiguredPricingRateQuote,
  getProductPriceDisplay as getCoreProductPriceDisplay,
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  type CommercePriceLike,
  type PricingRateInput,
} from "@conduit/core"

export {
  getConfiguredPricingRateQuote,
  isSatsLikeCurrency as isSatsCurrency,
  isUsdCurrencyCode as isUsdCurrency,
}

export function getProductPriceDisplay(
  product: CommercePriceLike,
  btcUsdRate: PricingRateInput = getConfiguredPricingRateQuote()
): { primary: string; secondary: string | null } {
  return getCoreProductPriceDisplay(product, btcUsdRate)
}

export function getComparablePriceValue(
  product: CommercePriceLike,
  btcUsdRate: PricingRateInput = getConfiguredPricingRateQuote()
): number | null {
  return getCoreComparablePriceValue(product, btcUsdRate)
}
