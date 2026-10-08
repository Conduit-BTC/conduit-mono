import { describe, expect, it } from "bun:test"
import { fetchCommonPricingRateQuote } from "@conduit/core/pricing/common-rate-provider"

const NOW = 1_800_000_000_000
const DATE = new Date(NOW).toISOString().slice(0, 10)
const frankfurter = (rates: Record<string, unknown>) => ({
  base: "USD",
  amount: 1,
  date: DATE,
  rates,
})
const floatrates = (rates: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(rates).map(([code, rate]) => [
      code.toLowerCase(),
      { code, rate, date: new Date(NOW).toUTCString() },
    ])
  )
function ecb(rates: Record<string, number>, date = DATE) {
  const currencies = Object.keys(rates)
  return {
    structure: {
      dimensions: {
        series: [
          { id: "FREQ", values: [{ id: "D" }] },
          { id: "CURRENCY", values: currencies.map((id) => ({ id })) },
          { id: "CURRENCY_DENOM", values: [{ id: "EUR" }] },
          { id: "EXR_TYPE", values: [{ id: "SP00" }] },
          { id: "EXR_SUFFIX", values: [{ id: "A" }] },
        ],
        observation: [{ id: "TIME_PERIOD", values: [{ id: date }] }],
      },
    },
    dataSets: [
      {
        series: Object.fromEntries(
          currencies.map((currency, index) => [
            `0:${index}:0:0:0`,
            { observations: { "0": [rates[currency]] } },
          ])
        ),
      },
    ],
  }
}
type Fixtures = Record<string, unknown | Response | Error>
function fixtureFetch(fixtures: Fixtures, calls: string[] = []): typeof fetch {
  return (async (input, options) => {
    const url = new URL(String(input))
    const provider = url.hostname.includes("mempool")
      ? "mempool"
      : url.hostname.includes("coinbase")
        ? "coinbase"
        : url.hostname.includes("kraken")
          ? "kraken"
          : url.hostname.includes("frankfurter")
            ? "frankfurter"
            : url.hostname.includes("floatrates")
              ? "floatrates"
              : "ecb"
    calls.push(provider)
    expect(options?.credentials).toBe("omit")
    expect(options?.referrerPolicy).toBe("no-referrer")
    expect(options?.redirect).toBe("error")
    const value = fixtures[provider]
    if (value instanceof Error) throw value
    return value instanceof Response
      ? value
      : value === undefined
        ? new Response(null, { status: 503 })
        : Response.json(value)
  }) as typeof fetch
}
const bitcoin = {
  mempool: { USD: 100_000, EUR: 80_000 },
  coinbase: { data: { base: "BTC", currency: "USD", amount: "100000" } },
  kraken: { error: [], result: { XXBTZUSD: { c: ["100000", "1"] } } },
}

describe("shared ordered pricing providers", () => {
  for (const [position, source] of [
    "mempool",
    "coinbase",
    "kraken",
  ].entries()) {
    it(`uses BTC provider ${position + 1} only after earlier failures`, async () => {
      const calls: string[] = []
      const fixtures = Object.fromEntries(
        Object.entries(bitcoin).slice(position)
      )
      const quote = await fetchCommonPricingRateQuote({
        nowMs: () => NOW,
        fetchImpl: fixtureFetch(fixtures, calls),
      })
      expect(quote.source).toBe(source)
      expect(quote.rate).toBe(100_000)
      expect(calls).toEqual(
        ["mempool", "coinbase", "kraken"].slice(0, position + 1)
      )
    })
  }

  for (const [position, source] of [
    "frankfurter",
    "floatrates",
    "ecb",
  ].entries()) {
    it(`uses broad FX provider ${position + 1} with the correct USD orientation`, async () => {
      const calls: string[] = []
      const fx = {
        frankfurter: frankfurter({ EUR: 0.8, JPY: 160 }),
        floatrates: floatrates({ EUR: "0.8", JPY: "160" }),
        ecb: ecb({ USD: 1.25, JPY: 200 }),
      }
      const quote = await fetchCommonPricingRateQuote({
        nowMs: () => NOW,
        requiredFiatCurrencies: ["EUR", "JPY"],
        fetchImpl: fixtureFetch(
          {
            coinbase: bitcoin.coinbase,
            ...Object.fromEntries(Object.entries(fx).slice(position)),
          },
          calls
        ),
      })
      expect(quote.source).toBe("coinbase")
      expect(quote.fiatUsdRates).toMatchObject({ EUR: 1.25, JPY: 1 / 160 })
      expect(quote.fiatSources).toMatchObject({ EUR: source, JPY: source })
      expect(
        calls.filter((p) => ["frankfurter", "floatrates", "ecb"].includes(p))
      ).toEqual(["frankfurter", "floatrates", "ecb"].slice(0, position + 1))
    })
  }

  it("preserves earlier valid rates while later providers fill partial coverage", async () => {
    const quote = await fetchCommonPricingRateQuote({
      nowMs: () => NOW,
      requiredFiatCurrencies: ["EUR", "CAD", "JPY", "CHF"],
      fetchImpl: fixtureFetch({
        mempool: bitcoin.mempool,
        frankfurter: frankfurter({ EUR: 0.9, CAD: 1.5 }),
        floatrates: floatrates({ CAD: "2", JPY: "150" }),
        ecb: ecb({ USD: 1.25, CHF: 1.1, JPY: 300 }),
      }),
    })
    expect(quote.fiatUsdRates).toEqual({
      EUR: 1.25,
      CAD: 1 / 1.5,
      JPY: 1 / 150,
      CHF: 1.25 / 1.1,
    })
    expect(quote.fiatSources).toEqual({
      EUR: "mempool",
      CAD: "frankfurter",
      JPY: "floatrates",
      CHF: "ecb",
    })
    expect(quote.fetchedAt).toBe(NOW)
  })

  it("retains usable BTC/fiat when an unrelated preferred conversion is unavailable", async () => {
    const fetchImpl = fixtureFetch({ mempool: bitcoin.mempool })
    const quote = await fetchCommonPricingRateQuote({
      includeFiatRates: true,
      requiredFiatCurrencies: ["EUR"],
      preferredFiatCurrencies: ["JPY"],
      fetchImpl,
      nowMs: () => NOW,
    })
    expect(quote.fiatUsdRates?.EUR).toBe(1.25)
    await expect(
      fetchCommonPricingRateQuote({
        requiredFiatCurrencies: ["JPY"],
        fetchImpl,
        nowMs: () => NOW,
      })
    ).rejects.toThrow("Required fiat conversion rates are unavailable")
  })

  for (const malformed of [
    { data: { base: "ETH", currency: "USD", amount: "100000" } },
    { data: { base: "BTC", currency: "EUR", amount: "100000" } },
    { data: { base: "BTC", currency: "USD", amount: "0x100" } },
  ]) {
    it("rejects a malformed or wrong-market Coinbase response and advances", async () => {
      const quote = await fetchCommonPricingRateQuote({
        nowMs: () => NOW,
        fetchImpl: fixtureFetch({
          coinbase: malformed,
          kraken: bitcoin.kraken,
        }),
      })
      expect(quote.source).toBe("kraken")
    })
  }

  for (const malformed of [
    { ...frankfurter({ EUR: 0.8 }), base: "GBP" },
    { ...frankfurter({ EUR: 0.8 }), amount: 100 },
    { ...frankfurter({ EUR: 0.8 }), date: "2000-01-01" },
    frankfurter({ EUR: 0 }),
    frankfurter({ EUR: "0.8" }),
    new Response("not JSON", {
      headers: { "content-type": "application/json" },
    }),
    new Response(null, { status: 429 }),
  ]) {
    it("rejects invalid, stale or rate-limited FX and uses the next source", async () => {
      const quote = await fetchCommonPricingRateQuote({
        nowMs: () => NOW,
        requiredFiatCurrencies: ["EUR"],
        fetchImpl: fixtureFetch({
          coinbase: bitcoin.coinbase,
          frankfurter: malformed,
          floatrates: floatrates({ EUR: "0.8" }),
        }),
      })
      expect(quote.fiatSources?.EUR).toBe("floatrates")
    })
  }

  it("rejects stale ECB observations and missing USD normalization", async () => {
    for (const value of [
      ecb({ USD: 1.25, JPY: 200 }, "2000-01-01"),
      ecb({ JPY: 200 }),
    ]) {
      await expect(
        fetchCommonPricingRateQuote({
          nowMs: () => NOW,
          requiredFiatCurrencies: ["JPY"],
          fetchImpl: fixtureFetch({ coinbase: bitcoin.coinbase, ecb: value }),
        })
      ).rejects.toThrow("Required fiat conversion rates are unavailable")
    }
  })

  it("bounds stalled fetches even when the transport ignores cancellation", async () => {
    const started = performance.now()
    const quote = await fetchCommonPricingRateQuote({
      nowMs: () => NOW,
      timeoutMs: 20,
      totalTimeoutMs: 100,
      fetchImpl: (async (input) =>
        String(input).includes("mempool")
          ? new Promise(() => {})
          : Response.json(bitcoin.coinbase)) as typeof fetch,
    })
    expect(quote.source).toBe("coinbase")
    expect(performance.now() - started).toBeLessThan(250)
  })

  it("bounds a stalled response body and advances to the next provider", async () => {
    const quote = await fetchCommonPricingRateQuote({
      nowMs: () => NOW,
      timeoutMs: 20,
      totalTimeoutMs: 100,
      fetchImpl: fixtureFetch({
        mempool: new Response(new ReadableStream({ start() {} })),
        coinbase: bitcoin.coinbase,
      }),
    })
    expect(quote.source).toBe("coinbase")
  })

  it("rejects streaming oversized data before reading an unbounded body", async () => {
    let cancelled = false
    const oversized = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(128 * 1024 + 1))
        },
        cancel() {
          cancelled = true
        },
      })
    )
    const quote = await fetchCommonPricingRateQuote({
      nowMs: () => NOW,
      fetchImpl: fixtureFetch({
        mempool: oversized,
        coinbase: bitcoin.coinbase,
      }),
    })
    expect(quote.source).toBe("coinbase")
    expect(cancelled).toBe(true)
  })

  it("caps the complete concurrent refresh and reports only bounded operational metadata", async () => {
    const events: unknown[] = []
    const started = performance.now()
    await expect(
      fetchCommonPricingRateQuote({
        nowMs: () => NOW,
        includeFiatRates: true,
        timeoutMs: 30,
        totalTimeoutMs: 45,
        onProviderAttempt: (event) => events.push(event),
        fetchImpl: (async () => new Promise(() => {})) as typeof fetch,
      })
    ).rejects.toThrow("BTC/USD pricing is unavailable")
    expect(performance.now() - started).toBeLessThan(250)
    expect(events.length).toBeGreaterThanOrEqual(2)
    for (const event of events)
      expect(Object.keys(event as object).sort()).toEqual([
        "durationMs",
        "outcome",
        "provider",
      ])
  })
})
