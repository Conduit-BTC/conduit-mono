import { describe, expect, it } from "bun:test"
import type { ParsedShippingOption, Product } from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import {
  createCartItemFromProduct,
  type CartItem,
  type CartPickupFulfillment,
} from "../apps/market/src/lib/cart-model"

const MERCHANT = "a".repeat(64)
const PRODUCT_ID = `30402:${MERCHANT}:field-notes`
const SHIPPING_ID = `30406:${MERCHANT}:field-notes-shipping-standard`
const ORGANIZER = "b".repeat(64)
const COLLECTION_ID = `30405:${ORGANIZER}:chicago-market`
const CALENDAR_ID = `31923:${ORGANIZER}:chicago-market`
const PICKUP_ID = `30406:${ORGANIZER}:chicago-market-pickup`

function rawItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: PRODUCT_ID,
    merchantPubkey: MERCHANT,
    title: "Field Notes",
    price: 20,
    currency: "USD",
    sourcePrice: {
      amount: 20,
      currency: "USD",
      normalizedCurrency: "USD",
    },
    format: "physical",
    shippingOptionId: SHIPPING_ID,
    shippingOptionDTag: "field-notes-shipping-standard",
    productUpdatedAt: 2,
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    quantity: 2,
    ...overrides,
  }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    pubkey: MERCHANT,
    title: "Field Notes",
    price: 20,
    currency: "USD",
    sourcePrice: {
      amount: 20,
      currency: "USD",
      normalizedCurrency: "USD",
    },
    type: "simple",
    specifications: [],
    format: "physical",
    shippingOptionId: SHIPPING_ID,
    shippingOptionDTag: "field-notes-shipping-standard",
    visibility: "public",
    images: [],
    tags: [],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function shippingOption(
  overrides: Partial<ParsedShippingOption> = {}
): ParsedShippingOption {
  return {
    eventId: "1".repeat(64),
    id: SHIPPING_ID,
    pubkey: MERCHANT,
    dTag: "field-notes-shipping-standard",
    title: "Standard Shipping",
    currency: "USD",
    price: 5,
    countries: ["US"],
    countryRules: [{ code: "US", name: "US", restrictTo: [], exclude: [] }],
    service: "standard",
    createdAt: 1,
    launchUnsupportedTags: [],
    ...overrides,
  }
}

function pickupFulfillment(
  overrides: Partial<CartPickupFulfillment> = {}
): CartPickupFulfillment {
  return {
    type: "pickup",
    organizerPubkey: ORGANIZER,
    product: {
      coordinate: PRODUCT_ID,
      eventId: "2".repeat(64),
      createdAt: 2,
      merchantPubkey: MERCHANT,
    },
    calendar: {
      coordinate: CALENDAR_ID,
      eventId: "3".repeat(64),
      createdAt: 3,
    },
    collection: {
      coordinate: COLLECTION_ID,
      eventId: "4".repeat(64),
      createdAt: 4,
    },
    option: {
      coordinate: PICKUP_ID,
      eventId: "5".repeat(64),
      createdAt: 5,
      title: "Chicago pickup",
      location: "Market entrance",
    },
    handoffMode: "organizer_handoff",
    handlerPubkey: ORGANIZER,
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SAT",
      normalizedCurrency: "SAT",
    },
    ...overrides,
  }
}

function pickupProduct(): Product {
  return product({
    shippingOptionId: PICKUP_ID,
    shippingOptionDTag: "chicago-market-pickup",
    shippingOptionRefs: [{ coordinate: PICKUP_ID }],
    collectionRefs: [COLLECTION_ID],
    canonicalShippingResolved: false,
  })
}

describe("checkout authorization refresh", () => {
  it("accepts unchanged raw listing terms after preparing the fresh shipping option", async () => {
    const original = rawItem()
    const option = shippingOption()
    const reviewed = {
      ...original,
      shippingCostSats: undefined,
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
      shippingCountryRules: option.countryRules,
      canonicalShippingResolved: true,
    }

    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [reviewed],
      rawItems: [original],
      refreshedProducts: [product()],
      readShippingOptions: async (coordinates) => {
        expect(coordinates).toEqual([SHIPPING_ID])
        return [option]
      },
    })

    expect(result).toMatchObject({ status: "ok", items: [reviewed] })
  })

  it("blocks when the referenced shipping terms change after review", async () => {
    const original = rawItem()
    const reviewedOption = shippingOption()
    const reviewed = {
      ...original,
      shippingCostSats: undefined,
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
      shippingCountryRules: reviewedOption.countryRules,
      canonicalShippingResolved: true,
    }

    for (const mode of ["direct_payment", "order_first"] as const) {
      const result = await authorizeCurrentCheckoutItems({
        mode,
        reviewedItems: [reviewed],
        rawItems: [original],
        refreshedProducts: [product()],
        readShippingOptions: async () => [shippingOption({ price: 6 })],
      })

      expect(result).toEqual({ status: "changed" })
    }
  })

  it("blocks when the referenced shipping option is withdrawn", async () => {
    const original = rawItem()
    const option = shippingOption()
    for (const mode of ["direct_payment", "order_first"] as const) {
      const result = await authorizeCurrentCheckoutItems({
        mode,
        reviewedItems: [
          {
            ...original,
            shippingCostSats: undefined,
            sourceShippingCost: {
              amount: 5,
              currency: "USD",
              normalizedCurrency: "USD",
            },
            shippingCountries: ["US"],
            shippingCountryRules: option.countryRules,
            canonicalShippingResolved: true,
          },
        ],
        rawItems: [original],
        refreshedProducts: [product()],
        readShippingOptions: async () => [],
      })

      expect(result).toEqual({ status: "changed" })
    }
  })

  it("blocks changed raw listing terms before reading shipping", async () => {
    let shippingRead = false
    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [rawItem()],
      rawItems: [rawItem()],
      refreshedProducts: [product({ price: 21 })],
      readShippingOptions: async () => {
        shippingRead = true
        return [shippingOption()]
      },
    })

    expect(result).toEqual({ status: "changed" })
    expect(shippingRead).toBe(false)
  })

  it("fails closed for direct payment when the shipping read is incomplete or unavailable", async () => {
    const original = rawItem()
    for (const message of [
      "Fixed shipping relay coverage was partial",
      "Fixed shipping could not be verified",
    ]) {
      await expect(
        authorizeCurrentCheckoutItems({
          mode: "direct_payment",
          reviewedItems: [original],
          rawItems: [original],
          refreshedProducts: [product()],
          readShippingOptions: async () => {
            throw new Error(message)
          },
        })
      ).rejects.toThrow(message)
    }
  })

  it("degrades incomplete or unavailable shipping reads to an unpriced order-first snapshot", async () => {
    const original = rawItem()
    const option = shippingOption()
    const reviewed = {
      ...original,
      shippingCostSats: 5,
      sourceShippingCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingCountries: ["US"],
      shippingCountryRules: option.countryRules,
      canonicalShippingResolved: true,
    }

    for (const message of [
      "Fixed shipping relay coverage was partial",
      "Fixed shipping could not be verified",
    ]) {
      const result = await authorizeCurrentCheckoutItems({
        mode: "order_first",
        reviewedItems: [reviewed],
        rawItems: [original],
        refreshedProducts: [product()],
        readShippingOptions: async () => {
          throw new Error(message)
        },
      })

      expect(result.status).toBe("ok")
      if (result.status !== "ok") throw new Error("Expected order-first items")
      expect(result.items[0]).toMatchObject({
        productId: PRODUCT_ID,
        price: 20,
        quantity: 2,
        canonicalShippingResolved: false,
      })
      expect(result.items[0]?.shippingCostSats).toBeUndefined()
      expect(result.items[0]?.sourceShippingCost).toBeUndefined()
      expect(result.items[0]?.shippingOptionId).toBeUndefined()
      expect(result.items[0]?.shippingOptionDTag).toBeUndefined()
      expect(result.items[0]?.shippingCountries).toBeUndefined()
      expect(result.items[0]?.shippingCountryRules).toBeUndefined()
    }
  })

  it("does not request 30406 data for digital or coordinate-after-order items", async () => {
    for (const format of ["digital", "physical"] as const) {
      const item = rawItem({
        format,
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
      })
      let shippingRead = false
      const result = await authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        reviewedItems: [item],
        rawItems: [item],
        refreshedProducts: [
          product({
            format,
            shippingOptionId: undefined,
            shippingOptionDTag: undefined,
          }),
        ],
        readShippingOptions: async () => {
          shippingRead = true
          return []
        },
      })

      expect(result.status).toBe("ok")
      expect(shippingRead).toBe(false)
    }
  })

  it("preserves the selected variation snapshot and quantity", async () => {
    const selection = [{ key: "size", value: "10" }]
    const item = rawItem({
      familyProductId: `30402:${MERCHANT}:field-notes-parent`,
      selectedSpecifications: selection,
      format: "digital",
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      quantity: 3,
    })

    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [item],
      rawItems: [item],
      refreshedProducts: [
        product({
          type: "variation",
          parentProductId: item.familyProductId,
          specifications: selection,
          format: "digital",
          shippingOptionId: undefined,
          shippingOptionDTag: undefined,
        }),
      ],
      readShippingOptions: async () => [],
    })

    expect(result).toMatchObject({
      status: "ok",
      items: [
        {
          familyProductId: item.familyProductId,
          selectedSpecifications: selection,
          quantity: 3,
        },
      ],
    })
  })

  it("blocks changed variation specifications, parent, or product type", async () => {
    const selection = [{ key: "size", value: "10" }]
    const familyProductId = `30402:${MERCHANT}:field-notes-parent`
    const item = rawItem({
      familyProductId,
      selectedSpecifications: selection,
      format: "digital",
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
    })
    const refreshedVariation = product({
      type: "variation",
      parentProductId: familyProductId,
      specifications: selection,
      format: "digital",
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
    })

    for (const changedProduct of [
      {
        ...refreshedVariation,
        specifications: [{ key: "size", value: "11" }],
      },
      {
        ...refreshedVariation,
        parentProductId: `30402:${MERCHANT}:other-parent`,
      },
      { ...refreshedVariation, type: "variable" as const },
    ]) {
      const result = await authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        reviewedItems: [item],
        rawItems: [item],
        refreshedProducts: [changedProduct],
        readShippingOptions: async () => [],
      })

      expect(result).toEqual({ status: "changed" })
    }
  })

  it("authorizes one exact pickup snapshot through the submit-time seam", async () => {
    const refreshedProduct = pickupProduct()
    const fulfillment = pickupFulfillment()
    const item = {
      ...createCartItemFromProduct(refreshedProduct, fulfillment),
      quantity: 2,
    }
    let shippingRead = false
    let handlerAuthorizationCount = 0

    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [item],
      rawItems: [item],
      refreshedProducts: [refreshedProduct],
      readShippingOptions: async () => {
        shippingRead = true
        return []
      },
      resolveProductFulfillment: async () => ({
        status: "pickup",
        product: refreshedProduct,
        fulfillment,
      }),
      authorizePickupHandlers: async (items) => {
        handlerAuthorizationCount += 1
        expect(items[0]?.fulfillment).toEqual(fulfillment)
      },
    })

    expect(result).toEqual({ status: "ok", items: [item] })
    expect(shippingRead).toBe(false)
    expect(handlerAuthorizationCount).toBe(1)
  })

  it("blocks a changed pickup graph before handler authorization", async () => {
    const refreshedProduct = pickupProduct()
    const reviewedFulfillment = pickupFulfillment()
    const item = {
      ...createCartItemFromProduct(refreshedProduct, reviewedFulfillment),
      quantity: 1,
    }
    let handlerAuthorized = false

    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [item],
      rawItems: [item],
      refreshedProducts: [refreshedProduct],
      readShippingOptions: async () => [],
      resolveProductFulfillment: async () => ({
        status: "pickup",
        product: refreshedProduct,
        fulfillment: pickupFulfillment({
          calendar: {
            ...reviewedFulfillment.calendar,
            eventId: "6".repeat(64),
          },
        }),
      }),
      authorizePickupHandlers: async () => {
        handlerAuthorized = true
      },
    })

    expect(result).toEqual({ status: "changed" })
    expect(handlerAuthorized).toBe(false)
  })

  it("propagates fail-closed pickup handler authorization", async () => {
    const refreshedProduct = pickupProduct()
    const fulfillment = pickupFulfillment()
    const item = {
      ...createCartItemFromProduct(refreshedProduct, fulfillment),
      quantity: 1,
    }

    await expect(
      authorizeCurrentCheckoutItems({
        mode: "direct_payment",
        reviewedItems: [item],
        rawItems: [item],
        refreshedProducts: [refreshedProduct],
        readShippingOptions: async () => [],
        resolveProductFulfillment: async () => ({
          status: "pickup",
          product: refreshedProduct,
          fulfillment,
        }),
        authorizePickupHandlers: async () => {
          throw new Error("Organizer inbox coverage is partial")
        },
      })
    ).rejects.toThrow("Organizer inbox coverage is partial")
  })
})
