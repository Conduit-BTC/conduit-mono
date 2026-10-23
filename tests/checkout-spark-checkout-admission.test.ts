import { describe, expect, test } from "bun:test"
import {
  parseEventMarketOrganizerFeeTerms,
  type PreparedProductFulfillment,
} from "@conduit/core"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import { assessCheckoutSparkCheckoutAdmission } from "../apps/market/src/lib/checkout-spark-checkout-admission"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import { isCheckoutSparkSettledCart } from "../apps/market/src/lib/checkout-spark-settled-cart"
import { createEventMarketCheckoutFixture } from "./helpers/event-market-checkout-fixture"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT,
} from "./support/checkout-spark-event-market-fixture"

const merchant = "1".repeat(64)
const digital: CartItem = {
  productId: `30402:${merchant}:admission`,
  merchantPubkey: merchant,
  title: "Admission fixture",
  price: 1_000,
  currency: "SATS",
  quantity: 1,
  format: "digital",
  fulfillment: { type: "digital" },
}
const physical: CartItem = {
  ...digital,
  format: "physical",
  fulfillment: { type: "shipping" },
}
function assess(
  items: CartItem[],
  fulfillment = new Map<string, PreparedProductFulfillment>()
) {
  return assessCheckoutSparkCheckoutAdmission({
    enabled: true,
    freeOrderVerified: false,
    items,
    fulfillment,
  })
}

function assessDisabled(
  items: CartItem[],
  options: { freeOrderVerified?: boolean; nowMs?: number } = {}
) {
  return assessCheckoutSparkCheckoutAdmission({
    enabled: false,
    freeOrderVerified: options.freeOrderVerified ?? false,
    items,
    fulfillment: new Map(),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  })
}

/** Keep malformed fee bytes genuinely signed by the same roster organizer. */
function signedFeeItem(feeTags: string[][]): CartItem {
  const fixture = checkoutSparkEventMarketFixture({ organizerFee: "absent" })
  const order = createCheckoutSparkEventMarketFixtureOrder(
    fixture,
    fixture.supplierPubkey
  )
  const item = order.items[0]!
  const fulfillment = item.fulfillment
  if (fulfillment?.type !== "event_market_pickup")
    throw new Error("Missing Event Market fixture.")
  const market = fixture.events.market
  const signedEvent = fixture.signOrganizer({
    kind: market.kind,
    created_at: market.created_at,
    content: market.content,
    tags: [...market.tags, ...feeTags],
  })
  return {
    productId: item.productId,
    merchantPubkey: fixture.merchantPubkey,
    title: item.title,
    price: item.priceAtPurchase,
    currency: item.currency,
    quantity: item.quantity,
    format: item.format,
    fulfillment: {
      ...fulfillment,
      market: { ...fulfillment.market, eventId: signedEvent.id, signedEvent },
    },
  }
}

describe("required checkout routing is separate from readiness", () => {
  test("disabled routing cannot waive a current signed organizer fee", async () => {
    const event = await createEventMarketCheckoutFixture({
      organizerFee: {
        state: "active",
        basisPoints: 250,
        minimumSats: 5,
        lightningAddress: "organizer@example.test",
      },
    })
    expect(
      assessCheckoutSparkCheckoutAdmission({
        enabled: false,
        freeOrderVerified: false,
        items: [event.item],
        fulfillment: new Map(),
      })
    ).toEqual({ mode: "router", ready: false })
  })
  test.each([
    [100, false, 0],
    [0, false, 0],
    [0, true, 5],
  ])(
    "disabled routing blocks active fee for price %i, verified free %s, minimum %i",
    async (price, freeOrderVerified, minimumSats) => {
      const event = await createEventMarketCheckoutFixture({
        price,
        organizerFee: {
          state: "active",
          basisPoints: 250,
          minimumSats,
          lightningAddress: "organizer@example.test",
        },
      })
      expect(assessDisabled([event.item], { freeOrderVerified })).toEqual({
        mode: "router",
        ready: false,
      })
    }
  )

  test("disabled routing preserves positively verified zero-commerce zero-fee flow", async () => {
    const event = await createEventMarketCheckoutFixture({
      price: 0,
      organizerFee: {
        state: "active",
        basisPoints: 250,
        minimumSats: 0,
        lightningAddress: "organizer@example.test",
      },
    })
    expect(assessDisabled([event.item], { freeOrderVerified: true })).toEqual({
      mode: "disabled",
    })
  })

  test.each(["absent", "disabled", "revoked", "zero"] as const)(
    "disabled routing preserves %s fee terms and legacy assignment flow",
    async (state) => {
      const event = await createEventMarketCheckoutFixture({
        ...(state === "absent"
          ? {}
          : {
              organizerFee:
                state === "zero"
                  ? {
                      state: "active" as const,
                      basisPoints: 0,
                      minimumSats: 0,
                      lightningAddress: "organizer@example.test",
                    }
                  : { state },
            }),
      })
      expect(assessDisabled([event.item])).toEqual({ mode: "disabled" })
      const legacy = {
        ...event.item,
        fulfillment: { ...event.fulfillment, occurrenceAssignment: undefined },
      }
      expect(isCheckoutSparkSettledCart([legacy])).toBe(false)
      expect(assessDisabled([legacy])).toEqual({ mode: "disabled" })
    }
  )

  test.each([
    ["unknown version", [["conduit_event_fee", "2", "disabled"]]],
    [
      "duplicate terms",
      [
        ["conduit_event_fee", "1", "disabled"],
        ["conduit_event_fee", "1", "revoked"],
      ],
    ],
    [
      "noncanonical rate",
      [
        [
          "conduit_event_fee",
          "1",
          "active",
          "0250",
          "0",
          "organizer@example.test",
        ],
      ],
    ],
    [
      "invalid destination",
      [["conduit_event_fee", "1", "active", "250", "0", "not-an-address"]],
    ],
  ] as const)(
    "disabled routing cannot waive genuinely signed %s",
    (_name, feeTags) => {
      const item = signedFeeItem(feeTags.map((tag) => [...tag]))
      if (item.fulfillment?.type !== "event_market_pickup")
        throw new Error("Missing event.")
      expect(
        parseEventMarketOrganizerFeeTerms({
          event: item.fulfillment.market.signedEvent,
          marketCoordinate: item.fulfillment.market.coordinate,
        }).state
      ).toBe("invalid")
      for (const freeOrderVerified of [false, true])
        expect(
          assessDisabled([item], {
            nowMs: EVENT_MARKET_FIXTURE_AT,
            freeOrderVerified,
          })
        ).toEqual({ mode: "router", ready: false })
    }
  )

  test.each([
    ["future", 99_999],
    ["exclusive expiry", 101_000],
    ["invalid clock", Number.NaN],
  ] as const)(
    "disabled routing cannot waive %s signed fee authority",
    async (_name, nowMs) => {
      const event = await createEventMarketCheckoutFixture({
        organizerFee: {
          state: "active",
          basisPoints: 250,
          minimumSats: 5,
          lightningAddress: "organizer@example.test",
          expiresAt: 101,
        },
      })
      for (const freeOrderVerified of [false, true])
        expect(
          assessDisabled([event.item], { nowMs, freeOrderVerified })
        ).toEqual({ mode: "router", ready: false })
    }
  )
  test("admits one uniform current event assignment without treating the hint as authority", async () => {
    const event = await createEventMarketCheckoutFixture()
    expect(isCheckoutSparkSettledCart([event.item])).toBe(true)
    expect(assess([event.item])).toEqual({ mode: "router", ready: true })
    expect(assess([event.item, digital])).toEqual({
      mode: "router",
      ready: false,
    })
    for (const changed of [
      {
        ...event.item,
        fulfillment: { ...event.fulfillment, occurrenceAssignment: undefined },
      },
      {
        ...event.item,
        fulfillment: { ...event.fulfillment, payeePubkey: event.organizer },
      },
      { ...event.item, merchantPubkey: event.organizer },
      {
        ...event.item,
        shippingOptionId: `30406:${event.merchant}:wrong-shipping`,
      },
    ])
      expect(isCheckoutSparkSettledCart([changed])).toBe(false)
    expect(
      isCheckoutSparkSettledCart([
        event.item,
        {
          ...event.item,
          fulfillment: { ...event.fulfillment, assignment: "Different terms" },
        },
      ])
    ).toBe(false)
  })

  test("free goods with a signed positive organizer minimum still require router funding", async () => {
    for (const minimumSats of [0, 5]) {
      const event = await createEventMarketCheckoutFixture({
        price: 0,
        organizerFee: {
          state: "active",
          basisPoints: 250,
          minimumSats,
          lightningAddress: "organizer@example.test",
        },
      })
      const input = {
        enabled: true,
        freeOrderVerified: true,
        items: [event.item],
        fulfillment: new Map<string, PreparedProductFulfillment>(),
      }
      expect(assessCheckoutSparkCheckoutAdmission(input)).toEqual(
        minimumSats === 0 ? { mode: "free" } : { mode: "router", ready: true }
      )
      const tampered = structuredClone(event.item)
      if (tampered.fulfillment?.type !== "event_market_pickup")
        throw new Error("Missing event")
      tampered.fulfillment.market.signedEvent.content = "Changed signed terms"
      expect(
        assessCheckoutSparkCheckoutAdmission({ ...input, items: [tampered] })
      ).toEqual({ mode: "router", ready: false })
    }
  })
  test("supported SAT and fiat digital purchases require routing", () => {
    expect(assess([digital])).toEqual({ mode: "router", ready: true })
    expect(assess([{ ...digital, currency: "USD", price: 1 }])).toEqual({
      mode: "router",
      ready: true,
    })
  })

  test.each([
    ["BTC", 0.00001],
    ["XBT", 0.00001],
    ["MSAT", 1_000_000],
    ["MSATS", 1_000_000],
  ])(
    "routes deterministic %s prices without a fiat rate",
    (currency, price) => {
      const item = { ...digital, currency, price }
      const pricing = buildCheckoutPricingIntent([item], null)
      expect(pricing.status).toBe("ok")
      if (pricing.status !== "ok") throw new Error("Deterministic price failed")
      expect(pricing.totalSats).toBe(1_000)
      expect(pricing.quote).toBeUndefined()
      expect(assess([item])).toEqual({ mode: "router", ready: true })
    }
  )

  test.each([
    ["BTC", 0.00001],
    ["XBT", 0.00001],
    ["MSAT", 1_000_000],
    ["MSATS", 1_000_000],
  ])(
    "retains deterministic %s source prices on projected SAT carts",
    (currency, amount) => {
      const item = {
        ...digital,
        sourcePrice: { amount, currency, normalizedCurrency: currency },
      }
      const pricing = buildCheckoutPricingIntent([item], null)
      expect(pricing.status).toBe("ok")
      if (pricing.status !== "ok") throw new Error("Deterministic price failed")
      expect(pricing.totalSats).toBe(1_000)
      expect(pricing.quote).toBeUndefined()
      expect(assess([item])).toEqual({ mode: "router", ready: true })
    }
  )

  test.each(["BGN", "XYZ"])(
    "keeps unsupported %s prices blocked instead of authorizing direct fallback",
    (currency) => {
      const nowMs = 1_800_000_000_000
      const quote = {
        rate: 100_000,
        fetchedAt: nowMs,
        source: "mempool" as const,
        fiatUsdRates: { [currency]: 1 },
      }
      for (const item of [
        { ...digital, currency, price: 1 },
        {
          ...digital,
          sourcePrice: { amount: 1, currency, normalizedCurrency: currency },
        },
      ]) {
        expect(assess([item])).toEqual({ mode: "router", ready: false })
        expect(buildCheckoutPricingIntent([item], quote, nowMs).status).toBe(
          "error"
        )
      }
    }
  )

  test("unsupported or unresolved upfront shipping cannot fall back to direct payment", () => {
    const item = { ...physical, shippingOptionId: `30406:${merchant}:pending` }
    const unresolved = new Map<string, PreparedProductFulfillment>([
      [
        item.productId,
        {
          intent: "fixed_standard",
          status: "order_first",
          reason: "unresolved",
        },
      ],
    ])
    expect(assess([item], unresolved)).toEqual({ mode: "router", ready: true })
    expect(
      assess([{ ...item, shippingOptionLaunchUnsupported: true }], unresolved)
    ).toEqual({ mode: "router", ready: false })
  })

  test("missing fulfillment evidence does not establish negotiated shipping", () => {
    expect(assess([physical])).toEqual({ mode: "router", ready: false })
  })

  test("only positively resolved coordinate-after-order shipping retains order-first", () => {
    const negotiated = new Map<string, PreparedProductFulfillment>([
      [
        physical.productId,
        {
          intent: "coordinate_after_order",
          status: "ready",
          reason: "missing_reference",
        },
      ],
    ])
    expect(assess([physical], negotiated)).toEqual({ mode: "order_first" })
    expect(
      assess(
        [{ ...digital, productId: `30402:${merchant}:digital` }, physical],
        negotiated
      )
    ).toEqual({ mode: "order_first" })
  })

  test("verified free and disabled profiles retain their existing flow", () => {
    expect(
      assessCheckoutSparkCheckoutAdmission({
        enabled: true,
        freeOrderVerified: true,
        items: [physical],
        fulfillment: new Map(),
      })
    ).toEqual({ mode: "free" })
    expect(
      assessCheckoutSparkCheckoutAdmission({
        enabled: false,
        freeOrderVerified: false,
        items: [digital],
        fulfillment: new Map(),
      })
    ).toEqual({ mode: "disabled" })
    expect(assess([])).toEqual({ mode: "disabled" })
  })
})
