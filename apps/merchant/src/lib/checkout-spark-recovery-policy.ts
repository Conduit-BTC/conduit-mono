import {
  checkoutSparkConduitFeeRecipient,
  assertCheckoutSparkTreasuryAddressAllowed,
  isCheckoutSparkNativeTreasuryPlan,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import { isLocalCheckoutSparkRecoveryRehearsal } from "./checkout-spark-settled-recovery"

/** Experimental receiving-provider lookup is separate from public routing. */
export function canUseMerchantCheckoutSparkRecipientCompatibility(): boolean {
  return isLocalCheckoutSparkRecoveryRehearsal({
    dev: import.meta.env?.DEV === true,
    deploymentProfile: import.meta.env?.VITE_DEPLOYMENT_PROFILE ?? "unknown",
    rehearsalFlag: import.meta.env?.VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL,
    routerCanaryFlag: import.meta.env?.VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY,
    hostname:
      typeof window === "undefined" ? undefined : window.location.hostname,
  })
}

/**
 * Recovery send authority cannot come from the sender's chosen canary policy.
 * Historical canary records remain readable; only an explicit local rehearsal
 * may prepare or dispatch their payouts. Hosted recovery uses the fixed public
 * destination and never rewrites an old plan to make it executable.
 *
 * This supplements full plan validation; it does not replace it. Send adapters
 * pass the canonical immutable plan from the strict private recovery callback,
 * and domain state restoration still validates its invoices and bindings.
 */
export function assertMerchantCheckoutSparkDispatchPlan(
  plan: CheckoutSparkSettledPlan,
  allowLocalCanary = canUseMerchantCheckoutSparkRecipientCompatibility()
): void {
  if (isCheckoutSparkNativeTreasuryPlan(plan)) {
    if (!plan.nativeTreasury)
      throw new Error("Checkout Spark native treasury is unavailable.")
    assertCheckoutSparkTreasuryAddressAllowed(
      plan.network,
      plan.nativeTreasury.sparkAddress
    )
  }
  assertCheckoutSparkRecoveryDestination(plan, allowLocalCanary)
}

/** Shared financial policy; this never grants stock-writer or handout authority. */
export function assertCheckoutSparkRecoveryDestination(
  plan: CheckoutSparkSettledPlan,
  allowLocalCanary = canUseMerchantCheckoutSparkRecipientCompatibility()
): void {
  const conduit = plan.recipients.find(
    (recipient) => recipient.kind === "conduit"
  )
  const source = conduit?.destination.source
  if (
    !conduit ||
    source?.type !== "conduit_allowlist" ||
    (source.policy !== "production" &&
      source.policy !== "local_router_canary") ||
    conduit.destination.value !==
      checkoutSparkConduitFeeRecipient(source.policy) ||
    conduit.recipientId !== checkoutSparkConduitFeeRecipient(source.policy) ||
    (!allowLocalCanary &&
      (plan.network !== "mainnet" || source.policy !== "production"))
  ) {
    throw new Error(
      "Checkout Spark recovery destination is unavailable in this deployment."
    )
  }
}
