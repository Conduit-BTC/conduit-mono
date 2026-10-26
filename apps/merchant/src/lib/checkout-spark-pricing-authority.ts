import {
  assessCheckoutSparkCommercePricingAuthority,
  getCheckoutSparkRequiredFiatCurrencies,
} from "@conduit/core/protocol/checkout-spark-commerce-pricing-authority"
import { getCheckoutSparkPricingAuthorityTrust } from "@conduit/core/protocol/checkout-spark-pricing-config"
import {
  getSparkCheckoutReceiveFundingTimeAnchor,
  type SparkCheckoutReceiveCreditProof,
} from "@conduit/core/protocol/checkout-spark-receive-credit"
import type { CheckoutSparkSettledPlan } from "@conduit/core/protocol/checkout-spark-settled-router"

/**
 * A provider-confirmed exact receive anchors the original frozen fiat quote.
 * Never use the recovery clock or unanchored buyer plan creation time here.
 */
export function assertCheckoutSparkMerchantPricingAuthority(input: {
  plan: CheckoutSparkSettledPlan
  fundingProof: SparkCheckoutReceiveCreditProof
  trustedPublicKeys?: ReadonlyMap<string, string> | null
}): void {
  if (!getCheckoutSparkRequiredFiatCurrencies(input.plan.commerceQuote).length)
    return
  const anchor = getSparkCheckoutReceiveFundingTimeAnchor(input.fundingProof)
  const receive = input.plan.funding
  if (
    !anchor ||
    anchor.requestId !== receive.requestId ||
    input.fundingProof.requestId !== receive.requestId ||
    input.fundingProof.grossSats !== receive.grossFundingSats ||
    input.fundingProof.receiverIdentityPublicKey !==
      receive.receiverIdentityPublicKey ||
    anchor.invoiceCreatedAtMs !== input.plan.createdAt ||
    anchor.invoiceCreatedAtMs !== receive.createdAt ||
    anchor.invoiceExpiresAtMs !== receive.expiresAt
  )
    throw new Error(
      "Original currency pricing could not be verified. Payment remains paused."
    )
  const trustedPublicKeys =
    input.trustedPublicKeys === undefined
      ? getCheckoutSparkPricingAuthorityTrust()
      : input.trustedPublicKeys
  if (
    assessCheckoutSparkCommercePricingAuthority({
      quote: input.plan.commerceQuote,
      acceptedAtMs: anchor.createdAtMs,
      trustedPublicKeys,
    }) !== "verified"
  )
    throw new Error(
      "Original currency pricing could not be verified. Payment remains paused."
    )
}
