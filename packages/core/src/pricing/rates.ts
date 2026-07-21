import { useQuery } from "@tanstack/react-query"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  isPricingRateQuoteFresh,
  type BtcUsdRateQuote,
} from "./index"
import { fetchTrustedPricingRateQuote } from "./trusted-rate-provider"

const STORAGE_KEY = "conduit:btc-usd-rate"
export const BTC_USD_RATE_QUERY_KEY = ["btc-usd-rate"] as const
export const BTC_USD_RATE_STALE_MS = DEFAULT_PRICING_RATE_MAX_AGE_MS
export const BTC_USD_RATE_REFRESH_INTERVAL_MS = 4 * 60_000

type FiatUsdRates = Record<string, number>

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

function parseEnvFiatUsdRates(): FiatUsdRates | undefined {
  const raw = import.meta.env.VITE_FIAT_USD_RATES
  if (typeof raw !== "string" || !raw.trim()) return undefined

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const rates = Object.entries(parsed).reduce<FiatUsdRates>(
      (accumulator, [currency, value]) => {
        const rate =
          typeof value === "number" ? value : Number.parseFloat(String(value))
        accumulator[currency] = rate
        return accumulator
      },
      {}
    )
    return normalizeFiatRates(rates)
  } catch {
    return undefined
  }
}

function parseEnvRate(): BtcUsdRateQuote | null {
  const raw = import.meta.env.VITE_BTC_USD_RATE
  if (typeof raw !== "string") return null

  const rate = Number.parseFloat(raw)
  if (!Number.isFinite(rate) || rate <= 0) return null

  return {
    rate,
    fetchedAt: Date.now(),
    source: "env",
    fiatUsdRates: parseEnvFiatUsdRates(),
    fiatSource: "env",
  }
}

export async function fetchBtcUsdRate(): Promise<BtcUsdRateQuote> {
  const env = parseEnvRate()
  if (env) return env
  return fetchTrustedPricingRateQuote({ includeFiatRates: true })
}

function writeStoredRate(next: BtcUsdRateQuote): void {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Keep price display non-blocking when storage is unavailable.
  }
}

function readStoredRate(): BtcUsdRateQuote | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<BtcUsdRateQuote>
    if (
      typeof parsed.rate !== "number" ||
      !Number.isFinite(parsed.rate) ||
      parsed.rate <= 0 ||
      typeof parsed.fetchedAt !== "number" ||
      (parsed.source !== "env" &&
        parsed.source !== "mempool" &&
        parsed.source !== "coinbase")
    ) {
      return null
    }

    const fiatUsdRates = normalizeFiatRates(parsed.fiatUsdRates ?? {})
    const fiatSource =
      parsed.fiatSource === "frankfurter" ||
      parsed.fiatSource === "exchange-rate-api" ||
      parsed.fiatSource === "env" ||
      parsed.fiatSource === "mempool"
        ? parsed.fiatSource
        : undefined

    return {
      rate: parsed.rate,
      fetchedAt: parsed.fetchedAt,
      source: parsed.source,
      fiatUsdRates,
      fiatSource,
    }
  } catch {
    return null
  }
}

export function getConfiguredBtcUsdRate(): number | null {
  return parseEnvRate()?.rate ?? null
}

export function getConfiguredPricingRateQuote(): BtcUsdRateQuote | null {
  return parseEnvRate()
}

export function isBtcUsdRateQuoteFresh(
  quote: BtcUsdRateQuote | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = BTC_USD_RATE_STALE_MS
): boolean {
  return isPricingRateQuoteFresh(quote, nowMs, maxAgeMs)
}

export function useBtcUsdRate() {
  const env = parseEnvRate()
  const stored = env ?? readStoredRate()

  return useQuery({
    queryKey: BTC_USD_RATE_QUERY_KEY,
    queryFn: async () => {
      try {
        const next = await fetchBtcUsdRate()
        writeStoredRate(next)
        return next
      } catch (error) {
        if (stored) return stored
        throw error
      }
    },
    initialData: stored ?? undefined,
    initialDataUpdatedAt: stored?.fetchedAt,
    staleTime: env ? Number.POSITIVE_INFINITY : BTC_USD_RATE_STALE_MS,
    gcTime: 30 * 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: env ? false : BTC_USD_RATE_REFRESH_INTERVAL_MS,
  })
}
