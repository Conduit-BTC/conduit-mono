import { describe, expect, it } from "bun:test"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import {
  getCartMerchantHiddenProductIds,
  merchantCartAvailabilityQueryKey,
} from "../apps/market/src/hooks/useCartReadiness"

const merchantPubkey = "a".repeat(64)
const productId = `30402:${merchantPubkey}:event-product`
const ordinaryProductId = `30402:${merchantPubkey}:ordinary-product`

function item(fulfillment: CartItem["fulfillment"], id = productId): CartItem {
  return {
    productId: id,
    merchantPubkey,
    title: "Event product",
    price: 10,
    currency: "SATS",
    quantity: 1,
    fulfillment,
  }
}

describe("cart readiness hidden product scope", () => {
  it("opts only explicit event pickup coordinates into exact hidden reads", () => {
    const ordinary = item({ type: "shipping" }, ordinaryProductId)
    const eventPickup = item({ type: "pickup" } as CartItem["fulfillment"])

    expect(getCartMerchantHiddenProductIds([ordinary])).toEqual([])
    expect(getCartMerchantHiddenProductIds([ordinary, eventPickup])).toEqual([
      productId,
    ])
  })

  it("separates ordinary and event-pickup readiness query caches", () => {
    expect(
      merchantCartAvailabilityQueryKey(merchantPubkey, [productId])
    ).toEqual(["merchant-cart-availability", merchantPubkey, [productId], []])
    expect(
      merchantCartAvailabilityQueryKey(merchantPubkey, [productId], [productId])
    ).toEqual([
      "merchant-cart-availability",
      merchantPubkey,
      [productId],
      [productId],
    ])
  })
})
