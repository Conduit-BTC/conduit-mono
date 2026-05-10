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
}

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

function toSafeIntegerSats(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null
  const rounded = Math.round(value)
  if (Math.abs(value - rounded) > Number.EPSILON) return null
  if (!Number.isSafeInteger(rounded)) return null
  return rounded
}

export function normalizeCommercePrice(
  amount: number,
  currency: string,
  btcUsdRate: number | null = null
): CommercePriceNormalization {
  const source = sourceQuote(amount, currency)

  if (!Number.isFinite(amount) || amount < 0) {
    return invalidPrice(amount, currency, "Price must be a non-negative number")
  }

  if (!source.normalizedCurrency) {
    return invalidPrice(amount, currency, "Price currency is required")
  }

  if (isSatsLikeCurrency(source.normalizedCurrency)) {
    const sats = toSafeIntegerSats(amount)
    if (sats === null) {
      return invalidPrice(amount, currency, "Satoshi prices must be whole sats")
    }
    return { status: "ok", sats, source, approximate: false }
  }

  if (isMsatsLikeCurrency(source.normalizedCurrency)) {
    const sats = toSafeIntegerSats(amount / MSATS_PER_SAT)
    if (sats === null) {
      return invalidPrice(
        amount,
        currency,
        "Millisatoshi prices must convert to whole sats"
      )
    }
    return { status: "ok", sats, source, approximate: false }
  }

  if (isBtcLikeCurrency(source.normalizedCurrency)) {
    const sats = toSafeIntegerSats(amount * SATS_PER_BTC)
    if (sats === null) {
      return invalidPrice(
        amount,
        currency,
        "BTC prices must convert to whole sats"
      )
    }
    return { status: "ok", sats, source, approximate: false }
  }

  if (isUsdCurrencyCode(source.normalizedCurrency)) {
    if (!btcUsdRate || !Number.isFinite(btcUsdRate) || btcUsdRate <= 0) {
      return {
        status: "rate_required",
        sats: null,
        source,
        approximate: false,
        reason: "BTC/USD rate is required to convert USD prices",
      }
    }

    const sats = Math.round((amount / btcUsdRate) * SATS_PER_BTC)
    if (!Number.isSafeInteger(sats) || sats < 0) {
      return invalidPrice(amount, currency, "USD price conversion overflowed")
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
  btcUsdRate: number | null = null
): T {
  const normalized = normalizeCommercePrice(
    product.price,
    product.currency,
    btcUsdRate
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
  btcUsdRate: number | null = null
): { sats: number; approximate: boolean } | null {
  if (
    typeof price.priceSats === "number" &&
    Number.isSafeInteger(price.priceSats) &&
    price.priceSats >= 0
  ) {
    const sourceCurrency =
      price.sourcePrice?.normalizedCurrency ?? price.currency
    return {
      sats: price.priceSats,
      approximate: isUsdCurrencyCode(sourceCurrency),
    }
  }

  const normalized = normalizeCommercePrice(
    price.price,
    price.currency,
    btcUsdRate
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
  btcUsdRate: number
): string {
  const usd = (sats / SATS_PER_BTC) * btcUsdRate
  if (usd > 0 && usd < 0.01) return "~$0.01"
  return `~${formatFiatPrice(usd, "USD")}`
}

function formatSourcePrice(source: SourcePriceQuote): string {
  if (isUsdCurrencyCode(source.normalizedCurrency)) {
    return formatFiatPrice(source.amount, "USD")
  }

  if (isSatsLikeCurrency(source.normalizedCurrency)) {
    return formatSats(source.amount)
  }

  return `${source.amount.toLocaleString()} ${source.normalizedCurrency}`
}

export function getProductPriceDisplay(
  product: CommercePriceLike,
  btcUsdRate: number | null = null
): { primary: string; secondary: string | null } {
  const sats = getPriceSats(product, btcUsdRate)
  const source = product.sourcePrice

  if (!sats) {
    return {
      primary: "Price unavailable",
      secondary: source
        ? `${formatSourcePrice(source)} source quote`
        : "Conversion unavailable",
    }
  }

  const primary = `${sats.approximate ? "~" : ""}${formatSats(sats.sats)}`

  if (sats.approximate && source) {
    return { primary, secondary: `${formatSourcePrice(source)} source quote` }
  }

  if (btcUsdRate && Number.isFinite(btcUsdRate) && btcUsdRate > 0) {
    return {
      primary,
      secondary: formatApproxUsdFromSats(sats.sats, btcUsdRate),
    }
  }

  return { primary, secondary: null }
}

export function getComparablePriceValue(
  product: CommercePriceLike,
  btcUsdRate: number | null = null
): number | null {
  return getPriceSats(product, btcUsdRate)?.sats ?? null
}
