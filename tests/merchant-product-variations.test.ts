import { describe, expect, it } from "bun:test"
import { canonicalizeProductPrice, type ProductSchema } from "@conduit/core"
import {
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  createProductVariationAxis,
  generateProductVariationRows,
  getProductVariationCartesianCount,
  getProductVariationCombinations,
  getProductVariationFormError,
  getProductVariationFormState,
  groupProductVariationRecords,
  removeProductVariationRow,
  updateProductVariationOverride,
  type ProductListingFamily,
  type ProductListingRecordLike,
  type ProductVariationFormState,
} from "../apps/merchant/src/lib/productVariations"

const MERCHANT_PUBKEY = "a".repeat(64)
const ORGANIZER_PUBKEY = "b".repeat(64)
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

  it("replaces event pickup evidence on every inherited child transition", () => {
    const standardShipping = `30406:${MERCHANT_PUBKEY}:standard`
    const firstCollection = `30405:${ORGANIZER_PUBKEY}:summer-market`
    const organizerPickup = `30406:${ORGANIZER_PUBKEY}:summer-pickup`
    const secondCollection = `30405:${ORGANIZER_PUBKEY}:autumn-market`
    const merchantPickup = `30406:${MERCHANT_PUBKEY}:autumn-booth`
    const initial = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingOptionId: standardShipping,
        shippingOptionDTag: "standard",
        shippingOptionRefs: [{ coordinate: standardShipping }],
        collectionRefs: undefined,
      }),
      variations: sizeVariationForm("S, M"),
      currency: "USD",
      now: NOW,
    })
    const shippingFamily = toFamily(initial)
    const shippingForm = getProductVariationFormState(
      shippingFamily.root,
      shippingFamily.variations
    )

    const organizerPickupPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        shippingCountries: undefined,
        shippingOptionId: organizerPickup,
        shippingOptionDTag: "summer-pickup",
        shippingOptionRefs: [{ coordinate: organizerPickup }],
        collectionRefs: [firstCollection],
      }),
      variations: shippingForm.state,
      currency: "USD",
      existing: shippingFamily,
      now: NOW + 60_000,
    })

    for (const child of organizerPickupPlan.desired.slice(1)) {
      expect(child.product.collectionRefs).toEqual([firstCollection])
      expect(child.product.shippingOptionRefs).toEqual([
        { coordinate: organizerPickup },
      ])
      expect(child.product.shippingOptionId).toBe(organizerPickup)
      expect(child.product.shippingOptionRefs).not.toContainEqual({
        coordinate: standardShipping,
      })
    }

    const organizerPickupFamily = toFamily(organizerPickupPlan)
    const pickupForm = getProductVariationFormState(
      organizerPickupFamily.root,
      organizerPickupFamily.variations
    )
    const merchantPickupPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        shippingCountries: undefined,
        shippingOptionId: merchantPickup,
        shippingOptionDTag: "autumn-booth",
        shippingOptionRefs: [{ coordinate: merchantPickup }],
        collectionRefs: [secondCollection],
      }),
      variations: pickupForm.state,
      currency: "USD",
      existing: organizerPickupFamily,
      now: NOW + 120_000,
    })

    for (const child of merchantPickupPlan.desired.slice(1)) {
      expect(child.product.collectionRefs).toEqual([secondCollection])
      expect(child.product.shippingOptionRefs).toEqual([
        { coordinate: merchantPickup },
      ])
      expect(child.product.shippingOptionId).toBe(merchantPickup)
      expect(child.product.collectionRefs).not.toContain(firstCollection)
      expect(child.product.shippingOptionRefs).not.toContainEqual({
        coordinate: organizerPickup,
      })
    }

    const merchantPickupFamily = toFamily(merchantPickupPlan)
    const merchantPickupForm = getProductVariationFormState(
      merchantPickupFamily.root,
      merchantPickupFamily.variations
    )
    const coordinatedShippingPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        shippingCountries: undefined,
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
        shippingOptionRefs: undefined,
        collectionRefs: undefined,
      }),
      variations: merchantPickupForm.state,
      currency: "USD",
      existing: merchantPickupFamily,
      now: NOW + 180_000,
    })

    for (const child of coordinatedShippingPlan.desired.slice(1)) {
      expect(child.product.collectionRefs).toBeUndefined()
      expect(child.product.shippingOptionRefs).toBeUndefined()
      expect(child.product.shippingOptionId).toBeUndefined()
    }
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
})
