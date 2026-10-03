import { describe, expect, it } from "bun:test"
import { parseProductEvent, type Product } from "@conduit/core"
import {
  createCartItemFromProduct,
  getCartCostSummary,
  getCartFulfillmentLane,
  groupCartPurchases,
  isPickupCartItem,
  parsePersistedCart,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import { validatePickupContactFields } from "../apps/market/src/lib/checkout-validation"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

function pickup(mode: "merchant_present" | "organizer_handoff", price = 100) {
  const fixture = createEventMarketOrderFixture({ mode, price })
  const product = parseProductEvent(fixture.fulfillment.product.signedEvent!)!
  const item: CartItem = {
    ...createCartItemFromProduct(product, fixture.fulfillment),
    quantity: 2,
  }
  return { fixture, product, item }
}

describe("current Event Market cart preserves ordinary and contact pickup", () => {
  for (const mode of ["merchant_present", "organizer_handoff"] as const) {
    it(`persists and prices standard contact pickup with ${mode}`, () => {
      const { item } = pickup(mode)
      expect(isPickupCartItem(item)).toBe(true)
      expect(getCartFulfillmentLane([item])).toBe("pickup")
      const parsed = parsePersistedCart({ version: 2, items: [item] })
      expect(parsed.state.items[0]?.fulfillment).toEqual(
        JSON.parse(JSON.stringify(item.fulfillment))
      )
      expect(groupCartPurchases(parsed.state.items)).toHaveLength(1)
      expect(getCartCostSummary(parsed.state.items)).toMatchObject({
        count: 2,
        itemSubtotalSats: 200,
        shippingTotalSats: 0,
        totalSats: 200,
        itemPricesAvailable: true,
      })
      expect(
        buildCheckoutPricingIntent(parsed.state.items, null)
      ).toMatchObject({
        status: "ok",
        totalSats: 200,
      })
      expect(
        validatePickupContactFields({
          name: "",
          firstName: "Sam",
          lastName: "Buyer",
          street: "",
          line2: "",
          city: "",
          postalCode: "",
          country: "",
          state: "",
          email: "sam@example.test",
          phone: "",
        })
      ).toEqual([])
    })
  }

  it("keeps ordinary shipping and digital purchases usable beside event pickup", () => {
    const { product, item } = pickup("merchant_present")
    const shippingProduct: Product = {
      ...product,
      shippingCostSats: 25,
      canonicalShippingResolved: true,
      shippingOptionId: `30406:${product.pubkey}:delivery`,
      shippingCountryRules: [
        { code: "US", name: "US", restrictTo: [], exclude: [] },
      ],
    }
    const shipped = {
      ...createCartItemFromProduct(shippingProduct),
      quantity: 1,
    }
    const digital = {
      ...createCartItemFromProduct({ ...product, format: "digital" }),
      quantity: 1,
    }
    expect(shipped.fulfillment).toEqual({ type: "shipping" })
    expect(shipped.shippingOptionId).toBe(shippingProduct.shippingOptionId)
    expect(digital.fulfillment).toEqual({ type: "digital" })
    expect(buildCheckoutPricingIntent([shipped], null)).toMatchObject({
      status: "ok",
      totalSats: 125,
    })
    expect(buildCheckoutPricingIntent([digital], null)).toMatchObject({
      status: "ok",
      totalSats: 100,
    })
    const groups = groupCartPurchases([item, shipped, digital])
    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.kind === "pickup")?.items).toHaveLength(
      1
    )
    expect(
      groups.find((group) => group.kind === "delivery")?.items
    ).toHaveLength(2)
  })

  it("keeps separate purchases for distinct event dates", () => {
    const { item } = pickup("merchant_present")
    if (item.fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing fixture")
    const otherDate = {
      ...item,
      fulfillment: {
        ...item.fulfillment,
        calendar: {
          ...item.fulfillment.calendar,
          coordinate: item.fulfillment.calendar.coordinate + "-next",
        },
      },
    }
    expect(groupCartPurchases([item, otherDate])).toHaveLength(2)
  })

  it("accepts zero-cost event pickup without enabling zero-cost ordinary sales", () => {
    const { item, product } = pickup("organizer_handoff", 0)
    expect(buildCheckoutPricingIntent([item], null)).toMatchObject({
      status: "ok",
      totalSats: 0,
    })
    expect(
      buildCheckoutPricingIntent(
        [{ ...createCartItemFromProduct(product), quantity: 1 }],
        null
      ).status
    ).toBe("error")
  })

  it("drops retired collection pickup without reinterpreting it as shipping", () => {
    const { item } = pickup("merchant_present")
    for (const type of ["pickup", "event_pickup_pending"]) {
      const parsed = parsePersistedCart({
        version: 2,
        items: [{ ...item, fulfillment: { type } }],
      })
      expect(parsed.state.items).toEqual([])
    }
  })
})
