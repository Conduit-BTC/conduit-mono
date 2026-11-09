import {
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  type BtcUsdRateQuote,
} from "./index"

export const HISTORICAL_PRICING_BENCHMARK_ID =
  "coinbase-minute-close-ecb-prior-day-v1"

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const MAX_RESPONSE_BYTES = 128 * 1024
const UNAVAILABLE = "Historical pricing is unavailable."

export type HistoricalPricingRateQuote = BtcUsdRateQuote & {
  /** Provider invoice time is the valuation anchor; fetchedAt is read metadata only. */
  historical: {
    policyId: typeof HISTORICAL_PRICING_BENCHMARK_ID
    acceptedAtMs: number
    btcMinuteStartMs: number
    fxRequestedDate?: string
    fxObservedDate?: string
  }
}

export type HistoricalPricingRateOptions = {
  acceptedAtMs: number
  currencies?: readonly string[]
  fetchImpl?: typeof fetch
  /** One shared wall-clock budget, including both streamed response bodies. */
  timeoutMs?: number
}

function unavailable(): never {
  throw new Error(UNAVAILABLE)
}

async function readJson(
  url: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = () => void reader?.cancel().catch(() => {})
  signal.addEventListener("abort", cancel, { once: true })
  try {
    if (signal.aborted) return unavailable()
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "manual",
      signal,
    })
    if (
      signal.aborted ||
      !response.ok ||
      response.redirected ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => {})
      return unavailable()
    }
    const length = response.headers.get("content-length")
    if (
      length &&
      (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
    ) {
      void response.body.cancel().catch(() => {})
      return unavailable()
    }
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const chunk = await reader.read()
      if (signal.aborted) return unavailable()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) return unavailable()
      chunks.push(chunk.value)
    }
    const payload = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      payload.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
  }
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : unavailable()
}

function candleClose(json: unknown, minuteStartMs: number): number {
  if (!Array.isArray(json)) return unavailable()
  const candidates = json.filter(
    (row) => Array.isArray(row) && row[0] === minuteStartMs / 1_000
  )
  if (candidates.length !== 1) return unavailable()
  const row: unknown[] = candidates[0]
  if (row.length !== 6) return unavailable()
  const low = positive(row[1])
  const high = positive(row[2])
  const open = positive(row[3])
  const close = positive(row[4])
  if (
    low > high ||
    open < low ||
    open > high ||
    close < low ||
    close > high ||
    typeof row[5] !== "number" ||
    !Number.isFinite(row[5]) ||
    row[5] < 0
  )
    return unavailable()
  return close
}

function ecbConversions(
  json: unknown,
  desired: readonly string[],
  requestedDate: string,
  anchorDayMs: number
): { rates: Record<string, number>; observedDate: string } {
  if (!Array.isArray(json)) return unavailable()
  const required = new Set(["USD", ...desired.filter((c) => c !== "EUR")])
  const perEuro = new Map<string, number>([["EUR", 1]])
  let observedDate: string | undefined
  for (const item of json) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return unavailable()
    const row = item as Record<string, unknown>
    if (typeof row.quote !== "string" || !required.has(row.quote)) continue
    if (
      row.base !== "EUR" ||
      perEuro.has(row.quote) ||
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      row.date > requestedDate
    )
      return unavailable()
    const observationMs = Date.parse(`${row.date}T00:00:00Z`)
    // Seven calendar days from the invoice's UTC day, not the recovery clock.
    if (
      !Number.isFinite(observationMs) ||
      new Date(observationMs).toISOString().slice(0, 10) !== row.date ||
      anchorDayMs - observationMs > 7 * DAY_MS ||
      (observedDate !== undefined && observedDate !== row.date)
    )
      return unavailable()
    observedDate = row.date
    perEuro.set(row.quote, positive(row.rate))
  }
  if (!observedDate || [...required].some((c) => !perEuro.has(c)))
    return unavailable()
  const usdPerEuro = perEuro.get("USD")!
  return {
    rates: Object.fromEntries(
      desired.map((c) => [c, positive(usdPerEuro / perEuro.get(c)!)])
    ),
    observedDate,
  }
}

/** A historical benchmark observation, not payment or pricing authorization. */
export async function fetchHistoricalPricingRate(
  options: HistoricalPricingRateOptions
): Promise<HistoricalPricingRateQuote> {
  const { acceptedAtMs } = options
  const timeoutMs = options.timeoutMs ?? 6_000
  if (
    !Number.isSafeInteger(acceptedAtMs) ||
    acceptedAtMs < MINUTE_MS ||
    !Number.isFinite(new Date(acceptedAtMs).getTime()) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 6_000 ||
    !Array.isArray(options.currencies ?? [])
  )
    return unavailable()
  const desired = new Set<string>()
  for (const raw of options.currencies ?? []) {
    if (typeof raw !== "string") return unavailable()
    const currency = raw.trim().toUpperCase()
    if (
      currency === "SATS" ||
      !SUPPORTED_PRODUCT_PRICE_CURRENCIES.some((c) => c === currency)
    )
      return unavailable()
    if (currency !== "USD") desired.add(currency)
  }
  const currencies = [...desired].sort()
  const btcMinuteStartMs =
    Math.floor(acceptedAtMs / MINUTE_MS) * MINUTE_MS - MINUTE_MS
  const anchorDayMs = Math.floor(acceptedAtMs / DAY_MS) * DAY_MS
  const fxRequestedDate = new Date(anchorDayMs - DAY_MS)
    .toISOString()
    .slice(0, 10)
  const btcUrl = new URL(
    "https://api.exchange.coinbase.com/products/BTC-USD/candles"
  )
  btcUrl.searchParams.set("granularity", "60")
  btcUrl.searchParams.set("start", new Date(btcMinuteStartMs).toISOString())
  btcUrl.searchParams.set(
    "end",
    new Date(btcMinuteStartMs + MINUTE_MS).toISOString()
  )
  const fxUrl = new URL("https://api.frankfurter.dev/v2/providers/ecb/rates")
  fxUrl.searchParams.set("date", fxRequestedDate)
  fxUrl.searchParams.set("base", "EUR")
  fxUrl.searchParams.set(
    "quotes",
    [...new Set(["USD", ...currencies.filter((c) => c !== "EUR")])]
      .sort()
      .join(",")
  )
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(UNAVAILABLE))
    }, timeoutMs)
  })
  try {
    const fetchImpl = options.fetchImpl ?? fetch
    const operation = async (): Promise<HistoricalPricingRateQuote> => {
      const [btc, fx] = await Promise.all([
        readJson(btcUrl, fetchImpl, controller.signal),
        currencies.length
          ? readJson(fxUrl, fetchImpl, controller.signal).then((json) =>
              ecbConversions(json, currencies, fxRequestedDate, anchorDayMs)
            )
          : null,
      ])
      return {
        rate: candleClose(btc, btcMinuteStartMs),
        source: "coinbase",
        fetchedAt: Date.now(),
        ...(fx
          ? {
              fiatUsdRates: fx.rates,
              fiatSource: "ecb" as const,
              fiatSources: Object.fromEntries(
                currencies.map((c) => [c, "ecb" as const])
              ),
            }
          : {}),
        historical: {
          policyId: HISTORICAL_PRICING_BENCHMARK_ID,
          acceptedAtMs,
          btcMinuteStartMs,
          ...(fx ? { fxRequestedDate, fxObservedDate: fx.observedDate } : {}),
        },
      }
    }
    return await Promise.race([operation(), deadline])
  } catch {
    return unavailable()
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
