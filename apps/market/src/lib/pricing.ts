import {
  compareCommercePrices as compareCoreCommercePrices,
  getComparablePriceValue as getCoreComparablePriceValue,
  getConfiguredPricingRateQuote,
  getProductPriceDisplay as getCoreProductPriceDisplay,
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  type CommercePriceLike,
  type CommercePriceSortDirection,
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

export function compareCommercePrices(
  a: CommercePriceLike,
  b: CommercePriceLike,
  btcUsdRate: PricingRateInput = getConfiguredPricingRateQuote(),
  direction: CommercePriceSortDirection = "asc"
): number {
  return compareCoreCommercePrices(a, b, btcUsdRate, direction)
}
