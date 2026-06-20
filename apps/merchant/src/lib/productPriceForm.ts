import {
  canonicalizeShippingCost,
  type CommerceShippingCostLike,
  getCurrencyAmountStep,
  isSatsLikeCurrency,
  normalizeCurrencyAmount,
  normalizeCommercePrice,
  normalizeCurrencyCode,
} from "@conduit/core"

export function getProductPriceInputStep(currency: string): string {
  return getCurrencyAmountStep(currency)
}

export function normalizePublishableProductPrice(
  price: number,
  currency: string
): number {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Price must be greater than zero")
  }

  const amount = normalizeCurrencyAmount(price, currency)
  if (amount.status !== "ok") {
    throw new Error(amount.reason)
  }

  if (amount.amount <= 0) {
    throw new Error("Price must be greater than zero")
  }

  const normalized = normalizeCommercePrice(amount.amount, currency)
  if (normalized.status === "ok" || normalized.status === "rate_required") {
    return amount.amount
  }

  throw new Error(normalized.reason)
}

export function assertPublishableProductPrice(
  price: number,
  currency: string
): void {
  normalizePublishableProductPrice(price, currency)
}

export function getProductShippingCurrencyLabel(currency: string): string {
  const normalized = normalizeCurrencyCode(currency)
  if (isSatsLikeCurrency(normalized)) return "sats"
  return normalized || "selected currency"
}

export function normalizePublishableProductShippingCost(
  amount: number,
  currency: string
): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Shipping must be a non-negative amount or blank.")
  }

  const normalized = normalizeCurrencyAmount(amount, currency)
  if (normalized.status !== "ok") {
    throw new Error(normalized.reason)
  }

  return normalized.amount
}

export function assertPublishableProductShippingCost(
  amount: number,
  currency: string
): void {
  normalizePublishableProductShippingCost(amount, currency)
}

export function canonicalizeProductShippingCost(
  amount: number | undefined,
  currency: string
): CommerceShippingCostLike {
  if (typeof amount !== "number") return {}
  const normalizedAmount = normalizePublishableProductShippingCost(
    amount,
    currency
  )
  return canonicalizeShippingCost(normalizedAmount, currency)
}
