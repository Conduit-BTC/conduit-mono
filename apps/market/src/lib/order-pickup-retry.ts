import {
  admitEmbeddedEventMarketOrderEvidence,
  verifyEventMarketOrderEvidence,
  type OrderSchema,
} from "@conduit/core"

/** Verify retained physical purchase terms without reopening roster admission. */
export async function assertCreatedEventMarketPickupTerms(
  order: Pick<
    OrderSchema,
    | "id"
    | "merchantPubkey"
    | "buyerPubkey"
    | "items"
    | "subtotal"
    | "currency"
    | "createdAt"
    | "shippingCostSats"
  >
): Promise<void> {
  if (
    !order.items.some(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )
  )
    return
  const embedded = await admitEmbeddedEventMarketOrderEvidence(order)
  const evidence = verifyEventMarketOrderEvidence({ order, events: embedded })
  if (evidence.status !== "verified")
    throw new Error(
      "The created order’s exact signed Event Market terms could not be verified. Refresh the order before retrying payment."
    )
}
