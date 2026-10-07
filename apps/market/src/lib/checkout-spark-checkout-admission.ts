import type { PreparedProductFulfillment } from "@conduit/core"
import type { CartItem } from "./cart-model"
import { isCheckoutSparkSettledCart } from "./checkout-spark-settled-cart"

export type CheckoutSparkCheckoutAdmission =
  | { mode: "disabled" | "free" | "order_first" }
  | { mode: "router"; ready: boolean }

/** Presentation policy only; submit-time signed evidence remains authoritative. */
export function assessCheckoutSparkCheckoutAdmission(input: {
  enabled: boolean
  freeOrderVerified: boolean
  items: readonly CartItem[]
  fulfillment: ReadonlyMap<string, PreparedProductFulfillment>
}): CheckoutSparkCheckoutAdmission {
  if (!input.enabled || input.items.length === 0) return { mode: "disabled" }
  if (input.freeOrderVerified) return { mode: "free" }
  // A missing/unsupported quote is not permission to bypass routing. Only a
  // positively resolved negotiated shipment has no upfront amount to route.
  const requiresNegotiation = input.items.some((item) => {
    if (
      item.format === "digital" ||
      item.fulfillment?.type === "event_market_pickup"
    )
      return false
    const fulfillment = input.fulfillment.get(item.productId)
    return (
      fulfillment?.intent === "coordinate_after_order" &&
      fulfillment.status === "ready"
    )
  })
  if (requiresNegotiation) return { mode: "order_first" }
  return { mode: "router", ready: isCheckoutSparkSettledCart(input.items) }
}
