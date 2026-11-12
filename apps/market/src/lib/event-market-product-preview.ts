import type {
  EventMarketProductReadResult,
  EventMarketRosterReadResult,
} from "@conduit/core"
import type { PickupHandoffSummary } from "./pickup-handoff"

/** Display terms cannot be stored as an order pickup snapshot. */
export function getEventMarketProductPreview(input: {
  marketRead: EventMarketRosterReadResult
  productRead: EventMarketProductReadResult
  selectedOccurrenceCoordinate?: string
}) {
  const market = input.marketRead.resolution
  const product = input.productRead.resolution
  const schedule = input.marketRead.schedule
  const calendar =
    schedule?.kind === "series"
      ? schedule.occurrences.find(
          (entry) =>
            entry.occurrence.coordinate === input.selectedOccurrenceCoordinate
        )?.occurrence
      : input.marketRead.calendar
  const authorization = input.productRead.authorization?.resolution
  if (
    market.state !== "current" ||
    market.market.state !== "open" ||
    product.state !== "eligible" ||
    authorization?.state !== "active" ||
    !calendar ||
    !calendar.signedEvent ||
    calendar.coordinate !== input.selectedOccurrenceCoordinate ||
    calendar.end <= Date.now() ||
    product.assignment.occurrenceCoordinate !== calendar.coordinate
  )
    return null

  const organizerHandoff = product.merchant.mode === "organizer_handoff"
  const handoff: PickupHandoffSummary = {
    mode: organizerHandoff ? "organizer_handoff" : "merchant_handoff",
    handlerPubkey: organizerHandoff
      ? market.market.organizerPubkey
      : product.merchant.pubkey,
    label: organizerHandoff
      ? "Pickup from event organizer"
      : "Pickup from merchant booth",
  }
  return {
    marketCoordinate: market.market.coordinate,
    occurrenceCoordinate: calendar.coordinate,
    productEventId: product.revision.id,
    mode: product.merchant.mode,
    assignment: product.merchant.assignment,
    handoff,
    // Compare the terms the shopper saw to a fresh authority read before the
    // existing snapshot gate. Scope and coverage never become authorization.
    termsKey: JSON.stringify([
      market.market.coordinate,
      market.market.organizerPubkey,
      product.merchant.pubkey,
      product.merchant.mode,
      product.merchant.assignment,
      authorization.tip.eventId,
      (input.productRead.authorization?.observedEvidence ?? [])
        .filter((event) => event.kind === 5)
        .map((event) => event.id)
        .sort(),
      calendar.coordinate,
      calendar.start,
      calendar.end,
      calendar.signedEvent.tags
        .filter((tag) =>
          ["location", "g", "start_tzid", "end_tzid"].includes(tag[0] ?? "")
        )
        .map((tag) => tag.slice(0, 2))
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
      schedule?.kind === "series" ? schedule.coordinate : null,
      schedule?.kind === "series"
        ? schedule.series.signedEvent.tags.some(
            (tag) => tag[0] === "a" && tag[1] === calendar.coordinate
          )
        : null,
      product.product.id,
      product.revision.id,
      product.product.price,
    ]),
  }
}
