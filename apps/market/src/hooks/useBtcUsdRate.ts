import { useQuery } from "@tanstack/react-query"

const STORAGE_KEY = "conduit:btc-usd-rate"
const STALE_MS = 5 * 60_000

type StoredRate = {
  rate: number
  fetchedAt: number
}

async function fetchCoinbaseRate(): Promise<number> {
  const response = await fetch(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot"
  )
  if (!response.ok) {
    throw new Error(`Failed to fetch BTC/USD rate (${response.status})`)
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

  return rate
}

async function fetchCoinGeckoRate(): Promise<number> {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
  )
  if (!response.ok) {
    throw new Error(
      `Failed to fetch CoinGecko BTC/USD rate (${response.status})`
    )
  }

  const json = (await response.json()) as {
    bitcoin?: {
      usd?: number
    }
  }

  const rate = json.bitcoin?.usd
  if (!Number.isFinite(rate) || !rate || rate <= 0) {
    throw new Error("Invalid CoinGecko BTC/USD rate response")
  }

  return rate
}

async function fetchBtcUsdRate(): Promise<StoredRate> {
  let rate: number
  try {
    rate = await fetchCoinbaseRate()
  } catch {
    rate = await fetchCoinGeckoRate()
  }

  const next = {
    rate,
    fetchedAt: Date.now(),
  }

  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  return next
}

function readStoredRate(): StoredRate | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<StoredRate>
    if (
      typeof parsed.rate !== "number" ||
      !Number.isFinite(parsed.rate) ||
      parsed.rate <= 0 ||
      typeof parsed.fetchedAt !== "number"
    ) {
      return null
    }

    return {
      rate: parsed.rate,
      fetchedAt: parsed.fetchedAt,
    }
  } catch {
    return null
  }
}

export function useBtcUsdRate() {
  const stored = readStoredRate()

  return useQuery({
    queryKey: ["btc-usd-rate"],
    queryFn: async () => {
      try {
        return await fetchBtcUsdRate()
      } catch (error) {
        if (stored) return stored
        throw error
      }
    },
    initialData: stored ?? undefined,
    staleTime: STALE_MS,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  })
}
