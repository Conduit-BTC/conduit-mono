import { isSatsLikeCurrency } from "../pricing"
import {
  orderPickupFulfillmentSchema,
  type OrderPickupFulfillmentSchema,
} from "../schemas"
import type { CheckoutSparkCommerceQuoteLine } from "./checkout-spark-reconciliation"
import {
  parseAddressableCoordinate,
  resolveEventMarketEvidence,
  resolveEventMarketProductParticipation,
} from "./event-market"
import { resolveEventMarketProductFulfillment } from "./event-market-fulfillment"
import { parseProductEvent } from "./products"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type CheckoutSparkSignedPickup = OrderPickupFulfillmentSchema &
  Required<Pick<OrderPickupFulfillmentSchema, "handoffMode" | "handlerPubkey">>

function unavailable(): never {
  throw new Error("Checkout Spark signed pickup evidence is unavailable.")
}

function exactSource(input: {
  event: SignedPublicNostrEvent | undefined
  reference: { coordinate: string; eventId: string }
  kinds: readonly number[]
  acceptedAtMs: number
}): SignedPublicNostrEvent {
  const coordinate = parseAddressableCoordinate(
    input.reference.coordinate,
    input.kinds
  )
  const event = input.event
  if (!event || !coordinate) unavailable()
  // Detach signed values, including tags, from transport or cache metadata.
  const source: SignedPublicNostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
  const dTags = source.tags.filter((tag) => tag[0] === "d")
  if (
    !isValidSignedPublicNostrEvent(source) ||
    source.id !== input.reference.eventId ||
    source.kind !== coordinate.kind ||
    source.pubkey !== coordinate.authorPubkey ||
    source.created_at > Math.floor(input.acceptedAtMs / 1_000) ||
    dTags.length !== 1 ||
    dTags[0]?.[1] !== coordinate.dTag
  ) {
    unavailable()
  }
  return source
}

/**
 * Reconstruct one legacy pickup line from the exact signed revisions accepted
 * at checkout. This is historical term validation, not live listing freshness,
 * organizer inbox readiness, payment proof, or permission to release an order.
 * A line without pickup graph references returns undefined and must be handled
 * by its own fulfillment validator; it is not admitted here.
 */
export function resolveCheckoutSparkSignedPickup(input: {
  productEvent: SignedPublicNostrEvent
  line: CheckoutSparkCommerceQuoteLine
  sourceEvents: readonly SignedPublicNostrEvent[]
  acceptedAtMs: number
}): CheckoutSparkSignedPickup | undefined {
  try {
    const { line, acceptedAtMs } = input
    if (line.pickup === undefined) return undefined
    if (
      !Number.isSafeInteger(acceptedAtMs) ||
      acceptedAtMs < 0 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !Number.isSafeInteger(line.unitMerchandiseSats) ||
      line.unitMerchandiseSats <= 0 ||
      !Number.isSafeInteger(line.unitShippingSats) ||
      line.unitShippingSats < 0 ||
      !line.shippingOption
    ) {
      unavailable()
    }
    const productEvent = exactSource({
      event: input.productEvent,
      reference: {
        coordinate: line.productCoordinate,
        eventId: line.productEventId,
      },
      kinds: [30402],
      acceptedAtMs,
    })
    const product = parseProductEvent(productEvent)
    if (
      productEvent.pubkey !== line.merchantPubkey ||
      product.id !== line.productCoordinate ||
      product.type !== "simple" ||
      product.format !== "physical" ||
      product.priceEvidenceMalformed ||
      product.currency !== "SATS" ||
      !product.sourcePrice ||
      !isSatsLikeCurrency(product.sourcePrice.normalizedCurrency) ||
      product.priceSats !== line.unitMerchandiseSats
    ) {
      unavailable()
    }
    const selectedSource = (
      reference: { coordinate: string; eventId: string },
      kinds: readonly number[]
    ): SignedPublicNostrEvent => {
      let selected: SignedPublicNostrEvent | undefined
      for (const candidate of input.sourceEvents) {
        if (candidate.id !== reference.eventId) continue
        // Every matching copy must authenticate its own bytes against the ID;
        // an earlier valid copy must not hide an unusable duplicate. Distinct
        // historical revisions are intentionally not selected by recency.
        const source = exactSource({
          event: candidate,
          reference,
          kinds,
          acceptedAtMs,
        })
        selected ??= source
      }
      return selected ?? unavailable()
    }
    const collectionEvent = selectedSource(line.pickup.collection, [30405])
    const calendarEvent = selectedSource(line.pickup.calendar, [31922, 31923])
    const pickupEvent = selectedSource(line.shippingOption, [30406])
    const resolution = resolveEventMarketEvidence({
      reference: line.pickup.collection.coordinate,
      expectedOrganizerPubkey: collectionEvent.pubkey,
      selectedProductCoordinates: [line.productCoordinate],
      events: [collectionEvent, calendarEvent, pickupEvent],
      productRequestEvents: [productEvent],
      nowMs: acceptedAtMs,
    })
    const participation = resolveEventMarketProductParticipation(
      product,
      resolution
    )
    const fulfillment = resolveEventMarketProductFulfillment(
      product,
      resolution
    )
    const { calendar, collection } = resolution
    if (
      resolution.state !== "active" ||
      !participation.accepted ||
      !participation.requested ||
      !calendar ||
      !collection ||
      calendar.eventId !== calendarEvent.id ||
      collection.eventId !== collectionEvent.id ||
      fulfillment.status !== "resolved" ||
      fulfillment.selectedPickup.eventId !== pickupEvent.id ||
      !isSatsLikeCurrency(fulfillment.sourceCost.normalizedCurrency) ||
      fulfillment.sourceCost.amount !== line.unitShippingSats
    ) {
      unavailable()
    }
    const pickup = fulfillment.selectedPickup
    const snapshot: CheckoutSparkSignedPickup = {
      type: "pickup",
      organizerPubkey: collection.authorPubkey,
      product: {
        coordinate: product.id,
        eventId: productEvent.id,
        createdAt: productEvent.created_at * 1_000,
        merchantPubkey: productEvent.pubkey,
      },
      calendar: {
        coordinate: calendar.coordinate,
        eventId: calendar.eventId,
        createdAt: calendar.createdAt,
      },
      collection: {
        coordinate: collection.coordinate,
        eventId: collection.eventId,
        createdAt: collection.createdAt,
      },
      option: {
        coordinate: pickup.coordinate,
        eventId: pickup.eventId,
        createdAt: pickup.createdAt,
        title: pickup.title,
        ...(pickup.location ? { location: pickup.location } : {}),
        ...(pickup.geohash ? { geohash: pickup.geohash } : {}),
      },
      handoffMode: fulfillment.handoffMode,
      handlerPubkey: fulfillment.handoffPubkey,
      costSats: line.unitShippingSats,
      sourceCost: { ...fulfillment.sourceCost },
    }
    if (!orderPickupFulfillmentSchema.safeParse(snapshot).success) unavailable()
    return snapshot
  } catch {
    return unavailable()
  }
}
