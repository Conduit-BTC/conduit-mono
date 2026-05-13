export const SATS_PER_BTC = 100_000_000
export const MSATS_PER_SAT = 1_000

export type SourcePriceQuote = {
  amount: number
  currency: string
  normalizedCurrency: string
}

export type BtcUsdRateQuote = {
  rate: number
  fetchedAt: number
  source: "env" | "mempool" | "coinbase"
  fiatUsdRates?: Record<string, number>
  fiatSource?: "frankfurter" | "exchange-rate-api" | "env" | "mempool"
}

export type PricingRateInput = number | BtcUsdRateQuote | null

export type CommercePriceNormalization =
  | {
      status: "ok"
      sats: number
      source: SourcePriceQuote
      approximate: boolean
    }
  | {
      status: "rate_required" | "unsupported" | "invalid"
      sats: null
      source: SourcePriceQuote
      approximate: false
      reason: string
    }

export type CommercePriceLike = {
  price: number
  currency: string
  priceSats?: number
  sourcePrice?: SourcePriceQuote
}

export type CommercePriceSortDirection = "asc" | "desc"

export function normalizeCurrencyCode(currency: string): string {
  return currency.trim().toUpperCase()
}

export function isSatsLikeCurrency(currency: string): boolean {
  const normalized = normalizeCurrencyCode(currency)
  return normalized === "SAT" || normalized === "SATS"
}

export function isMsatsLikeCurrency(currency: string): boolean {
  const normalized = normalizeCurrencyCode(currency)
  return normalized === "MSAT" || normalized === "MSATS"
}

export function isBtcLikeCurrency(currency: string): boolean {
  const normalized = normalizeCurrencyCode(currency)
  return normalized === "BTC" || normalized === "XBT"
}

export function isUsdCurrencyCode(currency: string): boolean {
  return normalizeCurrencyCode(currency) === "USD"
}

export function isFiatCurrencyCode(currency: string): boolean {
  const normalized = normalizeCurrencyCode(currency)
  return (
    /^[A-Z]{3}$/.test(normalized) &&
    !isSatsLikeCurrency(normalized) &&
    !isMsatsLikeCurrency(normalized) &&
    !isBtcLikeCurrency(normalized)
  )
}

function sourceQuote(amount: number, currency: string): SourcePriceQuote {
  return {
    amount,
    currency,
    normalizedCurrency: normalizeCurrencyCode(currency),
  }
}

function invalidPrice(
  amount: number,
  currency: string,
  reason: string
): CommercePriceNormalization {
  return {
    status: "invalid",
    sats: null,
    source: sourceQuote(amount, currency),
    approximate: false,
    reason,
  }
}

function getBtcUsdRate(rateInput: PricingRateInput): number | null {
  if (typeof rateInput === "number") {
    return Number.isFinite(rateInput) && rateInput > 0 ? rateInput : null
  }

  if (!rateInput) return null
  return Number.isFinite(rateInput.rate) && rateInput.rate > 0
    ? rateInput.rate
    : null
}

function getUsdPerUnitRate(
  currency: string,
  rateInput: PricingRateInput
): number | null {
  const normalized = normalizeCurrencyCode(currency)
  if (normalized === "USD") return 1

  if (!rateInput || typeof rateInput === "number") return null

  const usdPerUnit = rateInput.fiatUsdRates?.[normalized]
  return typeof usdPerUnit === "number" &&
    Number.isFinite(usdPerUnit) &&
    usdPerUnit > 0
    ? usdPerUnit
    : null
}

function toSafeIntegerSats(
  value: number,
  minimum = 1,
  tolerance = Number.EPSILON
): number | null {
  if (!Number.isFinite(value) || value < minimum) return null
  const rounded = Math.round(value)
  if (Math.abs(value - rounded) > tolerance) return null
  if (!Number.isSafeInteger(rounded)) return null
  if (rounded < minimum) return null
  return rounded
}

export function normalizeCommercePrice(
  amount: number,
  currency: string,
  rateInput: PricingRateInput = null
): CommercePriceNormalization {
  const source = sourceQuote(amount, currency)
  const btcUsdRate = getBtcUsdRate(rateInput)

  if (!Number.isFinite(amount) || amount < 0) {
    return invalidPrice(amount, currency, "Price must be a positive number")
  }

  if (!source.normalizedCurrency) {
    return invalidPrice(amount, currency, "Price currency is required")
  }

  if (isSatsLikeCurrency(source.normalizedCurrency)) {
    const sats = toSafeIntegerSats(amount)
    if (sats === null) {
      return invalidPrice(
        amount,
        currency,
        "Satoshi prices must be at least 1 whole sat"
      )
    }
    return { status: "ok", sats, source, approximate: false }
  }

  if (isMsatsLikeCurrency(source.normalizedCurrency)) {
    const sats = toSafeIntegerSats(amount / MSATS_PER_SAT)
    if (sats === null) {
      return invalidPrice(
        amount,
        currency,
        "Millisatoshi prices must convert to at least 1 whole sat"
      )
    }
    return { status: "ok", sats, source, approximate: false }
  }

  if (isBtcLikeCurrency(source.normalizedCurrency)) {
    const sats = toSafeIntegerSats(amount * SATS_PER_BTC, 1, 1e-6)
    if (sats === null) {
      return invalidPrice(
        amount,
        currency,
        "BTC prices must convert to at least 1 whole sat"
      )
    }
    return { status: "ok", sats, source, approximate: false }
  }

  if (isFiatCurrencyCode(source.normalizedCurrency)) {
    if (!btcUsdRate || !Number.isFinite(btcUsdRate) || btcUsdRate <= 0) {
      return {
        status: "rate_required",
        sats: null,
        source,
        approximate: false,
        reason: "BTC/USD rate is required to convert fiat prices",
      }
    }

    const usdPerUnit = getUsdPerUnitRate(source.normalizedCurrency, rateInput)
    if (!usdPerUnit) {
      return {
        status: "rate_required",
        sats: null,
        source,
        approximate: false,
        reason: `${source.normalizedCurrency}/USD rate is required to convert fiat prices`,
      }
    }

    const sats = Math.round(((amount * usdPerUnit) / btcUsdRate) * SATS_PER_BTC)
    if (!Number.isSafeInteger(sats)) {
      return invalidPrice(amount, currency, "Fiat price conversion overflowed")
    }
    if (sats < 1) {
      return invalidPrice(
        amount,
        currency,
        "Fiat prices must convert to at least 1 sat"
      )
    }
    return { status: "ok", sats, source, approximate: true }
  }

  return {
    status: "unsupported",
    sats: null,
    source,
    approximate: false,
    reason: `${source.normalizedCurrency} prices are not supported yet`,
  }
}

export function canonicalizeProductPrice<T extends CommercePriceLike>(
  product: T,
  rateInput: PricingRateInput = null
): T {
  const normalized = normalizeCommercePrice(
    product.price,
    product.currency,
    rateInput
  )

  const sourcePrice = product.sourcePrice ?? normalized.source

  if (normalized.status === "ok" && !normalized.approximate) {
    return {
      ...product,
      price: normalized.sats,
      currency: "SATS",
      priceSats: normalized.sats,
      sourcePrice,
    }
  }

  if (normalized.status === "ok") {
    return {
      ...product,
      priceSats: normalized.sats,
      sourcePrice,
    }
  }

  return {
    ...product,
    currency: normalized.source.normalizedCurrency,
    sourcePrice,
  }
}

export function getPriceSats(
  price: CommercePriceLike,
  rateInput: PricingRateInput = null
): { sats: number; approximate: boolean } | null {
  if (
    typeof price.priceSats === "number" &&
    Number.isSafeInteger(price.priceSats) &&
    price.priceSats >= 1
  ) {
    const sourceCurrency =
      price.sourcePrice?.normalizedCurrency ?? price.currency
    return {
      sats: price.priceSats,
      approximate: isFiatCurrencyCode(sourceCurrency),
    }
  }

  const normalized = normalizeCommercePrice(
    price.price,
    price.currency,
    rateInput
  )
  if (normalized.status !== "ok") return null
  return { sats: normalized.sats, approximate: normalized.approximate }
}

export function formatFiatPrice(
  amount: number,
  currency = "USD",
  locale = "en-US"
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount)
}

export function formatSats(sats: number): string {
  return `${sats.toLocaleString()} sats`
}

export function formatApproxUsdFromSats(
  sats: number,
  rateInput: PricingRateInput
): string {
  const btcUsdRate = getBtcUsdRate(rateInput)
  if (!btcUsdRate) return "USD unavailable"

  const usd = (sats / SATS_PER_BTC) * btcUsdRate
  if (usd > 0 && usd < 0.01) return "about $0.01 USD"
  return `about ${formatFiatPrice(usd, "USD")} USD`
}

function formatSourcePrice(source: SourcePriceQuote): string {
  if (isFiatCurrencyCode(source.normalizedCurrency)) {
    try {
      return `${formatFiatPrice(source.amount, source.normalizedCurrency)} ${
        source.normalizedCurrency
      }`
    } catch {
      return `${source.amount.toLocaleString()} ${source.normalizedCurrency}`
    }
  }

  if (isSatsLikeCurrency(source.normalizedCurrency)) {
    return formatSats(source.amount)
  }

  return `${source.amount.toLocaleString()} ${source.normalizedCurrency}`
}

export function getProductPriceDisplay(
  product: CommercePriceLike,
  rateInput: PricingRateInput = null
): { primary: string; secondary: string | null } {
  const sats = getPriceSats(product, rateInput)
  const source =
    product.sourcePrice ??
    (isFiatCurrencyCode(product.currency)
      ? sourceQuote(product.price, product.currency)
      : undefined)

  if (!sats) {
    return {
      primary: "Price unavailable",
      secondary: source
        ? `${formatSourcePrice(source)} source quote`
        : "Conversion unavailable",
    }
  }

  const primary = `${sats.approximate ? "〜 " : ""}${formatSats(sats.sats)}`

  if (sats.approximate && source) {
    return { primary, secondary: `${formatSourcePrice(source)} source quote` }
  }

  if (getBtcUsdRate(rateInput)) {
    return {
      primary,
      secondary: formatApproxUsdFromSats(sats.sats, rateInput),
    }
  }

  return { primary, secondary: null }
}

export function getComparablePriceValue(
  product: CommercePriceLike,
  rateInput: PricingRateInput = null
): number | null {
  return getPriceSats(product, rateInput)?.sats ?? null
}

export function compareCommercePrices(
  a: CommercePriceLike,
  b: CommercePriceLike,
  rateInput: PricingRateInput = null,
  direction: CommercePriceSortDirection = "asc"
): number {
  const aSats = getComparablePriceValue(a, rateInput)
  const bSats = getComparablePriceValue(b, rateInput)

  if (aSats === null && bSats === null) return 0
  if (aSats === null) return 1
  if (bSats === null) return -1

  return direction === "asc" ? aSats - bSats : bSats - aSats
}
