import {
  orderSchema,
  type OrderEventMarketPickupFulfillmentSchema,
  type OrderSchema,
} from "../schemas"
import { parseEventMarketCalendarEvent } from "./event-market"
import { resolveEventMarketAuthorization } from "./event-market-authorization"
import { parseEventMarketRosterEvent } from "./event-market-roster"
import { parseProductEvent } from "./products"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { normalizeCurrencyIdentity } from "../pricing"

export type EventMarketOrderEvidenceResult =
  | {
      status: "verified"
      marketCoordinate: string
      organizerPubkey: string
      mode: "merchant_present" | "organizer_handoff"
      assignment: string
    }
  | {
      status: "invalid"
      reason:
        | "order"
        | "missing_evidence"
        | "market"
        | "calendar"
        | "grant"
        | "product"
        | "terms"
    }

/** Exact original evidence authorizes only this already-created order's physical terms. */
export function verifyEventMarketOrderEvidence(input: {
  order: OrderSchema
  events: readonly SignedPublicNostrEvent[]
}): EventMarketOrderEvidenceResult {
  const parsed = orderSchema.safeParse(input.order)
  if (!parsed.success) return { status: "invalid", reason: "order" }
  const order = parsed.data
  const future = order.items.filter(
    (
      item
    ): item is typeof item & {
      fulfillment: OrderEventMarketPickupFulfillmentSchema
    } => item.fulfillment?.type === "event_market_pickup"
  )
  if (
    future.length === 0 ||
    future.length !== order.items.length ||
    future.some(
      (item) =>
        item.fulfillment.merchantPubkey !== order.merchantPubkey ||
        item.fulfillment.payeePubkey !== order.merchantPubkey
    )
  )
    return { status: "invalid", reason: "order" }
  const first = future[0]!.fulfillment
  if (
    future.some(
      (item) =>
        item.fulfillment.market.coordinate !== first.market.coordinate ||
        item.fulfillment.market.eventId !== first.market.eventId ||
        item.fulfillment.calendar.eventId !== first.calendar.eventId ||
        item.fulfillment.grant.eventId !== first.grant.eventId ||
        item.fulfillment.mode !== first.mode ||
        item.fulfillment.assignment !== first.assignment
    )
  )
    return { status: "invalid", reason: "terms" }
  const ids = new Set<string>([
    first.market.eventId,
    first.calendar.eventId,
    ...first.grant.ancestryEventIds,
    ...first.grant.observedDeletionEventIds,
    ...future.map((item) => item.fulfillment.product.eventId),
  ])
  const embeddedGrantEvidence = [
    first.grant.signedEvidence.tip,
    ...first.grant.signedEvidence.ancestry,
    ...first.grant.signedEvidence.deletions,
  ]
  const byId = new Map(
    [...embeddedGrantEvidence, ...input.events]
      .filter(
        (event) => ids.has(event.id) && isValidSignedPublicNostrEvent(event)
      )
      .map((event) => [event.id, event])
  )
  if ([...ids].some((id) => !byId.has(id)))
    return { status: "invalid", reason: "missing_evidence" }
  if (
    [...byId.values()].some(
      (event) => event.created_at * 1_000 > order.createdAt
    )
  )
    return { status: "invalid", reason: "terms" }
  const marketEvent = byId.get(first.market.eventId)!
  const market = parseEventMarketRosterEvent(marketEvent)
  if (
    !market ||
    market.coordinate !== first.market.coordinate ||
    market.createdAt * 1_000 !== first.market.createdAt ||
    market.organizerPubkey !== first.organizerPubkey ||
    market.state !== "open"
  )
    return { status: "invalid", reason: "market" }
  const calendar = parseEventMarketCalendarEvent(
    byId.get(first.calendar.eventId)!
  )
  if (
    !calendar ||
    calendar.coordinate !== first.calendar.coordinate ||
    calendar.createdAt !== first.calendar.createdAt ||
    calendar.coordinate !== market.calendarCoordinate ||
    calendar.start !== first.calendar.start ||
    calendar.end !== first.calendar.end
  )
    return { status: "invalid", reason: "calendar" }
  const row = market.merchants.find(
    (candidate) => candidate.pubkey === order.merchantPubkey
  )
  if (!row || row.mode !== first.mode || row.assignment !== first.assignment)
    return { status: "invalid", reason: "terms" }
  const authorization = resolveEventMarketAuthorization({
    marketCoordinate: first.market.coordinate,
    merchantPubkey: order.merchantPubkey,
    transitions: first.grant.ancestryEventIds.map((id) => byId.get(id)!),
    deletions: first.grant.observedDeletionEventIds.map((id) => byId.get(id)!),
  })
  if (
    authorization.state !== "active" ||
    authorization.tip.eventId !== first.grant.eventId ||
    authorization.tip.signedEvent.created_at * 1_000 !==
      first.grant.createdAt ||
    first.grant.pubkey !== first.organizerPubkey ||
    authorization.ancestry.length !== new Set(first.grant.ancestryEventIds).size
  )
    return { status: "invalid", reason: "grant" }
  for (const item of future) {
    const evidence = item.fulfillment.product
    const signed = byId.get(evidence.eventId)!
    if (
      signed.kind !== 30402 ||
      signed.pubkey !== order.merchantPubkey ||
      signed.created_at * 1_000 !== evidence.createdAt ||
      !signed.tags.some((tag) => tag[0] === "a" && tag[1] === market.coordinate)
    )
      return { status: "invalid", reason: "product" }
    let product: ReturnType<typeof parseProductEvent>
    try {
      product = parseProductEvent(signed)
    } catch {
      return { status: "invalid", reason: "product" }
    }
    if (
      product.id !== evidence.coordinate ||
      product.id !== item.productId ||
      product.pubkey !== order.merchantPubkey ||
      product.format !== "physical" ||
      (product.sourcePrice?.amount ?? product.price) !==
        (item.sourcePrice?.amount ?? item.priceAtPurchase) ||
      normalizeCurrencyIdentity(
        product.sourcePrice?.currency ?? product.currency
      ) !==
        normalizeCurrencyIdentity(item.sourcePrice?.currency ?? item.currency)
    )
      return { status: "invalid", reason: "product" }
  }
  return {
    status: "verified",
    marketCoordinate: market.coordinate,
    organizerPubkey: market.organizerPubkey,
    mode: first.mode,
    assignment: first.assignment,
  }
}
