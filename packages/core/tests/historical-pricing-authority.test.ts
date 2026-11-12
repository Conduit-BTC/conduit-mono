import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { normalizeCommercePrice, type BtcUsdRateQuote } from "../src/pricing"
import { productSchema } from "../src/schemas"
import {
  HISTORICAL_PRICING_BENCHMARK_ID,
  type HistoricalPricingRateOptions,
  type HistoricalPricingRateQuote,
} from "../src/pricing/historical-rate-provider"
import {
  CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
  freezeCheckoutSparkCommercePricing,
} from "../src/protocol/checkout-spark-commerce-pricing"
import { verifyCheckoutSparkCommercePricingAuthority } from "../src/protocol/checkout-spark-commerce-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "./fixtures/checkout-spark-pricing-authority"
import type { CheckoutSparkCommerceQuote } from "../src/protocol/checkout-spark-reconciliation"
import { buildProductListingEventDraft } from "../src/protocol/products"
import {
  buildShippingPolicyEventDraft,
  getMerchantShippingPolicyCoordinate,
  quoteShippingPolicy,
  type ShippingPolicy,
} from "../src/protocol/shipping-policy"
import { admitPublicEvent } from "../src/protocol/verified-public-event"

const acceptedAtMs = Date.UTC(2026, 10, 5, 14, 30)
const merchant = "a".repeat(64)

function rate(btc = 100_000, eur = 1.1): BtcUsdRateQuote {
  return {
    rate: btc,
    fetchedAt: acceptedAtMs,
    source: "coinbase",
    fiatUsdRates: { EUR: eur },
    fiatSource: "ecb",
    fiatSources: { EUR: "ecb" },
  }
}

function history(
  value: BtcUsdRateQuote,
  anchor = acceptedAtMs
): HistoricalPricingRateQuote {
  return {
    ...value,
    fetchedAt: Date.now(),
    historical: {
      policyId: HISTORICAL_PRICING_BENCHMARK_ID,
      acceptedAtMs: anchor,
      btcMinuteStartMs: Math.floor(anchor / 60_000) * 60_000 - 60_000,
      fxRequestedDate: new Date(anchor - 86_400_000).toISOString().slice(0, 10),
      fxObservedDate: new Date(anchor - 86_400_000).toISOString().slice(0, 10),
    },
  }
}

async function signedShippingQuote(options: {
  domesticThreshold?: number
  internationalThreshold?: number
}) {
  const secret = new Uint8Array(32)
  secret[31] = 1
  const pubkey = getPublicKey(secret)
  const created_at = Math.floor(acceptedAtMs / 1_000)
  const coordinate = getMerchantShippingPolicyCoordinate(pubkey)
  const policy: ShippingPolicy = {
    version: 2,
    title: "Ordinary domestic shipping",
    originCountry: "US",
    currency: "USD",
    domestic: {
      rules: [
        { country: "US", bands: [{ maxWeightGrams: 1_000, priceMinor: 500 }] },
      ],
      ...(options.domesticThreshold !== undefined
        ? { freeShippingThresholdMinor: options.domesticThreshold }
        : {}),
    },
    international:
      options.internationalThreshold !== undefined
        ? {
            rules: [
              {
                country: "CA",
                bands: [{ maxWeightGrams: 1_000, priceMinor: 500 }],
              },
            ],
            freeShippingThresholdMinor: options.internationalThreshold,
          }
        : null,
  }
  const product = productSchema.parse({
    id: `30402:${pubkey}:shipping-test`,
    pubkey,
    title: "Shipping test product",
    price: 10,
    currency: "EUR",
    shippingWeightGrams: 100,
    shippingOptionId: coordinate,
    createdAt: created_at,
    updatedAt: created_at,
  })
  const drafts = [
    buildShippingPolicyEventDraft({ policy }),
    buildProductListingEventDraft({ product, dTag: "shipping-test" }),
  ]
  const events = await Promise.all(
    drafts.map(async (draft) => {
      const result = await admitPublicEvent(
        finalizeEvent({ ...draft, created_at }, secret)
      )
      if (result.status !== "verified")
        throw new Error("Expected signed test event.")
      return result.event
    })
  )
  const policyEvent = events[0]!
  const productEvent = events[1]!
  const shipping = quoteShippingPolicy({
    policy,
    policyCoordinate: coordinate,
    policyEventId: policyEvent.id,
    policyCreatedAt: created_at,
    merchantPubkey: pubkey,
    policyEvent,
    destination: { country: "US" },
    rateInput: rate(),
    items: [
      {
        productId: product.id,
        productEventId: productEvent.id,
        productCreatedAt: created_at,
        productEvent,
        quantity: 1,
        weightGrams: 100,
        currency: "EUR",
        subtotalMinor: 1_000,
      },
    ],
  })
  if (shipping.status !== "quoted")
    throw new Error(`Expected shipping quote: ${shipping.status}`)
  const quote = quoteFor("EUR")
  const originalLine = quote.lines[0]!
  quote.lines = [
    {
      ...originalLine,
      productCoordinate: product.id,
      productEventId: productEvent.id,
      merchantPubkey: pubkey,
      unitMerchandiseSats: originalLine.unitMerchandiseSats * 10,
      sourcePrice: { amount: 10, currency: "EUR", normalizedCurrency: "EUR" },
      unitShippingSats: shipping.quote.amountSats!,
      shippingPolicy: {
        quote: shipping.quote,
        allocatedCostSats: shipping.quote.amountSats!,
      },
    },
  ]
  quote.commerceTotalSats =
    quote.lines[0]!.unitMerchandiseSats + shipping.quote.amountSats!
  return { quote, shipping: shipping.quote }
}

function quoteFor(
  currency: "USD" | "EUR",
  value = rate()
): CheckoutSparkCommerceQuote {
  const converted = normalizeCommercePrice(1, currency, value)
  if (converted.status !== "ok")
    throw new Error("Expected ordinary fiat conversion.")
  return {
    commerceTotalSats: converted.sats,
    lines: [
      {
        productCoordinate: `30402:${merchant}:${currency}`,
        productEventId: "b".repeat(64),
        merchantPubkey: merchant,
        quantity: 1,
        unitMerchandiseSats: converted.sats,
        unitShippingSats: 0,
        sourcePrice: converted.source,
      },
    ],
    pricing: freezeCheckoutSparkCommercePricing({
      version: 2,
      policy: CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
      rate: value,
    }),
  }
}

describe("invoice-time historical pricing authority", () => {
  it.each([1, 2_000, 30_000])(
    "rejects a claimed rate fetched %i ms after the provider invoice without rewriting time",
    async (lead) => {
      let historyReads = 0
      const claimed = { ...rate(), fetchedAt: acceptedAtMs + lead }
      expect(
        await verifyCheckoutSparkCommercePricingAuthority({
          quote: quoteFor("USD", claimed),
          acceptedAtMs,
          nowMs: acceptedAtMs + lead,
          trustedPublicKeys: null,
          fetchHistoricalRate: async () => {
            historyReads++
            return history(rate())
          },
        })
      ).toBe("expired")
      expect(historyReads).toBe(0)
    }
  )

  it.each([98_999, 101_011])(
    "rejects a plain fiat line outside the effective-rate bound at benchmark %i",
    async (benchmark) => {
      expect(
        await verifyCheckoutSparkCommercePricingAuthority({
          quote: quoteFor("USD"),
          acceptedAtMs,
          trustedPublicKeys: null,
          fetchHistoricalRate: async () => history(rate(benchmark)),
        })
      ).toBe("invalid")
    }
  )

  it.each([
    ["USD", rate(), rate(99_000)],
    ["USD", rate(), rate(101_000)],
    ["EUR", rate(100_000, 1.089), rate()],
    ["EUR", rate(100_000, 1.111), rate()],
  ] as const)(
    "accepts the exact one-percent effective-rate boundary for %s",
    async (currency, claimed, benchmark) => {
      expect(
        await verifyCheckoutSparkCommercePricingAuthority({
          quote: quoteFor(currency, claimed),
          acceptedAtMs,
          trustedPublicKeys: null,
          fetchHistoricalRate: async () => history(benchmark),
        })
      ).toBe("verified")
    }
  )

  it("compares the combined BTC/fiat conversion rather than two independent percentage limits", async () => {
    expect(
      await verifyCheckoutSparkCommercePricingAuthority({
        quote: quoteFor("EUR", rate(102_000, 1.122)),
        acceptedAtMs,
        trustedPublicKeys: null,
        fetchHistoricalRate: async () => history(rate()),
      })
    ).toBe("verified")
  })

  it("requests every economic currency at the independently supplied invoice time", async () => {
    const quote = quoteFor("USD")
    const eur = quoteFor("EUR")
    quote.lines = [...quote.lines, ...eur.lines]
    quote.commerceTotalSats += eur.commerceTotalSats
    let requested: HistoricalPricingRateOptions | undefined
    expect(
      await verifyCheckoutSparkCommercePricingAuthority({
        quote,
        acceptedAtMs,
        trustedPublicKeys: null,
        fetchHistoricalRate: async (options) => {
          requested = options
          return history(rate())
        },
      })
    ).toBe("verified")
    expect(requested).toEqual({ acceptedAtMs, currencies: ["EUR", "USD"] })
  })

  it("returns unavailable when the independent historical provider is down", async () => {
    expect(
      await verifyCheckoutSparkCommercePricingAuthority({
        quote: quoteFor("USD"),
        acceptedAtMs,
        trustedPublicKeys: null,
        fetchHistoricalRate: async () => {
          throw new Error("Provider unavailable.")
        },
      })
    ).toBe("unavailable")
  })

  it("recovers old accepted evidence without using the current observation time to reprice", async () => {
    const oldAnchor = acceptedAtMs - 60 * 86_400_000
    const originalRate = { ...rate(), fetchedAt: oldAnchor }
    let requestedAnchor: number | undefined
    expect(
      await verifyCheckoutSparkCommercePricingAuthority({
        quote: quoteFor("USD", originalRate),
        acceptedAtMs: oldAnchor,
        trustedPublicKeys: null,
        fetchHistoricalRate: async ({ acceptedAtMs: anchor }) => {
          requestedAnchor = anchor
          return history(originalRate, anchor)
        },
      })
    ).toBe("verified")
    expect(requestedAnchor).toBe(oldAnchor)
  })

  it("retains the original signed-v1 verifier without a historical-provider request", async () => {
    const quote = quoteFor("USD")
    quote.pricing = freezeCheckoutSparkCommercePricing({
      version: 1,
      rate: rate(),
    })
    const privateKeyHex = `${"0".repeat(63)}1`
    const publicKey = getCheckoutSparkPricingAuthorityPublicKey(privateKeyHex)!
    quote.pricingAuthority = createCheckoutSparkPricingRateAttestation({
      rate: quote.pricing.rate,
      keyId: "historical-test",
      privateKeyHex,
      issuedAtMs: acceptedAtMs,
    })
    let historicalCalls = 0
    expect(
      await verifyCheckoutSparkCommercePricingAuthority({
        quote,
        acceptedAtMs,
        trustedPublicKeys: new Map([["historical-test", publicKey]]),
        fetchHistoricalRate: async () => {
          historicalCalls++
          return history(rate())
        },
      })
    ).toBe("verified")
    expect(historicalCalls).toBe(0)
  })

  it.each([
    [1_000, true],
    [1_200, false],
  ] as const)(
    "keeps the signed shipping threshold %i and its free-shipping decision",
    async (threshold, free) => {
      const { quote, shipping } = await signedShippingQuote({
        domesticThreshold: threshold,
      })
      expect(shipping.freeShippingApplied).toBe(free)
      expect(shipping.pricingRate).toEqual(quote.pricing!.rate)
      expect(
        await verifyCheckoutSparkCommercePricingAuthority({
          quote,
          acceptedAtMs,
          trustedPublicKeys: null,
          fetchHistoricalRate: async () => history(rate(99_500)),
        })
      ).toBe("verified")
    }
  )

  it("ignores another destination table's unused subtotal conversion after country normalization", async () => {
    const { quote } = await signedShippingQuote({
      internationalThreshold: 1_200,
    })
    for (const country of ["US", "us", " us "]) {
      const persisted = structuredClone(quote)
      persisted.lines[0]!.shippingPolicy!.quote.destination.country = country
      expect(
        await verifyCheckoutSparkCommercePricingAuthority({
          quote: persisted,
          acceptedAtMs,
          trustedPublicKeys: null,
          fetchHistoricalRate: async () => history(rate(101_000, 1.122)),
        })
      ).toBe("verified")
    }
  })

  it("retains the active domestic subtotal conversion bound after country normalization", async () => {
    const { quote } = await signedShippingQuote({ domesticThreshold: 1_200 })
    for (const country of ["US", "us", " us "]) {
      const persisted = structuredClone(quote)
      persisted.lines[0]!.shippingPolicy!.quote.destination.country = country
      expect(
        await verifyCheckoutSparkCommercePricingAuthority({
          quote: persisted,
          acceptedAtMs,
          trustedPublicKeys: null,
          fetchHistoricalRate: async () => history(rate(101_000, 1.122)),
        })
      ).toBe("invalid")
    }
  })
})
