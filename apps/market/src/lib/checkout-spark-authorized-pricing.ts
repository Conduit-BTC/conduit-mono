import {
  CheckoutSparkAuthorizedPricingUnavailable,
  fetchCheckoutSparkPricingRate,
  type CheckoutSparkAuthorizedPricing,
} from "@conduit/core/pricing/signed-rate-client"
import type { CheckoutSparkPricingConfiguration } from "@conduit/core/protocol/checkout-spark-pricing-config"

export {
  CheckoutSparkAuthorizedPricingUnavailable,
  type CheckoutSparkAuthorizedPricing,
}

/** Shared public feed/cache; session cancellation never authorizes a checkout. */
export async function fetchCheckoutSparkAuthorizedPricing(input: {
  currencies: readonly string[]
  shouldContinue: () => boolean
  nowMs?: () => number
  configuration?: CheckoutSparkPricingConfiguration | null
  fetchImpl?: typeof fetch
}): Promise<CheckoutSparkAuthorizedPricing> {
  const assertCurrent = () => {
    if (!input.shouldContinue())
      throw new CheckoutSparkAuthorizedPricingUnavailable("session_changed")
  }
  assertCurrent()
  try {
    const pricing = await fetchCheckoutSparkPricingRate(input)
    assertCurrent()
    return pricing
  } catch (error) {
    assertCurrent()
    throw error
  }
}
