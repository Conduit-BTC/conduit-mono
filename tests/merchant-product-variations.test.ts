import { describe, expect, it } from "bun:test"
import { canonicalizeProductPrice, type ProductSchema } from "@conduit/core"
import {
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  createProductVariationAxis,
  generateProductVariationRows,
  getMissingProductVariationRowCount,
  getProductVariationAlternativeSuggestion,
  getProductVariationCartesianCount,
  getProductVariationCombinations,
  getProductVariationFormError,
  getProductVariationFormState,
  groupProductVariationAxesAsAlternatives,
  groupProductVariationRecords,
  removeProductVariationRow,
  updateProductVariationOverride,
  type ProductListingFamily,
  type ProductListingRecordLike,
  type ProductVariationFormState,
} from "../apps/merchant/src/lib/productVariations"

const MERCHANT_PUBKEY = "a".repeat(64)
const NOW = 1_800_000_000_000

function baseProduct(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return canonicalizeProductPrice({
    id: `30402:${MERCHANT_PUBKEY}:conduit-tee`,
    pubkey: MERCHANT_PUBKEY,
    title: "Conduit Tee",
    summary: "A Conduit shirt.",
    price: 25,
    currency: "USD",
    type: "simple",
    specifications: [],
    format: "physical",
    shippingCostSats: 500,
    shippingCountries: ["US"],
    visibility: "public",
    stock: 10,
    images: [{ url: "https://example.com/conduit-tee.png" }],
    tags: ["conduit", "shirt", "nostr"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}

function variationForm(
  axes: Array<{ key: string; values: string }>
): ProductVariationFormState {
  return generateProductVariationRows({
    ...createEmptyProductVariationForm(),
    enabled: true,
    axes: axes.map((axis, index) =>
      createProductVariationAxis(axis.key, axis.values, index)
    ),
  })
}

function sizeVariationForm(sizes = "S, M, L, XL") {
  return variationForm([{ key: "size", values: sizes }])
}

function toRecord(
  target: ReturnType<typeof buildProductFamilyChangePlan>["desired"][number],
  index: number
): ProductListingRecordLike {
  return {
    eventId: `event-${index}`,
    addressId: target.product.id,
    dTag: target.dTag,
    eventCreatedAt: 1_800_000_000 + index,
    product: target.product,
  }
}

function toFamily(
  plan: ReturnType<typeof buildProductFamilyChangePlan>
): ProductListingFamily {
  const records = plan.desired.map(toRecord)
  return {
    root: records[0]!,
    variations: records.slice(1),
    orphanVariation: false,
  }
}

describe("merchant product variation planning", () => {
  it("builds a variable parent and explicit S/M/L/XL child rows", () => {
    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm(),
      currency: "USD",
      now: NOW,
    })

    expect(plan.desired).toHaveLength(5)
    expect(plan.publish).toHaveLength(5)
    expect(plan.desired[0]?.product.type).toBe("variable")
    expect(
      plan.desired.slice(1).map(({ product }) => product.specifications)
    ).toEqual([
      [{ key: "size", value: "S" }],
      [{ key: "size", value: "M" }],
      [{ key: "size", value: "L" }],
      [{ key: "size", value: "XL" }],
    ])
  })

  it("supports three generic axes and explicit sparse child rows", () => {
    const full = variationForm([
      { key: "screen-size", values: '13", 15"' },
      { key: "license-tier", values: "Personal, Business" },
      { key: "theme", values: "Light, Dark" },
    ])
    const sparse = {
      ...full,
      rows: full.rows.filter((_, index) => ![1, 4, 6].includes(index)),
    }
    const plan = buildProductFamilyChangePlan({
      parentDTag: "workspace",
      baseProduct: baseProduct({ title: "Portable Workspace" }),
      variations: sparse,
      currency: "USD",
      now: NOW,
    })

    expect(full.rows).toHaveLength(8)
    expect(plan.desired).toHaveLength(6)
    expect(
      plan.desired
        .slice(1)
        .every(({ product }) => product.specifications.length === 3)
    ).toBe(true)
  })

  it("publishes only the edited child when its price changes", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    )
    expect(restored.supported).toBe(true)
    const medium = getProductVariationCombinations(restored.state).find(
      ({ label }) => label === "M"
    )
    if (!medium) throw new Error("Expected the M variation")

    const editedState = updateProductVariationOverride(
      restored.state,
      medium.identity,
      "price",
      "30"
    )
    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: editedState,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish).toHaveLength(1)
    expect(editedPlan.publish[0]?.product.specifications).toEqual([
      { key: "size", value: "M" },
    ])
    expect(editedPlan.publish[0]?.product.price).toBe(30)
  })

  it("round-trips sparse imported custom child fields without rewriting them", () => {
    const initial = buildProductFamilyChangePlan({
      parentDTag: "workspace",
      baseProduct: baseProduct({ title: "Workspace" }),
      variations: variationForm([
        { key: "screen-size", values: '13", 15"' },
        { key: "license-tier", values: "Personal, Business" },
      ]),
      currency: "USD",
      now: NOW,
    })
    const family = toFamily(initial)
    family.variations = family.variations.slice(0, 3)
    family.variations[1] = {
      ...family.variations[1]!,
      product: {
        ...family.variations[1]!.product,
        title: "Studio License",
        images: [{ url: "https://example.com/studio.png", alt: "Studio" }],
        format: "digital",
        shippingCostSats: undefined,
        shippingCountries: undefined,
      },
    }
    const restored = getProductVariationFormState(
      family.root,
      family.variations
    )
    expect(restored.supported).toBe(true)

    const roundTrip = buildProductFamilyChangePlan({
      parentDTag: "workspace",
      baseProduct: family.root.product,
      variations: restored.state,
      currency: "USD",
      existing: family,
      now: NOW + 60_000,
    })

    expect(roundTrip.desired).toHaveLength(4)
    expect(roundTrip.publish).toEqual([])
    expect(roundTrip.remove).toEqual([])
    expect(roundTrip.desired[2]?.product).toMatchObject({
      title: "Studio License",
      images: [{ url: "https://example.com/studio.png", alt: "Studio" }],
      format: "digital",
    })
  })

  it("tombstones an explicitly removed sparse row", () => {
    const initial = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm("S, M, L"),
      currency: "USD",
      now: NOW,
    })
    const family = toFamily(initial)
    const restored = getProductVariationFormState(
      family.root,
      family.variations
    )
    const removedIdentity = restored.state.rows[2]!.identity
    const reduced = removeProductVariationRow(restored.state, removedIdentity)
    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: family.root.product,
      variations: reduced,
      currency: "USD",
      existing: family,
      now: NOW + 60_000,
    })

    expect(plan.remove).toHaveLength(1)
    expect(plan.remove[0]?.product.specifications).toEqual([
      { key: "size", value: "L" },
    ])
  })

  it("groups reachable children and leaves orphan variations visible", () => {
    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm("S, M"),
      currency: "USD",
      now: NOW,
    })
    const records = plan.desired.map(toRecord)
    const orphan: ProductListingRecordLike = {
      ...records[1]!,
      eventId: "orphan-event",
      addressId: `30402:${MERCHANT_PUBKEY}:orphan`,
      dTag: "orphan",
      product: {
        ...records[1]!.product,
        id: `30402:${MERCHANT_PUBKEY}:orphan`,
        parentProductId: `30402:${MERCHANT_PUBKEY}:missing-parent`,
      },
    }

    const grouped = groupProductVariationRecords([...records, orphan])

    expect(grouped).toHaveLength(2)
    expect(grouped[0]?.variations).toHaveLength(2)
    expect(grouped[1]).toMatchObject({
      root: { addressId: orphan.addressId },
      variations: [],
      orphanVariation: true,
    })
  })

  it("diagnoses duplicate axes and duplicate explicit rows", () => {
    const duplicateAxes = variationForm([
      { key: "size", values: "S, M" },
      { key: "Size", values: "Small, Medium" },
    ])
    expect(getProductVariationFormError(duplicateAxes, "USD")).toContain(
      "different name"
    )

    const state = sizeVariationForm("S, M")
    const duplicateRow = {
      ...state,
      rows: [...state.rows, { ...state.rows[0]! }],
    }
    expect(getProductVariationFormError(duplicateRow, "USD")).toContain(
      "duplicates another"
    )

    const unknownValue = {
      ...state,
      rows: [
        {
          ...state.rows[0]!,
          specifications: [{ key: "size", value: "XL" }],
        },
      ],
    }
    expect(getProductVariationFormError(unknownValue, "USD")).toContain(
      "not listed"
    )
  })

  it("does not silently truncate oversized Cartesian generation", () => {
    const state = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("material", "A, B, C, D, E", 0),
        createProductVariationAxis("finish", "1, 2, 3, 4, 5", 1),
        createProductVariationAxis("voltage", "110, 220, USB", 2),
      ],
    }

    expect(getProductVariationCartesianCount(state)).toBe(75)
    expect(generateProductVariationRows(state).rows).toEqual([])
  })

  it("groups Men and Women size lists into 23 alternatives", () => {
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis(
          "US Size Men",
          "5, 5.5, 6.5, 7, 8, 8.5, 9.5, 10, 11, 12, 12.5, 13.5",
          0
        ),
        createProductVariationAxis(
          "US Size Women",
          "4, 5.5, 6.5, 7, 8, 8.5, 9.5, 10, 11, 11.5, 12.5",
          1
        ),
      ],
    }

    expect(getProductVariationAlternativeSuggestion(state)).toEqual({
      axisIds: ["axis-us-size-men-0", "axis-us-size-women-1"],
      axisKey: "US Size",
      groups: [
        {
          axisId: "axis-us-size-men-0",
          label: "Men",
          values: [
            "5",
            "5.5",
            "6.5",
            "7",
            "8",
            "8.5",
            "9.5",
            "10",
            "11",
            "12",
            "12.5",
            "13.5",
          ],
        },
        {
          axisId: "axis-us-size-women-1",
          label: "Women",
          values: [
            "4",
            "5.5",
            "6.5",
            "7",
            "8",
            "8.5",
            "9.5",
            "10",
            "11",
            "11.5",
            "12.5",
          ],
        },
      ],
      choiceCount: 23,
      currentVariationCount: 132,
      resultingVariationCount: 23,
      canGroup: true,
    })

    const grouped = groupProductVariationAxesAsAlternatives(state)
    const generated = generateProductVariationRows(grouped)
    expect(grouped.axes).toHaveLength(1)
    expect(grouped.axes[0]?.key).toBe("US Size")
    expect(getProductVariationCartesianCount(grouped)).toBe(23)
    expect(generated.rows).toHaveLength(23)
    expect(getProductVariationFormError(generated, "USD")).toBeNull()
    expect(generated.rows.map((row) => row.specifications[0]?.value)).toContain(
      "Men · 5.5"
    )
    expect(generated.rows.map((row) => row.specifications[0]?.value)).toContain(
      "Women · 5.5"
    )

    const plan = buildProductFamilyChangePlan({
      parentDTag: "grouped-shoes",
      baseProduct: baseProduct({ title: "Grouped Shoes" }),
      variations: generated,
      currency: "USD",
      now: NOW,
    })
    expect(plan.desired).toHaveLength(24)
  })

  it("adds alternative sizes before combining them with other axes", () => {
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("US Size Men", "5, 6", 0),
        createProductVariationAxis("US Size Women", "7, 8, 9", 1),
        createProductVariationAxis("color", "Orange, Black", 2),
      ],
    }

    const suggestion = getProductVariationAlternativeSuggestion(state)
    expect(suggestion).toMatchObject({
      choiceCount: 5,
      currentVariationCount: 12,
      resultingVariationCount: 10,
    })

    const generated = generateProductVariationRows(
      groupProductVariationAxesAsAlternatives(state)
    )
    expect(generated.rows).toHaveLength(10)
    expect(generated.rows.every((row) => row.specifications.length === 2)).toBe(
      true
    )
  })

  it("surfaces the real generation limit before the empty-row error", () => {
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis(
          "size",
          Array.from({ length: 23 }, (_, index) => `Size ${index + 1}`).join(
            ", "
          ),
          0
        ),
        createProductVariationAxis("color", "Orange, Black, White", 1),
      ],
    }

    expect(getProductVariationCartesianCount(state)).toBe(69)
    expect(getMissingProductVariationRowCount(state)).toBeNull()
    expect(getProductVariationFormError(state, "USD")).toBe(
      "This setup creates 69 variations. The limit is 64. Group mutually exclusive lists or reduce the options."
    )
  })

  it("does not infer that every pair of size axes is mutually exclusive", () => {
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("Waist Size", "28, 30, 32", 0),
        createProductVariationAxis("Inseam Size", "30, 32, 34", 1),
      ],
    }

    expect(getProductVariationCartesianCount(state)).toBe(9)
    expect(getProductVariationAlternativeSuggestion(state)).toBeNull()
    expect(groupProductVariationAxesAsAlternatives(state)).toBe(state)
  })

  it("does not collapse more alternatives than one axis can publish", () => {
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis(
          "US Size Men",
          Array.from({ length: 40 }, (_, index) => `M${index + 1}`).join(", "),
          0
        ),
        createProductVariationAxis(
          "US Size Women",
          Array.from({ length: 40 }, (_, index) => `W${index + 1}`).join(", "),
          1
        ),
      ],
    }

    expect(getProductVariationAlternativeSuggestion(state)).toMatchObject({
      choiceCount: 80,
      canGroup: false,
    })
    expect(groupProductVariationAxesAsAlternatives(state)).toBe(state)
  })
})
