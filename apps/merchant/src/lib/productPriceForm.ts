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
export type ProductShippingPricingMode = "fixed" | "coordinate_after_order"

const PLAIN_DECIMAL_INPUT_PATTERN = /^\d*(?:\.\d*)?$/
const COMPLETE_PLAIN_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/

export function getProductPriceInputStep(currency: string): string {
  return getCurrencyAmountStep(currency)
}

export function getProductAmountInputMode(
  currency: string
): "numeric" | "decimal" {
  return getCurrencyAmountStep(currency) === "1" ? "numeric" : "decimal"
}

export function isPlainDecimalInput(value: string): boolean {
  return PLAIN_DECIMAL_INPUT_PATTERN.test(value)
}

export function formatProductAmountInput(amount: number): string {
  if (!Number.isFinite(amount)) return ""

  const value = String(amount)
  if (!/[eE]/.test(value)) return value

  const [coefficient, exponentText] = value.toLowerCase().split("e")
  const exponent = Number(exponentText)
  if (!coefficient || !Number.isInteger(exponent)) return ""

  const negative = coefficient.startsWith("-")
  const unsignedCoefficient = negative ? coefficient.slice(1) : coefficient
  const decimalIndex = unsignedCoefficient.indexOf(".")
  const digits = unsignedCoefficient.replace(".", "")
  const integerDigits = decimalIndex === -1 ? digits.length : decimalIndex
  const expandedDecimalIndex = integerDigits + exponent
  const expanded =
    expandedDecimalIndex <= 0
      ? `0.${"0".repeat(-expandedDecimalIndex)}${digits}`
      : expandedDecimalIndex >= digits.length
        ? `${digits}${"0".repeat(expandedDecimalIndex - digits.length)}`
        : `${digits.slice(0, expandedDecimalIndex)}.${digits.slice(expandedDecimalIndex)}`

  return negative ? `-${expanded}` : expanded
}

export function parsePlainDecimalAmount(value: string, label: string): number {
  const trimmed = value.trim()
  if (!COMPLETE_PLAIN_DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`${label} must use digits and a decimal point only.`)
  }

  const amount = Number(trimmed)
  if (!Number.isFinite(amount)) {
    throw new Error(`${label} must be a finite amount.`)
  }

  return amount
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
  if (amount.amount !== price) {
    throw new Error(
      amount.fractionDigits === 0
        ? `${amount.normalizedCurrency} amounts must be whole numbers.`
        : `${amount.normalizedCurrency} supports up to ${amount.fractionDigits} decimal places.`
    )
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
    throw new Error("Shipping must be a non-negative amount.")
  }

  const normalized = normalizeCurrencyAmount(amount, currency)
  if (normalized.status !== "ok") {
    throw new Error(normalized.reason)
  }
  if (normalized.amount !== amount) {
    throw new Error(
      normalized.fractionDigits === 0
        ? `${normalized.normalizedCurrency} amounts must be whole numbers.`
        : `${normalized.normalizedCurrency} supports up to ${normalized.fractionDigits} decimal places.`
    )
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
  currency: string,
  pricingMode: ProductShippingPricingMode
): string {
  if (format === "digital") {
    return "Digital products do not need shipping details or preset shipping zones."
  }

  if (pricingMode === "coordinate_after_order") {
    return "No shipping amount will be published while coordination is enabled."
  }

  const trimmed = value.trim()
  const currencyLabel = getProductShippingCurrencyLabel(currency)
  if (!trimmed) {
    return `Enter 0 when shipping is included, or enter a fixed amount in ${currencyLabel}. A known amount keeps fast checkout available.`
  }

  let amount: number
  try {
    amount = parsePlainDecimalAmount(trimmed, "Shipping")
  } catch {
    return `Enter a non-negative amount in ${currencyLabel} using digits and a decimal point only.`
  }

  if (Number.isFinite(amount) && amount === 0) {
    return "Shipping is included in the product price. Buyers can use fast checkout without an added shipping charge."
  }

  if (Number.isFinite(amount) && amount > 0) {
    return `This fixed shipping amount will be added to the buyer total at checkout in ${currencyLabel}, keeping fast checkout available.`
  }

  return `Enter a non-negative shipping amount in ${currencyLabel}.`
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
