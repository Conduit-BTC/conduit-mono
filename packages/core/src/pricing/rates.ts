import { useQuery } from "@tanstack/react-query"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  isPricingRateQuoteFresh,
  normalizeFiatRates,
  type BtcUsdRateQuote,
} from "./index"
import { fetchTrustedPricingRateQuote } from "./trusted-rate-provider"
import { fetchCommonPricingRateQuote } from "./common-rate-provider"
import { config } from "../config"

const STORAGE_KEY = "conduit:btc-usd-rate"
const DISPLAY_STORAGE_KEY = "conduit:btc-usd-display-rate"
const HISTORICAL_STORAGE_KEY = "conduit:btc-usd-rate:invoice-historical-1pct-v1"
export const BTC_USD_RATE_QUERY_KEY = ["btc-usd-rate"] as const
const HISTORICAL_RATE_QUERY_KEY = [
  ...BTC_USD_RATE_QUERY_KEY,
  "invoice-historical-1pct-v1",
] as const
export const BTC_USD_DISPLAY_RATE_QUERY_KEY = ["btc-usd-display-rate"] as const
export const BTC_USD_RATE_STALE_MS = DEFAULT_PRICING_RATE_MAX_AGE_MS
export const BTC_USD_RATE_REFRESH_INTERVAL_MS = 4 * 60_000

type FiatUsdRates = Record<string, number>

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

/** Current public observations are claims; historical verification is separate. */
function fetchCurrentPublicRate(): Promise<BtcUsdRateQuote> {
  return fetchCommonPricingRateQuote({ includeFiatRates: true })
}

export function getBtcUsdRateQueryKey() {
  return config.checkoutSparkPricingPolicy === "invoice-historical-1pct-v1"
    ? HISTORICAL_RATE_QUERY_KEY
    : BTC_USD_RATE_QUERY_KEY
}

export async function fetchBtcUsdRate(): Promise<BtcUsdRateQuote> {
  if (config.checkoutSparkPricingPolicy === "invoice-historical-1pct-v1")
    return fetchCurrentPublicRate()
  const env = parseEnvRate()
  if (env) return env
  return fetchTrustedPricingRateQuote({ includeFiatRates: true })
}

/** Estimates only: this feed never supplies checkout pricing authority. */
export async function fetchDisplayBtcUsdRate(): Promise<BtcUsdRateQuote> {
  return parseEnvRate() ?? fetchCurrentPublicRate()
}

function writeStoredRate(next: BtcUsdRateQuote, storageKey: string): void {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // Keep price display non-blocking when storage is unavailable.
  }
}

function readStoredRate(
  storageKey: string,
  allowEnv = true
): BtcUsdRateQuote | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<BtcUsdRateQuote>
    if (
      typeof parsed.rate !== "number" ||
      !Number.isFinite(parsed.rate) ||
      parsed.rate <= 0 ||
      typeof parsed.fetchedAt !== "number" ||
      ((parsed.source !== "env" || !allowEnv) &&
        parsed.source !== "mempool" &&
        parsed.source !== "coinbase" &&
        parsed.source !== "kraken")
    ) {
      return null
    }

    const fiatUsdRates = normalizeFiatRates(parsed.fiatUsdRates ?? {})
    const fiatSource =
      parsed.fiatSource === "frankfurter" ||
      parsed.fiatSource === "floatrates" ||
      parsed.fiatSource === "ecb" ||
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
  if (config.checkoutSparkPricingPolicy === "invoice-historical-1pct-v1")
    return null
  return parseEnvRate()?.rate ?? null
}

export function getConfiguredPricingRateQuote(): BtcUsdRateQuote | null {
  if (config.checkoutSparkPricingPolicy === "invoice-historical-1pct-v1")
    return null
  return parseEnvRate()
}

export function isBtcUsdRateQuoteFresh(
  quote: BtcUsdRateQuote | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = BTC_USD_RATE_STALE_MS
): boolean {
  return isPricingRateQuoteFresh(quote, nowMs, maxAgeMs)
}

function useRateQuery(displayOnly: boolean) {
  const historical =
    !displayOnly &&
    config.checkoutSparkPricingPolicy === "invoice-historical-1pct-v1"
  const env = historical ? null : parseEnvRate()
  const storageKey = displayOnly
    ? DISPLAY_STORAGE_KEY
    : historical
      ? HISTORICAL_STORAGE_KEY
      : STORAGE_KEY
  // Historical observations never borrow environment or legacy display storage.
  const stored = env ?? readStoredRate(storageKey, !historical)

  return useQuery({
    queryKey: displayOnly
      ? BTC_USD_DISPLAY_RATE_QUERY_KEY
      : getBtcUsdRateQueryKey(),
    queryFn: async () => {
      try {
        const next = await (displayOnly
          ? fetchDisplayBtcUsdRate()
          : fetchBtcUsdRate())
        writeStoredRate(next, storageKey)
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

/** Current observations; new fiat preparation independently enforces its policy. */
export function useBtcUsdRate() {
  return useRateQuery(false)
}

/** Approximate wallet/dashboard values, isolated from the economic query cache. */
export function useDisplayBtcUsdRate() {
  return useRateQuery(true)
}
