import { describe, expect, it } from "bun:test"
import { fetchTrustedPricingRateQuote } from "@conduit/core/pricing/trusted-rate-provider"

const NOW = 1_800_000_000_000
describe("shared pricing provider fallback", () => {
  it("preserves valid mempool conversions while filling incomplete fiat coverage from the second provider", async () => {
    const calls: string[] = []
    const quote = await fetchTrustedPricingRateQuote({
      requiredFiatCurrencies: ["EUR", "JPY"],
      includeFiatRates: true,
      nowMs: () => NOW,
      fetchImpl: (async (input, options) => {
        const url = String(input)
        calls.push(url)
        expect(options?.credentials).toBe("omit")
        expect(options?.referrerPolicy).toBe("no-referrer")
        if (url.includes("mempool"))
          return Response.json({ USD: 100_000, EUR: 80_000 })
        if (url.includes("frankfurter"))
          return Response.json({ rates: { EUR: 0.9, CAD: 1.5 } })
        return Response.json({ rates: { EUR: 0.95, JPY: 150 } })
      }) as typeof fetch,
    })
    expect(calls).toHaveLength(3)
    expect(quote.fiatUsdRates).toEqual({
      EUR: 1.25,
      CAD: 1 / 1.5,
      JPY: 1 / 150,
    })
    expect(quote.fiatSources).toEqual({
      EUR: "mempool",
      CAD: "frankfurter",
      JPY: "exchange-rate-api",
    })
    expect(quote.fetchedAt).toBe(NOW)
  })

  it("falls back from BTC/USD and fiat provider outages without adding a provider", async () => {
    const calls: string[] = []
    const quote = await fetchTrustedPricingRateQuote({
      requiredFiatCurrencies: ["EUR"],
      nowMs: () => NOW,
      fetchImpl: (async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.includes("mempool") || url.includes("frankfurter"))
          return new Response(null, { status: 503 })
        if (url.includes("coinbase"))
          return Response.json({ data: { amount: "100000" } })
        return Response.json({ rates: { EUR: 0.8 } })
      }) as typeof fetch,
    })
    expect(calls).toHaveLength(4)
    expect(quote.source).toBe("coinbase")
    expect(quote.fiatUsdRates?.EUR).toBe(1.25)
    expect(quote.fiatSources?.EUR).toBe("exchange-rate-api")
  })

  it("retains valid conversions through auxiliary outages and fails only a missing required currency", async () => {
    const fetchImpl = (async (input) =>
      String(input).includes("mempool")
        ? Response.json({ USD: 100_000, EUR: 80_000 })
        : new Response(null, { status: 503 })) as typeof fetch
    const quote = await fetchTrustedPricingRateQuote({
      includeFiatRates: true,
      requiredFiatCurrencies: ["EUR"],
      preferredFiatCurrencies: ["EUR", "JPY"],
      fetchImpl,
      nowMs: () => NOW,
    })
    expect(quote.fiatUsdRates?.EUR).toBe(1.25)
    await expect(
      fetchTrustedPricingRateQuote({
        requiredFiatCurrencies: ["JPY"],
        fetchImpl,
        nowMs: () => NOW,
      })
    ).rejects.toThrow("Required fiat conversion rates are unavailable")
  })
})
