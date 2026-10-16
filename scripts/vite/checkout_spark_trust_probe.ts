import { config } from "../../packages/core/src/config"
import {
  getCheckoutSparkPricingAuthorityTrust,
  getCheckoutSparkPricingConfiguration,
} from "../../packages/core/src/protocol/checkout-spark-pricing-config"

/** Public deployment settings only; never opens a wallet or contacts a service. */
export function readCompiledCheckoutSparkPublicTrust(): {
  receiverContracts: string
  pricingUrl: string
  pricingPublicKeys: string
} {
  const keys = getCheckoutSparkPricingAuthorityTrust()
  return {
    receiverContracts: config.checkoutSparkReceiverContracts ?? "",
    pricingUrl: getCheckoutSparkPricingConfiguration()?.url ?? "",
    pricingPublicKeys: keys
      ? [...keys]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([keyId, publicKey]) => `${keyId}:${publicKey}`)
          .join(",")
      : "",
  }
}
