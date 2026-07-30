import { describe, expect, it } from "bun:test"
import { canonicalizeProductPrice, type ProductSchema } from "@conduit/core"
import {
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  getProductVariationCombinations,
  getProductVariationFormError,
  getProductVariationFormState,
  groupProductVariationRecords,
  reconcileProductVariationForm,
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

function sizeVariationForm(sizes = "S, M, L, XL"): ProductVariationFormState {
  return reconcileProductVariationForm({
    ...createEmptyProductVariationForm(),
    enabled: true,
    sizeOptions: sizes,
  })
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
  it("builds a variable parent and S/M/L/XL child listings", () => {
    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm(),
      currency: "USD",
      now: NOW,
    })

    expect(plan.desired).toHaveLength(5)
    expect(plan.publish).toHaveLength(5)
    expect(plan.remove).toEqual([])
    expect(plan.desired[0]?.product.type).toBe("variable")

    const children = plan.desired.slice(1)
    expect(children.map(({ product }) => product.specifications)).toEqual([
      [{ key: "size", value: "S" }],
      [{ key: "size", value: "M" }],
      [{ key: "size", value: "L" }],
      [{ key: "size", value: "XL" }],
    ])
    for (const child of children) {
      expect(child.product.type).toBe("variation")
      expect(child.product.parentProductId).toBe(
        `30402:${MERCHANT_PUBKEY}:conduit-tee`
      )
      expect(child.product.price).toBe(25)
      expect(child.product.stock).toBe(10)
    }
  })

  it("publishes only the edited variation when its price changes", () => {
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
      baseProduct: {
        ...existing.root.product,
        updatedAt: NOW + 60_000,
      },
      variations: editedState,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish).toHaveLength(1)
    expect(editedPlan.remove).toEqual([])
    expect(editedPlan.publish[0]?.product.specifications).toEqual([
      { key: "size", value: "M" },
    ])
    expect(editedPlan.publish[0]?.product.price).toBe(30)
  })

  it("tombstones removed options and all children when options are disabled", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const reducedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: sizeVariationForm("S, M, L"),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(reducedPlan.publish).toEqual([])
    expect(reducedPlan.remove).toHaveLength(1)
    expect(reducedPlan.remove[0]?.product.specifications).toEqual([
      { key: "size", value: "XL" },
    ])

    const simplePlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(simplePlan.publish).toHaveLength(1)
    expect(simplePlan.publish[0]?.product.type).toBe("simple")
    expect(simplePlan.remove).toHaveLength(4)
  })

  it("uses stable child coordinates for complete two-axis combinations", () => {
    const state = reconcileProductVariationForm({
      ...createEmptyProductVariationForm(),
      enabled: true,
      sizeOptions: "S, M",
      colorOptions: "Black, Purple",
    })
    const first = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: state,
      currency: "USD",
      now: NOW,
    })
    const second = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: state,
      currency: "USD",
      now: NOW + 60_000,
    })

    expect(first.desired).toHaveLength(5)
    expect(first.desired.map(({ dTag }) => dTag)).toEqual(
      second.desired.map(({ dTag }) => dTag)
    )
    expect(
      first.desired.slice(1).map(({ product }) => product.specifications)
    ).toEqual([
      [
        { key: "size", value: "S" },
        { key: "color", value: "Black" },
      ],
      [
        { key: "size", value: "S" },
        { key: "color", value: "Purple" },
      ],
      [
        { key: "size", value: "M" },
        { key: "color", value: "Black" },
      ],
      [
        { key: "size", value: "M" },
        { key: "color", value: "Purple" },
      ],
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
    expect(grouped[0]?.root.product.type).toBe("variable")
    expect(grouped[0]?.variations).toHaveLength(2)
    expect(grouped[1]).toMatchObject({
      root: { addressId: orphan.addressId },
      variations: [],
      orphanVariation: true,
    })
  })

  it("rejects unsafe or incomplete constrained families", () => {
    const twoAxisState = reconcileProductVariationForm({
      ...createEmptyProductVariationForm(),
      enabled: true,
      sizeOptions: "S, M",
      colorOptions: "Black, Purple",
    })
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: twoAxisState,
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const incomplete = getProductVariationFormState(
      existing.root,
      existing.variations.slice(0, -1)
    )
    const duplicateSpec = getProductVariationFormState(existing.root, [
      {
        ...existing.variations[0]!,
        product: {
          ...existing.variations[0]!.product,
          specifications: [
            { key: "size", value: "S" },
            { key: "size", value: "Small" },
          ],
        },
      },
      ...existing.variations.slice(1),
    ])

    expect(incomplete.supported).toBe(false)
    expect(incomplete.reason).toContain("complete")
    expect(duplicateSpec.supported).toBe(false)
    expect(duplicateSpec.reason).toContain("cannot preserve")
    expect(
      getProductVariationFormError(
        {
          ...createEmptyProductVariationForm(),
          enabled: true,
          sizeOptions: "S, s",
        },
        "USD"
      )
    ).toContain("duplicate")
  })
})
