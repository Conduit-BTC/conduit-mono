import { useQuery } from "@tanstack/react-query"
import type { BtcUsdRateQuote } from "./index"

const STORAGE_KEY = "conduit:btc-usd-rate"
const STALE_MS = 5 * 60_000
const MEMPOOL_PRICE_URL = "https://mempool.space/api/v1/prices"
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
const FRANKFURTER_USD_URL = "https://api.frankfurter.dev/v1/latest?base=USD"
const EXCHANGE_RATE_USD_URL = "https://open.er-api.com/v6/latest/USD"

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

async function fetchMempoolRate(): Promise<BtcUsdRateQuote> {
  const response = await fetch(MEMPOOL_PRICE_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch mempool BTC/USD rate (${response.status})`)
  }

  const json = (await response.json()) as Record<string, unknown>

  const rate = typeof json.USD === "number" ? json.USD : null
  if (!Number.isFinite(rate) || !rate || rate <= 0) {
    throw new Error("Invalid mempool BTC/USD rate response")
  }

  const fiatUsdRates = normalizeFiatRates(
    Object.entries(json).reduce<FiatUsdRates>(
      (accumulator, [currency, value]) => {
        if (currency === "USD" || typeof value !== "number" || value <= 0) {
          return accumulator
        }

        // Mempool reports BTC priced in each fiat currency. Divide BTC/USD by
        // BTC/fiat to get USD per one unit of that fiat.
        accumulator[currency] = rate / value
        return accumulator
      },
      {}
    )
  )

  return {
    rate,
    fetchedAt: Date.now(),
    source: "mempool",
    fiatUsdRates,
    fiatSource: fiatUsdRates ? "mempool" : undefined,
  }
}

async function fetchCoinbaseRate(): Promise<BtcUsdRateQuote> {
  const response = await fetch(COINBASE_SPOT_URL)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Coinbase BTC/USD rate (${response.status})`
    )
  }

  const json = (await response.json()) as {
    data?: {
      amount?: string
    }
  }

  const rate = Number.parseFloat(json.data?.amount ?? "")
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Invalid Coinbase BTC/USD rate response")
  }

  return {
    rate,
    fetchedAt: Date.now(),
    source: "coinbase",
  }
}

async function fetchFiatUsdRates(): Promise<{
  rates: FiatUsdRates
  source: BtcUsdRateQuote["fiatSource"]
}> {
  try {
    const response = await fetch(FRANKFURTER_USD_URL)
    if (!response.ok) {
      throw new Error(
        `Frankfurter fiat rate request failed (${response.status})`
      )
    }

    const json = (await response.json()) as {
      rates?: Record<string, number>
    }
    const normalized = normalizeFiatRates(
      Object.entries(json.rates ?? {}).reduce<FiatUsdRates>(
        (accumulator, [currency, unitsPerUsd]) => {
          if (Number.isFinite(unitsPerUsd) && unitsPerUsd > 0) {
            accumulator[currency] = 1 / unitsPerUsd
          }
          return accumulator
        },
        {}
      )
    )
    if (normalized) return { rates: normalized, source: "frankfurter" }
  } catch {
    // Fall through to the secondary free-rate provider.
  }

  const response = await fetch(EXCHANGE_RATE_USD_URL)
  if (!response.ok) {
    throw new Error(
      `ExchangeRate-API fiat rate request failed (${response.status})`
    )
  }

  const json = (await response.json()) as {
    rates?: Record<string, number>
  }
  const normalized = normalizeFiatRates(
    Object.entries(json.rates ?? {}).reduce<FiatUsdRates>(
      (accumulator, [currency, unitsPerUsd]) => {
        if (Number.isFinite(unitsPerUsd) && unitsPerUsd > 0) {
          accumulator[currency] = 1 / unitsPerUsd
        }
        return accumulator
      },
      {}
    )
  )

  if (!normalized) {
    throw new Error("Invalid fiat rate response")
  }

  return { rates: normalized, source: "exchange-rate-api" }
}

export async function fetchBtcUsdRate(): Promise<BtcUsdRateQuote> {
  const env = parseEnvRate()
  if (env) return env

  try {
    return await fetchMempoolRate()
  } catch {
    const btcUsd = await fetchCoinbaseRate()
    try {
      const fiat = await fetchFiatUsdRates()
      return {
        ...btcUsd,
        fiatUsdRates: fiat.rates,
        fiatSource: fiat.source,
      }
    } catch {
      return btcUsd
    }
  }
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

export function useBtcUsdRate() {
  const env = parseEnvRate()
  const stored = env ?? readStoredRate()

  return useQuery({
    queryKey: ["btc-usd-rate"],
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
    staleTime: env ? Number.POSITIVE_INFINITY : STALE_MS,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  })
}
