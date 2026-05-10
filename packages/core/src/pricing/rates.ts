import { useQuery } from "@tanstack/react-query"
import type { BtcUsdRateQuote } from "./index"

const STORAGE_KEY = "conduit:btc-usd-rate"
const STALE_MS = 5 * 60_000

function parseEnvRate(): BtcUsdRateQuote | null {
  const raw = import.meta.env.VITE_BTC_USD_RATE
  if (typeof raw !== "string") return null

  const rate = Number.parseFloat(raw)
  if (!Number.isFinite(rate) || rate <= 0) return null

  return {
    rate,
    fetchedAt: Date.now(),
    source: "env",
  }
}

async function fetchMempoolRate(): Promise<BtcUsdRateQuote> {
  const response = await fetch("https://mempool.space/api/v1/prices")
  if (!response.ok) {
    throw new Error(`Failed to fetch mempool BTC/USD rate (${response.status})`)
  }

  const json = (await response.json()) as {
    USD?: number
  }

  const rate = json.USD
  if (!Number.isFinite(rate) || !rate || rate <= 0) {
    throw new Error("Invalid mempool BTC/USD rate response")
  }

  return {
    rate,
    fetchedAt: Date.now(),
    source: "mempool",
  }
}

async function fetchCoinbaseRate(): Promise<BtcUsdRateQuote> {
  const response = await fetch(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot"
  )
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

export async function fetchBtcUsdRate(): Promise<BtcUsdRateQuote> {
  const env = parseEnvRate()
  if (env) return env

  try {
    return await fetchMempoolRate()
  } catch {
    return await fetchCoinbaseRate()
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

    return {
      rate: parsed.rate,
      fetchedAt: parsed.fetchedAt,
      source: parsed.source,
    }
  } catch {
    return null
  }
}

export function getConfiguredBtcUsdRate(): number | null {
  return parseEnvRate()?.rate ?? null
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
