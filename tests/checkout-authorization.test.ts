import { describe, expect, it } from "bun:test"
import type { ParsedShippingOption, Product } from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import {
  createCartItemFromProduct,
  type CartItem,
} from "../apps/market/src/lib/cart-model"

import { createEventMarketCheckoutFixture } from "./helpers/event-market-checkout-fixture"

const MERCHANT = "a".repeat(64)
const PRODUCT_ID = `30402:${MERCHANT}:field-notes`
const SHIPPING_ID = `30406:${MERCHANT}:field-notes-shipping-standard`
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

describe("checkout authorization refresh", () => {
  it("accepts unchanged raw listing terms after preparing the fresh shipping option", async () => {
    const original = rawItem()
    const option = shippingOption()
    const refreshedProduct = product({ sourceEventId: "9".repeat(64) })
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
      refreshedProducts: [refreshedProduct],
      readShippingOptions: async (coordinates) => {
        expect(coordinates).toEqual([SHIPPING_ID])
        return [option]
      },
    })

    expect(result).toMatchObject({ status: "ok", items: [reviewed] })
    if (result.status !== "ok") throw new Error("Expected authorized items")
    expect(result.listingReadProducts[0]).toBe(refreshedProduct)
    expect(result.fulfillmentResolvedProducts[0]).toBe(refreshedProduct)
    expect(result.listingReadProducts[0]?.sourceEventId).toBe("9".repeat(64))
    expect(result.shippingOptionEvidence).toEqual({
      status: "verified",
      options: [option],
    })
    if (result.shippingOptionEvidence.status === "verified") {
      expect(result.shippingOptionEvidence.options[0]).toBe(option)
      expect(result.shippingOptionEvidence.options[0]?.eventId).toBe(
        "1".repeat(64)
      )
    }
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
      expect(result.listingReadProducts[0]?.id).toBe(PRODUCT_ID)
      expect(result.fulfillmentResolvedProducts[0]?.id).toBe(PRODUCT_ID)
      expect(result.shippingOptionEvidence).toEqual({
        status: "unavailable_order_first",
        options: [],
      })
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
      if (result.status === "ok") {
        expect(result.shippingOptionEvidence).toEqual({
          status: "not_required",
          options: [],
        })
      }
    }
  })

  it("retains the exact product revision and allocation projection for later quote authority", async () => {
    const revisionEventId = "9".repeat(64)
    // CND-225 supplies the typed allocation field when these branches join.
    // This tests transport of the upstream projection, not its signature.
    const allocation = {
      state: "valid" as const,
      revisionEventId,
      revisionCreatedAt: 12,
      recipients: [{ pubkey: MERCHANT, role: "merchant", weight: 2 }],
    }
    const refreshedProduct = {
      ...product({
        sourceEventId: revisionEventId,
        updatedAt: 12_000,
        format: "digital",
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
      }),
      supplierAllocation: allocation,
    }
    const item = createCartItemFromProduct(refreshedProduct)

    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [item],
      rawItems: [item],
      refreshedProducts: [refreshedProduct],
      readShippingOptions: async () => {
        throw new Error("Digital checkout must not read shipping options")
      },
      resolveProductFulfillment: async () => ({
        status: "standard",
        type: "digital",
        product: refreshedProduct,
      }),
    })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("Expected authorized items")
    expect(result.listingReadProducts[0]).toBe(refreshedProduct)
    expect(result.fulfillmentResolvedProducts[0]).toBe(refreshedProduct)
    expect(result.listingReadProducts[0]).toEqual(
      expect.objectContaining({
        sourceEventId: revisionEventId,
        supplierAllocation: allocation,
      })
    )
    expect(result.shippingOptionEvidence).toEqual({
      status: "not_required",
      options: [],
    })
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

  for (const mode of ["direct_payment", "order_first"] as const) {
    it(`blocks an old collection pickup cart before ${mode} authorization`, async () => {
      const refreshedProduct = product()
      const item = {
        ...createCartItemFromProduct(refreshedProduct),
        fulfillment: { type: "pickup" } as unknown as CartItem["fulfillment"],
      }
      let read = false
      const result = await authorizeCurrentCheckoutItems({
        mode,
        reviewedItems: [item],
        rawItems: [item],
        refreshedProducts: [refreshedProduct],
        readShippingOptions: async () => {
          read = true
          return []
        },
        authorizePickupHandlers: async () => {
          read = true
        },
      })
      expect(result).toEqual({ status: "changed" })
      expect(read).toBe(false)
    })
  }
  it("retains exact current Event Market products beside ordinary evidence for later quotes", async () => {
    const event = await createEventMarketCheckoutFixture()
    const digital = product({
      format: "digital",
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
    })
    const digitalItem = { ...createCartItemFromProduct(digital), quantity: 1 }
    let handlerCalls = 0
    const result = await authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems: [event.item, digitalItem],
      rawItems: [event.item, digitalItem],
      refreshedProducts: [event.product, digital],
      futureEventMarketDependencies: event.futureEventMarketDependencies,
      readShippingOptions: async () => {
        throw new Error("No shipping read required")
      },
      authorizePickupHandlers: async (items) => {
        handlerCalls++
        expect(items[0]?.fulfillment).toEqual(event.fulfillment)
      },
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok")
      throw new Error("Expected current authorization")
    expect(result.listingReadProducts).toEqual([event.product, digital])
    expect(result.fulfillmentResolvedProducts).toEqual([digital, event.product])
    expect(result.fulfillmentResolvedProducts[1]).toBe(event.product)
    expect(result.items[0]?.productEventId).toBe(event.product.sourceEventId)
    expect(result.shippingOptionEvidence).toEqual({
      status: "not_required",
      options: [],
    })
    expect(handlerCalls).toBe(1)
  })

  it("retains Event Market product evidence when ordinary shipping falls back to order-first", async () => {
    const event = await createEventMarketCheckoutFixture()
    const shippedProduct = product()
    const shippedItem = {
      ...createCartItemFromProduct(shippedProduct),
      quantity: 1,
    }
    const result = await authorizeCurrentCheckoutItems({
      mode: "order_first",
      reviewedItems: [event.item, shippedItem],
      rawItems: [event.item, shippedItem],
      refreshedProducts: [event.product, shippedProduct],
      futureEventMarketDependencies: event.futureEventMarketDependencies,
      readShippingOptions: async () => {
        throw new Error("Shipping unavailable")
      },
      authorizePickupHandlers: async () => undefined,
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok")
      throw new Error("Expected order-first authorization")
    expect(result.fulfillmentResolvedProducts).toEqual([
      shippedProduct,
      event.product,
    ])
    expect(result.items[0]?.fulfillment).toEqual(event.fulfillment)
    expect(result.items[1]?.shippingOptionId).toBeUndefined()
    expect(result.shippingOptionEvidence).toEqual({
      status: "unavailable_order_first",
      options: [],
    })
  })
})
