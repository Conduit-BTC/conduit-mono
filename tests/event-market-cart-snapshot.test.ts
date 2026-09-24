import { describe, expect, it } from "bun:test"
import { orderItemSchema } from "@conduit/core"
import {
  getCartCommerceFingerprint,
  getMixedFulfillmentBlockingMessage,
  groupCartPurchases,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import { getEventMarketCartReviewReasons } from "../apps/market/src/lib/event-market-cart-review"

const organizer = "a".repeat(64)
const merchant = "b".repeat(64)
const eventId = "c".repeat(64)

function item(
  dTag: string,
  assignment = "Booth 12",
  marketEventId = eventId
): CartItem {
  const productId = `30402:${merchant}:${dTag}`
  return {
    productId,
    merchantPubkey: merchant,
    title: dTag,
    price: 12,
    currency: "USD",
    format: "physical",
    quantity: 1,
    fulfillment: {
      type: "event_market_pickup",
      organizerPubkey: organizer,
      merchantPubkey: merchant,
      payeePubkey: merchant,
      market: {
        coordinate: `30409:${organizer}:fair-market`,
        eventId: marketEventId,
        createdAt: 100,
      },
      calendar: {
        coordinate: `31923:${organizer}:fair`,
        eventId,
        createdAt: 100,
        start: 200,
        end: 300,
      },
      product: { coordinate: productId, eventId, createdAt: 100 },
      mode: "merchant_present",
      assignment,
    },
  }
}

describe("future Event Market cart and order snapshots", () => {
  it("groups two merchant products by market identity, not roster revision or booth label", () => {
    const first = item("soap")
    const second = item("candles", "Booth 14", "d".repeat(64))
    const groups = groupCartPurchases([first, second])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe("pickup")
    expect(groups[0]?.items).toHaveLength(2)
    expect(groups[0]?.id).toBe(groupCartPurchases([second, first])[0]?.id)
    expect(getMixedFulfillmentBlockingMessage([first, second])).toContain(
      "current signed"
    )
    expect(getCartCommerceFingerprint([first])).not.toBe(
      getCartCommerceFingerprint([item("soap", "Booth 14")])
    )
  })

  it("keeps exact market, product, merchant assignment, and payee in a created order", () => {
    const source = item("soap")
    const parsed = orderItemSchema.parse({
      productId: source.productId,
      title: source.title,
      format: "physical",
      quantity: 1,
      priceAtPurchase: 12,
      currency: "USD",
      fulfillment: source.fulfillment,
    })
    expect(parsed.fulfillment).toEqual(source.fulfillment)
    expect(() =>
      orderItemSchema.parse({
        ...parsed,
        fulfillment: { ...source.fulfillment, payeePubkey: organizer },
      })
    ).toThrow()
    expect(() =>
      orderItemSchema.parse({
        ...parsed,
        shippingCostSats: 10,
      })
    ).toThrow()
  })

  it("requires review for material changes but not a roster revision alone", () => {
    const saved = item("soap").fulfillment
    if (saved?.type !== "event_market_pickup")
      throw new Error("Missing snapshot")
    const laterRevision = {
      ...saved,
      market: { ...saved.market, eventId: "d".repeat(64) },
    }
    expect(
      getEventMarketCartReviewReasons({
        saved,
        current: laterRevision,
        savedPrice: 12,
        currentPrice: 12,
      })
    ).toEqual([])
    expect(
      getEventMarketCartReviewReasons({
        saved,
        current: {
          ...laterRevision,
          assignment: "Booth 14",
          mode: "organizer_handoff",
          calendar: { ...saved.calendar, start: 201 },
          product: { ...saved.product, eventId: "e".repeat(64) },
        },
        savedPrice: 12,
        currentPrice: 14,
      })
    ).toEqual([
      "Pickup handler changed",
      "Pickup assignment changed",
      "Event schedule changed",
      "Product changed",
      "Price changed",
    ])
  })
})
