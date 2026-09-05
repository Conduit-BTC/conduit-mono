import { describe, expect, it } from "bun:test"
import {
  type OrderPickupFulfillmentSchema,
  type OrderSummary,
  type ParsedShippingOption,
  type ProductSchema,
} from "@conduit/core"
import {
  getOrderStockPickupFulfillment,
  resolveStockUpdateFulfillmentIntent,
} from "../apps/merchant/src/lib/order-stock-fulfillment"

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
})
