import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import { normalizeCommercePrice } from "@conduit/core/pricing"
import { checkoutSparkCommerceQuoteDigestValue } from "@conduit/core/protocol/checkout-spark-commerce-pricing"
import { freezeCheckoutSparkCommerceQuote } from "@conduit/core/protocol/checkout-spark-reconciliation"
import {
  checkoutSparkPricingRateAttestationDigestValue,
  freezeCheckoutSparkPricingRateAttestation,
  parseCheckoutSparkPricingAuthorityPublicKeys,
  verifyCheckoutSparkPricingRateAttestation,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"

// Disposable test-runner material only; never a deployment credential.
const FIXTURE_SIGNING_KEY = Buffer.from(generateSecretKey()).toString("hex")
const NOW_MS = 1_800_000_000_000
const rate = {
  rate: 100_000,
  fetchedAt: NOW_MS,
  source: "mempool" as const,
  fiatUsdRates: { EUR: 1.25, CAD: 0.75 },
  fiatSource: "mempool" as const,
}
const pricing = { version: 1 as const, rate }

function attestation() {
  return createCheckoutSparkPricingRateAttestation({
    rate,
    keyId: "fixture-rate",
    privateKeyHex: FIXTURE_SIGNING_KEY,
    issuedAtMs: NOW_MS + 1_000,
  })
}

function publicKeys() {
  return parseCheckoutSparkPricingAuthorityPublicKeys(
    `fixture-rate:${getCheckoutSparkPricingAuthorityPublicKey(FIXTURE_SIGNING_KEY)}`
  )
}

describe("checkout Spark pricing authority", () => {
  it("authenticates a genuine immutable provider snapshot for normal USD and EUR conversion", () => {
    const signed = attestation()
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: signed,
        pricing,
        acceptedAtMs: NOW_MS + 2_000,
        nowMs: NOW_MS + 2_000,
        trustedPublicKeys: publicKeys(),
      })
    ).toBe("verified")
    expect(normalizeCommercePrice(10, "USD", signed.rate)).toMatchObject({
      status: "ok",
      sats: 10_000,
    })
    expect(normalizeCommercePrice(10, "EUR", signed.rate)).toMatchObject({
      status: "ok",
      sats: 12_500,
    })
    expect(Object.isFrozen(signed)).toBe(true)
    expect(Object.isFrozen(signed.rate)).toBe(true)
    expect(Object.isFrozen(signed.rate.fiatUsdRates)).toBe(true)
    expect(signed.expiresAtMs).toBe(NOW_MS + 300_000)
  })

  it("preserves the signed tuple and signature through an ordinary JSON recovery roundtrip", () => {
    const signed = attestation()
    const reopened = freezeCheckoutSparkPricingRateAttestation(
      JSON.parse(JSON.stringify(signed))
    )
    expect(
      JSON.stringify(
        checkoutSparkPricingRateAttestationDigestValue(reopened)
      ) ===
        JSON.stringify(checkoutSparkPricingRateAttestationDigestValue(signed))
    ).toBe(true)
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: reopened,
        pricing,
        // The integration must independently anchor this original acceptance time.
        acceptedAtMs: NOW_MS + 2_000,
        trustedPublicKeys: publicKeys(),
      })
    ).toBe("verified")
  })

  it("preserves a historically signed BGN quote and digest without authorizing new BGN commerce", () => {
    const historicalRate = {
      ...rate,
      fiatUsdRates: { ...rate.fiatUsdRates, BGN: 0.5 },
      fiatSources: {
        EUR: "mempool" as const,
        CAD: "mempool" as const,
        BGN: "frankfurter" as const,
      },
    }
    const signed = createCheckoutSparkPricingRateAttestation({
      rate: historicalRate,
      keyId: "fixture-rate",
      privateKeyHex: FIXTURE_SIGNING_KEY,
      issuedAtMs: NOW_MS + 1_000,
    })
    const merchant = "a".repeat(64)
    const quote = freezeCheckoutSparkCommerceQuote(
      {
        commerceTotalSats: 5_000,
        lines: [
          {
            productCoordinate: `30402:${merchant}:historical-bgn`,
            productEventId: "b".repeat(64),
            merchantPubkey: merchant,
            quantity: 1,
            unitMerchandiseSats: 5_000,
            unitShippingSats: 0,
            sourcePrice: {
              amount: 10,
              currency: "BGN",
              normalizedCurrency: "BGN",
            },
          },
        ],
        pricing: { version: 1, rate: historicalRate },
        pricingAuthority: signed,
      },
      merchant
    )
    const reopened = freezeCheckoutSparkCommerceQuote(
      JSON.parse(JSON.stringify(quote)),
      merchant
    )
    expect(checkoutSparkCommerceQuoteDigestValue(reopened)).toEqual(
      checkoutSparkCommerceQuoteDigestValue(quote)
    )
    expect(reopened.pricingAuthority?.signature).toBe(signed.signature)
    expect(reopened.pricing?.rate.fiatUsdRates?.BGN).toBe(0.5)
    expect(reopened.lines[0]?.sourcePrice?.normalizedCurrency).toBe("BGN")
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: reopened.pricingAuthority,
        pricing: reopened.pricing!,
        acceptedAtMs: NOW_MS + 2_000,
        trustedPublicKeys: publicKeys(),
      })
    ).toBe("verified")
    expect(
      normalizeCommercePrice(10, "BGN", reopened.pricing!.rate).status
    ).toBe("unsupported")
    expect(
      normalizeCommercePrice(10, "BGN", reopened.pricing!.rate, {
        currencyPolicy: "historical",
      })
    ).toMatchObject({ status: "ok", sats: 5_000 })
    const tamperedRate = {
      ...historicalRate,
      fiatUsdRates: { ...historicalRate.fiatUsdRates, BGN: 0.6 },
    }
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: { ...signed, rate: tamperedRate },
        pricing: { version: 1, rate: tamperedRate },
        acceptedAtMs: NOW_MS + 2_000,
        trustedPublicKeys: publicKeys(),
      })
    ).toBe("invalid")
  })

  it("keeps a retained USD order verifiable when its signed common snapshot includes incidental BGN", () => {
    const historicalRate = {
      ...rate,
      fiatUsdRates: { ...rate.fiatUsdRates, BGN: 0.5 },
      fiatSources: {
        EUR: "mempool" as const,
        CAD: "mempool" as const,
        BGN: "frankfurter" as const,
      },
    }
    const signed = createCheckoutSparkPricingRateAttestation({
      rate: historicalRate,
      keyId: "fixture-rate",
      privateKeyHex: FIXTURE_SIGNING_KEY,
      issuedAtMs: NOW_MS + 1_000,
    })
    const merchant = "a".repeat(64)
    const original = freezeCheckoutSparkCommerceQuote(
      {
        commerceTotalSats: 10_000,
        lines: [
          {
            productCoordinate: `30402:${merchant}:retained-usd`,
            productEventId: "b".repeat(64),
            merchantPubkey: merchant,
            quantity: 1,
            unitMerchandiseSats: 10_000,
            unitShippingSats: 0,
            sourcePrice: {
              amount: 10,
              currency: "USD",
              normalizedCurrency: "USD",
            },
          },
        ],
        pricing: { version: 1, rate: historicalRate },
        pricingAuthority: signed,
      },
      merchant
    )
    const reopened = freezeCheckoutSparkCommerceQuote(
      JSON.parse(JSON.stringify(original)),
      merchant
    )
    expect(checkoutSparkCommerceQuoteDigestValue(reopened)).toEqual(
      checkoutSparkCommerceQuoteDigestValue(original)
    )
    expect(reopened.pricingAuthority?.signature).toBe(signed.signature)
    expect(reopened.pricing!.rate.fiatUsdRates).toEqual(
      historicalRate.fiatUsdRates
    )
    expect(reopened.lines[0]!.sourcePrice?.currency).toBe("USD")
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: reopened.pricingAuthority,
        pricing: reopened.pricing!,
        acceptedAtMs: NOW_MS + 2_000,
        trustedPublicKeys: publicKeys(),
      })
    ).toBe("verified")
    expect(
      normalizeCommercePrice(10, "USD", reopened.pricing!.rate)
    ).toMatchObject({
      status: "ok",
      sats: 10_000,
    })
  })

  it("expires a genuine old snapshot for new admission without expiring its anchored prior acceptance", () => {
    const signed = attestation()
    const acceptedAtMs = NOW_MS + 2_000
    const trustedPublicKeys = publicKeys()
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: signed,
        pricing,
        acceptedAtMs,
        trustedPublicKeys,
        nowMs: NOW_MS + 600_000,
      })
    ).toBe("expired")
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: signed,
        pricing,
        acceptedAtMs,
        trustedPublicKeys,
      })
    ).toBe("verified")
  })

  it("keeps absent deployment trust configuration distinct from an unknown retired key", () => {
    const signed = attestation()
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: signed,
        pricing,
        acceptedAtMs: NOW_MS + 2_000,
        trustedPublicKeys: null,
      })
    ).toBe("unconfigured")
    const rotatedPublicKeys = parseCheckoutSparkPricingAuthorityPublicKeys(
      `rotated-rate:${getCheckoutSparkPricingAuthorityPublicKey(FIXTURE_SIGNING_KEY)}`
    )
    expect(
      verifyCheckoutSparkPricingRateAttestation({
        attestation: signed,
        pricing,
        acceptedAtMs: NOW_MS + 2_000,
        trustedPublicKeys: rotatedPublicKeys,
      })
    ).toBe("unknown_key")
  })
})
