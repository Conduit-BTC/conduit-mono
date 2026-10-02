import { describe, expect, it } from "bun:test"
import { getEventHash } from "nostr-tools/pure"
import type { OrderSchema } from "../packages/core/src/schemas"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  parseOrderMessageRumorEvent,
} from "../packages/core/src/protocol/orders"

const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const SHIPPING_D_TAG = "print-shipping-standard"
const SHIPPING = `30406:${MERCHANT}:${SHIPPING_D_TAG}`

function order(shippingSats = 20): OrderSchema {
  return {
    id: "fixed-shipping-router-order",
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    items: [
      {
        productId: `30402:${MERCHANT}:print`,
        format: "physical",
        fulfillment: { type: "shipping" },
        quantity: 2,
        priceAtPurchase: 1_000,
        currency: "SATS",
        sourcePrice: {
          amount: 1_000,
          currency: "SAT",
          normalizedCurrency: "SATS",
        },
        shippingCostSats: shippingSats,
        sourceShippingCost: {
          amount: shippingSats,
          currency: "SAT",
          normalizedCurrency: "SATS",
        },
        shippingOptionId: SHIPPING,
        shippingOptionDTag: SHIPPING_D_TAG,
        shippingCountries: ["US"],
        shippingCountryRules: [
          { code: "US", name: "United States", restrictTo: [], exclude: [] },
        ],
      },
      {
        productId: `30402:${MERCHANT}:download`,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 100,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 2_100 + shippingSats * 2,
    currency: "SATS",
    shippingCostSats: shippingSats * 2,
    shippingCostStatus: shippingSats > 0 ? "priced" : "included",
    shippingAddress: {
      name: "Example Shopper",
      street: "1 Example Street",
      city: "Example City",
      postalCode: "10001",
      country: "US",
    },
    createdAt: 1_800_000_000_000,
  }
}

function rumor(payload: OrderSchema, marked = true) {
  const event = {
    kind: 16,
    pubkey: BUYER,
    created_at: payload.createdAt / 1_000,
    content: JSON.stringify(payload),
    tags: [
      ["p", MERCHANT],
      ["type", "order"],
      ["order", payload.id],
      ["amount", String(payload.subtotal)],
      ["currency", payload.currency],
      ...payload.items.flatMap((item) => [
        ["item", item.productId, String(item.quantity)],
        ...(item.shippingOptionId ? [["shipping", item.shippingOptionId]] : []),
      ]),
      ...(marked ? [[...CHECKOUT_SPARK_ROUTER_ORDER_TAG]] : []),
    ],
  }
  return { ...event, id: getEventHash(event) }
}

describe("fixed-shipping checkout router order parsing", () => {
  it("accepts a mixed fixed-shipping and digital order with quantity-adjusted shipping", () => {
    const payload = order()
    const parsed = parseOrderMessageRumorEvent(rumor(payload))
    expect(parsed.type).toBe("order")
    if (parsed.type !== "order") throw new Error("Expected an order")
    expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
    expect(parsed.payload).toEqual(payload)
  })

  it("accepts included fixed shipping with its address and selected option", () => {
    const payload = order(0)
    const parsed = parseOrderMessageRumorEvent(rumor(payload))
    expect(parsed.type).toBe("order")
    if (parsed.type !== "order") throw new Error("Expected an order")
    expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
    expect(parsed.payload.shippingCostStatus).toBe("included")
    expect(parsed.payload.items[0]?.shippingOptionId).toBe(SHIPPING)
  })

  it("preserves structured guest contact on the private shipped order", () => {
    const payload = order()
    payload.buyerIdentityKind = "guest_ephemeral"
    payload.guestContact = {
      email: "shopper@example.com",
      phone: "+15555550100",
    }
    const parsed = parseOrderMessageRumorEvent(rumor(payload))
    expect(parsed.type).toBe("order")
    if (parsed.type !== "order") throw new Error("Expected an order")
    expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
    expect(parsed.payload.shippingAddress).toEqual(payload.shippingAddress)
    expect(parsed.payload.guestContact).toEqual(payload.guestContact)
  })

  it("keeps the previous digital-only marker shape readable", () => {
    const physical = order()
    const digital = physical.items[1]!
    const payload: OrderSchema = {
      ...physical,
      items: [{ ...digital, fulfillment: undefined }],
      subtotal: digital.priceAtPurchase,
      shippingCostSats: 0,
      shippingCostStatus: "not_required",
      shippingAddress: undefined,
    }
    const parsed = parseOrderMessageRumorEvent(rumor(payload))
    expect(parsed.type).toBe("order")
    if (parsed.type !== "order") throw new Error("Expected an order")
    expect(parsed.checkoutPaymentRoute).toBe("spark_router_v1")
  })

  it("leaves an ordinary manual-shipping order on its existing non-router path", () => {
    const payload = order()
    const shipped = payload.items[0]!
    payload.items = [
      {
        ...shipped,
        shippingCostSats: undefined,
        sourceShippingCost: undefined,
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
        shippingCountries: undefined,
        shippingCountryRules: undefined,
      },
    ]
    payload.subtotal = shipped.priceAtPurchase * shipped.quantity
    payload.shippingCostSats = undefined
    payload.shippingCostStatus = "manual"
    const parsed = parseOrderMessageRumorEvent(rumor(payload, false))
    expect(parsed.type).toBe("order")
    if (parsed.type !== "order") throw new Error("Expected an order")
    expect(parsed.checkoutPaymentRoute).toBeUndefined()
    expect(parsed.payload.shippingCostStatus).toBe("manual")
    expect(() => parseOrderMessageRumorEvent(rumor(payload))).toThrow(
      "Invalid private checkout payment marker"
    )
  })

  it("does not admit a shipping order before its required address and option are present", () => {
    const payload = order()
    payload.shippingAddress = undefined
    expect(() => parseOrderMessageRumorEvent(rumor(payload))).toThrow(
      "Invalid private checkout payment marker"
    )
    const withoutOption = order()
    withoutOption.items[0]!.shippingOptionId = undefined
    withoutOption.items[0]!.shippingOptionDTag = undefined
    expect(() => parseOrderMessageRumorEvent(rumor(withoutOption))).toThrow(
      "Invalid private checkout payment marker"
    )
  })

  it("keeps fiat and variation orders outside this bounded router shape", () => {
    const fiat = order()
    fiat.items[0]!.sourcePrice = {
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    }
    expect(() => parseOrderMessageRumorEvent(rumor(fiat))).toThrow(
      "Invalid private checkout payment marker"
    )
    const variation = order()
    variation.items[0]!.familyProductId = `30402:${MERCHANT}:print-family`
    variation.items[0]!.selectedSpecifications = [
      { key: "size", value: "small" },
    ]
    expect(() => parseOrderMessageRumorEvent(rumor(variation))).toThrow(
      "Invalid private checkout payment marker"
    )
  })
})
