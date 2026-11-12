import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { config } from "@conduit/core/config"
import { PRICING_PROVIDER_URLS } from "@conduit/core/pricing/common-rate-provider"
import { fetchCheckoutSparkNewFiatPricing } from "../apps/market/src/lib/checkout-spark-new-fiat-pricing"

const originalPolicy = config.checkoutSparkPricingPolicy
const originalUrl = config.checkoutSparkPricingUrl
const originalEnv = process.env.VITE_BTC_USD_RATE

afterEach(() => {
  config.checkoutSparkPricingPolicy = originalPolicy
  config.checkoutSparkPricingUrl = originalUrl
  if (originalEnv === undefined) delete process.env.VITE_BTC_USD_RATE
  else process.env.VITE_BTC_USD_RATE = originalEnv
})

describe("new fiat public pricing preparation", () => {
  it.each(["current", "revoked", "policy_changed"] as const)(
    "keeps public observations separate from obsolete issuance settings when %s",
    async (mode) => {
      config.checkoutSparkPricingPolicy = "invoice-historical-1pct-v1"
      config.checkoutSparkPricingUrl =
        "https://obsolete.example.test/api/checkout-spark-pricing"
      process.env.VITE_BTC_USD_RATE = "999999"
      let active = true
      const calls: string[] = []
      const http = spyOn(globalThis, "fetch").mockImplementation(
        async (input) => {
          const url = String(input)
          calls.push(url)
          if (mode === "revoked") active = false
          if (mode === "policy_changed")
            config.checkoutSparkPricingPolicy = "signed-v1"
          if (url === PRICING_PROVIDER_URLS.mempool)
            return Response.json({ USD: 80_000 })
          if (url === PRICING_PROVIDER_URLS.frankfurter)
            return Response.json({
              base: "USD",
              amount: 1,
              date: new Date().toISOString().slice(0, 10),
              rates: { EUR: 0.9 },
            })
          throw new Error("Unexpected pricing request")
        }
      )
      try {
        const preparing = fetchCheckoutSparkNewFiatPricing({
          currencies: ["EUR"],
          shouldContinue: () => active,
        })
        if (mode === "current") {
          const quote = await preparing
          expect(quote.rate).toBe(80_000)
          expect(quote.source).toBe("mempool")
          expect(quote.fiatUsdRates?.EUR).toBeCloseTo(1 / 0.9)
        } else
          await expect(preparing).rejects.toThrow(
            mode === "revoked"
              ? "session changed"
              : "New currency checkout is unavailable"
          )
        expect(calls.sort()).toEqual(
          [
            PRICING_PROVIDER_URLS.frankfurter,
            PRICING_PROVIDER_URLS.mempool,
          ].sort()
        )
      } finally {
        http.mockRestore()
      }
    }
  )

  it("rejects a revoked session before any pricing HTTP", async () => {
    config.checkoutSparkPricingPolicy = "invoice-historical-1pct-v1"
    const http = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("No request is allowed for a revoked session")
    })
    try {
      await expect(
        fetchCheckoutSparkNewFiatPricing({
          currencies: ["USD"],
          shouldContinue: () => false,
        })
      ).rejects.toThrow("session changed")
      expect(http).not.toHaveBeenCalled()
    } finally {
      http.mockRestore()
    }
  })
})
