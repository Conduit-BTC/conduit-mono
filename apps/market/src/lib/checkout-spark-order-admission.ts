import type { OrderLifecycle } from "@conduit/core"

type RouterOrderBinding = Pick<OrderLifecycle, "checkoutSparkRouterBinding">

/** A routed order can only resume against its exact Spark plan, never a new merchant invoice. */
export function assertLegacyOrderPaymentAllowed(
  lifecycle: RouterOrderBinding | null | undefined
): void {
  if (lifecycle?.checkoutSparkRouterBinding !== undefined) {
    throw new Error(
      "This order uses Spark routing. Resume its saved checkout instead of paying the merchant directly."
    )
  }
}
