import { describe, expect, it } from "bun:test"
import type { ParsedShippingOption, Product } from "@conduit/core"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import type { CartItem } from "../apps/market/src/lib/cart-model"

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

    const result = await authorizeCurrentCheckoutItems({
      reviewedItems: [reviewed],
      rawItems: [original],
      refreshedProducts: [product()],
      readShippingOptions: async () => [shippingOption({ price: 6 })],
    })

    expect(result).toEqual({ status: "changed" })
  })

  it("blocks when the referenced shipping option is withdrawn", async () => {
    const original = rawItem()
    const option = shippingOption()
    const result = await authorizeCurrentCheckoutItems({
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
  })

  it("blocks changed raw listing terms before reading shipping", async () => {
    let shippingRead = false
    const result = await authorizeCurrentCheckoutItems({
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

  it("fails closed when the exact shipping read is unavailable", async () => {
    const original = rawItem()
    await expect(
      authorizeCurrentCheckoutItems({
        reviewedItems: [original],
        rawItems: [original],
        refreshedProducts: [product()],
        readShippingOptions: async () => {
          throw new Error("Fixed shipping could not be verified")
        },
      })
    ).rejects.toThrow("Fixed shipping could not be verified")
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
        reviewedItems: [item],
        rawItems: [item],
        refreshedProducts: [changedProduct],
        readShippingOptions: async () => [],
      })

      expect(result).toEqual({ status: "changed" })
    }
  })
})
