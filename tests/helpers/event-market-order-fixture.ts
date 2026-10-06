import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  buildEventMarketAssignmentDraft,
  orderSchema,
  type OrderEventMarketPickupFulfillmentSchema,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const organizerSecret = generateSecretKey()
const merchantSecret = generateSecretKey()

/** Synthetic signed terms shared by current-model order workflow tests. */
export function createEventMarketOrderFixture(
  options: {
    mode?: "merchant_present" | "organizer_handoff"
    assignment?: string
    dTag?: string
    calendarDTag?: string
    productDTag?: string
    productCreatedAt?: number
    price?: number
    newAssignment?: boolean
  } = {}
) {
  const organizer = getPublicKey(organizerSecret)
  const merchant = getPublicKey(merchantSecret)
  const buyer = "c".repeat(64)
  const dTag = options.dTag ?? "market-day"
  const calendarDTag = options.calendarDTag ?? dTag
  const productDTag = options.productDTag ?? `${dTag}-coffee`
  const productCreatedAt = options.productCreatedAt ?? 101
  const mode = options.mode ?? "organizer_handoff"
  const assignment = options.assignment ?? "Organizer table"
  const price = options.price ?? 100
  const start = options.newAssignment ? 1_900_000_000 : 1_790_000_000
  const marketCoordinate = `30409:${organizer}:${dTag}`
  const calendarCoordinate = `31923:${organizer}:${calendarDTag}`
  const productCoordinate = `30402:${merchant}:${productDTag}`
  const market = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag,
        organizerPubkey: organizer,
        calendarCoordinate,
        state: "open",
        merchants: [{ pubkey: merchant, mode, assignment }],
      }),
      created_at: 100,
    },
    organizerSecret
  )
  const calendar = finalizeEvent(
    {
      kind: 31923,
      tags: [
        ["d", calendarDTag],
        ["title", "Market day"],
        ["start", String(start)],
        ["end", String(start + 3_600)],
        ["location", "100 Public Square"],
        ["D", String(Math.floor(start / 86_400))],
      ],
      content: "",
      created_at: 100,
    },
    organizerSecret
  )
  const grant = finalizeEvent(
    {
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "active",
        sequence: 0,
        parentIds: [],
      }),
      created_at: 99,
    },
    organizerSecret
  )
  const product = finalizeEvent(
    {
      kind: 30402,
      tags: [
        ["d", productDTag],
        ["title", "Coffee"],
        ["price", String(price), "SATS"],
        ["type", "simple", "physical"],
        ...(options.newAssignment
          ? [["stock", "6"]]
          : [["a", marketCoordinate]]),
      ],
      content: "Coffee",
      created_at: productCreatedAt,
    },
    merchantSecret
  )
  const assignmentEvent = options.newAssignment
    ? finalizeEvent(
        {
          ...buildEventMarketAssignmentDraft({
            marketCoordinate,
            occurrenceCoordinate: calendarCoordinate,
            productCoordinate,
            merchantPubkey: merchant,
            state: "active",
            inventory: { mode: "tracked", quantity: 6 },
            fulfillmentMethods: ["pickup"],
          }),
          created_at: 101,
        },
        merchantSecret
      )
    : undefined
  const fulfillment: OrderEventMarketPickupFulfillmentSchema = {
    type: "event_market_pickup",
    organizerPubkey: organizer,
    merchantPubkey: merchant,
    payeePubkey: merchant,
    market: {
      coordinate: marketCoordinate,
      eventId: market.id,
      createdAt: 100_000,
      signedEvent: market,
    },
    calendar: {
      coordinate: calendarCoordinate,
      eventId: calendar.id,
      createdAt: 100_000,
      start: start * 1_000,
      end: (start + 3_600) * 1_000,
      signedEvent: calendar,
    },
    grant: {
      kind: 3841,
      pubkey: organizer,
      eventId: grant.id,
      createdAt: 99_000,
      ancestryEventIds: [grant.id],
      observedDeletionEventIds: [],
      signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
    },
    product: {
      coordinate: productCoordinate,
      eventId: product.id,
      createdAt: productCreatedAt * 1_000,
      signedEvent: product,
    },
    ...(assignmentEvent
      ? {
          occurrenceAssignment: {
            coordinate: `30410:${merchant}:${assignmentEvent.tags.find((tag) => tag[0] === "d")?.[1]}`,
            eventId: assignmentEvent.id,
            createdAt: 101_000,
            signedEvent: assignmentEvent,
          },
        }
      : {}),
    mode,
    assignment,
  }
  const order = orderSchema.parse({
    id: "order-1",
    merchantPubkey: merchant,
    buyerPubkey: buyer,
    items: [
      {
        productId: productCoordinate,
        title: "Coffee",
        format: "physical",
        quantity: 1,
        priceAtPurchase: price,
        currency: "SATS",
        sourcePrice: {
          amount: price,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
        shippingCostSats: 0,
        fulfillment,
      },
    ],
    subtotal: price,
    currency: "SATS",
    shippingCostSats: 0,
    createdAt: 102_000,
  })
  return {
    order,
    fulfillment,
    events: [
      market,
      calendar,
      grant,
      product,
      ...(assignmentEvent ? [assignmentEvent] : []),
    ] as SignedPublicNostrEvent[],
    organizer,
    merchant,
    buyer,
  }
}
