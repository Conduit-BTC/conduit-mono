import { describe, expect, it } from "bun:test"
import type { Product } from "@conduit/core"
import {
  cartItemInputFromProductSelection,
  getDefaultProductSelection,
  getProductSelection,
  getProductSelectionImages,
  getProductVariationSelectorModel,
} from "../apps/market/src/lib/productVariations"

const MERCHANT_PUBKEY = "a".repeat(64)

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: `30402:${MERCHANT_PUBKEY}:shirt`,
    pubkey: MERCHANT_PUBKEY,
    title: "Conduit Shirt",
    price: 25_000,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "public",
    images: [{ url: "https://example.com/shirt.png" }],
    tags: ["shirt"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function sizeVariation(size: string, stock: number): Product {
  return product({
    id: `30402:${MERCHANT_PUBKEY}:shirt-${size.toLowerCase()}`,
    title: `Conduit Shirt — ${size}`,
    type: "variation",
    parentProductId: `30402:${MERCHANT_PUBKEY}:shirt`,
    specifications: [{ key: "size", value: size }],
    stock,
  })
}

describe("product variation selection", () => {
  it("shows natural size choices, disables sold-out stock, and defaults in stock", () => {
    const parent = product({
      type: "variable",
      variations: [
        sizeVariation("XL", 3),
        sizeVariation("S", 0),
        sizeVariation("L", 2),
        sizeVariation("M", 5),
      ],
    })
    const model = getProductVariationSelectorModel(parent)

    expect(model?.label).toBe("Size")
    expect(model?.options.map((option) => option.label)).toEqual([
      "S",
      "M",
      "L",
      "XL",
    ])
    expect(model?.options[0]?.soldOut).toBe(true)
    expect(getDefaultProductSelection(parent).specifications).toEqual([
      { key: "size", value: "M" },
    ])
  })

  it("keeps the selected child coordinate and checkout data in the cart", () => {
    const large = { ...sizeVariation("L", 2), images: [] }
    const parent = product({
      type: "variable",
      images: [{ url: "https://example.com/parent.png" }],
      variations: [large],
    })
    const cartItem = cartItemInputFromProductSelection(parent, large)

    expect(cartItem.productId).toBe(`30402:${MERCHANT_PUBKEY}:shirt-l`)
    expect(cartItem.productId).not.toBe(large.parentProductId)
    expect(cartItem.price).toBe(large.price)
    expect(cartItem.image).toBe("https://example.com/parent.png")
  })

  it("resolves selected price, stock, and coordinate from the child listing", () => {
    const medium = sizeVariation("M", 5)
    const large = sizeVariation("L", 2)
    large.price = 30_000
    const parent = product({
      type: "variable",
      variations: [medium, large],
    })
    const selected = getProductSelection(parent, large.id)

    expect(selected.id).toBe(`30402:${MERCHANT_PUBKEY}:shirt-l`)
    expect(selected.price).toBe(30_000)
    expect(selected.stock).toBe(2)
  })

  it("preserves a percent-encoded child coordinate from detail navigation", () => {
    const medium = sizeVariation("M", 5)
    const large = sizeVariation("L", 2)
    const parent = product({
      type: "variable",
      variations: [medium, large],
    })

    expect(getProductSelection(parent, encodeURIComponent(large.id)).id).toBe(
      large.id
    )
  })

  it("falls back to a sibling image when the parent and selection have none", () => {
    const medium = sizeVariation("M", 5)
    const large = sizeVariation("L", 2)
    const parent = product({
      type: "variable",
      images: [],
      variations: [
        { ...medium, images: [] },
        {
          ...large,
          images: [{ url: "https://example.com/large.png" }],
        },
      ],
    })

    expect(getProductSelectionImages(parent, parent.variations![0]!)).toEqual([
      { url: "https://example.com/large.png" },
    ])
  })
})
