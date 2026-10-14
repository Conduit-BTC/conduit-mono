import { config } from "../config"
import { parseCheckoutSparkPricingAuthorityPublicKeys } from "./checkout-spark-pricing-authority"

export interface CheckoutSparkPricingConfiguration {
  readonly url: string
  readonly publicKeys: ReadonlyMap<string, string>
}

/** Public deployment configuration only; private signing material is server-only. */
export function parseCheckoutSparkPricingConfiguration(input: {
  url?: string
  publicKeys?: string
}): CheckoutSparkPricingConfiguration | null {
  if (!input.url || input.url.length > 2_048) return null
  const publicKeys = parseCheckoutSparkPricingAuthorityPublicKeys(
    input.publicKeys
  )
  if (!publicKeys) return null
  try {
    const url = new URL(input.url)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/checkout-spark-pricing"
    )
      return null
    return Object.freeze({ url: url.toString(), publicKeys })
  } catch {
    return null
  }
}

export function getCheckoutSparkPricingConfiguration(): CheckoutSparkPricingConfiguration | null {
  return parseCheckoutSparkPricingConfiguration({
    url: config.checkoutSparkPricingUrl ?? undefined,
    publicKeys: config.checkoutSparkPricingPublicKeys ?? undefined,
  })
}

/** Historical recovery needs retained public verification keys, not a live URL. */
export function getCheckoutSparkPricingAuthorityTrust(): ReadonlyMap<
  string,
  string
> | null {
  return parseCheckoutSparkPricingAuthorityPublicKeys(
    config.checkoutSparkPricingPublicKeys ?? undefined
  )
}
