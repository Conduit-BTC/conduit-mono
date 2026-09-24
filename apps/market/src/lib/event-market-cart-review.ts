import type { OrderEventMarketPickupFulfillmentSchema } from "@conduit/core"

/** Compare accepted unpaid-cart terms with freshly resolved signed terms. */
export function getEventMarketCartReviewReasons(input: {
  saved: OrderEventMarketPickupFulfillmentSchema
  current: OrderEventMarketPickupFulfillmentSchema
  savedPrice: number
  currentPrice: number
}): string[] {
  const { saved, current } = input
  const reasons: string[] = []
  if (
    saved.market.coordinate !== current.market.coordinate ||
    saved.merchantPubkey !== current.merchantPubkey
  ) {
    reasons.push("Event Market participation changed")
  }
  if (saved.mode !== current.mode) reasons.push("Pickup handler changed")
  if (saved.assignment !== current.assignment)
    reasons.push("Pickup assignment changed")
  if (
    saved.calendar.coordinate !== current.calendar.coordinate ||
    saved.calendar.start !== current.calendar.start ||
    saved.calendar.end !== current.calendar.end
  ) {
    reasons.push("Event schedule changed")
  }
  if (
    saved.product.coordinate !== current.product.coordinate ||
    saved.product.eventId !== current.product.eventId
  ) {
    reasons.push("Product changed")
  }
  if (saved.payeePubkey !== current.payeePubkey) reasons.push("Payee changed")
  if (input.savedPrice !== input.currentPrice) reasons.push("Price changed")
  return reasons
}
