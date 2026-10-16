import type { CheckoutSparkCommerceQuote } from "@conduit/core/protocol/checkout-spark-reconciliation"
import {
  assessCheckoutSparkCommercePricingAuthority,
  getCheckoutSparkRequiredFiatCurrencies,
} from "@conduit/core/protocol/checkout-spark-commerce-pricing-authority"
import { getCheckoutSparkPricingAuthorityTrust } from "@conduit/core/protocol/checkout-spark-pricing-config"
import { decodeLightningInvoiceMetadata } from "@conduit/core/protocol/lightning"
import type { SparkCheckoutReceiveRequest } from "./spark-wallet"

/**
 * Called on a fresh SDK-created receive, before its funding invoice is shown.
 * RAM-only provider precision is not restored from saved checkout state. Once
 * accepted, historical recovery verifies its original time, not the current rate.
 */
export function assertCheckoutSparkPrefundingPricingAuthority(input: {
  quote: CheckoutSparkCommerceQuote
  receive: SparkCheckoutReceiveRequest
  nowMs?: number
  trustedPublicKeys?: ReadonlyMap<string, string> | null
}): void {
  if (!getCheckoutSparkRequiredFiatCurrencies(input.quote).length) return
  const receive = input.receive
  const createdAtMs = receive.providerCreatedAtMs
  const expiresAtMs = receive.providerExpiresAtMs
  const metadata = decodeLightningInvoiceMetadata(receive.paymentRequest)
  if (
    createdAtMs === undefined ||
    expiresAtMs === undefined ||
    !Number.isSafeInteger(createdAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    createdAtMs < 0 ||
    expiresAtMs <= createdAtMs ||
    Math.floor(createdAtMs / 1_000) * 1_000 !== receive.createdAt ||
    Math.floor(expiresAtMs / 1_000) * 1_000 !== receive.expiresAt ||
    metadata.createdAt === null ||
    metadata.expiresAt === null ||
    metadata.createdAt * 1_000 !== receive.createdAt ||
    metadata.expiresAt * 1_000 !== receive.expiresAt
  )
    throw new Error(
      "Current currency pricing could not be confirmed. Try again before paying."
    )
  const trustedPublicKeys =
    input.trustedPublicKeys === undefined
      ? getCheckoutSparkPricingAuthorityTrust()
      : input.trustedPublicKeys
  if (
    assessCheckoutSparkCommercePricingAuthority({
      quote: input.quote,
      acceptedAtMs: createdAtMs,
      nowMs: input.nowMs ?? Date.now(),
      trustedPublicKeys,
    }) !== "verified"
  )
    throw new Error(
      "Current currency pricing could not be confirmed. Try again before paying."
    )
}
