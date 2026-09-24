import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  orderItemSchema,
  orderSchema,
  parseEventMarketAuthorizationEvent,
  resolveEventMarketAuthorization,
} from "@conduit/core"
import {
  getCartCommerceFingerprint,
  getMixedFulfillmentBlockingMessage,
  groupCartPurchases,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import { getEventMarketCartReviewReasons } from "../apps/market/src/lib/event-market-cart-review"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = "b".repeat(64)
const eventId = "c".repeat(64)
const marketCoordinate = `30409:${organizer}:fair-market`
const signedGrant = finalizeEvent(
  {
    kind: 3841,
    created_at: 100,
    tags: [
      ["openmarkets", "event-market-auth", "1"],
      ["a", marketCoordinate],
      ["p", merchant],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ],
    content: "",
  },
  organizerSecret
)
const grant = JSON.parse(JSON.stringify(signedGrant)) as typeof signedGrant

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
      calendar: {
        coordinate: `31923:${organizer}:fair`,
        eventId,
        createdAt: 100,
        start: 200,
        end: 300,
      },
      product: { coordinate: productId, eventId, createdAt: 100 },
      authorization: { tip: grant, ancestry: [grant], deletions: [] },
      mode: "merchant_present",
      assignment,
    },
  }
}

function order(items: CartItem[] = [item("soap")]) {
  return {
    id: "order-1",
    merchantPubkey: merchant,
    buyerPubkey: "d".repeat(64),
    items: items.map((source) => ({
      productId: source.productId,
      title: source.title,
      format: source.format,
      quantity: source.quantity,
      priceAtPurchase: source.price,
      currency: source.currency,
      fulfillment: source.fulfillment,
    })),
    subtotal: items.reduce((sum, source) => sum + source.price, 0),
    currency: "USD",
    shippingCostStatus: "not_required" as const,
    createdAt: 100,
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
    expect(orderSchema.parse(order()).items[0]?.fulfillment).toEqual(
      source.fulfillment
    )
    const withoutGrant = {
      ...source.fulfillment,
      authorization: undefined,
    }
    expect(
      orderItemSchema.safeParse({
        ...parsed,
        fulfillment: withoutGrant,
      }).success
    ).toBe(false)
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

  it("keeps the accepted signed authorization history in historical orders", () => {
    const created = orderSchema.parse(order())
    const fulfillment = created.items[0]?.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing Event Market pickup")
    expect(fulfillment.authorization).toEqual({
      tip: grant,
      ancestry: [grant],
      deletions: [],
    })
    expect(
      orderItemSchema.safeParse({
        ...created.items[0],
        fulfillment: {
          ...fulfillment,
          authorization: { tip: grant, ancestry: [], deletions: [] },
        },
      }).success
    ).toBe(false)
    const revoke = JSON.parse(
      JSON.stringify(
        finalizeEvent(
          {
            kind: 3841,
            created_at: 101,
            tags: grant.tags.map((tag) =>
              tag[0] === "state" ? ["state", "revoked"] : tag
            ),
            content: "",
          },
          organizerSecret
        )
      )
    ) as typeof grant
    expect(
      orderItemSchema.safeParse({
        ...created.items[0],
        fulfillment: {
          ...fulfillment,
          authorization: { tip: revoke, ancestry: [revoke], deletions: [] },
        },
      }).success
    ).toBe(false)
    const parsedGrant = parseEventMarketAuthorizationEvent(grant)
    if (!parsedGrant) throw new Error("Missing initial grant")
    const descendant = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          parents: [parsedGrant],
        }),
        created_at: 102,
      },
      organizerSecret
    )
    expect(
      orderItemSchema.safeParse({
        ...created.items[0],
        fulfillment: {
          ...fulfillment,
          authorization: {
            tip: descendant,
            ancestry: [descendant],
            deletions: [],
          },
        },
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...created,
        items: [
          {
            ...created.items[0],
            fulfillment: {
              ...fulfillment,
              authorization: {
                tip: { ...grant, sig: "0".repeat(128) },
                ancestry: [grant],
                deletions: [],
              },
            },
          },
        ],
      }).success
    ).toBe(false)
  })

  it("retains a repaired revocation deletion without reinterpreting the paid order", () => {
    const parsedGrant = parseEventMarketAuthorizationEvent(grant)
    if (!parsedGrant) throw new Error("Missing initial grant")
    const revoke = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "revoked",
          parents: [parsedGrant],
        }),
        created_at: 101,
      },
      organizerSecret
    )
    const parsedRevoke = parseEventMarketAuthorizationEvent(revoke)
    if (!parsedRevoke) throw new Error("Missing revoke")
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 102,
        tags: [["e", revoke.id]],
        content: "",
      },
      organizerSecret
    )
    const regrant = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          parents: [parsedRevoke],
          repairs: [{ deletionId: deletion.id, targetEventId: revoke.id }],
        }),
        created_at: 103,
      },
      organizerSecret
    )
    const resolution = resolveEventMarketAuthorization({
      marketCoordinate,
      merchantPubkey: merchant,
      transitions: [grant, revoke, regrant],
      deletions: [deletion],
    })
    expect(resolution.state).toBe("active")
    if (resolution.state !== "active") throw new Error("Missing regrant")
    const historical = order()
    const fulfillment = historical.items[0]?.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing Event Market pickup")
    fulfillment.authorization = {
      tip: resolution.tip.signedEvent,
      ancestry: resolution.ancestry,
      deletions: resolution.deletions,
    }
    const created = orderSchema.parse(historical)
    const accepted = created.items[0]?.fulfillment
    if (accepted?.type !== "event_market_pickup")
      throw new Error("Missing saved Event Market pickup")
    expect(accepted.authorization.tip.id).toBe(regrant.id)
    expect(accepted.authorization.ancestry.map((event) => event.id)).toContain(
      revoke.id
    )
    expect(accepted.authorization.deletions.map((event) => event.id)).toEqual([
      deletion.id,
    ])
  })

  it("enforces merchant, market, pickup lane, and shipping terms across the full order", () => {
    const base = order([item("soap"), item("candles")])
    expect(orderSchema.safeParse(base).success).toBe(true)
    expect(
      orderSchema.safeParse({ ...base, merchantPubkey: organizer }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse(order([item("soap"), item("candles", "Booth 14")]))
        .success
    ).toBe(false)
    expect(
      orderSchema.safeParse(
        order([item("soap"), item("candles", "Booth 12", "e".repeat(64))])
      ).success
    ).toBe(false)
    const laterGrant = JSON.parse(
      JSON.stringify(
        finalizeEvent(
          { kind: 3841, created_at: 101, tags: grant.tags, content: "" },
          organizerSecret
        )
      )
    ) as typeof grant
    const changedAuthorization = order([item("soap"), item("candles")])
    const second = changedAuthorization.items[1]?.fulfillment
    if (second?.type !== "event_market_pickup")
      throw new Error("Missing second Event Market pickup")
    second.authorization = {
      tip: laterGrant,
      ancestry: [laterGrant],
      deletions: [],
    }
    expect(orderSchema.safeParse(changedAuthorization).success).toBe(false)
    expect(
      orderSchema.safeParse({ ...base, shippingCostSats: 10 }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...base,
        shippingAddress: {
          name: "Buyer",
          street: "1 Road",
          city: "City",
          postalCode: "00000",
          country: "US",
        },
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...base,
        items: [
          ...base.items,
          {
            productId: `30402:${merchant}:shipped`,
            format: "physical",
            quantity: 1,
            priceAtPurchase: 10,
            currency: "USD",
            fulfillment: { type: "shipping" },
          },
        ],
      }).success
    ).toBe(false)
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
