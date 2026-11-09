import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

export type CheckoutSparkPricingPolicy =
  "signed-v1" | "invoice-historical-1pct-v1"

/** Historical pricing requires an explicit rollout choice, never a missing URL. */
export function resolveCheckoutSparkPricingPolicy(
  value: unknown
): CheckoutSparkPricingPolicy {
  return value === "invoice-historical-1pct-v1" ? value : "signed-v1"
}

export interface CheckoutSparkPublicTrustConfiguration {
  readonly receiverContracts: string
  readonly pricingUrl: string
  /** Includes retained historical verification keys, not only a live key. */
  readonly pricingPublicKeys: string
  readonly pricingPolicy?: string
}

export interface ResolvedCheckoutSparkPublicTrustConfiguration extends CheckoutSparkPublicTrustConfiguration {
  readonly pricingPolicy: CheckoutSparkPricingPolicy
}

const EMPTY_TRUST: ResolvedCheckoutSparkPublicTrustConfiguration =
  Object.freeze({
    receiverContracts: "",
    pricingUrl: "",
    pricingPublicKeys: "",
    pricingPolicy: "signed-v1",
  })

export function checkoutSparkPublicTrustDigest(
  trust: CheckoutSparkPublicTrustConfiguration
): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit-checkout-spark-public-trust-v1",
          trust.receiverContracts.trim(),
          trust.pricingUrl.trim(),
          trust.pricingPublicKeys.trim(),
          // Keep historical signed-v1 digests byte-identical.
          ...(resolveCheckoutSparkPricingPolicy(trust.pricingPolicy) ===
          "signed-v1"
            ? []
            : [["pricing_policy", "invoice-historical-1pct-v1"]]),
        ])
      )
    )
  )
}

/**
 * Managed builds must commit their actual runtime trust settings to the
 * reviewed deployment policy. This guard also covers an explicitly inactive
 * policy; a digest in a manifest alone cannot authenticate ambient settings.
 * Local builds retain their explicit environment/dotenv behavior.
 */
export function resolveCheckoutSparkPublicTrust(input: {
  deploymentProfile: string
  compiledDigest: string
  configuration: CheckoutSparkPublicTrustConfiguration
}): ResolvedCheckoutSparkPublicTrustConfiguration {
  const configuration = Object.freeze({
    receiverContracts: input.configuration.receiverContracts.trim(),
    pricingUrl: input.configuration.pricingUrl.trim(),
    pricingPublicKeys: input.configuration.pricingPublicKeys.trim(),
    pricingPolicy: resolveCheckoutSparkPricingPolicy(
      input.configuration.pricingPolicy
    ),
  })
  if (!input.deploymentProfile || input.deploymentProfile === "local")
    return configuration
  if (
    !["preview", "production", "staging"].includes(input.deploymentProfile) ||
    !/^[0-9a-f]{64}$/.test(input.compiledDigest) ||
    checkoutSparkPublicTrustDigest(configuration) !== input.compiledDigest
  )
    return EMPTY_TRUST
  return configuration
}
