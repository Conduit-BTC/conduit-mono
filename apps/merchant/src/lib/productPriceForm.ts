import {
  canonicalizeShippingCost,
  type CommerceShippingCostLike,
  getCurrencyAmountStep,
  isSatsLikeCurrency,
  normalizeCurrencyAmount,
  normalizeCommercePrice,
  normalizeCurrencyCode,
} from "@conduit/core"

export type ProductFulfillmentFormat = "physical" | "digital"

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

export function getProductShippingCostHelpText(
  value: string,
  format: ProductFulfillmentFormat,
  currency: string
): string {
  if (format === "digital") {
    return "Digital products do not need shipping details or preset shipping zones."
  }

  const trimmed = value.trim()
  const currencyLabel = getProductShippingCurrencyLabel(currency)
  if (!trimmed) {
    return `Blank means shipping will be coordinated with the buyer after the order request. Enter a fixed amount in ${currencyLabel} only when shipping can be charged at checkout.`
  }

  const amount = Number(trimmed)
  if (Number.isFinite(amount) && amount === 0) {
    return "0 means shipping is included in the product price."
  }

  if (Number.isFinite(amount) && amount > 0) {
    return `This fixed shipping amount will be added to the buyer total at checkout in ${currencyLabel}.`
  }

  return `Enter a non-negative shipping amount in ${currencyLabel}, leave blank to coordinate later, or enter 0 when shipping is included.`
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
