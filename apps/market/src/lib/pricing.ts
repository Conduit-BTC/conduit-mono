import {
  getComparablePriceValue as getCoreComparablePriceValue,
  getProductPriceDisplay as getCoreProductPriceDisplay,
  isSatsCurrency,
  isUsdCurrency,
  type Product,
} from "@conduit/core"

export { isSatsCurrency, isUsdCurrency }

export function getConfiguredBtcUsdRate(): number | null {
  const raw = import.meta.env.VITE_BTC_USD_RATE
  if (typeof raw !== "string") return null

  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null

  return parsed
}

export function getProductPriceDisplay(
  product: Pick<Product, "price" | "currency">,
  btcUsdRate: number | null = getConfiguredBtcUsdRate()
): { primary: string; secondary: string | null } {
  return getCoreProductPriceDisplay(product, btcUsdRate)
}

export function getComparablePriceValue(
  product: Pick<Product, "price" | "currency">,
  btcUsdRate: number | null = getConfiguredBtcUsdRate()
): number | null {
  return getCoreComparablePriceValue(product, btcUsdRate)
}
