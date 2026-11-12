import { describe, expect, it } from "bun:test"
import {
  CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
  checkoutSparkCommerceQuoteDigestValue,
  freezeCheckoutSparkCommercePricing,
  matchesCheckoutSparkOrderPrice,
} from "../src/protocol/checkout-spark-commerce-pricing"
import {
  checkoutSparkPricingRateAttestationDigestValue,
  verifyCheckoutSparkPricingRateAttestation,
} from "../src/protocol/checkout-spark-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "./fixtures/checkout-spark-pricing-authority"

const rate = {
  rate: 80_000,
  fetchedAt: 1_800_000_000_000,
  source: "coinbase" as const,
  fiatUsdRates: { GBP: 1.25, EUR: 1.1 },
  fiatSource: "frankfurter" as const,
  fiatSources: { GBP: "frankfurter" as const, EUR: "frankfurter" as const },
}
const originalPricingDigest = [
  "pricing",
  1,
  80_000,
  1_800_000_000_000,
  "coinbase",
  [
    ["EUR", 1.1],
    ["GBP", 1.25],
  ],
  "frankfurter",
  [
    "fiat_sources",
    [
      ["EUR", "frankfurter"],
      ["GBP", "frankfurter"],
    ],
  ],
]

describe("checkout pricing policy versions", () => {
  it("preserves the original v1 wire value and digest bytes", () => {
    const input = { version: 1, rate }
    const pricing = freezeCheckoutSparkCommercePricing(input)
    expect(JSON.stringify(pricing)).toBe(JSON.stringify(input))
    expect(
      JSON.stringify(
        checkoutSparkCommerceQuoteDigestValue({
          commerceTotalSats: 1_250,
          lines: [],
          pricing,
        })
      )
    ).toBe(JSON.stringify([1_250, [], originalPricingDigest]))
  })

  it("roundtrips and deeply freezes v2 evidence with the same whole-sat conversion", () => {
    const input = {
      version: 2,
      policy: CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
      rate,
    }
    const pricing = freezeCheckoutSparkCommercePricing(
      JSON.parse(JSON.stringify(input))
    )
    expect(pricing).toEqual(input)
    expect(Object.isFrozen(pricing)).toBe(true)
    expect(Object.isFrozen(pricing.rate)).toBe(true)
    expect(Object.isFrozen(pricing.rate.fiatUsdRates)).toBe(true)
    expect(Object.isFrozen(pricing.rate.fiatSources)).toBe(true)
    expect(
      matchesCheckoutSparkOrderPrice(
        {
          sourcePrice: {
            amount: 1,
            currency: "USD",
            normalizedCurrency: "USD",
          },
          priceAtPurchase: 1_250,
        },
        pricing
      )
    ).toBe(true)
  })

  it("commits the v2 version and explicit policy in the quote digest", () => {
    const pricing = freezeCheckoutSparkCommercePricing({
      version: 2,
      policy: CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
      rate,
    })
    const digest = checkoutSparkCommerceQuoteDigestValue({
      commerceTotalSats: 1_250,
      lines: [],
      pricing,
    })
    expect(JSON.stringify(digest)).toBe(
      JSON.stringify([
        1_250,
        [],
        [
          "pricing",
          2,
          ...originalPricingDigest.slice(2),
          ["policy", "invoice-historical-1pct-v1"],
        ],
      ])
    )
  })

  it("keeps original v1 signed-price recovery and attestation commitment", () => {
    const pricing = freezeCheckoutSparkCommercePricing({ version: 1, rate })
    if (pricing.version !== 1) throw new Error("Expected original pricing.")
    const privateKeyHex = `${"0".repeat(63)}1`
    const publicKey = getCheckoutSparkPricingAuthorityPublicKey(privateKeyHex)!
    const pricingAuthority = createCheckoutSparkPricingRateAttestation({
      rate: pricing.rate,
      keyId: "policy-version-test",
      privateKeyHex,
      issuedAtMs: rate.fetchedAt,
    })
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: pricingAuthority,
        pricing,
        acceptedAtMs: rate.fetchedAt + 1_000,
        trustedPublicKeys: new Map([["policy-version-test", publicKey]]),
      })
    ).toBe("verified")
    expect(
      checkoutSparkCommerceQuoteDigestValue({
        commerceTotalSats: 1_250,
        lines: [],
        pricing,
        pricingAuthority,
      })
    ).toEqual([
      1_250,
      [],
      originalPricingDigest,
      checkoutSparkPricingRateAttestationDigestValue(pricingAuthority),
    ])
  })
})
