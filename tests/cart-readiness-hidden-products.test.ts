import { describe, expect, it } from "bun:test"
import type { Product } from "@conduit/core"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import {
  getCartAvailabilityReadScopes,
  getCartMerchantHiddenProductIds,
  merchantCartAvailabilityQueryKey,
} from "../apps/market/src/hooks/useCartReadiness"
import {
  getCartAvailabilityReadDecision,
  getCartProductAvailability,
} from "../apps/market/src/lib/cart-model"

const merchantPubkey = "a".repeat(64)
const productId = `30402:${merchantPubkey}:event-product`
const ordinaryProductId = `30402:${merchantPubkey}:ordinary-product`

function pickupFulfillment(): CartItem["fulfillment"] {
  return {
    type: "pickup",
    organizerPubkey: "b".repeat(64),
    product: {
      coordinate: productId,
      eventId: "1".repeat(64),
      createdAt: 100,
      merchantPubkey,
    },
    calendar: {
      coordinate: `31922:${"b".repeat(64)}:event`,
      eventId: "2".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: `30405:${"b".repeat(64)}:market`,
      eventId: "3".repeat(64),
      createdAt: 102,
    },
    option: {
      coordinate: `30406:${"b".repeat(64)}:pickup`,
      eventId: "4".repeat(64),
      createdAt: 103,
      title: "Pickup",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: "b".repeat(64),
    costSats: 0,
    sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
  }
}

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
    const eventPickup = item(pickupFulfillment())

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

  it("does not let a pickup hidden-listing exception leak into delivery", () => {
    const shipping = item({ type: "shipping" })
    const pickup = item(pickupFulfillment())
    const scopes = getCartAvailabilityReadScopes([shipping, pickup])

    expect(scopes).toHaveLength(2)
    expect(
      scopes.map((scope) => scope.merchantHiddenProductIds).sort()
    ).toEqual([[], [productId]])
    expect(scopes.every((scope) => scope.productIds[0] === productId)).toBe(
      true
    )

    const hiddenProduct: Product = {
      id: productId,
      pubkey: merchantPubkey,
      title: "Event product",
      price: 10,
      currency: "SATS",
      type: "simple",
      format: "physical",
      visibility: "hidden",
      images: [],
      tags: [],
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
      publicZapPolicyKnown: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const pickupDecision = getCartAvailabilityReadDecision({
      productIds: [productId],
      availability: getCartProductAvailability([pickup], [hiddenProduct]),
      meta: { source: "commerce", stale: false, degraded: false },
      diagnostics: [
        {
          productId,
          addressId: productId,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
      querySucceeded: true,
    })
    const deliveryDecision = getCartAvailabilityReadDecision({
      productIds: [productId],
      availability: getCartProductAvailability([shipping], []),
      meta: { source: "commerce", stale: false, degraded: false },
      diagnostics: [
        { productId, addressId: productId, issue: "listing_filtered" },
      ],
      querySucceeded: true,
    })

    expect(pickupDecision).toEqual({
      status: "verified_at_read",
      coverage: "complete",
    })
    expect(deliveryDecision).toMatchObject({
      status: "unverified",
      reason: "listing_filtered",
    })
  })

  it("separates signed-in relay scopes while preserving the guest key", () => {
    const guest = merchantCartAvailabilityQueryKey(merchantPubkey, [productId])
    const accountA = merchantCartAvailabilityQueryKey(
      merchantPubkey,
      [productId],
      [],
      "account:a"
    )
    const accountB = merchantCartAvailabilityQueryKey(
      merchantPubkey,
      [productId],
      [],
      "account:b"
    )

    expect(accountA).not.toEqual(guest)
    expect(accountB).not.toEqual(guest)
    expect(accountA).not.toEqual(accountB)
  })
})
