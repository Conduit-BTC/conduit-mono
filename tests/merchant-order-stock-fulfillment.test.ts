import { describe, expect, it } from "bun:test"
import {
  type CommerceProductRecord,
  type OrderPickupFulfillmentSchema,
  type OrderSummary,
  type ParsedShippingOption,
  type ProductSchema,
} from "@conduit/core"
import {
  getOrderStockPickupFulfillment,
  rebaseOrderStockAdjustmentOnProduct,
  resolveStockUpdateFulfillmentIntent,
} from "../apps/merchant/src/lib/order-stock-fulfillment"
import type { OrderStockAdjustment } from "../apps/merchant/src/lib/productStock"

const MERCHANT = "a".repeat(64)
const ORGANIZER = "b".repeat(64)
const PRODUCT_COORDINATE = `30402:${MERCHANT}:event-item`
const COLLECTION_COORDINATE = `30405:${ORGANIZER}:event`
const PICKUP_COORDINATE = `30406:${ORGANIZER}:event-pickup`

function product(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return {
    id: PRODUCT_COORDINATE,
    pubkey: MERCHANT,
    title: "Event item",
    price: 10,
    currency: "SATS",
    type: "simple",
    format: "physical",
    visibility: "private",
    images: [{ url: "https://example.com/event-item.png" }],
    tags: ["event", "item", "pickup"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function pickup(
  overrides: Partial<OrderPickupFulfillmentSchema> = {}
): OrderPickupFulfillmentSchema {
  return {
    type: "pickup",
    organizerPubkey: ORGANIZER,
    product: {
      coordinate: PRODUCT_COORDINATE,
      eventId: "1".repeat(64),
      createdAt: 1_000,
      merchantPubkey: MERCHANT,
    },
    calendar: {
      coordinate: `31923:${ORGANIZER}:calendar`,
      eventId: "2".repeat(64),
      createdAt: 1_000,
    },
    collection: {
      coordinate: COLLECTION_COORDINATE,
      eventId: "3".repeat(64),
      createdAt: 1_000,
    },
    option: {
      coordinate: PICKUP_COORDINATE,
      eventId: "4".repeat(64),
      createdAt: 1_000,
      title: "Event pickup",
      location: "Booth 5",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: ORGANIZER,
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
    ...overrides,
  }
}

function standardShippingOption(coordinate: string): ParsedShippingOption {
  return {
    eventId: "5".repeat(64),
    id: coordinate,
    pubkey: MERCHANT,
    dTag: "standard",
    title: "Standard shipping",
    currency: "SATS",
    price: 5,
    countries: ["US"],
    countryRules: [
      {
        code: "US",
        name: "United States",
        restrictTo: [],
        exclude: [],
      },
    ],
    service: "standard",
    createdAt: 1_000,
    launchUnsupportedTags: [],
  }
}

describe("merchant stock update fulfillment", () => {
  it("rebases a calculated update onto the exact verified product revision", () => {
    const adjustment: OrderStockAdjustment = {
      key: "order:item",
      addressId: PRODUCT_COORDINATE,
      sourceEventId: "1".repeat(64),
      title: "Stale title",
      quantity: 3,
      currentStock: 10,
      nextStock: 7,
      shortfall: 0,
    }
    const currentRecord: CommerceProductRecord = {
      product: product({ title: "Current title", stock: 5 }),
      eventId: "9".repeat(64),
      addressId: PRODUCT_COORDINATE,
      dTag: "event-item",
      eventCreatedAt: 3_000,
    }

    expect(
      rebaseOrderStockAdjustmentOnProduct({
        adjustment,
        record: currentRecord,
      })
    ).toEqual({
      ...adjustment,
      sourceEventId: currentRecord.eventId,
      title: "Current title",
      currentStock: 5,
      nextStock: 2,
      shortfall: 0,
    })
    expect(currentRecord.product.stock).toBe(5)
  })

  it("keeps an explicit target while preserving the current product revision", () => {
    const adjustment: OrderStockAdjustment = {
      key: "order:item",
      addressId: PRODUCT_COORDINATE,
      sourceEventId: "1".repeat(64),
      title: "Stale title",
      quantity: 3,
      currentStock: 10,
      nextStock: 12,
      shortfall: 0,
      targetMode: "custom",
    }
    const currentRecord: CommerceProductRecord = {
      product: product({ title: "Current title", stock: 5 }),
      eventId: "9".repeat(64),
      addressId: PRODUCT_COORDINATE,
      dTag: "event-item",
      eventCreatedAt: 3_000,
    }

    expect(
      rebaseOrderStockAdjustmentOnProduct({
        adjustment,
        record: currentRecord,
      })
    ).toMatchObject({
      sourceEventId: currentRecord.eventId,
      title: "Current title",
      currentStock: 5,
      nextStock: 12,
      targetMode: "custom",
    })
  })

  it("rejects a stale simple product whose verified revision is variable", () => {
    const adjustment: OrderStockAdjustment = {
      key: "order:item",
      addressId: PRODUCT_COORDINATE,
      sourceEventId: "1".repeat(64),
      title: "Stale simple product",
      quantity: 1,
      currentStock: 10,
      nextStock: 9,
      shortfall: 0,
    }
    const variableRecord: CommerceProductRecord = {
      product: product({ type: "variable", stock: 10 }),
      eventId: "9".repeat(64),
      addressId: PRODUCT_COORDINATE,
      dTag: "event-item",
      eventCreatedAt: 3_000,
    }

    expect(() =>
      rebaseOrderStockAdjustmentOnProduct({
        adjustment,
        record: variableRecord,
      })
    ).toThrow("cannot be used for this stock update")
  })

  it("still rebases a verified variation revision", () => {
    const adjustment: OrderStockAdjustment = {
      key: "order:item",
      addressId: PRODUCT_COORDINATE,
      sourceEventId: "1".repeat(64),
      title: "Variation",
      quantity: 2,
      currentStock: 8,
      nextStock: 6,
      shortfall: 0,
    }
    const variationRecord: CommerceProductRecord = {
      product: product({ type: "variation", stock: 5 }),
      eventId: "9".repeat(64),
      addressId: PRODUCT_COORDINATE,
      dTag: "event-item",
      eventCreatedAt: 3_000,
    }

    expect(
      rebaseOrderStockAdjustmentOnProduct({
        adjustment,
        record: variationRecord,
      }).nextStock
    ).toBe(3)
  })

  it("preserves exact currently verified event pickup references", async () => {
    const fulfillment = pickup()
    const eventProduct = product({
      collectionRefs: [COLLECTION_COORDINATE],
      shippingOptionId: PICKUP_COORDINATE,
      shippingOptionRefs: [
        { coordinate: PICKUP_COORDINATE, relayHints: ["wss://relay.example"] },
      ],
      canonicalShippingResolved: false,
    })

    expect(
      await resolveStockUpdateFulfillmentIntent(
        {
          product: eventProduct,
          productAddressId: PRODUCT_COORDINATE,
          verifiedPickup: fulfillment,
        },
        {
          getShippingOptions: async () => {
            throw new Error("event pickup must not be treated as shipping")
          },
        }
      )
    ).toEqual({ kind: "coordinate_after_order" })
  })

  it("preserves a collection-level event pickup reference", async () => {
    const fulfillment = pickup()
    const eventProduct = product({
      collectionRefs: [COLLECTION_COORDINATE],
      shippingOptionId: COLLECTION_COORDINATE,
      shippingOptionRefs: [{ coordinate: COLLECTION_COORDINATE }],
      canonicalShippingResolved: false,
    })

    expect(
      await resolveStockUpdateFulfillmentIntent({
        product: eventProduct,
        productAddressId: PRODUCT_COORDINATE,
        orderHasPickupClaim: true,
        verifiedPickup: fulfillment,
      })
    ).toEqual({ kind: "coordinate_after_order" })
    expect(eventProduct.shippingOptionId).toBe(COLLECTION_COORDINATE)
    expect(eventProduct.shippingOptionRefs).toEqual([
      { coordinate: COLLECTION_COORDINATE },
    ])
  })

  it("keeps an ordinary standard option fixed despite collection membership", async () => {
    const shippingCoordinate = `30406:${MERCHANT}:standard`
    const ordinaryProduct = product({
      visibility: "public",
      collectionRefs: [COLLECTION_COORDINATE],
      shippingOptionId: shippingCoordinate,
      shippingOptionDTag: "standard",
      shippingOptionRefs: [
        { coordinate: shippingCoordinate, relayHints: ["wss://relay.example"] },
      ],
      canonicalShippingResolved: false,
      shippingOptionLaunchUnsupported: false,
    })

    expect(
      await resolveStockUpdateFulfillmentIntent(
        {
          product: ordinaryProduct,
          productAddressId: PRODUCT_COORDINATE,
        },
        {
          getShippingOptions: async () => [
            standardShippingOption(shippingCoordinate),
          ],
        }
      )
    ).toEqual({
      kind: "fixed_standard",
      amount: 5,
      currency: "SATS",
      countries: ["US"],
    })
  })

  it("rejects a verified pickup that does not match the current listing", async () => {
    await expect(
      resolveStockUpdateFulfillmentIntent({
        product: product({
          collectionRefs: [COLLECTION_COORDINATE],
          shippingOptionId: PICKUP_COORDINATE,
          shippingOptionRefs: [{ coordinate: PICKUP_COORDINATE }],
          canonicalShippingResolved: false,
        }),
        productAddressId: PRODUCT_COORDINATE,
        verifiedPickup: pickup({
          collection: {
            coordinate: `30405:${ORGANIZER}:other-event`,
            eventId: "6".repeat(64),
            createdAt: 1_000,
          },
        }),
      })
    ).rejects.toThrow("no longer matches")
  })

  it("selects pickup only for the matching product coordinate", () => {
    const fulfillment = pickup()
    const items = [
      {
        productId: PRODUCT_COORDINATE,
        format: "physical" as const,
        fulfillment,
        quantity: 1,
        priceAtPurchase: 10,
        currency: "SATS",
      },
    ] satisfies OrderSummary["items"]

    expect(
      getOrderStockPickupFulfillment({
        items,
        productAddressId: PRODUCT_COORDINATE,
      })
    ).toEqual(fulfillment)
    expect(
      getOrderStockPickupFulfillment({
        items,
        productAddressId: `30402:${MERCHANT}:other-item`,
      })
    ).toBeNull()
  })

  it("allows digital stock updates in an order that also has pickup", async () => {
    expect(
      await resolveStockUpdateFulfillmentIntent({
        product: product({ format: "digital" }),
        productAddressId: `30402:${MERCHANT}:digital-item`,
        orderHasPickupClaim: true,
      })
    ).toEqual({ kind: "digital" })
  })

  it("rejects an unmatched physical target in a pickup order", async () => {
    await expect(
      resolveStockUpdateFulfillmentIntent({
        product: product(),
        productAddressId: `30402:${MERCHANT}:other-item`,
        orderHasPickupClaim: true,
      })
    ).rejects.toThrow("does not match")
  })
})
