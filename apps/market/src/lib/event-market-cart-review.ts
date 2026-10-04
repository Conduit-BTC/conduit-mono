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
    saved.organizerPubkey !== current.organizerPubkey ||
    saved.merchantPubkey !== current.merchantPubkey
  ) {
    reasons.push("Event Market participation changed")
  }
  if (saved.mode !== current.mode) reasons.push("Pickup handler changed")
  if (saved.assignment !== current.assignment)
    reasons.push("Pickup assignment changed")
  if (
    saved.grant.eventId !== current.grant.eventId ||
    saved.grant.signedEvidence.deletions
      .map((event) => event.id)
      .sort()
      .join(",") !==
      current.grant.signedEvidence.deletions
        .map((event) => event.id)
        .sort()
        .join(",")
  ) {
    reasons.push("Merchant authorization changed")
  }
  const calendarPickupTerms = (
    snapshot: OrderEventMarketPickupFulfillmentSchema
  ): string =>
    JSON.stringify(
      snapshot.calendar.signedEvent.tags
        .filter((tag) =>
          ["location", "g", "start_tzid", "end_tzid"].includes(tag[0] ?? "")
        )
        .map((tag) => tag.slice(0, 2))
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        )
    )
  if (
    saved.calendar.coordinate !== current.calendar.coordinate ||
    saved.calendar.start !== current.calendar.start ||
    saved.calendar.end !== current.calendar.end ||
    calendarPickupTerms(saved) !== calendarPickupTerms(current)
  ) {
    reasons.push("Event schedule changed")
  }
  const selectedMembership = (
    snapshot: OrderEventMarketPickupFulfillmentSchema
  ): boolean | undefined =>
    snapshot.schedule
      ? snapshot.schedule.signedEvent.tags.some(
          (tag) => tag[0] === "a" && tag[1] === snapshot.calendar.coordinate
        )
      : undefined
  if (
    saved.schedule?.coordinate !== current.schedule?.coordinate ||
    selectedMembership(saved) !== selectedMembership(current)
  ) {
    reasons.push("Event schedule membership changed")
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
