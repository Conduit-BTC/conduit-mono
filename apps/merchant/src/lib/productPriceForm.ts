import {
  isBtcLikeCurrency,
  isSatsLikeCurrency,
  normalizeCommercePrice,
} from "@conduit/core"

export function getProductPriceInputStep(currency: string): string {
  if (isSatsLikeCurrency(currency)) return "1"
  if (isBtcLikeCurrency(currency)) return "0.00000001"
  return "0.01"
}

export function assertPublishableProductPrice(
  price: number,
  currency: string
): void {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Price must be greater than zero")
  }

  const normalized = normalizeCommercePrice(price, currency)
  if (normalized.status === "ok" || normalized.status === "rate_required") {
    return
  }

  throw new Error(normalized.reason)
}
