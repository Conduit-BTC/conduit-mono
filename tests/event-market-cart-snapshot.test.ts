import { admitFixture } from "./helpers/public-event"
import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  type OrderEventMarketPickupFulfillmentSchema,
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
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const marketCoordinate = `30409:${organizer}:fair-market`
const calendarCoordinate = `31923:${organizer}:fair`
const calendarStart = 1_790_000_000
const calendarEnd = calendarStart + 3_600
const signedCalendar = finalizeEvent(
  {
    kind: 31923,
    created_at: 100,
    tags: [
      ["d", "fair"],
      ["title", "Fair"],
      ["start", String(calendarStart)],
      ["end", String(calendarEnd)],
      ["D", String(Math.floor(calendarStart / 86_400))],
    ],
    content: "",
  },
  organizerSecret
)
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

function snapshotGrant(
  evidence: OrderEventMarketPickupFulfillmentSchema["grant"]["signedEvidence"]
): OrderEventMarketPickupFulfillmentSchema["grant"] {
  return {
    kind: 3841,
    pubkey: organizer,
    eventId: evidence.tip.id,
    createdAt: evidence.tip.created_at * 1000,
    ancestryEventIds: evidence.ancestry.map((event) => event.id),
    observedDeletionEventIds: evidence.deletions.map((event) => event.id),
    signedEvidence: evidence,
  }
}

function item(
  dTag: string,
  assignment = "Booth 12",
  marketCreatedAt = 100
): CartItem {
  const productId = `30402:${merchant}:${dTag}`
  const signedMarket = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "fair-market",
        organizerPubkey: organizer,
        calendarCoordinate,
        state: "open",
        merchants: [{ pubkey: merchant, mode: "merchant_present", assignment }],
      }),
      created_at: marketCreatedAt,
    },
    organizerSecret
  )
  const signedProduct = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      tags: [
        ["d", dTag],
        ["title", dTag],
        ["price", "12", "USD"],
        ["type", "simple", "physical"],
        ["a", marketCoordinate],
      ],
      content: dTag,
    },
    merchantSecret
  )
  return {
    productId,
    merchantPubkey: merchant,
    title: dTag,
    price: 12,
    currency: "USD",
    sourcePrice: { amount: 12, currency: "USD", normalizedCurrency: "USD" },
    format: "physical",
    quantity: 1,
    fulfillment: {
      type: "event_market_pickup",
      organizerPubkey: organizer,
      merchantPubkey: merchant,
      payeePubkey: merchant,
      market: {
        coordinate: marketCoordinate,
        eventId: signedMarket.id,
        createdAt: marketCreatedAt * 1_000,
        signedEvent: signedMarket,
      },
      calendar: {
        coordinate: calendarCoordinate,
        eventId: signedCalendar.id,
        createdAt: signedCalendar.created_at * 1_000,
        start: calendarStart * 1_000,
        end: calendarEnd * 1_000,
        signedEvent: signedCalendar,
      },
      product: {
        coordinate: productId,
        eventId: signedProduct.id,
        createdAt: signedProduct.created_at * 1_000,
        signedEvent: signedProduct,
      },
      grant: snapshotGrant({ tip: grant, ancestry: [grant], deletions: [] }),
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
      priceAtPurchase: source.price * 100,
      currency: "SATS",
      sourcePrice: source.sourcePrice,
      fulfillment: source.fulfillment,
    })),
    subtotal: items.reduce(
      (sum, source) => sum + source.price * 100 * source.quantity,
      0
    ),
    currency: "SATS",
    shippingCostStatus: "not_required" as const,
    createdAt: 100,
  }
}

describe("future Event Market cart and order snapshots", () => {
  it("groups two merchant products by market identity, not roster revision or booth label", () => {
    const first = item("soap")
    const second = item("candles", "Booth 14", 101)
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

  it("allows compatible cart lines added across a roster-only revision", () => {
    const first = item("soap")
    const second = item("candles", "Booth 12", 101)
    expect(groupCartPurchases([first, second])).toHaveLength(1)
    expect(getMixedFulfillmentBlockingMessage([first, second])).toBeNull()
    expect(getMixedFulfillmentBlockingMessage([second, first])).toBeNull()
    expect(
      getMixedFulfillmentBlockingMessage([
        first,
        item("candles", "Booth 14", 101),
      ])
    ).toContain("current signed")
  })

  it("keeps exact market, product, merchant assignment, and payee in a created order", () => {
    const source = item("soap")
    const parsed = orderItemSchema.parse({
      productId: source.productId,
      title: source.title,
      format: "physical",
      quantity: 1,
      priceAtPurchase: 1200,
      currency: "SATS",
      sourcePrice: source.sourcePrice,
      fulfillment: source.fulfillment,
    })
    const signedSnapshot = JSON.parse(JSON.stringify(source.fulfillment))
    expect(parsed.fulfillment).toEqual(signedSnapshot)
    expect(orderSchema.parse(order([source])).items[0]?.fulfillment).toEqual(
      signedSnapshot
    )
    const withoutGrant = {
      ...source.fulfillment,
      grant: undefined,
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

  it("rejects invented market, calendar, product, and price claims beside a real grant", () => {
    const accepted = orderSchema.parse(order())
    const line = accepted.items[0]!
    const fulfillment = line.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing Event Market pickup")
    const laterMarket = item("soap", "Booth 14", 101).fulfillment
    if (laterMarket?.type !== "event_market_pickup")
      throw new Error("Missing later Event Market pickup")
    const fabricated = [
      {
        ...fulfillment,
        market: { ...fulfillment.market, eventId: "d".repeat(64) },
      },
      { ...fulfillment, mode: "organizer_handoff" as const },
      { ...fulfillment, assignment: "Invented booth" },
      { ...fulfillment, market: laterMarket.market },
      {
        ...fulfillment,
        calendar: {
          ...fulfillment.calendar,
          start: fulfillment.calendar.start + 1_000,
        },
      },
      {
        ...fulfillment,
        product: { ...fulfillment.product, eventId: "e".repeat(64) },
      },
      {
        ...fulfillment,
        product: {
          ...fulfillment.product,
          signedEvent: {
            ...fulfillment.product.signedEvent,
            content: "altered after signing",
          },
        },
      },
    ]
    for (const claim of fabricated) {
      expect(
        orderSchema.safeParse({
          ...accepted,
          items: [{ ...line, fulfillment: claim }],
        }).success
      ).toBe(false)
    }
    expect(
      orderSchema.safeParse({
        ...accepted,
        items: [{ ...line, sourcePrice: { ...line.sourcePrice!, amount: 1 } }],
      }).success
    ).toBe(false)
    expect(orderSchema.parse(accepted)).toEqual(accepted)
    expect(fulfillment.market.eventId).not.toBe(laterMarket.market.eventId)
  })

  for (const [label, tags] of [
    ["missing title", signedCalendar.tags.filter((tag) => tag[0] !== "title")],
    ["missing day bucket", signedCalendar.tags.filter((tag) => tag[0] !== "D")],
    [
      "incorrect day bucket",
      signedCalendar.tags.map((tag) => (tag[0] === "D" ? ["D", "1"] : tag)),
    ],
    [
      "invalid start timezone",
      [...signedCalendar.tags, ["start_tzid", "Invalid/Zone"]],
    ],
    [
      "invalid end timezone",
      [...signedCalendar.tags, ["end_tzid", "Invalid/Zone"]],
    ],
  ] as const) {
    it(`rejects an exact signed calendar with ${label}`, () => {
      const source = item("soap")
      const fulfillment = source.fulfillment
      if (fulfillment?.type !== "event_market_pickup")
        throw new Error("Missing Event Market pickup")
      const invalidCalendar = finalizeEvent(
        { ...signedCalendar, tags: tags.map((tag) => [...tag]) },
        organizerSecret
      )
      fulfillment.calendar = {
        ...fulfillment.calendar,
        eventId: invalidCalendar.id,
        signedEvent: invalidCalendar,
      }
      expect(orderSchema.safeParse(order([source])).success).toBe(false)
    })
  }

  it("round-trips an exact signed date-based calendar", () => {
    const source = item("soap")
    const fulfillment = source.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing Event Market pickup")
    const coordinate = `31922:${organizer}:fair-date`
    const calendar = finalizeEvent(
      {
        kind: 31922,
        created_at: 100,
        tags: [
          ["d", "fair-date"],
          ["title", "Fair"],
          ["start", "2026-09-27"],
          ["end", "2026-09-28"],
        ],
        content: "",
      },
      organizerSecret
    )
    const market = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "fair-market",
          organizerPubkey: organizer,
          calendarCoordinate: coordinate,
          state: "open",
          merchants: [
            {
              pubkey: merchant,
              mode: "merchant_present",
              assignment: "Booth 12",
            },
          ],
        }),
        created_at: 100,
      },
      organizerSecret
    )
    fulfillment.market = {
      ...fulfillment.market,
      eventId: market.id,
      signedEvent: market,
    }
    fulfillment.calendar = {
      coordinate,
      eventId: calendar.id,
      createdAt: 100_000,
      start: Date.parse("2026-09-27T00:00:00Z"),
      end: Date.parse("2026-09-28T00:00:00Z"),
      signedEvent: calendar,
    }
    const accepted = orderSchema.parse(order([source]))
    expect(accepted.items[0]?.fulfillment).toEqual(
      JSON.parse(JSON.stringify(fulfillment))
    )
    expect(orderSchema.parse(accepted)).toEqual(accepted)
  })

  it("keeps the accepted signed authorization history in historical orders", async () => {
    const created = orderSchema.parse(order())
    const fulfillment = created.items[0]?.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing Event Market pickup")
    expect(fulfillment.grant.signedEvidence).toEqual({
      tip: grant,
      ancestry: [grant],
      deletions: [],
    })
    expect(
      orderItemSchema.safeParse({
        ...created.items[0],
        fulfillment: {
          ...fulfillment,
          grant: snapshotGrant({ tip: grant, ancestry: [], deletions: [] }),
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
          grant: snapshotGrant({
            tip: revoke,
            ancestry: [revoke],
            deletions: [],
          }),
        },
      }).success
    ).toBe(false)
    const parsedGrant = parseEventMarketAuthorizationEvent(
      await admitFixture(grant)
    )
    if (!parsedGrant) throw new Error("Missing initial grant")
    const descendant = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "active",
          sequence: parsedGrant.sequence + 1,
          parentIds: [parsedGrant.eventId],
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
          grant: snapshotGrant({
            tip: descendant,
            ancestry: [descendant],
            deletions: [],
          }),
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
              grant: snapshotGrant({
                tip: { ...grant, sig: "0".repeat(128) },
                ancestry: [grant],
                deletions: [],
              }),
            },
          },
        ],
      }).success
    ).toBe(false)
  })

  it("retains a repaired revocation deletion without reinterpreting the paid order", async () => {
    const parsedGrant = parseEventMarketAuthorizationEvent(
      await admitFixture(grant)
    )
    if (!parsedGrant) throw new Error("Missing initial grant")
    const revoke = finalizeEvent(
      {
        ...buildEventMarketAuthorizationDraft({
          marketCoordinate,
          merchantPubkey: merchant,
          state: "revoked",
          sequence: parsedGrant.sequence + 1,
          parentIds: [parsedGrant.eventId],
        }),
        created_at: 101,
      },
      organizerSecret
    )
    const parsedRevoke = parseEventMarketAuthorizationEvent(
      await admitFixture(revoke)
    )
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
          sequence: parsedRevoke.sequence + 1,
          parentIds: [parsedRevoke.eventId],
          repairs: [{ deletionId: deletion.id, targetId: revoke.id }],
        }),
        created_at: 103,
      },
      organizerSecret
    )
    const resolution = resolveEventMarketAuthorization({
      marketCoordinate,
      merchantPubkey: merchant,
      transitions: await Promise.all(
        [grant, revoke, regrant].map(admitFixture)
      ),
      deletions: [await admitFixture(deletion)],
    })
    expect(resolution.state).toBe("active")
    if (resolution.state !== "active") throw new Error("Missing regrant")
    const historical = order()
    const fulfillment = historical.items[0]?.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing Event Market pickup")
    fulfillment.grant = snapshotGrant({
      tip: {
        ...resolution.tip.signedEvent,
        tags: resolution.tip.signedEvent.tags.map((tag) => [...tag]),
      },
      ancestry: resolution.ancestry.map((event) => ({
        ...event.signedEvent,
        tags: event.signedEvent.tags.map((tag) => [...tag]),
      })),
      deletions: [
        {
          ...(await admitFixture(deletion)),
          tags: deletion.tags.map((tag) => [...tag]),
        },
      ],
    })
    const created = orderSchema.parse(historical)
    const accepted = created.items[0]?.fulfillment
    if (accepted?.type !== "event_market_pickup")
      throw new Error("Missing saved Event Market pickup")
    expect(accepted.grant.signedEvidence.tip.id).toBe(regrant.id)
    expect(
      accepted.grant.signedEvidence.ancestry.map((event) => event.id)
    ).toContain(revoke.id)
    expect(
      accepted.grant.signedEvidence.deletions.map((event) => event.id)
    ).toEqual([deletion.id])
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
        order([item("soap"), item("candles", "Booth 12", 101)])
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
    second.grant = snapshotGrant({
      tip: laterGrant,
      ancestry: [laterGrant],
      deletions: [],
    })
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
