import type { OrderSchema } from "../schemas"
import {
  EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG,
  parseEventMarketAssignmentEvent,
} from "./event-market-assignment"

export type EventMarketOrderHandoffPolicy =
  | "not_organizer_handoff"
  | "legacy_merchant_release"
  | "reserved_organizer_stock"
  | "stock_reconciliation_required"

/**
 * Selects a UI workflow from the immutable signed order snapshot, never from
 * live listings or payment labels. It grants no payment or physical authority.
 * A reserved/malformed marker cannot fall back to the old live-Merchant release.
 */
export function classifyEventMarketOrderHandoff(
  order: Pick<OrderSchema, "items"> | null | undefined
): EventMarketOrderHandoffPolicy {
  const delegated =
    order?.items.filter(
      (item) =>
        item.fulfillment?.type === "event_market_pickup" &&
        item.fulfillment.mode === "organizer_handoff"
    ) ?? []
  if (!delegated.length) return "not_organizer_handoff"
  let committed = 0
  for (const item of delegated) {
    const pickup = item.fulfillment!
    if (pickup.type !== "event_market_pickup")
      return "stock_reconciliation_required"
    const snapshot = pickup.occurrenceAssignment
    if (!snapshot) continue
    const hasMarker = snapshot.signedEvent.tags.some(
      (tag) => tag[0] === EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG
    )
    if (!hasMarker) continue
    const assignment = parseEventMarketAssignmentEvent(snapshot.signedEvent)
    if (
      !assignment ||
      assignment.stockPool.state !== "valid" ||
      assignment.eventId !== snapshot.eventId ||
      assignment.coordinate !== snapshot.coordinate ||
      assignment.createdAt * 1_000 !== snapshot.createdAt ||
      assignment.marketCoordinate !== pickup.market.coordinate ||
      assignment.occurrenceCoordinate !== pickup.calendar.coordinate ||
      assignment.productCoordinate !== pickup.product.coordinate ||
      assignment.merchantPubkey !== pickup.merchantPubkey ||
      assignment.organizerPubkey !== pickup.organizerPubkey ||
      assignment.stockPool.pool.organizerPubkey !== pickup.organizerPubkey
    )
      return "stock_reconciliation_required"
    committed++
  }
  if (!committed) return "legacy_merchant_release"
  return committed === delegated.length
    ? "reserved_organizer_stock"
    : "stock_reconciliation_required"
}
