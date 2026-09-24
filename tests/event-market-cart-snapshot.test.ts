import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  orderItemSchema,
  parseProductEvent,
  type Product,
  type EventMarketProductReadResult,
  type EventMarketRosterReadResult,
} from "@conduit/core"
import {
  getCartCommerceFingerprint,
  getMixedFulfillmentBlockingMessage,
  groupCartPurchases,
  createCartItemFromProduct,
  rebuildCurrentCartItems,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import { getEventMarketCartReviewReasons } from "../apps/market/src/lib/event-market-cart-review"
import { resolveCurrentFutureEventMarketFulfillments } from "../apps/market/src/lib/checkout-authorization"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import { isZeroCostPickupOrder } from "../apps/market/src/lib/order-view"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = "b".repeat(64)
const eventId = "c".repeat(64)
const marketCoordinate = `30409:${organizer}:fair-market`
const grantDraft = buildEventMarketAuthorizationDraft({
  marketCoordinate,
  merchantPubkey: merchant,
  state: "active",
  sequence: 0,
  parentIds: [],
})
const grant = finalizeEvent({ ...grantDraft, created_at: 1 }, organizerSecret)

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
        coordinate: marketCoordinate,
        eventId: marketEventId,
        createdAt: 100,
      },
      grant: {
        kind: 3841,
        pubkey: organizer,
        eventId: grant.id,
        createdAt: 1_000,
        ancestryEventIds: [grant.id],
        observedDeletionEventIds: [],
        signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
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
  it("prices a signed zero SAT future listing as one zero-cost pickup order", () => {
    const secret = generateSecretKey()
    const signed = finalizeEvent(
      {
        kind: 30402,
        created_at: 100,
        content: "Soap",
        tags: [
          ["d", "soap"],
          ["title", "Soap"],
          ["price", "0", "SAT"],
          ["type", "simple", "physical"],
          ["stock", "5"],
        ],
      },
      secret
    )
    const product = parseProductEvent(signed)
    const future = item("soap").fulfillment
    if (future?.type !== "event_market_pickup")
      throw new Error("Missing future pickup")
    const cartItem = {
      ...createCartItemFromProduct(product, future),
      quantity: 1,
    }
    expect(cartItem.priceSats).toBe(0)
    const pricing = buildCheckoutPricingIntent([cartItem], null, 200_000)
    expect(pricing).toMatchObject({
      status: "ok",
      paymentRequired: false,
      totalSats: 0,
    })
    if (pricing.status !== "ok") throw new Error("Missing zero-cost pricing")
    expect(
      isZeroCostPickupOrder({
        items: pricing.items.map((priced) => ({
          ...priced,
          displayTitle: priced.title,
        })),
        requiresPickup: true,
        totalSats: 0,
      })
    ).toBe(true)
  })
  it("prices a nonzero signed future listing to the merchant with no buyer pickup fee", () => {
    const secret = generateSecretKey()
    const signed = finalizeEvent(
      {
        kind: 30402,
        created_at: 100,
        content: "Soap",
        tags: [
          ["d", "soap"],
          ["title", "Soap"],
          ["price", "2500", "SAT"],
          ["type", "simple", "physical"],
          ["stock", "5"],
        ],
      },
      secret
    )
    const product = parseProductEvent(signed)
    const future = item("soap").fulfillment
    if (future?.type !== "event_market_pickup")
      throw new Error("Missing future pickup")
    const cartItem = {
      ...createCartItemFromProduct(product, future),
      quantity: 1,
    }
    const pricing = buildCheckoutPricingIntent([cartItem], null, 200_000)
    expect(pricing).toMatchObject({
      status: "ok",
      paymentRequired: true,
      itemSubtotalSats: 2500,
      totalSats: 2500,
      shippingCost: { totalSats: 0 },
    })
    if (pricing.status !== "ok") throw new Error("Missing paid pricing")
    expect(pricing.items[0]).toMatchObject({
      priceAtPurchase: 2500,
      shippingCostSats: 0,
      fulfillment: { type: "event_market_pickup", payeePubkey: merchant },
    })
  })
  it("requires actionable exact signed evidence before a future checkout", async () => {
    const cartItem = item("soap")
    const snapshot = cartItem.fulfillment
    if (snapshot?.type !== "event_market_pickup")
      throw new Error("Missing snapshot")
    const currentProduct = {
      id: cartItem.productId,
      pubkey: merchant,
      format: "physical",
      sourceEventId: eventId,
      updatedAt: 1_000,
    } as Product
    const marketRead = {} as EventMarketRosterReadResult
    const productRead = {
      actionable: true,
      resolution: {
        state: "eligible",
        revision: { id: eventId, created_at: 1 },
      },
    } as EventMarketProductReadResult
    let marketReads = 0
    const dependencies = {
      readMarket: async () => {
        marketReads += 1
        return marketRead
      },
      readProduct: async ({
        productCoordinate,
      }: {
        productCoordinate: string
      }) => ({
        ...productRead,
        productCoordinate,
      }),
      snapshot: ({
        productRead: read,
      }: {
        productRead: EventMarketProductReadResult
      }) => ({
        ...snapshot,
        product: { ...snapshot.product, coordinate: read.productCoordinate },
      }),
    } as unknown as Parameters<
      typeof resolveCurrentFutureEventMarketFulfillments
    >[1]
    const current = await resolveCurrentFutureEventMarketFulfillments(
      {
        items: [cartItem, item("candles")],
        products: [
          currentProduct,
          { ...currentProduct, id: `30402:${merchant}:candles` },
        ],
      },
      dependencies
    )
    expect(current?.size).toBe(2)
    expect(marketReads).toBe(1)
    const blocked = await resolveCurrentFutureEventMarketFulfillments(
      {
        items: [cartItem],
        products: [currentProduct],
      },
      {
        ...dependencies,
        readProduct: async () => ({ ...productRead, actionable: false }),
      } as typeof dependencies
    )
    expect(blocked).toBeNull()
    for (const coverage of ["partial", "stale"] as const) {
      const unreadable = await resolveCurrentFutureEventMarketFulfillments(
        { items: [cartItem], products: [currentProduct] },
        {
          ...dependencies,
          readProduct: async () => ({
            ...productRead,
            coverage,
            actionable: false,
          }),
        } as typeof dependencies
      )
      expect(unreadable).toBeNull()
    }
    const divergentRevision = await resolveCurrentFutureEventMarketFulfillments(
      {
        items: [cartItem],
        products: [{ ...currentProduct, sourceEventId: "d".repeat(64) }],
      },
      dependencies
    )
    expect(divergentRevision).toBeNull()
    const changedPayee = await resolveCurrentFutureEventMarketFulfillments(
      { items: [cartItem], products: [currentProduct] },
      {
        ...dependencies,
        snapshot: () => ({ ...snapshot, payeePubkey: organizer }),
      } as typeof dependencies
    )
    expect(changedPayee).toBeNull()
    const changedPrice = rebuildCurrentCartItems(
      [cartItem],
      [
        {
          ...currentProduct,
          title: cartItem.title,
          price: 14,
          currency: "USD",
          type: "simple",
          visibility: "public",
          images: [],
          tags: [],
          createdAt: 1,
          updatedAt: 1_000,
        } as Product,
      ],
      new Map([[cartItem.productId, snapshot]])
    )
    expect(changedPrice).not.toBeNull()
    expect(getCartCommerceFingerprint(changedPrice!)).not.toBe(
      getCartCommerceFingerprint([cartItem])
    )
  })
  it("groups two merchant products by market identity, not roster revision or booth label", () => {
    const first = item("soap")
    const second = item("candles", "Booth 14", "d".repeat(64))
    const groups = groupCartPurchases([first, second])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe("pickup")
    expect(groups[0]?.items).toHaveLength(2)
    expect(groups[0]?.id).toBe(groupCartPurchases([second, first])[0]?.id)
    expect(getMixedFulfillmentBlockingMessage([first, second])).toBeNull()
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
    expect(JSON.parse(JSON.stringify(parsed.fulfillment))).toEqual(
      JSON.parse(JSON.stringify(source.fulfillment))
    )
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
    expect(
      getEventMarketCartReviewReasons({
        saved,
        current: { ...saved, payeePubkey: organizer },
        savedPrice: 12,
        currentPrice: 12,
      })
    ).toContain("Payee changed")
    expect(getCartCommerceFingerprint([item("soap")])).not.toBe(
      getCartCommerceFingerprint([{ ...item("soap"), price: 14 }])
    )
  })
})
