import type { ConduitDB } from "../db"
import { orderSchema } from "../schemas"
import { openMarketsLocalOrderId } from "./open-markets-orders"
import { hasCompleteOrderTerms, type ParsedOrderMessage } from "./orders"

export const LEGACY_ORDER_STOCK_REVIEW_MESSAGE =
  "Older stock history uses this order number without identifying its buyer. Review saved stock updates before changing stock or accepting this order."

/** An authenticated original locates old history; it does not prove who owns it.
 * Old manual stock checkpoints never recorded the buyer or original terms. */
export function getLegacyNumericStockOrderId(
  merchantPubkey: string,
  original?: Extract<ParsedOrderMessage, { type: "order" }>
): string | null {
  if (
    original?.wireFormat !== "open_markets" ||
    !hasCompleteOrderTerms(original)
  )
    return null
  const order = orderSchema.parse(original.payload)
  const raw = original.wireOrderId
  if (
    !raw ||
    original.recipientPubkey !== merchantPubkey ||
    order.merchantPubkey !== merchantPubkey ||
    original.senderPubkey !== order.buyerPubkey ||
    original.orderId !== order.id ||
    openMarketsLocalOrderId(raw, order.buyerPubkey, merchantPubkey) !== order.id
  )
    throw new Error("Stock history does not match its authenticated original.")
  // Current rich v2 workflows intentionally commit stock under the raw ID;
  // their existing authenticated acceptance/recovery boundary remains in charge.
  if (
    original.commerceExtensionVersion === 2 &&
    (original.checkoutPaymentRoute === "spark_router_v1" ||
      order.items.some(
        (item) => item.fulfillment?.type === "event_market_pickup"
      ))
  )
    return null
  return raw === order.id ? null : raw
}

/** Refusal only: raw history cannot grant credit to a participant-scoped order. */
export async function assertNoUnboundLegacyStockHistory(
  database: ConduitDB,
  merchantPubkey: string,
  orderId: string,
  legacyOrderId?: string | null
): Promise<void> {
  if (!legacyOrderId || legacyOrderId === orderId) return
  if (
    await database.localProductStockCheckpoints
      .where("orderId")
      .equals(legacyOrderId)
      .filter((row) => row.merchantPubkey === merchantPubkey)
      .count()
  )
    throw new Error(LEGACY_ORDER_STOCK_REVIEW_MESSAGE)
}
