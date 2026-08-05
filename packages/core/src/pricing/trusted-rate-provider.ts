import type { BtcUsdRateQuote } from "./index"

const MEMPOOL_PRICE_URL = "https://mempool.space/api/v1/prices"
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
const FRANKFURTER_USD_URL = "https://api.frankfurter.dev/v1/latest?base=USD"
const EXCHANGE_RATE_USD_URL = "https://open.er-api.com/v6/latest/USD"
const DEFAULT_TIMEOUT_MS = 6_000
const MAX_RESPONSE_BYTES = 128 * 1024

type FiatUsdRates = Record<string, number>

export type TrustedPricingRateOptions = {
  requiredFiatCurrencies?: readonly string[]
  includeFiatRates?: boolean
  fetchImpl?: typeof fetch
  nowMs?: () => number
  timeoutMs?: number
}

function normalizeFiatRates(rates: FiatUsdRates): FiatUsdRates | undefined {
  const normalized = Object.entries(rates).reduce<FiatUsdRates>(
    (accumulator, [currency, usdPerUnit]) => {
      const normalizedCurrency = currency.trim().toUpperCase()
      if (
        /^[A-Z]{3}$/.test(normalizedCurrency) &&
        normalizedCurrency !== "USD" &&
        Number.isFinite(usdPerUnit) &&
        usdPerUnit > 0
      ) {
        accumulator[normalizedCurrency] = usdPerUnit
      }
      return accumulator
    },
    {}
  )

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeRequiredCurrencies(currencies: readonly string[]): string[] {
  return Array.from(
    new Set(
      currencies
        .map((currency) => currency.trim().toUpperCase())
        .filter((currency) => /^[A-Z]{3}$/.test(currency) && currency !== "USD")
    )
  ).sort()
}

function hasRequiredRates(
  rates: FiatUsdRates | undefined,
  requiredCurrencies: readonly string[]
): boolean {
  return requiredCurrencies.every((currency) => {
    const rate = rates?.[currency]
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0
  })
}

async function fetchJsonRecord(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Pricing provider request failed (${response.status}).`)
  }

  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Pricing provider response is too large.")
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Pricing provider response is too large.")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Pricing provider returned invalid JSON.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pricing provider returned invalid data.")
  }
  return parsed as Record<string, unknown>
}

async function fetchMempoolQuote(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  fetchedAt: number
): Promise<BtcUsdRateQuote> {
  const json = await fetchJsonRecord(MEMPOOL_PRICE_URL, fetchImpl, timeoutMs)
  const rate = typeof json.USD === "number" ? json.USD : null
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Pricing provider returned an invalid BTC/USD rate.")
  }

  const fiatUsdRates = normalizeFiatRates(
    Object.entries(json).reduce<FiatUsdRates>(
      (accumulator, [currency, value]) => {
        if (currency !== "USD" && typeof value === "number" && value > 0) {
          accumulator[currency] = rate / value
        }
        return accumulator
      },
      {}
    )
  )

  return {
    rate,
    fetchedAt,
    source: "mempool",
    fiatUsdRates,
    fiatSource: fiatUsdRates ? "mempool" : undefined,
  }
}

async function fetchCoinbaseQuote(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  fetchedAt: number
): Promise<BtcUsdRateQuote> {
  const json = await fetchJsonRecord(COINBASE_SPOT_URL, fetchImpl, timeoutMs)
  const data = json.data
  const amount =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).amount
      : null
  const rate = typeof amount === "string" ? Number.parseFloat(amount) : NaN
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Pricing provider returned an invalid BTC/USD rate.")
  }
  return { rate, fetchedAt, source: "coinbase" }
}

function unitsPerUsdToUsdPerUnit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? 1 / value
    : null
}

async function fetchFiatUsdRates(
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{
  rates: FiatUsdRates
  source: NonNullable<BtcUsdRateQuote["fiatSource"]>
}> {
  try {
    const json = await fetchJsonRecord(
      FRANKFURTER_USD_URL,
      fetchImpl,
      timeoutMs
    )
    const rawRates =
      json.rates && typeof json.rates === "object" && !Array.isArray(json.rates)
        ? (json.rates as Record<string, unknown>)
        : {}
    const rates = normalizeFiatRates(
      Object.entries(rawRates).reduce<FiatUsdRates>(
        (accumulator, [currency, value]) => {
          const rate = unitsPerUsdToUsdPerUnit(value)
          if (rate) accumulator[currency] = rate
          return accumulator
        },
        {}
      )
    )
    if (rates) return { rates, source: "frankfurter" }
  } catch {
    // Continue to the independent fallback provider.
  }

  const json = await fetchJsonRecord(
    EXCHANGE_RATE_USD_URL,
    fetchImpl,
    timeoutMs
  )
  const rawRates =
    json.rates && typeof json.rates === "object" && !Array.isArray(json.rates)
      ? (json.rates as Record<string, unknown>)
      : {}
  const rates = normalizeFiatRates(
    Object.entries(rawRates).reduce<FiatUsdRates>(
      (accumulator, [currency, value]) => {
        const rate = unitsPerUsdToUsdPerUnit(value)
        if (rate) accumulator[currency] = rate
        return accumulator
      },
      {}
    )
  )
  if (!rates) throw new Error("Pricing provider returned invalid fiat rates.")
  return { rates, source: "exchange-rate-api" }
}

export async function fetchTrustedPricingRateQuote(
  options: TrustedPricingRateOptions = {}
): Promise<BtcUsdRateQuote> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Pricing provider timeout is invalid.")
  }
  const fetchedAt = (options.nowMs ?? Date.now)()
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) {
    throw new Error("Pricing quote timestamp is invalid.")
  }

  const requiredCurrencies = normalizeRequiredCurrencies(
    options.requiredFiatCurrencies ?? []
  )
  let quote: BtcUsdRateQuote
  try {
    quote = await fetchMempoolQuote(fetchImpl, timeoutMs, fetchedAt)
  } catch {
    quote = await fetchCoinbaseQuote(fetchImpl, timeoutMs, fetchedAt)
  }

  const needsFiatRates =
    options.includeFiatRates === true ||
    !hasRequiredRates(quote.fiatUsdRates, requiredCurrencies)
  if (
    needsFiatRates &&
    (options.includeFiatRates === true || quote.fiatSource !== "mempool")
  ) {
    try {
      const fiat = await fetchFiatUsdRates(fetchImpl, timeoutMs)
      quote = {
        ...quote,
        fiatUsdRates: { ...quote.fiatUsdRates, ...fiat.rates },
        fiatSource: fiat.source,
      }
    } catch (error) {
      if (requiredCurrencies.length > 0) throw error
    }
  } else if (
    requiredCurrencies.length > 0 &&
    !hasRequiredRates(quote.fiatUsdRates, requiredCurrencies)
  ) {
    const fiat = await fetchFiatUsdRates(fetchImpl, timeoutMs)
    quote = {
      ...quote,
      fiatUsdRates: fiat.rates,
      fiatSource: fiat.source,
    }
  }

  if (!hasRequiredRates(quote.fiatUsdRates, requiredCurrencies)) {
    throw new Error("Required fiat conversion rates are unavailable.")
  }
  return quote
}
