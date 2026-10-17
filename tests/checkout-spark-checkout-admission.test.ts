import { describe, expect, test } from "bun:test"
import type { PreparedProductFulfillment } from "@conduit/core"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import { assessCheckoutSparkCheckoutAdmission } from "../apps/market/src/lib/checkout-spark-checkout-admission"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import { isCheckoutSparkSettledCart } from "../apps/market/src/lib/checkout-spark-settled-cart"
import { createEventMarketCheckoutFixture } from "./helpers/event-market-checkout-fixture"

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

describe("required checkout routing is separate from readiness", () => {
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
