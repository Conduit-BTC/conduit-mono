import {
  getComparablePriceValue as getCoreComparablePriceValue,
  getConfiguredBtcUsdRate,
  getProductPriceDisplay as getCoreProductPriceDisplay,
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  type CommercePriceLike,
} from "@conduit/core"

export {
  getConfiguredBtcUsdRate,
  isSatsLikeCurrency as isSatsCurrency,
  isUsdCurrencyCode as isUsdCurrency,
}

export function getProductPriceDisplay(
  product: CommercePriceLike,
  btcUsdRate: number | null = getConfiguredBtcUsdRate()
): { primary: string; secondary: string | null } {
  return getCoreProductPriceDisplay(product, btcUsdRate)
}

export function getComparablePriceValue(
  product: CommercePriceLike,
  btcUsdRate: number | null = getConfiguredBtcUsdRate()
): number | null {
  return getCoreComparablePriceValue(product, btcUsdRate)
}
