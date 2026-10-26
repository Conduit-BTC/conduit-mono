import { schnorr } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  type BtcUsdRateQuote,
} from "../pricing"
import {
  CHECKOUT_SPARK_PRICING_AUTHORITY_PURPOSE,
  checkoutSparkPricingRateAttestationSigningValue,
  freezeCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAttestation,
} from "./checkout-spark-pricing-authority"

/** Server-only signing helper; do not export this from the browser core barrel. */
export function getCheckoutSparkPricingAuthorityPublicKey(
  privateKeyHex: string
): string | null {
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) return null
  try {
    return bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)))
  } catch {
    return null
  }
}

export function createCheckoutSparkPricingRateAttestation(input: {
  rate: BtcUsdRateQuote
  keyId: string
  privateKeyHex: string
  issuedAtMs: number
}): CheckoutSparkPricingRateAttestation {
  if (!getCheckoutSparkPricingAuthorityPublicKey(input.privateKeyHex))
    throw new Error("Checkout pricing authority signing is unavailable.")
  const candidate = freezeCheckoutSparkPricingRateAttestation({
    schemaVersion: 1,
    purpose: CHECKOUT_SPARK_PRICING_AUTHORITY_PURPOSE,
    keyId: input.keyId,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.rate.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS,
    rate: input.rate,
    signature: "0".repeat(128),
  })
  const message = sha256(
    new TextEncoder().encode(
      JSON.stringify(checkoutSparkPricingRateAttestationSigningValue(candidate))
    )
  )
  const signature = bytesToHex(
    schnorr.sign(message, hexToBytes(input.privateKeyHex))
  )
  return freezeCheckoutSparkPricingRateAttestation({ ...candidate, signature })
}
