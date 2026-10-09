import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools"
import { checkoutSparkCommerceQuoteDigestValue } from "../packages/core/src/protocol/checkout-spark-commerce-pricing"
import {
  freezeCheckoutSparkCommerceQuote,
  type CheckoutSparkCommerceQuote,
} from "../packages/core/src/protocol/checkout-spark-reconciliation"
import {
  checkoutSparkPricingRateAttestationDigestValue,
  verifyCheckoutSparkPricingRateAttestation,
} from "../packages/core/src/protocol/checkout-spark-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "../packages/core/src/protocol/checkout-spark-pricing-authority-server"

describe("portable pricing evidence in frozen commerce quotes", () => {
  const merchant = "a".repeat(64)
  const acceptedAtMs = 1_790_000_000_000
  const quote: CheckoutSparkCommerceQuote = {
    commerceTotalSats: 1_000,
    lines: [
      {
        productCoordinate: `30402:${merchant}:ordinary-fiat-fixture`,
        productEventId: "b".repeat(64),
        merchantPubkey: merchant,
        quantity: 1,
        unitMerchandiseSats: 1_000,
        unitShippingSats: 0,
        sourcePrice: {
          amount: 0.3,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
    ],
    pricing: {
      version: 1,
      rate: { rate: 30_000, fetchedAt: acceptedAtMs, source: "mempool" },
    },
  }

  it("preserves the historical digest tuple when no new evidence is present", () => {
    const before = checkoutSparkCommerceQuoteDigestValue(quote)
    const restored = freezeCheckoutSparkCommerceQuote(quote, merchant)
    expect(
      JSON.stringify(checkoutSparkCommerceQuoteDigestValue(restored)) ===
        JSON.stringify(before)
    ).toBe(true)
    expect(before.length).toBe(3)
    expect(restored.pricingAuthority === undefined).toBe(true)
  })

  it("roundtrips a legitimate service rate proof without treating it as an order signature", () => {
    const privateKeyHex = Buffer.from(generateSecretKey()).toString("hex")
    const keyId = "fixture-rate-key"
    const authority = createCheckoutSparkPricingRateAttestation({
      rate: quote.pricing!.rate,
      keyId,
      privateKeyHex,
      issuedAtMs: acceptedAtMs,
    })
    const publicKey = getCheckoutSparkPricingAuthorityPublicKey(privateKeyHex)!
    const frozen = freezeCheckoutSparkCommerceQuote(
      { ...quote, pricingAuthority: authority },
      merchant
    )
    const restored = freezeCheckoutSparkCommerceQuote(
      JSON.parse(JSON.stringify(frozen)),
      merchant
    )
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: restored.pricingAuthority,
        pricing: restored.pricing!,
        acceptedAtMs,
        nowMs: acceptedAtMs + 1_000,
        trustedPublicKeys: new Map([[keyId, publicKey]]),
      })
    ).toBe("verified")
    const tuple = checkoutSparkCommerceQuoteDigestValue(restored)
    expect(tuple.length).toBe(4)
    expect(
      JSON.stringify(tuple[3]) ===
        JSON.stringify(
          checkoutSparkPricingRateAttestationDigestValue(authority)
        )
    ).toBe(true)
    expect(Object.isFrozen(restored.pricingAuthority)).toBe(true)
    expect(Object.isFrozen(restored.pricingAuthority!.rate)).toBe(true)
    expect(restored.commerceTotalSats).toBe(1_000)
  })
})
