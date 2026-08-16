import { describe, expect, it } from "bun:test"
import {
  prepareProductCatalog,
  type CommerceProductRecord,
  type PreparedProductFamily,
  type Product,
} from "@conduit/core"
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
    images: [{ url: "https://cdn.conduit.market/shirt.png" }],
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

function family(
  parent: Product,
  children: Product[]
): PreparedProductFamily<CommerceProductRecord> {
  const records = [parent, ...children].map(
    (candidate, index): CommerceProductRecord => ({
      product: candidate,
      addressId: candidate.id,
      eventId: `${candidate.id}-event`,
      eventCreatedAt: index,
      dTag: candidate.id.split(":").at(-1) ?? null,
    })
  )
  const item = prepareProductCatalog(records, {
    source: "commerce",
    fetchedAt: 2,
    stale: false,
    degraded: false,
    capped: false,
  }).items[0]
  if (item?.kind !== "family") throw new Error("Expected a family")
  return item.family
}

describe("product variation selection", () => {
  it("uses a size presentation preset without changing the generic default", () => {
    const parent = product({ type: "variable" })
    const prepared = family(parent, [
      sizeVariation("XL", 3),
      sizeVariation("S", 0),
      sizeVariation("L", 2),
      sizeVariation("M", 5),
    ])
    const selected = getDefaultProductSelection(parent, prepared)
    const model = getProductVariationSelectorModel(prepared, selected)

    expect(model?.axes[0]?.label).toBe("Size")
    expect(model?.axes[0]?.options.map((option) => option.label)).toEqual([
      "S",
      "M",
      "L",
      "XL",
    ])
    expect(model?.axes[0]?.options[0]?.soldOut).toBe(true)
    expect(selected.specifications).toEqual([{ key: "size", value: "L" }])
  })

  it("keeps child identity and human-readable specifications in the cart", () => {
    const large = { ...sizeVariation("L", 2), images: [] }
    const parent = product({
      type: "variable",
      images: [{ url: "https://cdn.conduit.market/parent.png" }],
    })
    const cartItem = cartItemInputFromProductSelection(parent, large)

    expect(cartItem.productId).toBe(`30402:${MERCHANT_PUBKEY}:shirt-l`)
    expect(cartItem.familyProductId).toBe(parent.id)
    expect(cartItem.selectedSpecifications).toEqual([
      { key: "size", value: "L" },
    ])
    expect(cartItem.price).toBe(large.price)
    expect(cartItem.image).toBe("https://cdn.conduit.market/parent.png")
  })

  it("resolves selected price, stock, and percent-encoded child coordinate", () => {
    const medium = sizeVariation("M", 5)
    const large = { ...sizeVariation("L", 2), price: 30_000 }
    const parent = product({ type: "variable" })
    const prepared = family(parent, [medium, large])
    const selected = getProductSelection(
      parent,
      prepared,
      encodeURIComponent(large.id)
    )

    expect(selected.id).toBe(`30402:${MERCHANT_PUBKEY}:shirt-l`)
    expect(selected.price).toBe(30_000)
    expect(selected.stock).toBe(2)
  })

  it("does not borrow an image from an unrelated sibling", () => {
    const medium = { ...sizeVariation("M", 5), images: [] }
    const large = {
      ...sizeVariation("L", 2),
      images: [{ url: "https://cdn.conduit.market/large.png" }],
    }
    const parent = product({ type: "variable", images: [] })
    family(parent, [medium, large])

    expect(getProductSelectionImages(parent, medium)).toEqual([])
  })

  it("filters non-public selection images before rendering or cart persistence", () => {
    const medium = {
      ...sizeVariation("M", 5),
      images: [{ url: "http://127.0.0.1/variation.png" }],
    }
    const parent = product({
      type: "variable",
      images: [{ url: "https://localhost/parent.png" }],
    })

    expect(getProductSelectionImages(parent, medium)).toEqual([])
    expect(cartItemInputFromProductSelection(parent, medium).image).toBe(
      undefined
    )
  })
})
