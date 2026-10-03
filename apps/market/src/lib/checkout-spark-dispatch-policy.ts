import {
  checkoutSparkConduitFeeRecipient,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import { canUseCheckoutSparkLocalRouterCanary } from "./checkout-spark-local-router-canary"

/**
 * Saved plan policy cannot grant a local payment exception to a public build.
 * This admission check supplements, rather than replaces, canonical plan and
 * live payment authority validation at the shared execution boundary.
 */
export function assertMarketCheckoutSparkDispatchPlan(
  plan: Pick<CheckoutSparkSettledPlan, "network" | "recipients">,
  allowLocalCanary = canUseCheckoutSparkLocalRouterCanary()
): void {
  if (allowLocalCanary) return
  const conduit = plan.recipients.find(
    (recipient) => recipient.kind === "conduit"
  )
  const destination = conduit?.destination
  const recipient = checkoutSparkConduitFeeRecipient("production")
  if (
    plan.network !== "mainnet" ||
    destination?.source.type !== "conduit_allowlist" ||
    destination.source.policy !== "production" ||
    destination.value !== recipient ||
    conduit?.recipientId !== recipient
  ) {
    throw new Error(
      "Checkout Spark destination is unavailable in this deployment."
    )
  }
}
