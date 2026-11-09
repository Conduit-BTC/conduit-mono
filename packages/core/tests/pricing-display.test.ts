import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { config } from "../src/config"
import {
  BTC_USD_DISPLAY_RATE_QUERY_KEY,
  BTC_USD_RATE_QUERY_KEY,
  fetchBtcUsdRate,
  fetchDisplayBtcUsdRate,
  useBtcUsdRate,
  useDisplayBtcUsdRate,
} from "../src/pricing/rates"
import { PRICING_PROVIDER_URLS } from "../src/pricing/common-rate-provider"
import { verifyCheckoutSparkPricingRateAttestation } from "../src/protocol/checkout-spark-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "../src/protocol/checkout-spark-pricing-authority-server"
import { freezeCheckoutSparkCommercePricing } from "../src/protocol/checkout-spark-commerce-pricing"
import type { BtcUsdRateQuote } from "../src/pricing"

const WORKER = "https://pricing.example.test/api/checkout-spark-pricing"
const ECONOMIC_STORAGE = "conduit:btc-usd-rate"
const DISPLAY_STORAGE = "conduit:btc-usd-display-rate"
const originalFetch = globalThis.fetch
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const originalConfig = {
  url: config.checkoutSparkPricingUrl,
  keys: config.checkoutSparkPricingPublicKeys,
}
const originalEnv = [
  process.env.VITE_BTC_USD_RATE,
  process.env.VITE_FIAT_USD_RATES,
]
const signingKeyHex = `${"0".repeat(63)}1`
const publicKey = getCheckoutSparkPricingAuthorityPublicKey(signingKeyHex)!
const stored = new Map<string, string>()
const calls: string[] = []
const clients: QueryClient[] = []

beforeEach(() => {
  config.checkoutSparkPricingUrl = WORKER
  config.checkoutSparkPricingPublicKeys = `display-test:${publicKey}`
  delete process.env.VITE_BTC_USD_RATE
  delete process.env.VITE_FIAT_USD_RATES
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    },
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  config.checkoutSparkPricingUrl = originalConfig.url
  config.checkoutSparkPricingPublicKeys = originalConfig.keys
  for (const [index, name] of [
    "VITE_BTC_USD_RATE",
    "VITE_FIAT_USD_RATES",
  ].entries()) {
    if (originalEnv[index] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[index]
  }
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
  for (const client of clients.splice(0)) client.clear()
  stored.clear()
  calls.length = 0
})

function publicPrices(
  options: { primaryDown?: boolean; allDown?: boolean } = {}
) {
  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (options.allDown) return new Response("Unavailable", { status: 503 })
    if (url === PRICING_PROVIDER_URLS.mempool && !options.primaryDown)
      return Response.json({ USD: 80_000 })
    if (url === PRICING_PROVIDER_URLS.coinbase)
      return Response.json({
        data: { base: "BTC", currency: "USD", amount: "81000" },
      })
    if (url === PRICING_PROVIDER_URLS.frankfurter)
      return Response.json({
        base: "USD",
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        rates: { EUR: 0.9 },
      })
    return new Response("Unavailable", { status: 503 })
  }) as typeof fetch
}

function renderRate(client: QueryClient, useRate = useDisplayBtcUsdRate) {
  let observed: ReturnType<typeof useBtcUsdRate> | undefined
  function Rate() {
    observed = useRate()
    return null
  }
  renderToString(
    createElement(QueryClientProvider, { client }, createElement(Rate))
  )
  return observed!
}

function client() {
  const result = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(result)
  return result
}

function quote(rate: number): BtcUsdRateQuote {
  return { rate, source: "mempool", fetchedAt: Date.now() - 60_000 }
}

function signedSnapshot(fetchedAt = Date.now() - 100) {
  const pricing = freezeCheckoutSparkCommercePricing({
    version: 1,
    rate: { rate: 90_000, source: "coinbase", fetchedAt },
  })
  return {
    pricing,
    pricingAuthority: createCheckoutSparkPricingRateAttestation({
      rate: pricing.rate,
      keyId: "display-test",
      privateKeyHex: signingKeyHex,
      issuedAtMs: fetchedAt,
    }),
  }
}

describe("display-only currency estimates", () => {
  it("uses public rates even when economic checkout has a signed Worker configured", async () => {
    publicPrices()
    const result = await fetchDisplayBtcUsdRate()
    expect(result.rate).toBe(80_000)
    expect(result.source).toBe("mempool")
    expect(result.fiatUsdRates?.EUR).toBeCloseTo(1 / 0.9)
    expect(calls).toContain(PRICING_PROVIDER_URLS.mempool)
    expect(calls).not.toContain(WORKER)
  })

  it("fails over between public providers without making a Worker request", async () => {
    publicPrices({ primaryDown: true })
    const result = await fetchDisplayBtcUsdRate()
    expect(result.rate).toBe(81_000)
    expect(result.source).toBe("coinbase")
    expect(calls).toContain(PRICING_PROVIDER_URLS.coinbase)
    expect(calls).not.toContain(WORKER)
  })

  it("refreshes display cache/storage without changing the economic cache/storage", async () => {
    publicPrices()
    const economic = quote(70_000)
    const display = quote(75_000)
    stored.set(ECONOMIC_STORAGE, JSON.stringify(economic))
    stored.set(DISPLAY_STORAGE, JSON.stringify(display))
    const queries = client()
    queries.setQueryData(BTC_USD_RATE_QUERY_KEY, economic)
    expect(renderRate(queries).data?.rate).toBe(75_000)
    expect(renderRate(queries, useBtcUsdRate).data?.rate).toBe(70_000)

    // SSR has no mounted observer; hydrate the observed value before refetching.
    queries.setQueryData(BTC_USD_DISPLAY_RATE_QUERY_KEY, display)
    await queries.refetchQueries({
      queryKey: BTC_USD_DISPLAY_RATE_QUERY_KEY,
      exact: true,
    })
    expect(
      queries.getQueryData<BtcUsdRateQuote>(BTC_USD_DISPLAY_RATE_QUERY_KEY)
        ?.rate
    ).toBe(80_000)
    expect(JSON.parse(stored.get(DISPLAY_STORAGE)!).rate).toBe(80_000)
    expect(queries.getQueryData(BTC_USD_RATE_QUERY_KEY)).toEqual(economic)
    expect(JSON.parse(stored.get(ECONOMIC_STORAGE)!)).toEqual(economic)
    expect(calls).not.toContain(WORKER)
  })

  it("uses only the display's saved estimate during a public-provider outage", async () => {
    publicPrices({ allDown: true })
    stored.set(ECONOMIC_STORAGE, JSON.stringify(quote(70_000)))
    expect(renderRate(client()).data).toBeUndefined()
    const display = quote(75_000)
    stored.set(DISPLAY_STORAGE, JSON.stringify(display))
    const queries = client()
    expect(renderRate(queries).data).toEqual(display)
    queries.setQueryData(BTC_USD_DISPLAY_RATE_QUERY_KEY, display)
    await queries.refetchQueries({
      queryKey: BTC_USD_DISPLAY_RATE_QUERY_KEY,
      exact: true,
    })
    expect(queries.getQueryData(BTC_USD_DISPLAY_RATE_QUERY_KEY)).toEqual(
      display
    )
    expect(JSON.parse(stored.get(DISPLAY_STORAGE)!)).toEqual(display)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls).not.toContain(WORKER)
  })

  it("retains signed economic pricing and original-attestation recovery", async () => {
    const live = signedSnapshot()
    process.env.VITE_BTC_USD_RATE = "100000"
    globalThis.fetch = (async (input) => {
      calls.push(String(input))
      return Response.json(live)
    }) as typeof fetch
    expect((await fetchBtcUsdRate()).rate).toBe(90_000)
    expect(calls).toEqual([WORKER])
    expect((await fetchDisplayBtcUsdRate()).source).toBe("env")
    expect(calls).toEqual([WORKER])

    const original = signedSnapshot(Date.now() - 86_400_000)
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        pricing: original.pricing,
        attestation: original.pricingAuthority,
        acceptedAtMs: original.pricingAuthority.issuedAtMs + 1,
        trustedPublicKeys: new Map([["display-test", publicKey]]),
      })
    ).toBe("verified")
    expect(original.pricing.rate.fetchedAt).toBe(
      original.pricingAuthority.rate.fetchedAt
    )
    expect(calls).toEqual([WORKER])
  })
})
