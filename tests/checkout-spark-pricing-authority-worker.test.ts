import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import {
  parseCheckoutSparkPricingAuthorityPublicKeys,
  verifyCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAttestation,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import { getCheckoutSparkPricingAuthorityPublicKey } from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import {
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
          expect(options?.requiredFiatCurrencies).toEqual(["EUR"])
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
    expect(body.pricing.rate.fiatUsdRates).toEqual({ EUR: 1.25 })
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
})
