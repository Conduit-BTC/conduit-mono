import type { BtcUsdRateQuote, PricingFiatSource } from "./index"

/** Fixed public destinations. A caller cannot supply an upstream URL. */
export const PRICING_PROVIDER_URLS = {
  mempool: "https://mempool.space/api/v1/prices",
  coinbase: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  kraken: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
  frankfurter: "https://api.frankfurter.dev/v1/latest?base=USD",
  floatrates: "https://www.floatrates.com/daily/usd.json",
  ecb: "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?lastNObservations=1&format=jsondata",
} as const
export type PricingProvider = keyof typeof PRICING_PROVIDER_URLS
export type PricingProviderAttempt = {
  provider: PricingProvider
  outcome: "ok" | "unavailable" | "timeout"
  durationMs: number
}
type FiatUsdRates = Record<string, number>
const MAX_RESPONSE_BYTES = 128 * 1024
const DAY_MS = 86_400_000

export type CommonPricingRateOptions = {
  requiredFiatCurrencies?: readonly string[]
  /** Missing optional coverage does not make unrelated conversions unavailable. */
  preferredFiatCurrencies?: readonly string[]
  includeFiatRates?: boolean
  fetchImpl?: typeof fetch
  nowMs?: () => number
  timeoutMs?: number
  totalTimeoutMs?: number
  /** Fixed provider identifiers, outcome and elapsed time only; no payloads. */
  onProviderAttempt?: (event: PricingProviderAttempt) => void
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pricing provider returned invalid data.")
  return value as Record<string, unknown>
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error("Pricing provider returned an invalid rate.")
  return value
}

function decimal(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  )
    throw new Error("Pricing provider returned an invalid decimal rate.")
  return positive(Number(value))
}

function currentPublication(
  value: unknown,
  now: number,
  maxAge = 7 * DAY_MS
): boolean {
  if (typeof value !== "string") return false
  const timestamp = Date.parse(value)
  return (
    Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAge
  )
}

function currencies(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((v) => v.trim().toUpperCase())
        .filter((v) => /^[A-Z]{3}$/.test(v) && v !== "USD")
    ),
  ].sort()
}

function hasRates(rates: FiatUsdRates, desired: readonly string[]): boolean {
  return desired.every((currency) => rates[currency] !== undefined)
}

/** The deadline includes fetch, streamed bytes and decoding, even with a broken transport. */
async function fetchJson(
  provider: PricingProvider,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  overall: AbortSignal
): Promise<Record<string, unknown>> {
  const attempt = new AbortController()
  const timer = setTimeout(() => attempt.abort(), timeoutMs)
  const signal = AbortSignal.any([attempt.signal, overall])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let onAbort: () => void = () => {}
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader?.cancel().catch(() => {})
        reject(new Error("Pricing provider deadline exceeded."))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const operation = (async () => {
      if (signal.aborted) throw new Error("Pricing provider deadline exceeded.")
      const response = await fetchImpl(PRICING_PROVIDER_URLS[provider], {
        headers: { accept: "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal,
      })
      if (!response.ok || !response.body)
        throw new Error("Pricing provider is unavailable.")
      const length = response.headers.get("content-length")
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
      ) {
        void response.body.cancel().catch(() => {})
        throw new Error("Pricing provider response is too large.")
      }
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        const chunk = await reader.read()
        if (signal.aborted)
          throw new Error("Pricing provider deadline exceeded.")
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES)
          throw new Error("Pricing provider response is too large.")
        chunks.push(chunk.value)
      }
      const payload = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        payload.set(chunk, offset)
        offset += chunk.byteLength
      }
      return record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))
      )
    })()
    return await Promise.race([operation, aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    attempt.abort()
    void reader?.cancel().catch(() => {})
  }
}

function btcRate(
  provider: "mempool" | "coinbase" | "kraken",
  json: Record<string, unknown>,
  now: number
): BtcUsdRateQuote {
  if (provider === "coinbase") {
    const data = record(json.data)
    if (data.base !== "BTC" || data.currency !== "USD")
      throw new Error("Unexpected pricing market.")
    return { rate: decimal(data.amount), source: provider, fetchedAt: now }
  }
  if (provider === "kraken") {
    if (!Array.isArray(json.error) || json.error.length)
      throw new Error("Pricing provider is unavailable.")
    const result = record(json.result)
    if (Object.keys(result).length !== 1)
      throw new Error("Unexpected pricing market.")
    const ticker = record(result.XXBTZUSD ?? result.XBTUSD)
    if (!Array.isArray(ticker.c))
      throw new Error("Pricing provider returned invalid data.")
    return { rate: decimal(ticker.c[0]), source: provider, fetchedAt: now }
  }
  const rate = positive(json.USD)
  if (
    json.time !== undefined &&
    (typeof json.time !== "number" ||
      !Number.isSafeInteger(json.time) ||
      json.time * 1000 > now + 30_000 ||
      now - json.time * 1000 > 600_000)
  )
    throw new Error("Pricing provider observation is stale.")
  const fiatUsdRates: FiatUsdRates = {}
  for (const [currency, value] of Object.entries(json)) {
    if (!/^[A-Z]{3}$/.test(currency) || currency === "USD") continue
    try {
      fiatUsdRates[currency] = positive(rate / positive(value))
    } catch {
      /* Invalid optional conversions are missing coverage. */
    }
  }
  return {
    rate,
    fetchedAt: now,
    source: provider,
    ...(Object.keys(fiatUsdRates).length
      ? {
          fiatUsdRates,
          fiatSource: "mempool",
          fiatSources: Object.fromEntries(
            Object.keys(fiatUsdRates).map((c) => [c, "mempool"])
          ) as Record<string, PricingFiatSource>,
        }
      : {}),
  }
}

/** Official SDMX JSON avoids an XML parser dependency and excludes retired observations. */
function ecbRates(json: Record<string, unknown>, now: number): FiatUsdRates {
  const dimensions = record(record(json.structure).dimensions)
  const seriesDimensions = dimensions.series
  const observationDimensions = dimensions.observation
  if (
    !Array.isArray(seriesDimensions) ||
    !Array.isArray(observationDimensions) ||
    observationDimensions.length !== 1
  )
    throw new Error("Invalid ECB dimensions.")
  const ids = ["FREQ", "CURRENCY", "CURRENCY_DENOM", "EXR_TYPE", "EXR_SUFFIX"]
  if (
    seriesDimensions.length !== ids.length ||
    seriesDimensions.some((d, i) => record(d).id !== ids[i])
  )
    throw new Error("Invalid ECB dimensions.")
  const time = record(observationDimensions[0])
  if (time.id !== "TIME_PERIOD" || !Array.isArray(time.values))
    throw new Error("Invalid ECB observations.")
  if (!Array.isArray(json.dataSets) || json.dataSets.length !== 1)
    throw new Error("Invalid ECB dataset.")
  const series = record(record(json.dataSets[0]).series)
  const perEuro: FiatUsdRates = { EUR: 1 }
  for (const [key, raw] of Object.entries(series)) {
    const indices = key.split(":")
    if (indices.length !== ids.length || indices.some((v) => !/^\d+$/.test(v)))
      continue
    const values = indices.map((value, i) => {
      const list = record(seriesDimensions[i]).values
      return Array.isArray(list) ? record(list[Number(value)]).id : undefined
    })
    if (
      values[0] !== "D" ||
      values[2] !== "EUR" ||
      values[3] !== "SP00" ||
      values[4] !== "A" ||
      typeof values[1] !== "string" ||
      !/^[A-Z]{3}$/.test(values[1])
    )
      continue
    const observations = record(record(raw).observations)
    if (Object.keys(observations).length !== 1) continue
    const [index, value] = Object.entries(observations)[0]
    if (!/^\d+$/.test(index) || !Array.isArray(value)) continue
    const date = record(time.values[Number(index)]).id
    if (!currentPublication(date, now)) continue
    try {
      perEuro[values[1]] = positive(value[0])
    } catch {
      /* Reject this optional series. */
    }
  }
  const usdPerEuro = positive(perEuro.USD)
  return Object.fromEntries(
    Object.entries(perEuro)
      .filter(([c]) => c !== "USD")
      .map(([c, units]) => [c, positive(usdPerEuro / units)])
  )
}

function fiatRates(
  provider: "frankfurter" | "floatrates" | "ecb",
  json: Record<string, unknown>,
  now: number
): FiatUsdRates {
  if (provider === "ecb") return ecbRates(json, now)
  const rates: FiatUsdRates = {}
  if (provider === "frankfurter") {
    if (
      json.base !== "USD" ||
      json.amount !== 1 ||
      !currentPublication(json.date, now)
    )
      throw new Error("Unexpected or stale FX dataset.")
    for (const [currency, value] of Object.entries(record(json.rates))) {
      if (!/^[A-Z]{3}$/.test(currency) || currency === "USD") continue
      try {
        rates[currency] = positive(1 / positive(value))
      } catch {
        /* Missing coverage permits the next source. */
      }
    }
  } else {
    for (const [key, value] of Object.entries(json)) {
      const currency = key.toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency) || currency === "USD") continue
      try {
        const entry = record(value)
        if (
          entry.code !== currency ||
          !currentPublication(entry.date, now, 3 * DAY_MS)
        )
          continue
        rates[currency] = positive(1 / decimal(entry.rate))
      } catch {
        /* Invalid optional conversions are missing coverage. */
      }
    }
  }
  return rates
}

export async function fetchCommonPricingRateQuote(
  options: CommonPricingRateOptions = {}
): Promise<BtcUsdRateQuote> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_000
  const totalTimeoutMs = options.totalTimeoutMs ?? 6_000
  if (
    [timeoutMs, totalTimeoutMs].some(
      (v) => !Number.isSafeInteger(v) || v < 1 || v > 30_000
    )
  )
    throw new Error("Pricing provider timeout is invalid.")
  const fetchedAt = (options.nowMs ?? Date.now)()
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0)
    throw new Error("Pricing quote timestamp is invalid.")
  const required = currencies(options.requiredFiatCurrencies ?? [])
  const desired = currencies([
    ...required,
    ...(options.preferredFiatCurrencies ?? []),
  ])
  const overall = new AbortController()
  const timer = setTimeout(() => overall.abort(), totalTimeoutMs)
  const attempt = async <T>(
    provider: PricingProvider,
    parse: (json: Record<string, unknown>) => T
  ): Promise<T> => {
    const start = performance.now()
    let outcome: PricingProviderAttempt["outcome"] = "unavailable"
    try {
      const value = parse(
        await fetchJson(provider, fetchImpl, timeoutMs, overall.signal)
      )
      outcome = "ok"
      return value
    } catch (error) {
      if (overall.signal.aborted || performance.now() - start >= timeoutMs)
        outcome = "timeout"
      throw error
    } finally {
      options.onProviderAttempt?.({
        provider,
        outcome,
        durationMs: Math.max(0, Math.round(performance.now() - start)),
      })
    }
  }
  const btc = async () => {
    for (const provider of ["mempool", "coinbase", "kraken"] as const) {
      if (overall.signal.aborted) break
      try {
        return await attempt(provider, (json) =>
          btcRate(provider, json, fetchedAt)
        )
      } catch {
        /* Ordered failover; no retry of the failed source. */
      }
    }
    throw new Error("BTC/USD pricing is unavailable.")
  }
  const fx = async () => {
    const rates: FiatUsdRates = {}
    const sources: Record<string, PricingFiatSource> = {}
    if (options.includeFiatRates !== true && !desired.length)
      return { rates, sources }
    for (const provider of ["frankfurter", "floatrates", "ecb"] as const) {
      if (overall.signal.aborted) break
      try {
        const result = await attempt(provider, (json) => {
          const result = fiatRates(provider, json, fetchedAt)
          if (!Object.keys(result).length)
            throw new Error("FX pricing is unavailable.")
          return result
        })
        for (const [currency, rate] of Object.entries(result)) {
          if (rates[currency] !== undefined) continue
          rates[currency] = rate
          sources[currency] = provider
        }
        if (Object.keys(rates).length && hasRates(rates, desired)) break
      } catch {
        /* An outage or incomplete dataset does not veto earlier valid results. */
      }
    }
    return { rates, sources }
  }
  try {
    // Independent chains share one wall-clock budget and at most two active fetches.
    const bitcoinLookup = btc()
    const emptyFx = {
      rates: {} as FiatUsdRates,
      sources: {} as Record<string, PricingFiatSource>,
    }
    const fiatLookup =
      options.includeFiatRates === true
        ? fx()
        : bitcoinLookup.then(
            (quote) =>
              hasRates(quote.fiatUsdRates ?? {}, desired) ? emptyFx : fx(),
            () => emptyFx
          )
    const [bitcoin, fiat] = await Promise.allSettled([
      bitcoinLookup,
      fiatLookup,
    ])
    if (bitcoin.status !== "fulfilled")
      throw new Error("BTC/USD pricing is unavailable.")
    const quote = bitcoin.value
    const rates: FiatUsdRates = { ...quote.fiatUsdRates }
    const sources: Record<string, PricingFiatSource> = { ...quote.fiatSources }
    let fiatSource = quote.fiatSource
    if (fiat.status === "fulfilled")
      for (const [currency, rate] of Object.entries(fiat.value.rates)) {
        if (rates[currency] !== undefined) continue
        rates[currency] = rate
        sources[currency] = fiat.value.sources[currency]
        fiatSource = sources[currency]
      }
    if (!hasRates(rates, required))
      throw new Error("Required fiat conversion rates are unavailable.")
    return Object.keys(rates).length
      ? { ...quote, fiatUsdRates: rates, fiatSources: sources, fiatSource }
      : quote
  } finally {
    clearTimeout(timer)
    overall.abort()
  }
}
