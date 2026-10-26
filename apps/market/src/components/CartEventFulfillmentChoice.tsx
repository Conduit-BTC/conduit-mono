import type { CartItem } from "../lib/cart-model"

/** Display saved fulfillment without rewriting older shipping carts. */
export function CartEventFulfillmentChoice({
  item,
}: {
  item: CartItem
  authenticatedPubkey: string | null
  disabled?: boolean
  shouldContinue?: () => boolean
}) {
  if (
    !item.eventMarketContext &&
    item.fulfillment?.type !== "event_market_pickup"
  )
    return null
  return (
    <p className="mt-3 text-sm text-[var(--text-secondary)]">
      {item.fulfillment?.type === "event_market_pickup"
        ? "Take it at the event"
        : "Shipping · saved selection"}
    </p>
  )
}
