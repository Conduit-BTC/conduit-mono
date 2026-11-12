import { config } from "@conduit/core/config"
import { fetchCommonPricingRateQuote } from "@conduit/core/pricing/common-rate-provider"
import { CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY } from "@conduit/core/protocol/checkout-spark-commerce-pricing"

/** Retained signed-v1 keys authorize recovery, never a new fiat invoice. */
export function assertCheckoutSparkNewFiatPricingPolicy(): void {
  if (
    config.checkoutSparkPricingPolicy !==
    CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY
  )
    throw new Error(
      "New currency checkout is unavailable. Refresh checkout before paying."
    )
}

/** Current public claims are verified against original invoice history later. */
export async function fetchCheckoutSparkNewFiatPricing(input: {
  currencies: readonly string[]
  shouldContinue: () => boolean
}) {
  const assertCurrent = () => {
    if (!input.shouldContinue())
      throw new Error("Buyer session changed while checking currency pricing.")
  }
  assertCurrent()
  assertCheckoutSparkNewFiatPricingPolicy()
  try {
    return await fetchCommonPricingRateQuote({
      requiredFiatCurrencies: input.currencies,
      includeFiatRates: true,
    })
  } finally {
    assertCurrent()
    assertCheckoutSparkNewFiatPricingPolicy()
  }
}
