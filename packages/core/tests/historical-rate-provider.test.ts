import { describe, expect, it } from "bun:test"
import { SUPPORTED_PRODUCT_PRICE_CURRENCIES } from "../src/pricing"
import {
  fetchHistoricalPricingRate,
  HISTORICAL_PRICING_BENCHMARK_ID,
} from "../src/pricing/historical-rate-provider"

const ACCEPTED = Date.parse("2026-11-09T15:00:00Z")
const MINUTE = 60_000
const UNAVAILABLE = "Historical pricing is unavailable."

function candle(startMs: number, close = 80_000) {
  return [startMs / 1_000, 70_000, 90_000, 79_000, close, 1]
}

function fx(quote: string, rate: number, date = "2026-11-06") {
  return { date, base: "EUR", quote, rate }
}

function fixture(options: { btc?: unknown; fx?: unknown } = {}) {
  const calls: { url: URL; options: RequestInit | undefined }[] = []
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, options: init })
    return Response.json(
      url.hostname === "api.exchange.coinbase.com"
        ? (options.btc ?? [candle(ACCEPTED - MINUTE)])
        : (options.fx ?? [fx("USD", 1.1), fx("GBP", 0.88)])
    )
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe("historical pricing benchmark", () => {
  it("selects the exact previous completed UTC minute despite response ordering and extra buckets", async () => {
    const { fetchImpl, calls } = fixture({
      btc: [
        candle(ACCEPTED, 81_000),
        candle(ACCEPTED - 2 * MINUTE, 78_000),
        candle(ACCEPTED - MINUTE),
      ],
    })
    const result = await fetchHistoricalPricingRate({
      acceptedAtMs: ACCEPTED + 59_999,
      currencies: ["USD"],
      fetchImpl,
    })
    expect(result.rate).toBe(80_000)
    expect(result.source).toBe("coinbase")
    expect(result.historical).toEqual({
      policyId: HISTORICAL_PRICING_BENCHMARK_ID,
      acceptedAtMs: ACCEPTED + 59_999,
      btcMinuteStartMs: ACCEPTED - MINUTE,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(
      "https://api.exchange.coinbase.com/products/BTC-USD/candles"
    )
    expect(calls[0].url.searchParams.get("granularity")).toBe("60")
    expect(calls[0].url.searchParams.get("start")).toBe(
      "2026-11-09T14:59:00.000Z"
    )
    expect(calls[0].url.searchParams.get("end")).toBe(
      "2026-11-09T15:00:00.000Z"
    )
    expect(calls[0].options).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "manual",
      headers: { accept: "application/json" },
    })
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal)
  })

  it("uses the previous UTC date's ECB native-EUR rates, including a weekend fixing", async () => {
    const { fetchImpl, calls } = fixture()
    const result = await fetchHistoricalPricingRate({
      acceptedAtMs: ACCEPTED,
      currencies: [" eur ", "GBP", "gbp", "USD"],
      fetchImpl,
    })
    expect(result.fiatUsdRates?.EUR).toBe(1.1)
    expect(result.fiatUsdRates?.GBP).toBeCloseTo(1.25)
    expect(result.fiatSource).toBe("ecb")
    expect(result.fiatSources).toEqual({ EUR: "ecb", GBP: "ecb" })
    expect(result.historical.fxRequestedDate).toBe("2026-11-08")
    expect(result.historical.fxObservedDate).toBe("2026-11-06")
    const request = calls.find((c) => c.url.hostname === "api.frankfurter.dev")!
    expect(request.url.pathname).toBe("/v2/providers/ecb/rates")
    expect(request.url.searchParams.get("date")).toBe("2026-11-08")
    expect(request.url.searchParams.get("base")).toBe("EUR")
    expect(request.url.searchParams.get("quotes")).toBe("GBP,USD")
  })

  it("covers every configured fiat currency without a blended-provider fallback", async () => {
    const currencies = SUPPORTED_PRODUCT_PRICE_CURRENCIES.filter(
      (currency) => currency !== "SATS"
    )
    const { fetchImpl } = fixture({
      fx: currencies
        .filter((currency) => currency !== "EUR")
        .map((currency) => fx(currency, currency === "USD" ? 1.1 : 2)),
    })
    const result = await fetchHistoricalPricingRate({
      acceptedAtMs: ACCEPTED,
      currencies,
      fetchImpl,
    })
    expect(currencies).toHaveLength(30)
    expect(Object.keys(result.fiatUsdRates!)).toHaveLength(29)
    expect(result.fiatUsdRates?.EUR).toBe(1.1)
    expect(result.fiatUsdRates?.JPY).toBe(0.55)
  })

  it("crosses UTC midnight without selecting the current unfinished candle or same-day FX", async () => {
    const acceptedAtMs = Date.parse("2026-11-10T00:00:00Z")
    const { fetchImpl } = fixture({
      btc: [candle(acceptedAtMs - MINUTE)],
      fx: [fx("USD", 1.1, "2026-11-09")],
    })
    const result = await fetchHistoricalPricingRate({
      acceptedAtMs,
      currencies: ["EUR"],
      fetchImpl,
    })
    expect(result.historical.btcMinuteStartMs).toBe(acceptedAtMs - MINUTE)
    expect(result.historical.fxRequestedDate).toBe("2026-11-09")
  })

  it("reports unavailable for a missing or ambiguous exact candle, never an adjacent price", async () => {
    for (const btc of [
      [candle(ACCEPTED)],
      [candle(ACCEPTED - MINUTE), candle(ACCEPTED - MINUTE)],
    ]) {
      await expect(
        fetchHistoricalPricingRate({
          acceptedAtMs: ACCEPTED,
          fetchImpl: fixture({ btc }).fetchImpl,
        })
      ).rejects.toThrow(UNAVAILABLE)
    }
  })

  it("requires complete FX coverage on one actual observation date within seven UTC calendar days", async () => {
    for (const rates of [
      [fx("USD", 1.1)],
      [fx("USD", 1.1), fx("GBP", 0.88, "2026-11-05")],
      [fx("USD", 1.1, "2026-11-09"), fx("GBP", 0.88, "2026-11-09")],
      [fx("USD", 1.1, "2026-11-01"), fx("GBP", 0.88, "2026-11-01")],
    ]) {
      await expect(
        fetchHistoricalPricingRate({
          acceptedAtMs: ACCEPTED,
          currencies: ["GBP"],
          fetchImpl: fixture({ fx: rates }).fetchImpl,
        })
      ).rejects.toThrow(UNAVAILABLE)
    }
    const result = await fetchHistoricalPricingRate({
      acceptedAtMs: ACCEPTED,
      currencies: ["EUR"],
      fetchImpl: fixture({ fx: [fx("USD", 1.1, "2026-11-02")] }).fetchImpl,
    })
    expect(result.historical.fxObservedDate).toBe("2026-11-02")
  })

  it("rejects unknown or non-fiat currencies before making a provider request", async () => {
    for (const currency of ["XYZ", "SATS"]) {
      const { fetchImpl, calls } = fixture()
      await expect(
        fetchHistoricalPricingRate({
          acceptedAtMs: ACCEPTED,
          currencies: [currency],
          fetchImpl,
        })
      ).rejects.toThrow(UNAVAILABLE)
      expect(calls).toHaveLength(0)
    }
  })

  it("does not fail over after a provider outage or redirect", async () => {
    for (const status of [503, 302]) {
      let calls = 0
      const fetchImpl = (async () => {
        calls++
        return new Response(null, { status })
      }) as typeof fetch
      await expect(
        fetchHistoricalPricingRate({ acceptedAtMs: ACCEPTED, fetchImpl })
      ).rejects.toThrow(UNAVAILABLE)
      expect(calls).toBe(1)
    }
  })

  it("bounds streamed response size and the total wait for a stalled response body", async () => {
    const oversized = (async () =>
      new Response(" ".repeat(128 * 1024 + 1))) as typeof fetch
    await expect(
      fetchHistoricalPricingRate({
        acceptedAtMs: ACCEPTED,
        fetchImpl: oversized,
      })
    ).rejects.toThrow(UNAVAILABLE)

    let cancelled = false
    const stalled = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        })
      )) as typeof fetch
    await expect(
      fetchHistoricalPricingRate({
        acceptedAtMs: ACCEPTED,
        timeoutMs: 20,
        fetchImpl: stalled,
      })
    ).rejects.toThrow(UNAVAILABLE)
    expect(cancelled).toBe(true)
  })
})
