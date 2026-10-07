import { schnorr } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { hexToBytes } from "@noble/hashes/utils.js"
import { z } from "zod"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  type BtcUsdRateQuote,
} from "../pricing"

export const CHECKOUT_SPARK_PRICING_AUTHORITY_DOMAIN =
  "conduit-checkout-spark-pricing-rate-v1"
export const CHECKOUT_SPARK_PRICING_AUTHORITY_PURPOSE =
  "checkout_spark_pricing_rate"

const keyIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)
const publicKeyPattern = /^[0-9a-f]{64}$/
const timestampSchema = z.number().int().safe().nonnegative()

/** A service-owned provider snapshot; browser environment overrides cannot qualify. */
export const checkoutSparkAuthorizedPricingRateSchema = z
  .object({
    rate: z.number().finite().positive(),
    fetchedAt: timestampSchema,
    source: z.enum(["mempool", "coinbase"]),
    fiatUsdRates: z
      .record(
        z
          .string()
          .refine((key) =>
            SUPPORTED_PRODUCT_PRICE_CURRENCIES.some(
              (currency) => currency !== "SATS" && currency === key
            )
          ),
        z.number().finite().positive()
      )
      .optional(),
    fiatSource: z
      .enum(["frankfurter", "exchange-rate-api", "mempool"])
      .optional(),
  })
  .strict()
  .refine(
    (rate) => !Object.keys(rate.fiatUsdRates ?? {}).length || !!rate.fiatSource,
    "Fiat conversion rates require their provider source."
  )

export const checkoutSparkPricingRateAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal(CHECKOUT_SPARK_PRICING_AUTHORITY_PURPOSE),
    keyId: keyIdSchema,
    issuedAtMs: timestampSchema,
    expiresAtMs: timestampSchema,
    rate: checkoutSparkAuthorizedPricingRateSchema,
    signature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict()
  .refine(
    (attestation) =>
      attestation.rate.fetchedAt <= attestation.issuedAtMs &&
      attestation.issuedAtMs < attestation.expiresAtMs &&
      attestation.expiresAtMs <=
        attestation.rate.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS,
    "Pricing authority must expire within the original rate freshness window."
  )

export type CheckoutSparkPricingRateAttestation = z.infer<
  typeof checkoutSparkPricingRateAttestationSchema
>

export type CheckoutSparkPricingRateAuthorization =
  "verified" | "invalid" | "expired" | "unknown_key" | "unconfigured"

export function checkoutSparkPricingRateDigestValue(
  rate: BtcUsdRateQuote
): unknown[] {
  return [
    rate.rate,
    rate.fetchedAt,
    rate.source,
    Object.entries(rate.fiatUsdRates ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    ),
    rate.fiatSource ?? null,
  ]
}

export function checkoutSparkPricingRateAttestationSigningValue(
  attestation: Omit<CheckoutSparkPricingRateAttestation, "signature">
): unknown[] {
  return [
    CHECKOUT_SPARK_PRICING_AUTHORITY_DOMAIN,
    attestation.schemaVersion,
    attestation.purpose,
    attestation.keyId,
    attestation.issuedAtMs,
    attestation.expiresAtMs,
    checkoutSparkPricingRateDigestValue(attestation.rate),
  ]
}

/** Include the signature as well as its canonical payload in the frozen plan digest. */
export function checkoutSparkPricingRateAttestationDigestValue(
  attestation: CheckoutSparkPricingRateAttestation
): unknown[] {
  return [
    ...checkoutSparkPricingRateAttestationSigningValue(attestation),
    attestation.signature,
  ]
}

export function freezeCheckoutSparkPricingRateAttestation(
  input: unknown
): CheckoutSparkPricingRateAttestation {
  const attestation = checkoutSparkPricingRateAttestationSchema.parse(input)
  if (attestation.rate.fiatUsdRates)
    Object.freeze(attestation.rate.fiatUsdRates)
  Object.freeze(attestation.rate)
  return Object.freeze(attestation)
}

/** A dedicated public trust ring, never an account or anonymous-zap signing key. */
export function parseCheckoutSparkPricingAuthorityPublicKeys(
  raw: string | undefined
): ReadonlyMap<string, string> | null {
  if (!raw || raw.length > 2_000) return null
  const entries = raw.split(",")
  if (entries.length > 16) return null
  const keys = new Map<string, string>()
  for (const entry of entries) {
    const parts = entry.trim().split(":")
    if (
      parts.length !== 2 ||
      !keyIdSchema.safeParse(parts[0]).success ||
      !publicKeyPattern.test(parts[1]) ||
      keys.has(parts[0])
    )
      return null
    keys.set(parts[0], parts[1])
  }
  return keys.size ? keys : null
}

/**
 * Verify against the original accepted plan time for recovery. Supply nowMs only
 * for a new admission; funded, immutable plans must not be expired or repriced.
 * Recovered acceptedAtMs must have an independent acceptance/funding anchor;
 * a buyer-provided plan timestamp alone does not establish rate acceptance.
 * This authenticates rates, not private order terms or the recipient payment.
 */
export function verifyCheckoutSparkPricingRateAttestation(input: {
  attestation: unknown
  pricing: { version: 1; rate: BtcUsdRateQuote }
  acceptedAtMs: number
  trustedPublicKeys: ReadonlyMap<string, string> | null | undefined
  nowMs?: number
}): CheckoutSparkPricingRateAuthorization {
  if (!input.trustedPublicKeys?.size) return "unconfigured"
  const parsed = checkoutSparkPricingRateAttestationSchema.safeParse(
    input.attestation
  )
  const pricing = checkoutSparkAuthorizedPricingRateSchema.safeParse(
    input.pricing.rate
  )
  if (
    !parsed.success ||
    !pricing.success ||
    input.pricing.version !== 1 ||
    !timestampSchema.safeParse(input.acceptedAtMs).success ||
    (input.nowMs !== undefined &&
      (!timestampSchema.safeParse(input.nowMs).success ||
        input.nowMs < input.acceptedAtMs))
  )
    return "invalid"
  const attestation = parsed.data
  const publicKey = input.trustedPublicKeys.get(attestation.keyId)
  if (!publicKey) return "unknown_key"
  if (
    !publicKeyPattern.test(publicKey) ||
    JSON.stringify(checkoutSparkPricingRateDigestValue(pricing.data)) !==
      JSON.stringify(checkoutSparkPricingRateDigestValue(attestation.rate)) ||
    input.acceptedAtMs < attestation.issuedAtMs
  )
    return "invalid"
  try {
    const message = sha256(
      new TextEncoder().encode(
        JSON.stringify(
          checkoutSparkPricingRateAttestationSigningValue(attestation)
        )
      )
    )
    if (
      !schnorr.verify(
        hexToBytes(attestation.signature),
        message,
        hexToBytes(publicKey)
      )
    )
      return "invalid"
  } catch {
    return "invalid"
  }
  if (
    input.acceptedAtMs >= attestation.expiresAtMs ||
    (input.nowMs !== undefined && input.nowMs >= attestation.expiresAtMs)
  )
    return "expired"
  return "verified"
}
