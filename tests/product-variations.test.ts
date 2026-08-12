import { describe, expect, it } from "bun:test"
import {
  formatGroupedProductOptionValue,
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
  getProductSelectionForAxisValue,
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

  it("presents qualified size alternatives in accessible Men and Women groups", () => {
    const menFive = sizeVariation(
      formatGroupedProductOptionValue("Men", "5"),
      3
    )
    const menFiveAndAHalf = sizeVariation(
      formatGroupedProductOptionValue("Men", "5.5"),
      2
    )
    const womenFour = sizeVariation(
      formatGroupedProductOptionValue("Women", "4"),
      4
    )
    const womenFiveAndAHalf = sizeVariation(
      formatGroupedProductOptionValue("Women", "5.5"),
      1
    )
    const parent = product({ type: "variable" })
    const prepared = family(parent, [
      womenFiveAndAHalf,
      menFive,
      womenFour,
      menFiveAndAHalf,
    ])
    const model = getProductVariationSelectorModel(prepared, menFive)

    expect(model?.axes[0]?.selectedValue).toBe("Men · 5")
    expect(model?.axes[0]?.selectedLabel).toBe("Men · 5")
    expect(
      model?.axes[0]?.optionGroups?.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({
          label: option.label,
          value: option.value,
        })),
      }))
    ).toEqual([
      {
        label: "Men",
        options: [
          { label: "5", value: "Men · 5" },
          { label: "5.5", value: "Men · 5.5" },
        ],
      },
      {
        label: "Women",
        options: [
          { label: "4", value: "Women · 4" },
          { label: "5.5", value: "Women · 5.5" },
        ],
      },
    ])

    expect(
      getProductSelectionForAxisValue(prepared, menFive, "size", "Women · 4")
        ?.id
    ).toBe(womenFour.id)
  })

  it("keeps full labels when grouped and ordinary values are mixed", () => {
    const parent = product({ type: "variable" })
    const prepared = family(parent, [
      sizeVariation("XL", 2),
      sizeVariation(formatGroupedProductOptionValue("Premium", "XL"), 1),
    ])
    const model = getProductVariationSelectorModel(
      prepared,
      prepared.children[0]!.product
    )

    expect(model?.axes[0]?.optionGroups).toBeNull()
    expect(model?.axes[0]?.options.map((option) => option.label)).toEqual([
      "XL",
      "Premium · XL",
    ])
  })

  it("keeps child identity and human-readable specifications in the cart", () => {
    const large = { ...sizeVariation("L", 2), images: [] }
    const parent = product({
      type: "variable",
      images: [{ url: "https://example.com/parent.png" }],
    })
    const cartItem = cartItemInputFromProductSelection(parent, large)

    expect(cartItem.productId).toBe(`30402:${MERCHANT_PUBKEY}:shirt-l`)
    expect(cartItem.familyProductId).toBe(parent.id)
    expect(cartItem.selectedSpecifications).toEqual([
      { key: "size", value: "L" },
    ])
    expect(cartItem.price).toBe(large.price)
    expect(cartItem.image).toBe("https://example.com/parent.png")
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
      images: [{ url: "https://example.com/large.png" }],
    }
    const parent = product({ type: "variable", images: [] })
    family(parent, [medium, large])

    expect(getProductSelectionImages(parent, medium)).toEqual([])
  })
})
