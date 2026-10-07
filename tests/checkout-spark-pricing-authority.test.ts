import { describe, expect, it } from "bun:test"
import { generateSecretKey } from "nostr-tools/pure"
import { normalizeCommercePrice } from "@conduit/core/pricing"
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
