import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  type EventMarketEventDraft,
} from "@conduit/core/protocol/event-market"

// Retired public graph writers stay test-only. These are historical fixtures,
// never new checkout admission or a replacement for the kind-31927 writers.
function buildEventMarketCollectionDraft(input: {
  dTag: string
  title: string
  eventCoordinate: string
  productCoordinates: string[]
  pickupCoordinate?: string
  orderAcceptance?: "open" | "closed"
}): EventMarketEventDraft {
  return {
    kind: 30405,
    content: "",
    tags: [
      ["d", input.dTag],
      ["title", input.title],
      ["a", input.eventCoordinate],
      ...input.productCoordinates.map((coordinate) => ["a", coordinate]),
      ...(input.pickupCoordinate
        ? [["shipping_option", input.pickupCoordinate]]
        : []),
      ...(input.orderAcceptance
        ? [["conduit_event_market", "1", input.orderAcceptance]]
        : []),
    ],
  }
}
function buildEventMarketPickupDraft(input: {
  dTag: string
  title: string
  price: number
  currency: string
  countries: string[]
  location: string
  geohash: string
}): EventMarketEventDraft {
  return {
    kind: 30406,
    content: "",
    tags: [
      ["d", input.dTag],
      ["title", input.title],
      ["service", "pickup"],
      ["price", String(input.price), input.currency],
      ...input.countries.map((country) => ["country", country]),
      ["location", input.location],
      ["g", input.geohash],
    ],
  }
}
import type { CheckoutSparkCommerceQuoteLine } from "@conduit/core/protocol/checkout-spark-reconciliation"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ORGANIZER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
export const CHECKOUT_SPARK_PICKUP_FIXTURE_CREATED_AT = 1_750_000_000

function sign(
  draft: EventMarketEventDraft,
  secret: Uint8Array,
  createdAt: number,
  dTagExtraFields: readonly string[] = []
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      ...draft,
      created_at: createdAt,
      tags: draft.tags.map((tag) =>
        tag[0] === "d" ? [...tag, ...dTagExtraFields] : [...tag]
      ),
    },
    secret
  )
}

/** Ordinary signed legacy event graph; all keys and sources remain test-only. */
export function createCheckoutSparkPickupFixture(
  options: {
    merchantSecret?: Uint8Array
    organizerSecret?: Uint8Array
    handoffMode?: "merchant_handoff" | "organizer_handoff"
    calendarKind?: 31922 | 31923
    pickupPriceSats?: number
    extraCostSats?: number
    quantity?: number
    collectionAlias?: boolean
    orderAcceptance?: "open" | "closed"
    dTagExtraFields?: readonly string[]
    createdAt?: number
    acceptedAtMs?: number
  } = {}
) {
  const merchantSecret = options.merchantSecret ?? MERCHANT_SECRET
  const organizerSecret = options.organizerSecret ?? ORGANIZER_SECRET
  const merchantPubkey = getPublicKey(merchantSecret)
  const organizerPubkey = getPublicKey(organizerSecret)
  const organizerHandoff = options.handoffMode === "organizer_handoff"
  const createdAt =
    options.createdAt ?? CHECKOUT_SPARK_PICKUP_FIXTURE_CREATED_AT
  const calendarKind = options.calendarKind ?? 31923
  const pickupPriceSats = options.pickupPriceSats ?? 10
  const extraCostSats = options.extraCostSats ?? 0
  const productCoordinate = `30402:${merchantPubkey}:coffee`
  const calendarCoordinate = `${calendarKind}:${organizerPubkey}:market-day`
  const collectionCoordinate = `30405:${organizerPubkey}:market`
  const pickupCoordinate = `30406:${organizerHandoff ? organizerPubkey : merchantPubkey}:booth`
  const calendar = sign(
    buildEventMarketCalendarDraft({
      dTag: "market-day",
      title: "Market day",
      locations: ["Public square"],
      ...(calendarKind === 31922
        ? {
            kind: 31922,
            start: new Date(createdAt * 1_000).toISOString().slice(0, 10),
            end: new Date((createdAt + 86_400) * 1_000)
              .toISOString()
              .slice(0, 10),
          }
        : {
            kind: 31923,
            start: createdAt + 60,
            end: createdAt + 3_600,
          }),
    }),
    organizerSecret,
    createdAt,
    options.dTagExtraFields
  )
  const collection = sign(
    buildEventMarketCollectionDraft({
      dTag: "market",
      title: "Market collection",
      eventCoordinate: calendarCoordinate,
      productCoordinates: [productCoordinate],
      ...(organizerHandoff ? { pickupCoordinate } : {}),
      ...(options.orderAcceptance
        ? { orderAcceptance: options.orderAcceptance }
        : {}),
    }),
    organizerSecret,
    createdAt,
    options.dTagExtraFields
  )
  const pickup = sign(
    buildEventMarketPickupDraft({
      dTag: "booth",
      title: organizerHandoff ? "Organizer desk" : "Merchant booth",
      price: pickupPriceSats,
      currency: "SAT",
      countries: ["US"],
      location: "Public square, booth 2",
      geohash: "dr5ru",
    }),
    organizerHandoff ? organizerSecret : merchantSecret,
    createdAt,
    options.dTagExtraFields
  )
  const productEvent = sign(
    {
      kind: 30402,
      content: "Coffee for pickup",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["type", "simple", "physical"],
        ["price", "100", "SAT"],
        ["stock", "10"],
        ["image", "https://cdn.conduit.market/coffee.png"],
        ["t", "coffee"],
        ["t", "groceries"],
        ["t", "pickup"],
        ["a", collectionCoordinate],
        [
          "shipping_option",
          options.collectionAlias ? collectionCoordinate : pickupCoordinate,
          ...(extraCostSats > 0 ? [String(extraCostSats)] : []),
        ],
      ],
    },
    merchantSecret,
    createdAt,
    options.dTagExtraFields
  )
  const line: CheckoutSparkCommerceQuoteLine = {
    productCoordinate,
    productEventId: productEvent.id,
    merchantPubkey,
    quantity: options.quantity ?? 2,
    unitMerchandiseSats: 100,
    unitShippingSats: pickupPriceSats + extraCostSats,
    shippingOption: { coordinate: pickupCoordinate, eventId: pickup.id },
    pickup: {
      calendar: { coordinate: calendarCoordinate, eventId: calendar.id },
      collection: { coordinate: collectionCoordinate, eventId: collection.id },
    },
  }
  return {
    merchantPubkey,
    organizerPubkey,
    calendar,
    collection,
    pickup,
    productEvent,
    line,
    sourceEvents: [calendar, collection, pickup],
    acceptedAtMs: options.acceptedAtMs ?? (createdAt + 120) * 1_000,
  }
}
