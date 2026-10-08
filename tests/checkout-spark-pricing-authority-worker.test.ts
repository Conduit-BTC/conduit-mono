import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import { SIGNED_PRICING_FEED_CURRENCIES } from "@conduit/core/pricing/signed-rate-client"
import {
  parseCheckoutSparkPricingAuthorityPublicKeys,
  verifyCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAttestation,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import { getCheckoutSparkPricingAuthorityPublicKey } from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import {
  createCheckoutSparkPricingAuthorityCache,
  handleCheckoutSparkPricingAuthorityRequest,
  type CheckoutSparkPricingAuthorityEnv,
} from "../apps/anon-zap-signer/src/checkout-pricing-authority"

const FIXTURE_SIGNING_KEY = Buffer.from(generateSecretKey()).toString("hex")
const NOW_MS = 1_800_000_000_000
const ORIGIN = "https://shop.example"

function env(): CheckoutSparkPricingAuthorityEnv {
  return {
    CHECKOUT_SPARK_PRICING_ALLOWED_ORIGINS: ORIGIN,
    CHECKOUT_SPARK_PRICING_KEY_ID: "fixture-rate",
    CHECKOUT_SPARK_PRICING_PRIVATE_KEY_HEX: FIXTURE_SIGNING_KEY,
    CHECKOUT_SPARK_PRICING_PUBLIC_KEYS: `fixture-rate:${getCheckoutSparkPricingAuthorityPublicKey(FIXTURE_SIGNING_KEY)}`,
    CHECKOUT_SPARK_PRICING_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
  }
}

function request(currencies = ["USD"]): Request {
  return new Request("https://pricing.example/api/checkout-spark-pricing", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ currencies }),
  })
}

describe("checkout Spark pricing authority standalone Worker", () => {
  it("fetches server-owned USD/EUR rates and returns a genuine signed, content-free snapshot", async () => {
    const configuration = env()
    let limits = 0
    let fetches = 0
    configuration.CHECKOUT_SPARK_PRICING_RATE_LIMITER = {
      limit: async ({ key }) => {
        expect(key).toBe("checkout-spark-pricing:global")
        limits++
        return { success: true }
      },
    }
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(["USD", "EUR"]),
      configuration,
      {
        nowMs: () => NOW_MS,
        fetchPricingRate: async (options) => {
          fetches++
          expect(options?.requiredFiatCurrencies).toBeUndefined()
          expect(options?.preferredFiatCurrencies).toContain("EUR")
          expect(options?.preferredFiatCurrencies).toContain("CAD")
          expect(options?.timeoutMs).toBe(3_000)
          return {
            rate: 100_000,
            fetchedAt: NOW_MS,
            source: "mempool",
            fiatUsdRates: { EUR: 1.25, CAD: 0.75 },
            fiatSource: "mempool",
          }
        },
      }
    )
    expect(result.status).toBe(200)
    expect(result.headers.get("cache-control")).toBe("no-store")
    expect(result.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    const body = (await result.json()) as {
      pricing: { version: 1; rate: CheckoutSparkPricingRateAttestation["rate"] }
      pricingAuthority: CheckoutSparkPricingRateAttestation
    }
    expect(Object.keys(body).sort()).toEqual(["pricing", "pricingAuthority"])
    expect(body.pricing.rate.fiatUsdRates).toEqual({ EUR: 1.25, CAD: 0.75 })
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        ...body,
        attestation: body.pricingAuthority,
        acceptedAtMs: NOW_MS,
        nowMs: NOW_MS,
        trustedPublicKeys: parseCheckoutSparkPricingAuthorityPublicKeys(
          configuration.CHECKOUT_SPARK_PRICING_PUBLIC_KEYS
        ),
      })
    ).toBe("verified")
    expect(limits).toBe(1)
    expect(fetches).toBe(1)
  })

  it("stays unavailable with no deployment configuration and does not fetch providers", async () => {
    let fetched = false
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      {},
      {
        fetchPricingRate: async () => {
          fetched = true
          throw new Error("Not configured.")
        },
      }
    )
    expect(result.status).toBe(503)
    expect(fetched).toBe(false)
  })

  it("excludes retired BGN from the common feed and new signed Worker snapshots", async () => {
    const configuration = env()
    expect(SIGNED_PRICING_FEED_CURRENCIES).not.toContain("BGN")
    expect(SIGNED_PRICING_FEED_CURRENCIES).toContain("USD")
    expect(SIGNED_PRICING_FEED_CURRENCIES).toContain("EUR")
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(["USD", "EUR"]),
      configuration,
      {
        nowMs: () => NOW_MS,
        fetchPricingRate: async (options) => {
          expect(options?.preferredFiatCurrencies).not.toContain("BGN")
          return {
            rate: 100_000,
            fetchedAt: NOW_MS,
            source: "mempool",
            fiatUsdRates: { EUR: 1.25, BGN: 0.5 },
            fiatSource: "mempool",
            fiatSources: { EUR: "mempool", BGN: "frankfurter" },
          }
        },
      }
    )
    expect(result.status).toBe(200)
    const body = (await result.json()) as {
      pricing: { version: 1; rate: CheckoutSparkPricingRateAttestation["rate"] }
      pricingAuthority: CheckoutSparkPricingRateAttestation
    }
    expect(body.pricing.rate.fiatUsdRates).toEqual({ EUR: 1.25 })
    expect(body.pricing.rate.fiatSources).toEqual({ EUR: "mempool" })
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        ...body,
        attestation: body.pricingAuthority,
        acceptedAtMs: NOW_MS,
        nowMs: NOW_MS,
        trustedPublicKeys: parseCheckoutSparkPricingAuthorityPublicKeys(
          configuration.CHECKOUT_SPARK_PRICING_PUBLIC_KEYS
        ),
      })
    ).toBe("verified")
    let fetched = false
    const unsupported = await handleCheckoutSparkPricingAuthorityRequest(
      request(["BGN"]),
      configuration,
      {
        fetchPricingRate: async () => {
          fetched = true
          throw new Error("Must not fetch unsupported requested currency.")
        },
      }
    )
    expect(unsupported.status).toBe(400)
    expect(fetched).toBe(false)
  })

  it("requires the native limiter before fetching or signing", async () => {
    const configuration = env()
    delete configuration.CHECKOUT_SPARK_PRICING_RATE_LIMITER
    let fetched = false
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      {
        fetchPricingRate: async () => {
          fetched = true
          throw new Error("Not configured.")
        },
      }
    )
    expect(result.status).toBe(503)
    expect(fetched).toBe(false)
  })

  it("handles an ordinary provider outage without leaking upstream content", async () => {
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      {
        fetchPricingRate: async () => {
          throw new Error("Provider failure detail.")
        },
      }
    )
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({
      error: "Checkout pricing is unavailable.",
    })
  })

  it("returns a bounded backoff when the native service limit is reached", async () => {
    const configuration = env()
    configuration.CHECKOUT_SPARK_PRICING_RATE_LIMITER = {
      limit: async () => ({ success: false }),
    }
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration
    )
    expect(result.status).toBe(429)
    expect(result.headers.get("retry-after")).toBe("60")
  })

  it("coalesces ordinary requests and preserves the original fetch, issue and expiry on cache hits", async () => {
    const configuration = env()
    const cache = createCheckoutSparkPricingAuthorityCache()
    let now = NOW_MS
    let calls = 0
    const overrides = {
      cache,
      nowMs: () => now,
      fetchPricingRate: async () => {
        calls++
        await Promise.resolve()
        return { rate: 100_000, fetchedAt: now, source: "mempool" as const }
      },
    }
    const [first, second] = await Promise.all([
      handleCheckoutSparkPricingAuthorityRequest(
        request(),
        configuration,
        overrides
      ),
      handleCheckoutSparkPricingAuthorityRequest(
        request(["EUR"]),
        configuration,
        overrides
      ),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const original = await first.json()
    expect(await second.json()).toEqual(original)
    now += 30_000
    const cached = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      overrides
    )
    expect(await cached.json()).toEqual(original)
    expect(calls).toBe(1)
  })

  it("serves an unexpired cached snapshot through an outage without rejuvenating it", async () => {
    const cache = createCheckoutSparkPricingAuthorityCache()
    const configuration = env()
    let now = NOW_MS
    let outage = false
    const overrides = {
      cache,
      nowMs: () => now,
      fetchPricingRate: async () => {
        if (outage) throw new Error("Unavailable.")
        return { rate: 100_000, fetchedAt: now, source: "mempool" as const }
      },
    }
    const initial = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      overrides
    )
    const original = await initial.json()
    outage = true
    now += 250_000
    const duringOutage = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      overrides
    )
    expect(duringOutage.status).toBe(200)
    expect(await duringOutage.json()).toEqual(original)
    now = NOW_MS + 300_000
    const expired = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      overrides
    )
    expect(expired.status).toBe(503)
  })
})
