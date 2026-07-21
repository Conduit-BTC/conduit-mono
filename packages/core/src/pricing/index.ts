export const SATS_PER_BTC = 100_000_000
export const MSATS_PER_SAT = 1_000
export const DEFAULT_PRICING_RATE_MAX_AGE_MS = 5 * 60_000

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

export type CommerceShippingCostLike = {
  shippingCostSats?: number
  sourceShippingCost?: SourcePriceQuote
}

export type CommercePriceSortDirection = "asc" | "desc"

export type CurrencyAmountNormalization =
  | {
      status: "ok"
      amount: number
      normalizedCurrency: string
      fractionDigits: number
      rounded: boolean
    }
  | {
      status: "invalid"
      amount: number
      normalizedCurrency: string
      fractionDigits: number
      rounded: false
      reason: string
    }

export const SUPPORTED_PRODUCT_PRICE_CURRENCIES = [
  "SATS",
  "USD",
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "ZAR",
] as const

export type SupportedProductPriceCurrency =
  (typeof SUPPORTED_PRODUCT_PRICE_CURRENCIES)[number]

export const SUPPORTED_SHOPPER_DISPLAY_CURRENCIES = [
  "BITCOIN",
  ...SUPPORTED_PRODUCT_PRICE_CURRENCIES.filter(
    (currency) => currency !== "SATS"
  ),
] as const

export type ShopperDisplayCurrency =
  (typeof SUPPORTED_SHOPPER_DISPLAY_CURRENCIES)[number]
export type BitcoinDisplayUnit = "bitcoin" | "sats"

export type ShopperPricePreference = {
  currency: ShopperDisplayCurrency
  bitcoinUnit: BitcoinDisplayUnit
}

export const DEFAULT_SHOPPER_PRICE_PREFERENCE: ShopperPricePreference = {
  currency: "BITCOIN",
  bitcoinUnit: "bitcoin",
}

export type ShopperPriceDisplayState =
  "ready" | "rate_required" | "rate_stale" | "unsupported" | "invalid"

export type ShopperPriceDisplay = {
  state: ShopperPriceDisplayState
  primary: string
  secondary: string | null
  displayCurrency: ShopperDisplayCurrency
  sats: number | null
  approximate: boolean
  source: SourcePriceQuote | null
}

export function normalizeCurrencyCode(currency: string): string {
  return currency.trim().toUpperCase()
}

export function isSupportedShopperDisplayCurrency(
  currency: string
): currency is ShopperDisplayCurrency {
  const normalized = normalizeCurrencyCode(currency)
  return SUPPORTED_SHOPPER_DISPLAY_CURRENCIES.some(
    (supported) => supported === normalized
  )
}

export function normalizeShopperPricePreference(
  value: unknown
): ShopperPricePreference {
  if (!value || typeof value !== "object") {
    return DEFAULT_SHOPPER_PRICE_PREFERENCE
  }

  const candidate = value as {
    currency?: unknown
    bitcoinUnit?: unknown
  }
  const currency =
    typeof candidate.currency === "string" &&
    isSupportedShopperDisplayCurrency(candidate.currency)
      ? normalizeCurrencyCode(candidate.currency)
      : DEFAULT_SHOPPER_PRICE_PREFERENCE.currency
  const bitcoinUnit =
    candidate.bitcoinUnit === "sats" || candidate.bitcoinUnit === "bitcoin"
      ? candidate.bitcoinUnit
      : DEFAULT_SHOPPER_PRICE_PREFERENCE.bitcoinUnit

  return {
    currency: currency as ShopperDisplayCurrency,
    bitcoinUnit,
  }
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

const CUSTOM_CURRENCY_FRACTION_DIGITS: Record<string, number> = {
  SAT: 0,
  SATS: 0,
  MSAT: 0,
  MSATS: 0,
  BTC: 8,
  XBT: 8,
}

export function getCurrencyFractionDigits(currency: string): number {
  const normalized = normalizeCurrencyCode(currency)
  const customDigits = CUSTOM_CURRENCY_FRACTION_DIGITS[normalized]
  if (typeof customDigits === "number") return customDigits
  if (!/^[A-Z]{3}$/.test(normalized)) return 2

  try {
    const fractionDigits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalized,
    }).resolvedOptions().maximumFractionDigits
    return typeof fractionDigits === "number" ? fractionDigits : 2
  } catch {
    return 2
  }
}

export function getCurrencyAmountStep(currency: string): string {
  const fractionDigits = getCurrencyFractionDigits(currency)
  if (fractionDigits <= 0) return "1"
  return `0.${"0".repeat(fractionDigits - 1)}1`
}

export function normalizeCurrencyAmount(
  amount: number,
  currency: string
): CurrencyAmountNormalization {
  const normalizedCurrency = normalizeCurrencyCode(currency)
  const fractionDigits = getCurrencyFractionDigits(normalizedCurrency)

  if (!Number.isFinite(amount)) {
    return {
      status: "invalid",
      amount,
      normalizedCurrency,
      fractionDigits,
      rounded: false,
      reason: "Amount must be a finite number",
    }
  }

  const factor = 10 ** fractionDigits
  const rounded = Math.round((amount + Number.EPSILON) * factor) / factor
  const normalizedAmount = Object.is(rounded, -0) ? 0 : rounded

  if (!Number.isSafeInteger(Math.round(normalizedAmount * factor))) {
    return {
      status: "invalid",
      amount,
      normalizedCurrency,
      fractionDigits,
      rounded: false,
      reason: "Amount is too large",
    }
  }

  return {
    status: "ok",
    amount: normalizedAmount,
    normalizedCurrency,
    fractionDigits,
    rounded: Math.abs(amount - normalizedAmount) > 1 / factor / 1_000_000,
  }
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

export function isPricingRateQuoteFresh(
  quote: BtcUsdRateQuote | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_PRICING_RATE_MAX_AGE_MS
): boolean {
  if (!quote) return false
  if (quote.source === "env") return true
  if (!Number.isFinite(quote.fetchedAt)) return false
  const ageMs = nowMs - quote.fetchedAt
  return ageMs >= 0 && ageMs <= maxAgeMs
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

function toSafeShippingSats(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  return null
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

export function canonicalizeShippingCost(
  amount: number | undefined,
  currency: string
): CommerceShippingCostLike {
  if (typeof amount !== "number") return {}
  if (!Number.isFinite(amount) || amount < 0) return {}

  const source = sourceQuote(amount, currency)
  if (amount === 0) return { shippingCostSats: 0, sourceShippingCost: source }

  const normalized = normalizeCommercePrice(amount, currency)
  if (normalized.status === "ok" && !normalized.approximate) {
    return {
      shippingCostSats: normalized.sats,
      sourceShippingCost: normalized.source,
    }
  }

  return { sourceShippingCost: normalized.source }
}

export function getShippingCostSats(
  shipping: CommerceShippingCostLike,
  rateInput: PricingRateInput = null
): { sats: number; approximate: boolean } | null {
  const source = shipping.sourceShippingCost
  if (source) {
    if (!Number.isFinite(source.amount) || source.amount < 0) return null
    if (source.amount === 0) return { sats: 0, approximate: false }

    const normalized = normalizeCommercePrice(
      source.amount,
      source.normalizedCurrency || source.currency,
      rateInput
    )
    if (normalized.status !== "ok") return null
    return { sats: normalized.sats, approximate: normalized.approximate }
  }

  const cached = toSafeShippingSats(shipping.shippingCostSats)
  if (cached === null) return null
  return { sats: cached, approximate: false }
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

export function formatBitcoinBaseUnits(
  sats: number,
  unit: BitcoinDisplayUnit = "bitcoin",
  locale = "en-US"
): string {
  const amount = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(sats)
  return unit === "sats" ? `${amount} sats` : `₿${amount}`
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

export function formatSourcePrice(source: SourcePriceQuote): string {
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

function getDisplaySource(price: CommercePriceLike): SourcePriceQuote | null {
  if (price.sourcePrice) return price.sourcePrice
  if (!Number.isFinite(price.price) || !price.currency.trim()) return null
  return sourceQuote(price.price, price.currency)
}

function formatSourceForPreference(
  source: SourcePriceQuote,
  preference: ShopperPricePreference,
  locale: string
): string {
  if (isSatsLikeCurrency(source.normalizedCurrency)) {
    return formatBitcoinBaseUnits(source.amount, preference.bitcoinUnit, locale)
  }

  if (isMsatsLikeCurrency(source.normalizedCurrency)) {
    return formatBitcoinBaseUnits(
      source.amount / MSATS_PER_SAT,
      preference.bitcoinUnit,
      locale
    )
  }

  if (isBtcLikeCurrency(source.normalizedCurrency)) {
    return `${source.amount.toLocaleString(locale, {
      maximumFractionDigits: 8,
    })} ${source.normalizedCurrency}`
  }

  if (isFiatCurrencyCode(source.normalizedCurrency)) {
    try {
      return `${formatFiatPrice(
        source.amount,
        source.normalizedCurrency,
        locale
      )} ${source.normalizedCurrency}`
    } catch {
      return `${source.amount.toLocaleString(locale)} ${source.normalizedCurrency}`
    }
  }

  return `${source.amount.toLocaleString(locale)} ${source.normalizedCurrency}`
}

function formatSourceContext(
  source: SourcePriceQuote,
  preference: ShopperPricePreference,
  locale: string
): string {
  const label =
    isSatsLikeCurrency(source.normalizedCurrency) ||
    isMsatsLikeCurrency(source.normalizedCurrency) ||
    isBtcLikeCurrency(source.normalizedCurrency)
      ? "Bitcoin amount"
      : "source quote"
  return `${formatSourceForPreference(source, preference, locale)} ${label}`
}

function unavailableShopperDisplay(
  state: Exclude<ShopperPriceDisplayState, "ready">,
  preference: ShopperPricePreference,
  source: SourcePriceQuote | null,
  locale: string
): ShopperPriceDisplay {
  const primary =
    state === "rate_stale"
      ? "Price conversion is stale"
      : state === "rate_required"
        ? "Price conversion unavailable"
        : state === "unsupported"
          ? "Display currency unavailable"
          : "Price unavailable"

  return {
    state,
    primary,
    secondary: source ? formatSourceContext(source, preference, locale) : null,
    displayCurrency: preference.currency,
    sats: null,
    approximate: false,
    source,
  }
}

export interface ShopperPriceDisplayOptions {
  locale?: string
  nowMs?: number
  maxRateAgeMs?: number
  settledSatsAreAuthoritative?: boolean
}

export function getShopperPriceDisplay(
  price: CommercePriceLike,
  preference: ShopperPricePreference = DEFAULT_SHOPPER_PRICE_PREFERENCE,
  quote: BtcUsdRateQuote | null = null,
  options: ShopperPriceDisplayOptions = {}
): ShopperPriceDisplay {
  const normalizedPreference = normalizeShopperPricePreference(preference)
  const locale = options.locale ?? "en-US"
  const source = getDisplaySource(price)
  const sourceCurrency = source?.normalizedCurrency ?? price.currency
  const recordedSats = options.settledSatsAreAuthoritative
    ? getPriceSats(price)
    : null
  const authoritativeSats = recordedSats
    ? { sats: recordedSats.sats, approximate: false }
    : null
  const sourceNeedsRate =
    isFiatCurrencyCode(sourceCurrency) && !authoritativeSats
  const displaysExactSourceQuote =
    !!source &&
    isFiatCurrencyCode(source.normalizedCurrency) &&
    source.normalizedCurrency === normalizedPreference.currency
  const displayNeedsRate =
    normalizedPreference.currency !== "BITCOIN" && !displaysExactSourceQuote
  const needsRate = sourceNeedsRate || displayNeedsRate

  if (displaysExactSourceQuote && source) {
    const cachedSats = getPriceSats(
      price,
      isPricingRateQuoteFresh(
        quote,
        options.nowMs,
        options.maxRateAgeMs ?? DEFAULT_PRICING_RATE_MAX_AGE_MS
      )
        ? quote
        : null
    )
    return {
      state: "ready",
      primary: formatFiatPrice(
        source.amount,
        normalizedPreference.currency,
        locale
      ),
      secondary: cachedSats
        ? formatBitcoinBaseUnits(
            cachedSats.sats,
            normalizedPreference.bitcoinUnit,
            locale
          )
        : null,
      displayCurrency: normalizedPreference.currency,
      sats: cachedSats?.sats ?? null,
      approximate: false,
      source,
    }
  }

  if (needsRate && !quote) {
    return unavailableShopperDisplay(
      "rate_required",
      normalizedPreference,
      source,
      locale
    )
  }

  if (
    needsRate &&
    !isPricingRateQuoteFresh(
      quote,
      options.nowMs,
      options.maxRateAgeMs ?? DEFAULT_PRICING_RATE_MAX_AGE_MS
    )
  ) {
    return unavailableShopperDisplay(
      "rate_stale",
      normalizedPreference,
      source,
      locale
    )
  }

  const normalized =
    sourceNeedsRate && source
      ? normalizeCommercePrice(source.amount, source.normalizedCurrency, quote)
      : null
  const sats =
    authoritativeSats ??
    (normalized
      ? normalized.status === "ok"
        ? { sats: normalized.sats, approximate: normalized.approximate }
        : null
      : getPriceSats(price, quote))

  if (!sats) {
    const state =
      normalized?.status === "unsupported"
        ? "unsupported"
        : normalized?.status === "rate_required"
          ? "rate_required"
          : "invalid"
    return unavailableShopperDisplay(
      state,
      normalizedPreference,
      source,
      locale
    )
  }

  if (normalizedPreference.currency === "BITCOIN") {
    const sourceIsNative =
      !!source &&
      (isSatsLikeCurrency(source.normalizedCurrency) ||
        isMsatsLikeCurrency(source.normalizedCurrency))
    return {
      state: "ready",
      primary: `${sats.approximate ? "~= " : ""}${formatBitcoinBaseUnits(
        sats.sats,
        normalizedPreference.bitcoinUnit,
        locale
      )}`,
      secondary:
        source && !sourceIsNative
          ? formatSourceContext(source, normalizedPreference, locale)
          : null,
      displayCurrency: normalizedPreference.currency,
      sats: sats.sats,
      approximate: sats.approximate,
      source,
    }
  }

  const usdPerDisplayUnit = getUsdPerUnitRate(
    normalizedPreference.currency,
    quote
  )
  const btcUsdRate = getBtcUsdRate(quote)
  if (!usdPerDisplayUnit || !btcUsdRate) {
    return unavailableShopperDisplay(
      "rate_required",
      normalizedPreference,
      source,
      locale
    )
  }

  const displayAmount =
    ((sats.sats / SATS_PER_BTC) * btcUsdRate) / usdPerDisplayUnit
  if (!Number.isFinite(displayAmount) || displayAmount < 0) {
    return unavailableShopperDisplay(
      "invalid",
      normalizedPreference,
      source,
      locale
    )
  }

  return {
    state: "ready",
    primary: `~= ${formatFiatPrice(
      displayAmount,
      normalizedPreference.currency,
      locale
    )}`,
    secondary: source
      ? formatSourceContext(source, normalizedPreference, locale)
      : formatBitcoinBaseUnits(
          sats.sats,
          normalizedPreference.bitcoinUnit,
          locale
        ),
    displayCurrency: normalizedPreference.currency,
    sats: sats.sats,
    approximate: true,
    source,
  }
}

export function getShopperSatsDisplay(
  sats: number,
  preference: ShopperPricePreference = DEFAULT_SHOPPER_PRICE_PREFERENCE,
  quote: BtcUsdRateQuote | null = null,
  options: {
    locale?: string
    nowMs?: number
    maxRateAgeMs?: number
  } = {}
): ShopperPriceDisplay {
  return getShopperPriceDisplay(
    { price: sats, currency: "SATS", priceSats: sats },
    preference,
    quote,
    options
  )
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
