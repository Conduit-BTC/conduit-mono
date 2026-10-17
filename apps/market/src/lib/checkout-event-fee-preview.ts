import {
  assertCurrentEventMarketOrganizerFeeTerms,
  calculateEventMarketOrganizerFeeSats,
  parseEventMarketOrganizerFeeTerms,
  type EventMarketOrganizerFeeTerms,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

export type CheckoutEventFeePreview =
  | { status: "not_event" }
  | { status: "unavailable" }
  | {
      status: "ready"
      organizerFeeSats: number
      terms: EventMarketOrganizerFeeTerms
    }

/** Signed estimate only. Submit-time graph admission and final approval remain independent. */
export function getCheckoutEventFeePreview(
  items: readonly Pick<CartItem, "merchantPubkey" | "fulfillment">[],
  commerceTotalSats: number,
  nowMs: number
): CheckoutEventFeePreview {
  const events = items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  if (events.length === 0) return { status: "not_event" }
  if (events.length !== items.length) return { status: "unavailable" }
  try {
    const first = events[0]!.fulfillment
    if (
      first?.type !== "event_market_pickup" ||
      events.some(
        (item) =>
          item.merchantPubkey !== events[0]!.merchantPubkey ||
          item.fulfillment?.type !== "event_market_pickup" ||
          item.fulfillment.market.eventId !== first.market.eventId ||
          item.fulfillment.market.coordinate !== first.market.coordinate ||
          item.fulfillment.calendar.eventId !== first.calendar.eventId
      )
    )
      return { status: "unavailable" }
    const terms = assertCurrentEventMarketOrganizerFeeTerms(
      parseEventMarketOrganizerFeeTerms({
        marketCoordinate: first.market.coordinate,
        event: first.market.signedEvent,
      }),
      nowMs
    )
    const organizerFeeSats =
      terms.state === "active"
        ? calculateEventMarketOrganizerFeeSats({
            commerceTotalSats,
            basisPoints: terms.basisPoints,
            minimumSats: terms.minimumSats,
          })
        : 0
    return { status: "ready", terms, organizerFeeSats }
  } catch {
    return { status: "unavailable" }
  }
}
