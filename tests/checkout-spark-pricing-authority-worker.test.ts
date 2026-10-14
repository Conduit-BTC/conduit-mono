import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import type { BtcUsdRateQuote } from "@conduit/core/pricing"
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
import type { PricingSnapshotStore } from "../apps/anon-zap-signer/src/checkout-pricing-cache"
import { previewPricingQualification } from "../apps/anon-zap-signer/src/checkout-pricing-qualification"
import { PRICING_PROVIDER_URLS } from "@conduit/core/pricing/common-rate-provider"

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
          expect(options?.timeoutMs).toBe(2_000)
          expect(options?.totalTimeoutMs).toBe(6_000)
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

  it("rejects malformed requests without consuming valid-request capacity", async () => {
    const configuration = env()
    let limits = 0
    let fetched = false
    configuration.CHECKOUT_SPARK_PRICING_RATE_LIMITER = {
      limit: async () => {
        limits++
        return { success: false }
      },
    }
    for (const body of [
      "{",
      '{"currencies":["BGN"]}',
      '{"currencies":["USD"],"checkoutId":"fixture"}',
    ]) {
      const invalid = new Request(request(), { body })
      const result = await handleCheckoutSparkPricingAuthorityRequest(
        invalid,
        configuration,
        {
          fetchPricingRate: async () => {
            fetched = true
            throw new Error("Rejected input must not fetch.")
          },
        }
      )
      expect(result.status).toBe(400)
    }
    expect(limits).toBe(0)
    expect(fetched).toBe(false)
    const valid = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration
    )
    expect(valid.status).toBe(429)
    expect(limits).toBe(1)
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

  it.each(["exhausted", "unavailable"] as const)(
    "keeps another caller's valid cache usable when refresh admission is %s",
    async (failure) => {
      const configuration = env()
      const secondOrigin = "https://merchant.example"
      configuration.CHECKOUT_SPARK_PRICING_ALLOWED_ORIGINS += `,${secondOrigin}`
      const cache = createCheckoutSparkPricingAuthorityCache()
      let now = NOW_MS
      let limits = 0
      let fetches = 0
      configuration.CHECKOUT_SPARK_PRICING_RATE_LIMITER = {
        limit: async () => {
          limits++
          if (limits === 1) return { success: true }
          if (failure === "unavailable")
            throw new Error("Native limiter unavailable.")
          return { success: false }
        },
      }
      const overrides = {
        cache,
        nowMs: () => now,
        fetchPricingRate: async () => {
          fetches++
          return { rate: 100_000, fetchedAt: now, source: "mempool" as const }
        },
      }
      const original = await handleCheckoutSparkPricingAuthorityRequest(
        request(),
        configuration,
        overrides
      )
      const signed = await original.json()
      for (let count = 0; count < 130; count++) {
        const repeated = await handleCheckoutSparkPricingAuthorityRequest(
          request(),
          configuration,
          overrides
        )
        expect(repeated.status).toBe(200)
      }
      expect(limits).toBe(1)
      const otherCaller = () =>
        new Request(request(), {
          headers: { origin: secondOrigin, "content-type": "application/json" },
        })
      const other = await handleCheckoutSparkPricingAuthorityRequest(
        otherCaller(),
        configuration,
        overrides
      )
      expect(other.status).toBe(200)
      expect(await other.json()).toEqual(signed)
      now += 240_001
      const deniedRefresh = await handleCheckoutSparkPricingAuthorityRequest(
        otherCaller(),
        configuration,
        overrides
      )
      expect(deniedRefresh.status).toBe(200)
      expect(await deniedRefresh.json()).toEqual(signed)
      expect(limits).toBe(2)
      expect(fetches).toBe(1)
      now = NOW_MS + 300_000
      const expired = await handleCheckoutSparkPricingAuthorityRequest(
        otherCaller(),
        configuration,
        overrides
      )
      expect(expired.status).toBe(failure === "exhausted" ? 429 : 503)
      expect(fetches).toBe(1)
      expect(limits).toBe(3)
    }
  )

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

  it("restores an independently verified edge snapshot into a new isolate without upstream access", async () => {
    let saved: unknown
    const store: PricingSnapshotStore = {
      read: async () => saved,
      write: async (_key, value) => {
        saved = JSON.parse(JSON.stringify(value))
      },
    }
    const configuration = env()
    const first = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      {
        nowMs: () => NOW_MS,
        store,
        fetchPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: NOW_MS,
          source: "kraken",
          fiatUsdRates: { EUR: 1.25 },
          fiatSource: "ecb",
          fiatSources: { EUR: "ecb" },
        }),
      }
    )
    const original = await first.json()
    let fetches = 0
    const outage = async () => {
      fetches++
      throw new Error("Unavailable")
    }
    const restored = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      {
        cache: createCheckoutSparkPricingAuthorityCache(),
        nowMs: () => NOW_MS + 1000,
        store,
        fetchPricingRate: outage,
      }
    )
    expect(restored.status).toBe(200)
    expect(restored.headers.get("x-pricing-cache")).toBe("edge")
    expect(await restored.json()).toEqual(original)
    expect(fetches).toBe(0)
    const expired = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      {
        cache: createCheckoutSparkPricingAuthorityCache(),
        nowMs: () => NOW_MS + 300_000,
        store,
        fetchPricingRate: outage,
      }
    )
    expect(expired.status).toBe(503)
    expect(fetches).toBe(1)
    const tampered = saved as CheckoutSparkPricingRateAttestation
    saved = { ...tampered, signature: "0".repeat(128) }
    const invalid = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      configuration,
      {
        cache: createCheckoutSparkPricingAuthorityCache(),
        nowMs: () => NOW_MS + 1000,
        store,
        fetchPricingRate: outage,
      }
    )
    expect(invalid.status).toBe(503)
    expect(fetches).toBe(2)
  })

  it("serves immediately during one background refresh and preserves prior valid coverage", async () => {
    const cache = createCheckoutSparkPricingAuthorityCache()
    let now = NOW_MS
    let resolveRefresh: (value: BtcUsdRateQuote) => void = () => {}
    let calls = 0
    const background: Promise<unknown>[] = []
    const overrides = {
      cache,
      nowMs: () => now,
      fetchPricingRate: async (): Promise<BtcUsdRateQuote> => {
        calls++
        if (calls === 1)
          return {
            rate: 100_000,
            fetchedAt: now,
            source: "mempool" as const,
            fiatUsdRates: { EUR: 1.25 },
            fiatSource: "mempool" as const,
          }
        return new Promise<BtcUsdRateQuote>((resolve) => {
          resolveRefresh = resolve
        })
      },
    }
    const first = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      overrides
    )
    const original = await first.json()
    now += 240_001
    const start = performance.now()
    const refreshing = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      overrides,
      {
        waitUntil: (p) => {
          background.push(p)
        },
      }
    )
    expect(performance.now() - start).toBeLessThan(100)
    expect(refreshing.status).toBe(200)
    expect(await refreshing.json()).toEqual(original)
    const concurrent = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      overrides,
      {
        waitUntil: (p) => {
          background.push(p)
        },
      }
    )
    expect(await concurrent.json()).toEqual(original)
    expect(calls).toBe(2)
    resolveRefresh({ rate: 100_001, fetchedAt: now, source: "coinbase" })
    await Promise.all(background)
    const retained = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      overrides
    )
    expect(await retained.json()).toEqual(original)
    expect(retained.headers.get("x-pricing-refresh")).toBe("unavailable")
  })

  it("bounds stalled native-cache operations and still returns a fresh signed rate", async () => {
    const start = performance.now()
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      {
        nowMs: () => NOW_MS,
        store: {
          read: async () => new Promise(() => {}),
          write: async () => new Promise(() => {}),
        },
        fetchPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: NOW_MS,
          source: "coinbase",
        }),
      }
    )
    expect(result.status).toBe(200)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  for (const header of [
    "authorization",
    "proxy-authorization",
    "cookie",
    "referer",
  ]) {
    it(`rejects a request carrying ${header} before calling a provider`, async () => {
      const input = request()
      input.headers.set(header, "synthetic-boundary-fixture")
      let fetched = false
      const result = await handleCheckoutSparkPricingAuthorityRequest(
        input,
        env(),
        {
          fetchPricingRate: async () => {
            fetched = true
            throw new Error("Must not fetch")
          },
        }
      )
      expect(result.status).toBe(400)
      expect(fetched).toBe(false)
    })
  }

  it("does not let cache storage failure invalidate a genuine fresh signed rate", async () => {
    const result = await handleCheckoutSparkPricingAuthorityRequest(
      request(),
      env(),
      {
        nowMs: () => NOW_MS,
        store: {
          read: async () => {
            throw new Error("cache failed")
          },
          write: async () => {
            throw new Error("cache failed")
          },
        },
        fetchPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: NOW_MS,
          source: "coinbase",
        }),
      }
    )
    expect(result.status).toBe(200)
    expect(result.headers.get("x-pricing-cache-store")).toBe("unavailable")
  })
})

describe("preview-only fixed qualification schedule", () => {
  const hostname = "conduit-checkout-pricing-preview.example.workers.dev"
  const config = JSON.stringify({
    hostname,
    startMs: NOW_MS,
    endMs: NOW_MS + 18 * 60_000,
  })
  it("is absent by default and becomes permanently inert after its configured window", () => {
    expect(
      previewPricingQualification(undefined, hostname, NOW_MS)
    ).toBeUndefined()
    expect(previewPricingQualification(config, hostname, NOW_MS - 1)).toEqual({
      phase: "normal",
    })
    expect(
      previewPricingQualification(config, hostname, NOW_MS + 18 * 60_000)
    ).toEqual({ phase: "complete" })
  })
  it("refuses production, other hosts, extra controls and unbounded windows", () => {
    for (const [raw, host] of [
      [config, "conduit-checkout-pricing.example.workers.dev"],
      [config, "other.example.workers.dev"],
      [
        JSON.stringify({
          hostname,
          startMs: NOW_MS,
          endMs: NOW_MS + 60 * 60_000,
        }),
        hostname,
      ],
      [
        JSON.stringify({
          hostname,
          startMs: NOW_MS,
          endMs: NOW_MS + 18 * 60_000,
          url: "https://untrusted.example",
        }),
        hostname,
      ],
    ])
      expect(() => previewPricingQualification(raw, host, NOW_MS)).toThrow()
  })
  it("forces fixed upstream failures through the normal provider transport in each phase", async () => {
    for (const [offset, phase, blocked] of [
      [0, "secondary", ["mempool", "frankfurter"]],
      [
        6 * 60_000,
        "tertiary",
        ["mempool", "coinbase", "frankfurter", "floatrates"],
      ],
      [12 * 60_000, "outage", Object.keys(PRICING_PROVIDER_URLS)],
    ] as const) {
      const qualification = previewPricingQualification(
        config,
        hostname,
        NOW_MS + offset
      )!
      expect(qualification.phase).toBe(phase)
      for (const provider of blocked) {
        const response = await qualification.fetchImpl!(
          PRICING_PROVIDER_URLS[provider as keyof typeof PRICING_PROVIDER_URLS]
        )
        expect(response.status).toBe(503)
        expect(await response.text()).toBe("")
      }
    }
  })
})
