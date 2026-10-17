import { expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import { parseEventMarketOrganizerFeeTerms } from "@conduit/core/protocol/event-market-organizer-fee"
import { freezeCheckoutSparkEventMarketBinding } from "@conduit/core/protocol/checkout-spark-event-market"
import { orderSchema } from "@conduit/core/schemas"
import {
  createEventMarketFreePurchase,
  restoreEventMarketFreePurchase,
  buildEventMarketFreePurchaseRumor,
  parseEventMarketFreePurchaseRumor,
  isEventMarketFreePurchaseRumor,
} from "@conduit/core/protocol/event-market-free-purchase"
import {
  decodeCommerceMessageRumor,
  commerceMessageSearchText,
} from "@conduit/core/protocol/commerce-message-codec"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

function fixture() {
  const f = checkoutSparkEventMarketFixture({
    commerceTotalSats: 0,
    supplier: false,
    mode: "organizer_handoff",
  })
  const market = f.signOrganizer(
    buildEventMarketRosterDraft({
      dTag: "fair",
      organizerPubkey: f.organizerPubkey,
      calendarCoordinate: f.eventMarket.occurrenceCoordinate,
      state: "open",
      merchants: [
        {
          pubkey: f.merchantPubkey,
          mode: "organizer_handoff",
          assignment: "Booth 1",
        },
      ],
      organizerFee: { state: "disabled" },
    })
  )
  const eventMarket = freezeCheckoutSparkEventMarketBinding(
    {
      ...f.eventMarket,
      marketEventId: market.id,
      organizerFee: parseEventMarketOrganizerFeeTerms({
        event: market,
        marketCoordinate: f.eventMarket.marketCoordinate,
      }),
      organizerFeeSats: 0,
    },
    {
      merchantPubkey: f.merchantPubkey,
      commerceQuote: f.plan.commerceQuote,
      acceptedAtMs: AT,
    }
  )
  const original = createCheckoutSparkEventMarketFixtureOrder(
    f,
    getPublicKey(generateSecretKey()),
    AT
  )
  const order = orderSchema.parse({
    ...original,
    items: original.items.map((item) => {
      if (item.fulfillment?.type !== "event_market_pickup")
        throw new Error("Expected event")
      return {
        ...item,
        fulfillment: {
          ...item.fulfillment,
          market: {
            ...item.fulfillment.market,
            eventId: market.id,
            createdAt: market.created_at * 1000,
            signedEvent: market,
          },
        },
      }
    }),
  })
  return {
    ...f,
    order,
    input: {
      order,
      commerceQuote: f.plan.commerceQuote,
      eventMarket,
      sourceEvents: f.sourceEvents.map((event) =>
        event.id === f.events.market.id ? market : event
      ),
    },
  }
}

it("creates a minimal exact free organizer packet without any wallet, invoice, contacts or full order", () => {
  const f = fixture(),
    payload = createEventMarketFreePurchase(f.input)
  expect(payload.orderId).toBe(f.order.id)
  expect(payload.commerceQuote.commerceTotalSats).toBe(0)
  expect(payload.eventMarket.organizerFeeSats).toBe(0)
  for (const field of [
    "wallet",
    "invoice",
    "funding",
    "order",
    "guestContact",
    "shippingAddress",
    "items",
  ])
    expect(payload).not.toHaveProperty(field)
  const rumor = buildEventMarketFreePurchaseRumor(payload)
  expect(rumor.pubkey).toBe(f.order.buyerPubkey)
  expect(rumor.tags[0]).toEqual(["p", f.organizerPubkey])
  expect(parseEventMarketFreePurchaseRumor(rumor)).toEqual(payload)
  expect(
    restoreEventMarketFreePurchase(JSON.parse(JSON.stringify(payload)))
  ).toEqual(payload)
  expect(createEventMarketFreePurchase(f.input).handoffId).toBe(
    payload.handoffId
  )
})

it("rejects nonzero goods/fees, changed exact order terms and missing or tampered source evidence", () => {
  const f = fixture(),
    payload = createEventMarketFreePurchase(f.input)
  expect(() =>
    createEventMarketFreePurchase({
      ...f.input,
      order: { ...f.order, subtotal: 1 },
    })
  ).toThrow()
  expect(() =>
    createEventMarketFreePurchase({
      ...f.input,
      sourceEvents: f.sourceEvents.filter(
        (event) => event.id !== f.events.product.id
      ),
    })
  ).toThrow()
  expect(() =>
    createEventMarketFreePurchase({
      ...f.input,
      eventMarket: { ...f.input.eventMarket, organizerFeeSats: 1 },
    })
  ).toThrow()
  for (const change of [
    { schemaVersion: 2 },
    { orderId: crypto.randomUUID() },
    { organizerPubkey: f.merchantPubkey },
    { wallet: {} },
    {
      orderBinding: {
        ...payload.orderBinding,
        termsHash: getPublicKey(generateSecretKey()),
      },
    },
  ])
    expect(() =>
      restoreEventMarketFreePurchase({ ...payload, ...change })
    ).toThrow()
  const rumor = buildEventMarketFreePurchaseRumor(payload)
  const altered = { ...rumor, pubkey: f.merchantPubkey }
  expect(() =>
    parseEventMarketFreePurchaseRumor({ ...altered, id: getEventHash(altered) })
  ).toThrow()
})

it("quarantines malformed and unknown-version free-purchase traffic before generic order or search projection", () => {
  const f = fixture(),
    payload = createEventMarketFreePurchase(f.input),
    rumor = buildEventMarketFreePurchaseRumor(payload)
  for (const candidate of [
    rumor,
    { ...rumor, content: "malformed private machine content" },
    { ...rumor, content: JSON.stringify({ ...payload, schemaVersion: 99 }) },
    {
      ...rumor,
      tags: [["type", "order"]],
      content: JSON.stringify({ ...payload, schemaVersion: 99 }),
    },
  ]) {
    expect(isEventMarketFreePurchaseRumor(candidate)).toBe(true)
    const decoded = decodeCommerceMessageRumor(candidate)
    expect(decoded.category).toBe("machine")
    expect(commerceMessageSearchText(decoded)).toBe("")
  }
})
