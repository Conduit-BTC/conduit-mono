import {
  handleCheckoutSparkPricingAuthorityRequest,
  type CheckoutSparkPricingAuthorityEnv,
} from "./checkout-pricing-authority"

/** Only the preview Wrangler environment selects this entry point. */
export default {
  fetch(
    request: Request,
    env: CheckoutSparkPricingAuthorityEnv,
    execution: { waitUntil(promise: Promise<unknown>): void }
  ) {
    return handleCheckoutSparkPricingAuthorityRequest(
      request,
      env,
      {},
      execution,
      { allowPagesPreviewOrigins: true }
    )
  },
}
