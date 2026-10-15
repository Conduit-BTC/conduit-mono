import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import { isPricingRateQuoteFresh } from "@conduit/core/pricing"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import {
  createCheckoutSparkPricingClient,
  SIGNED_PRICING_FEED_CURRENCIES,
} from "@conduit/core/pricing/signed-rate-client"
import { parseCheckoutSparkPricingConfiguration } from "@conduit/core/protocol/checkout-spark-pricing-config"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"
import { verifyCheckoutSparkPricingRateAttestation } from "@conduit/core/protocol/checkout-spark-pricing-authority"

const NOW = 1_800_000_000_000
const key = Buffer.from(generateSecretKey()).toString("hex")
function configuration(keyId = "fixture-rate") {
  return parseCheckoutSparkPricingConfiguration({
    url: "https://pricing.example/api/checkout-spark-pricing",
    publicKeys: `${keyId}:${getCheckoutSparkPricingAuthorityPublicKey(key)}`,
  })!
}
function snapshot(issuedAtMs = NOW, keyId = "fixture-rate", fetchedAtMs = NOW) {
  const pricingAuthority = createCheckoutSparkPricingRateAttestation({
    keyId,
    privateKeyHex: key,
    issuedAtMs,
    rate: {
      rate: 100_000,
      fetchedAt: fetchedAtMs,
      source: "mempool",
      fiatUsdRates: { EUR: 1.25, CAD: 0.75 },
      fiatSource: "frankfurter",
      fiatSources: { EUR: "mempool", CAD: "frankfurter" },
    },
  })
  return {
    pricing: { version: 1 as const, rate: pricingAuthority.rate },
    pricingAuthority,
  }
}

describe("shared signed pricing feed", () => {
  it("shares one generic in-flight lookup between display and checkout consumers", async () => {
    let calls = 0
    const original = snapshot()
    const client = createCheckoutSparkPricingClient({
      nowMs: () => NOW + 100,
      fetchImpl: (async (_url, options) => {
        calls++
        expect(JSON.parse(String(options?.body))).toEqual({
          currencies: SIGNED_PRICING_FEED_CURRENCIES,
        })
        expect(options?.credentials).toBe("omit")
        expect(options?.referrerPolicy).toBe("no-referrer")
        expect(options?.redirect).toBe("error")
        await Promise.resolve()
        return Response.json(original)
      }) as typeof fetch,
    })
    const [display, checkout] = await Promise.all([
      client.fetch({ configuration: configuration(), currencies: ["USD"] }),
      client.fetch({ configuration: configuration(), currencies: ["EUR"] }),
    ])
    expect(display).toBe(checkout)
    expect(display).toEqual(original)
    expect(calls).toBe(1)
    expect(Object.isFrozen(checkout.pricing.rate.fiatSources)).toBe(true)
    const warm = await client.fetch({
      configuration: configuration(),
      currencies: ["CAD"],
    })
    expect(warm).toBe(display)
    expect(calls).toBe(1)
  })

  it("keeps an unexpired exact snapshot during outage, but never extends its expiry", async () => {
    let now = NOW + 100
    let outage = false
    let calls = 0
    const original = snapshot()
    const client = createCheckoutSparkPricingClient({
      nowMs: () => now,
      fetchImpl: (async () => {
        calls++
        if (outage) return new Response(null, { status: 503 })
        return Response.json(original)
      }) as typeof fetch,
    })
    const first = await client.fetch({
      configuration: configuration(),
      currencies: ["USD"],
    })
    outage = true
    now = NOW + 250_000
    const cached = await client.fetch({
      configuration: configuration(),
      currencies: ["EUR"],
    })
    expect(cached).toBe(first)
    expect(cached.pricingAuthority.expiresAtMs).toBe(NOW + 300_000)
    expect(cached.pricingAuthority.issuedAtMs).toBe(NOW)
    now = NOW + 300_000
    await expect(
      client.fetch({ configuration: configuration(), currencies: ["USD"] })
    ).rejects.toThrow("Current currency pricing is unavailable")
    expect(calls).toBe(3)
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: original.pricingAuthority,
        pricing: original.pricing,
        acceptedAtMs: NOW + 100,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("verified")
  })

  it("allows a small live issuance clock difference without relaxing the funding anchor or expiry", async () => {
    const original = snapshot(NOW + 24)
    let now = NOW
    const client = createCheckoutSparkPricingClient({
      nowMs: () => now,
      fetchImpl: (async () => Response.json(original)) as typeof fetch,
      wait: async (milliseconds) => {
        expect(milliseconds).toBe(24)
        now += milliseconds
      },
    })
    const live = await client.fetch({
      configuration: configuration(),
      currencies: ["USD"],
    })
    expect(live.pricingAuthority.issuedAtMs).toBe(NOW + 24)
    expect(live).toEqual(original)
    expect(now).toBe(NOW + 24)
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: live.pricingAuthority,
        pricing: live.pricing,
        acceptedAtMs: NOW,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("invalid")
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: live.pricingAuthority,
        pricing: live.pricing,
        acceptedAtMs: NOW + 24,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("verified")
  })

  it("waits for the real feed to be fresh for display and normal checkout when both service timestamps are ahead", async () => {
    const original = snapshot(NOW + 150, "fixture-rate", NOW + 100)
    let now = NOW
    const waits: number[] = []
    expect(isPricingRateQuoteFresh(original.pricing.rate, now)).toBe(false)
    const client = createCheckoutSparkPricingClient({
      nowMs: () => now,
      fetchImpl: (async () => Response.json(original)) as typeof fetch,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        now += milliseconds
      },
    })
    const live = await client.fetch({
      configuration: configuration(),
      currencies: ["USD"],
    })
    expect(waits).toEqual([150])
    expect(live).toEqual(original)
    expect(isPricingRateQuoteFresh(live.pricing.rate, now)).toBe(true)
    const intent = buildCheckoutPricingIntent(
      [
        {
          productId: "synthetic-digital-item",
          merchantPubkey: "synthetic-merchant",
          title: "Synthetic item",
          price: 1,
          currency: "USD",
          sourcePrice: {
            amount: 1,
            currency: "USD",
            normalizedCurrency: "USD",
          },
          quantity: 1,
          format: "digital",
          fulfillment: { type: "digital" },
          shippingCostSats: 0,
        },
      ],
      live.pricing.rate,
      now
    )
    expect(intent.status).toBe("ok")
    if (intent.status === "ok") expect(intent.totalSats).toBe(1_000)
    expect(live.pricing.rate.fetchedAt).toBe(NOW + 100)
    expect(live.pricingAuthority.issuedAtMs).toBe(NOW + 150)
    expect(live.pricingAuthority.expiresAtMs).toBe(NOW + 300_100)
    // The native funding anchor stays strict, regardless of the browser wait.
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: live.pricingAuthority,
        pricing: live.pricing,
        acceptedAtMs: NOW + 149,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("invalid")
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: live.pricingAuthority,
        pricing: live.pricing,
        acceptedAtMs: NOW + 150,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("verified")
  })

  it("never waits beyond the one-second allowance or returns from a frozen/rollback clock", async () => {
    for (const clockAfterWait of [NOW, NOW - 1]) {
      const original = snapshot(NOW + 150, "fixture-rate", NOW + 100)
      let now = NOW
      const waits: number[] = []
      const client = createCheckoutSparkPricingClient({
        nowMs: () => now,
        fetchImpl: (async () => Response.json(original)) as typeof fetch,
        wait: async (milliseconds) => {
          waits.push(milliseconds)
          now = clockAfterWait
        },
      })
      await expect(
        client.fetch({ configuration: configuration(), currencies: ["USD"] })
      ).rejects.toThrow("Current currency pricing is unavailable")
      expect(waits).toEqual([150])
    }
    let waited = false
    const client = createCheckoutSparkPricingClient({
      nowMs: () => NOW,
      fetchImpl: (async () =>
        Response.json(
          snapshot(NOW + 1_001, "fixture-rate", NOW + 100)
        )) as typeof fetch,
      wait: async () => {
        waited = true
      },
    })
    await expect(
      client.fetch({ configuration: configuration(), currencies: ["USD"] })
    ).rejects.toThrow("Current currency pricing is unavailable")
    expect(waited).toBe(false)
  })

  it("strictly rechecks expiry after waiting and keeps the historical snapshot unchanged", async () => {
    const original = snapshot(NOW + 1_000, "fixture-rate", NOW + 100)
    let now = NOW
    const waits: number[] = []
    const client = createCheckoutSparkPricingClient({
      nowMs: () => now,
      fetchImpl: (async () => Response.json(original)) as typeof fetch,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        now = original.pricingAuthority.expiresAtMs
      },
    })
    await expect(
      client.fetch({ configuration: configuration(), currencies: ["USD"] })
    ).rejects.toThrow("Current currency pricing is unavailable")
    expect(waits).toEqual([1_000])
    expect(original.pricingAuthority.expiresAtMs).toBe(NOW + 300_100)
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: original.pricingAuthority,
        pricing: original.pricing,
        acceptedAtMs: NOW + 1_000,
        trustedPublicKeys: configuration().publicKeys,
      })
    ).toBe("verified")
  })

  it("keeps missing unrelated currencies local and invalidates cache after trust rotation", async () => {
    let calls = 0
    const client = createCheckoutSparkPricingClient({
      nowMs: () => NOW + 100,
      fetchImpl: (async () => {
        calls++
        return Response.json(
          snapshot(NOW, calls === 1 ? "fixture-rate" : "rotated-rate")
        )
      }) as typeof fetch,
    })
    await client.fetch({ configuration: configuration(), currencies: ["USD"] })
    await expect(
      client.fetch({ configuration: configuration(), currencies: ["JPY"] })
    ).rejects.toThrow("Current currency pricing is unavailable")
    expect(calls).toBe(1)
    const rotated = await client.fetch({
      configuration: configuration("rotated-rate"),
      currencies: ["USD"],
    })
    expect(rotated.pricingAuthority.keyId).toBe("rotated-rate")
    expect(calls).toBe(2)
  })
})
