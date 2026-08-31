import { describe, expect, it } from "bun:test"
import {
  canonicalizeProductPrice,
  compileProductFulfillmentIntent,
  getFixedShippingRateZones,
  type ProductFulfillmentIntent,
  type ProductSchema,
} from "@conduit/core"
import {
  addProductVariationAxis,
  buildProductFamilyChangePlan as buildProductFamilyChangePlanWithFulfillment,
  createEmptyProductVariationForm,
  createProductVariationAxis,
  generateProductVariationRows,
  getProductVariationCartesianCount,
  getProductVariationCombinations,
  getProductVariationFormError,
  getProductVariationFormState,
  getProductVariationMatrix,
  getProductVariationRemovalCount,
  groupProductVariationRecords,
  mergeProductVariationAuthoringState,
  parseProductVariationFormState,
  reconcileProductVariationDraftResolution,
  reconcileProductVariationForm,
  removeProductVariationAxis,
  setProductVariationCombinationIncluded,
  updateProductVariationAxis,
  updateProductVariationInheritance,
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

type ProductFamilyPlanInput = Omit<
  Parameters<typeof buildProductFamilyChangePlanWithFulfillment>[0],
  "fulfillmentIntent" | "authoringCountries"
>

function buildProductFamilyChangePlan(input: ProductFamilyPlanInput) {
  const product = input.baseProduct
  const amount = product.sourceShippingCost?.amount ?? product.shippingCostSats
  const projectedCountries = product.shippingCountries?.length
    ? product.shippingCountries
    : product.shippingCountryRules?.map((rule) => rule.code)
  const authoringCountries = Array.from(
    new Set(
      (projectedCountries ?? []).map((country) => country.trim().toUpperCase())
    )
  ).sort()
  const fulfillmentIntent: ProductFulfillmentIntent =
    product.format === "digital"
      ? { kind: "digital" }
      : typeof amount !== "number"
        ? { kind: "coordinate_after_order" }
        : compileProductFulfillmentIntent({
            format: "physical",
            shippingPricingMode: "fixed",
            amount,
            currency:
              product.sourceShippingCost?.currency.trim().toUpperCase() ??
              "SATS",
            destinations: authoringCountries.map((code) => ({
              code,
              name: code,
              restrictTo: [],
              exclude: [],
            })),
          })

  return buildProductFamilyChangePlanWithFulfillment({
    ...input,
    fulfillmentIntent,
    authoringCountries,
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
  const product =
    target.fulfillmentIntent.kind === "fixed_standard"
      ? (() => {
          const zones = getFixedShippingRateZones(target.fulfillmentIntent)
          return {
            ...target.product,
            shippingOptionId: `30406:${MERCHANT_PUBKEY}:${target.dTag}-shipping-standard`,
            shippingOptionDTag: `${target.dTag}-shipping-standard`,
            shippingCountries: Array.from(
              new Set(zones.flatMap((zone) => zone.countries))
            ).sort(),
            canonicalShippingResolved: true,
          }
        })()
      : target.product
  return {
    eventId: `event-${index}`,
    addressId: product.id,
    dTag: target.dTag,
    eventCreatedAt: 1_800_000_000 + index,
    product,
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
  it("starts with a neutral option definition", () => {
    const state = createEmptyProductVariationForm()

    expect(state.axes).toHaveLength(1)
    expect(state.axes[0]?.key).toBe("")
    expect(state.axes[0]?.values).toBe("")
  })

  it("keeps option IDs unique after removing a middle axis and adding one", () => {
    const initial: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("first", "one", 0),
        createProductVariationAxis("second", "two", 1),
        createProductVariationAxis("third", "three", 2),
      ],
    }
    const withoutMiddle = removeProductVariationAxis(
      initial,
      initial.axes[1]!.id
    )
    const added = addProductVariationAxis(withoutMiddle)
    const addedAxis = added.axes[2]!
    const edited = updateProductVariationAxis(
      added,
      addedAxis.id,
      "key",
      "fourth"
    )

    expect(added.axes.map(({ id }) => id)).toEqual([
      "axis-first-0",
      "axis-third-2",
      "axis-option-3",
    ])
    expect(new Set(added.axes.map(({ id }) => id)).size).toBe(3)
    expect(edited.axes.map(({ key }) => key)).toEqual([
      "first",
      "third",
      "fourth",
    ])
  })

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
    const matrix = getProductVariationMatrix(sparse)
    expect(matrix).toHaveLength(8)
    expect(matrix.filter(({ included }) => included)).toHaveLength(5)
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

  it("publishes the root when only its canonical fixed shipping amount changes", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        shippingOptionId: `30406:${MERCHANT_PUBKEY}:conduit-tee-shipping-standard`,
        shippingOptionDTag: "conduit-tee-shipping-standard",
      }),
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)

    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: {
        ...existing.root.product,
        sourceShippingCost: {
          amount: 8,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish.map(({ dTag }) => dTag)).toEqual(["conduit-tee"])
  })

  it("preserves an unrelated collection when reconstructing a fixed product edit", () => {
    const collectionCoordinate = `30405:${ORGANIZER_PUBKEY}:catalog`
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const shippingOptionId = existing.root.product.shippingOptionId!
    existing.root.product = {
      ...existing.root.product,
      collectionRefs: [collectionCoordinate],
      shippingOptionRefs: [{ coordinate: shippingOptionId }],
    }

    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: {
        ...existing.root.product,
        title: "Edited Conduit Tee",
        collectionRefs: undefined,
        shippingOptionRefs: undefined,
      },
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish).toHaveLength(1)
    expect(editedPlan.publish[0]?.product.collectionRefs).toEqual([
      collectionCoordinate,
    ])
  })

  it("publishes only the variation whose fixed shipping amount changes", () => {
    const variations = sizeVariationForm("S, M")
    const medium = getProductVariationCombinations(variations).find(
      ({ label }) => label === "M"
    )!
    const withShippingOverride = updateProductVariationOverride(
      variations,
      medium.identity,
      "shippingCost",
      "7"
    )
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: withShippingOverride,
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state
    const restoredMedium = getProductVariationCombinations(restored).find(
      ({ label }) => label === "M"
    )!

    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: updateProductVariationOverride(
        restored,
        restoredMedium.identity,
        "shippingCost",
        "9"
      ),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish).toHaveLength(1)
    expect(editedPlan.publish[0]?.product.specifications).toEqual([
      { key: "size", value: "M" },
    ])
    expect(editedPlan.publish[0]?.product.sourceShippingCost?.amount).toBe(9)
  })

  it("keeps a blank non-inherited physical child order-first", () => {
    const variations = sizeVariationForm("S, M")
    const medium = getProductVariationCombinations(variations).find(
      ({ label }) => label === "M"
    )!
    const withManualChild = updateProductVariationInheritance(
      variations,
      medium.identity,
      "inheritShipping",
      false
    )

    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: withManualChild,
      currency: "USD",
      now: NOW,
    })
    const mediumTarget = plan.desired.find(
      ({ product }) => product.specifications[0]?.value === "M"
    )

    expect(plan.desired[0]?.fulfillmentIntent).toEqual({
      kind: "fixed_standard",
      zones: [
        {
          amount: 5,
          currency: "USD",
          countries: ["US"],
          countryRules: [
            { code: "US", name: "US", restrictTo: [], exclude: [] },
          ],
          usesProductFallback: true,
        },
      ],
    })
    expect(mediumTarget?.product.format).toBe("physical")
    expect(mediumTarget?.fulfillmentIntent).toEqual({
      kind: "coordinate_after_order",
    })
  })

  it("preserves event pickup references for inherited variation fulfillment", () => {
    const collectionCoordinate = `30405:${ORGANIZER_PUBKEY}:event`
    const pickupCoordinate = `30406:${MERCHANT_PUBKEY}:conduit-tee-event-pickup`
    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        shippingCountries: undefined,
        collectionRefs: [collectionCoordinate],
        shippingOptionId: pickupCoordinate,
        shippingOptionRefs: [{ coordinate: pickupCoordinate }],
        canonicalShippingResolved: false,
      }),
      variations: sizeVariationForm("S"),
      currency: "USD",
      now: NOW,
    })

    expect(plan.desired).toHaveLength(2)
    for (const target of plan.desired) {
      expect(target.fulfillmentIntent).toEqual({
        kind: "coordinate_after_order",
      })
      expect(target.product.collectionRefs).toEqual([collectionCoordinate])
      expect(target.product.shippingOptionId).toBe(pickupCoordinate)
      expect(target.product.shippingOptionRefs).toEqual([
        { coordinate: pickupCoordinate },
      ])
    }
  })

  it("blocks an unrelated family edit while a child's exact shipping option is unresolved", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: sizeVariationForm("S"),
      currency: "USD",
      now: NOW,
    })
    const resolvedExisting = toFamily(initialPlan)
    const existing = toFamily(initialPlan)
    const child = existing.variations[0]!
    child.product = {
      ...child.product,
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
      canonicalShippingResolved: false,
    }

    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    )
    const unresolvedRow = restored.state.rows[0]

    expect(restored.supported).toBe(true)
    expect(existing.root.product.canonicalShippingResolved).toBe(true)
    expect(unresolvedRow?.shippingResolution).toBe("unresolved")
    expect(unresolvedRow?.shippingCost).toBe("")
    expect(
      parseProductVariationFormState(JSON.parse(JSON.stringify(restored.state)))
        ?.rows[0]?.shippingResolution
    ).toBe("unresolved")
    expect(getProductVariationFormError(restored.state, "USD")).toBe(
      "S shipping could not be verified from the current relay read. Refresh products before saving this family."
    )
    expect(() =>
      buildProductFamilyChangePlan({
        parentDTag: "conduit-tee",
        baseProduct: {
          ...existing.root.product,
          title: "Conduit Tee refreshed",
        },
        variations: restored.state,
        currency: "USD",
        existing,
        now: NOW + 60_000,
      })
    ).toThrow(
      "S shipping could not be verified from the current relay read. Refresh products before saving this family."
    )
    const staleDraft = {
      ...restored.state,
      rows: restored.state.rows.map((row) => {
        const staleRow = { ...row }
        delete staleRow.shippingResolution
        return {
          ...staleRow,
          title: "Unsaved Small Tee",
          price: "29",
          stock: "3",
          inheritStock: false,
          imageUrls: "https://example.com/unsaved-small.png",
          inheritImages: false,
          format: "physical" as const,
        }
      }),
    }
    const rehydratedStaleDraft = reconcileProductVariationDraftResolution(
      restored,
      staleDraft
    )
    expect(rehydratedStaleDraft.rows[0]?.shippingResolution).toBe("unresolved")
    expect(rehydratedStaleDraft.rows[0]).toMatchObject({
      title: "Unsaved Small Tee",
      price: "29",
      stock: "3",
      inheritStock: false,
      imageUrls: "https://example.com/unsaved-small.png",
      inheritImages: false,
      format: "physical",
    })
    const resolvedRefresh = getProductVariationFormState(
      resolvedExisting.root,
      resolvedExisting.variations
    )
    const resolvedRefreshRow = resolvedRefresh.state.rows[0]!
    const recoveredDraft = reconcileProductVariationDraftResolution(
      resolvedRefresh,
      rehydratedStaleDraft
    )
    expect(recoveredDraft.rows[0]?.shippingResolution).toBeUndefined()
    expect(recoveredDraft.rows[0]).toMatchObject({
      title: "Unsaved Small Tee",
      price: "29",
      stock: "3",
      inheritStock: false,
      imageUrls: "https://example.com/unsaved-small.png",
      inheritImages: false,
      format: resolvedRefreshRow.format,
      shippingCost: resolvedRefreshRow.shippingCost,
      inheritShipping: resolvedRefreshRow.inheritShipping,
    })
    expect(() =>
      buildProductFamilyChangePlan({
        parentDTag: "conduit-tee",
        baseProduct: {
          ...existing.root.product,
          title: "Conduit Tee refreshed",
        },
        variations: staleDraft,
        currency: "USD",
        existing,
        now: NOW + 60_000,
      })
    ).toThrow(
      "S shipping could not be verified from the current relay read. Refresh products before saving this family."
    )
    const removalPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: setProductVariationCombinationIncluded(
        restored.state,
        unresolvedRow!.identity,
        false
      ),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })
    expect(removalPlan.remove.map(({ addressId }) => addressId)).toEqual([
      child.addressId,
    ])

    const replacementState = updateProductVariationOverride(
      rehydratedStaleDraft,
      unresolvedRow!.identity,
      "shippingCost",
      "7"
    )
    expect(replacementState.rows[0]?.shippingResolution).toBe("replacement")
    const persistedReplacement = parseProductVariationFormState(
      JSON.parse(JSON.stringify(replacementState))
    )!
    const mergedReplacement = mergeProductVariationAuthoringState(
      restored,
      persistedReplacement
    ).state
    expect(mergedReplacement.rows[0]?.shippingCost).toBe("7")
    expect(mergedReplacement.rows[0]?.inheritShipping).toBe(false)
    expect(mergedReplacement.rows[0]?.shippingResolution).toBe("replacement")
    const repairPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: mergedReplacement,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })
    expect(
      repairPlan.publish.find(({ dTag }) => dTag === child.dTag)
        ?.fulfillmentIntent
    ).toEqual({
      kind: "fixed_standard",
      zones: [
        {
          amount: 7,
          currency: "USD",
          countries: ["US"],
          countryRules: [
            { code: "US", name: "US", restrictTo: [], exclude: [] },
          ],
          usesProductFallback: true,
        },
      ],
    })

    const revertedReplacement = updateProductVariationOverride(
      replacementState,
      unresolvedRow!.identity,
      "shippingCost",
      ""
    )
    expect(revertedReplacement.rows[0]?.shippingResolution).toBe("unresolved")
    expect(getProductVariationFormError(revertedReplacement, "USD")).toBe(
      "S shipping could not be verified from the current relay read. Refresh products before saving this family."
    )
    expect(() =>
      buildProductFamilyChangePlan({
        parentDTag: "conduit-tee",
        baseProduct: existing.root.product,
        variations: revertedReplacement,
        currency: "USD",
        existing,
        now: NOW + 60_000,
      })
    ).toThrow(
      "S shipping could not be verified from the current relay read. Refresh products before saving this family."
    )
    expect(child.product.shippingOptionId).toBe(
      `30406:${MERCHANT_PUBKEY}:${child.dTag}-shipping-standard`
    )
  })

  it("publishes the canonical family when only its destinations change", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: sizeVariationForm("S, M"),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    for (const record of [existing.root, ...existing.variations]) {
      record.product = {
        ...record.product,
        shippingOptionId: `30406:${MERCHANT_PUBKEY}:${record.dTag}-shipping-standard`,
        shippingOptionDTag: `${record.dTag}-shipping-standard`,
      }
    }
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state

    expect(restored.rows.every(({ inheritShipping }) => inheritShipping)).toBe(
      true
    )

    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: {
        ...existing.root.product,
        shippingCountries: ["ca", "US", "CA"],
      },
      variations: restored,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish.map(({ dTag }) => dTag)).toEqual(
      editedPlan.desired.map(({ dTag }) => dTag)
    )
    expect(
      editedPlan.publish.map(({ fulfillmentIntent }) => fulfillmentIntent)
    ).toEqual([
      {
        kind: "fixed_standard",
        zones: [
          {
            amount: 5,
            currency: "USD",
            countries: ["CA", "US"],
            countryRules: [
              { code: "CA", name: "CA", restrictTo: [], exclude: [] },
              { code: "US", name: "US", restrictTo: [], exclude: [] },
            ],
            usesProductFallback: true,
          },
        ],
      },
      {
        kind: "fixed_standard",
        zones: [
          {
            amount: 5,
            currency: "USD",
            countries: ["CA", "US"],
            countryRules: [
              { code: "CA", name: "CA", restrictTo: [], exclude: [] },
              { code: "US", name: "US", restrictTo: [], exclude: [] },
            ],
            usesProductFallback: true,
          },
        ],
      },
      {
        kind: "fixed_standard",
        zones: [
          {
            amount: 5,
            currency: "USD",
            countries: ["CA", "US"],
            countryRules: [
              { code: "CA", name: "CA", restrictTo: [], exclude: [] },
              { code: "US", name: "US", restrictTo: [], exclude: [] },
            ],
            usesProductFallback: true,
          },
        ],
      },
    ])
  })

  it("preserves a child with custom destinations outside root inheritance", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: sizeVariationForm("S"),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    existing.root.product = {
      ...existing.root.product,
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:conduit-tee-shipping-standard`,
      shippingOptionDTag: "conduit-tee-shipping-standard",
    }
    existing.variations[0]!.product = {
      ...existing.variations[0]!.product,
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:${existing.variations[0]!.dTag}-shipping-standard`,
      shippingOptionDTag: `${existing.variations[0]!.dTag}-shipping-standard`,
      shippingCountries: ["CA"],
    }
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state

    expect(restored.rows[0]?.inheritShipping).toBe(false)

    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: {
        ...existing.root.product,
        shippingCountries: ["MX", "US"],
      },
      variations: restored,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.publish.map(({ dTag }) => dTag)).toEqual(["conduit-tee"])
    expect(editedPlan.desired[1]?.fulfillmentIntent).toEqual({
      kind: "fixed_standard",
      zones: [
        {
          amount: 5,
          currency: "USD",
          countries: ["CA"],
          countryRules: [
            { code: "CA", name: "CA", restrictTo: [], exclude: [] },
          ],
          usesProductFallback: true,
        },
      ],
    })
  })

  it("applies an edited shipping override to a hydrated child policy", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: sizeVariationForm("S"),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const child = existing.variations[0]!
    child.product = {
      ...child.product,
      shippingCostSats: undefined,
      sourceShippingCost: {
        amount: 7,
        currency: "USD",
        normalizedCurrency: "USD",
      },
      shippingOptionId: `30406:${MERCHANT_PUBKEY}:${child.dTag}-old-policy`,
      shippingOptionDTag: `${child.dTag}-old-policy`,
      shippingOptionIds: [`30406:${MERCHANT_PUBKEY}:${child.dTag}-old-policy`],
      shippingOptionDTags: [`${child.dTag}-old-policy`],
      shippingCountries: ["CA"],
      shippingCountryRules: [
        { code: "CA", name: "CA", restrictTo: [], exclude: [] },
      ],
      shippingZones: [
        {
          shippingOptionId: `30406:${MERCHANT_PUBKEY}:${child.dTag}-old-policy`,
          shippingOptionDTag: `${child.dTag}-old-policy`,
          amount: 7,
          currency: "USD",
          countries: ["CA"],
          countryRules: [
            { code: "CA", name: "CA", restrictTo: [], exclude: [] },
          ],
        },
      ],
      canonicalShippingResolved: true,
    }
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state
    const edited = updateProductVariationOverride(
      restored,
      restored.rows[0]!.identity,
      "shippingCost",
      "8"
    )

    const editedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: edited,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.desired[1]?.product.shippingOptionIds).toBeUndefined()
    expect(editedPlan.desired[1]?.product.shippingZones).toBeUndefined()
    expect(editedPlan.desired[1]?.fulfillmentIntent).toMatchObject({
      kind: "fixed_standard",
      zones: [{ amount: 8, currency: "USD", countries: ["CA"] }],
    })
  })

  it("preserves preview destination policy for a child shipping override", () => {
    const countryRule = {
      code: "US",
      name: "United States",
      restrictTo: ["787*"],
      exclude: ["78799"],
      includeSubdivisions: ["US-TX"],
    }
    const previewIntent = compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      amount: 5,
      currency: "USD",
      destinations: [countryRule],
      allowExperimentalDestinationPolicy: true,
    })
    const initialPlan = buildProductFamilyChangePlanWithFulfillment({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        shippingCountries: ["US"],
        shippingCountryRules: [countryRule],
      }),
      variations: sizeVariationForm("S"),
      currency: "USD",
      fulfillmentIntent: previewIntent,
      authoringCountries: ["US"],
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state
    const edited = updateProductVariationOverride(
      restored,
      restored.rows[0]!.identity,
      "shippingCost",
      "8"
    )

    const editedPlan = buildProductFamilyChangePlanWithFulfillment({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: edited,
      currency: "USD",
      fulfillmentIntent: previewIntent,
      authoringCountries: ["US"],
      existing,
      now: NOW + 60_000,
    })

    expect(editedPlan.desired[1]?.fulfillmentIntent).toEqual({
      kind: "fixed_standard",
      zones: [
        {
          amount: 8,
          currency: "USD",
          countries: ["US"],
          countryRules: [countryRule],
          usesProductFallback: true,
          destinationSchema: "1",
        },
      ],
    })
  })

  it("does not widen a restricted legacy child during an ordinary family save", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: sizeVariationForm("S"),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    existing.variations[0]!.product = {
      ...existing.variations[0]!.product,
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      canonicalShippingResolved: false,
      shippingCountries: ["US"],
      shippingCountryRules: [
        {
          code: "US",
          name: "United States",
          restrictTo: ["787**"],
          exclude: ["78799"],
        },
      ],
    }
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state

    expect(restored.rows[0]?.inheritShipping).toBe(false)
    expect(() =>
      buildProductFamilyChangePlan({
        parentDTag: "conduit-tee",
        baseProduct: {
          ...existing.root.product,
          title: "Conduit Tee refreshed",
        },
        variations: restored,
        currency: "USD",
        existing,
        now: NOW + 60_000,
      })
    ).toThrow("Remove subdivision/postal rules")
  })

  it("does not republish equivalent normalized fixed shipping intent", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        shippingOptionId: `30406:${MERCHANT_PUBKEY}:conduit-tee-shipping-standard`,
        shippingOptionDTag: "conduit-tee-shipping-standard",
        shippingCountries: ["CA", "US"],
      }),
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)

    const unchangedPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: {
        ...existing.root.product,
        sourceShippingCost: {
          amount: 5,
          currency: "usd",
          normalizedCurrency: "USD",
        },
        shippingCountries: ["us", "CA", "US"],
      },
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(unchangedPlan.publish).toEqual([])
  })

  it("publishes a canonical pair when the existing listing is inline-only", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
      }),
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    existing.root.product = {
      ...existing.root.product,
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
    }

    const upgradePlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: {
        ...existing.root.product,
        shippingOptionId: `30406:${MERCHANT_PUBKEY}:conduit-tee-shipping-standard`,
        shippingOptionDTag: "conduit-tee-shipping-standard",
      },
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(upgradePlan.publish.map(({ dTag }) => dTag)).toEqual(["conduit-tee"])
  })

  it("repairs an unresolved canonical reference with inline shipping fields", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    existing.root.product = {
      ...existing.root.product,
      canonicalShippingResolved: false,
    }

    const repairPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: existing.root.product,
      variations: createEmptyProductVariationForm(),
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })

    expect(repairPlan.publish.map(({ dTag }) => dTag)).toEqual(["conduit-tee"])
  })

  it("publishes the family when fixed shipping becomes order-first or digital", () => {
    const initialPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct({
        shippingCostSats: undefined,
        sourceShippingCost: {
          amount: 5,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      }),
      variations: sizeVariationForm("S, M"),
      currency: "USD",
      now: NOW,
    })
    const existing = toFamily(initialPlan)
    const restored = getProductVariationFormState(
      existing.root,
      existing.variations
    ).state
    const withoutFixedShipping = {
      ...existing.root.product,
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
    }

    const orderFirstPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: withoutFixedShipping,
      variations: restored,
      currency: "USD",
      existing,
      now: NOW + 60_000,
    })
    const digitalPlan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: { ...withoutFixedShipping, format: "digital" },
      variations: restored,
      currency: "USD",
      existing,
      now: NOW + 120_000,
    })

    expect(
      orderFirstPlan.publish.map(({ fulfillmentIntent }) => fulfillmentIntent)
    ).toEqual(
      orderFirstPlan.desired.map(() => ({ kind: "coordinate_after_order" }))
    )
    expect(
      digitalPlan.publish.map(({ fulfillmentIntent }) => fulfillmentIntent)
    ).toEqual(digitalPlan.desired.map(() => ({ kind: "digital" })))
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
        shippingOptionId: undefined,
        shippingOptionDTag: undefined,
        shippingCountries: undefined,
      },
    }
    const restored = getProductVariationFormState(
      family.root,
      family.variations
    )
    expect(restored.supported).toBe(true)
    const matrix = getProductVariationMatrix(restored.state)
    expect(matrix).toHaveLength(4)
    expect(matrix.filter(({ included }) => included)).toHaveLength(3)

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
    const reduced = setProductVariationCombinationIncluded(
      restored.state,
      removedIdentity,
      false
    )
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

  it("counts every published child before converting a variable product to simple", () => {
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
    ).state
    const simple = { ...restored, enabled: false }
    const plan = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: family.root.product,
      variations: simple,
      currency: "USD",
      existing: family,
      now: NOW + 60_000,
    })

    expect(plan.remove).toHaveLength(3)
    expect(getProductVariationRemovalCount(simple, family.variations)).toBe(
      plan.remove.length
    )
  })

  it("preserves row fields when availability is toggled off and on", () => {
    const initial = buildProductFamilyChangePlan({
      parentDTag: "conduit-tee",
      baseProduct: baseProduct(),
      variations: sizeVariationForm("S, M"),
      currency: "USD",
      now: NOW,
    })
    const family = toFamily(initial)
    const restored = getProductVariationFormState(
      family.root,
      family.variations
    ).state
    const target = restored.rows[1]!
    const customized = updateProductVariationOverride(
      restored,
      target.identity,
      "title",
      "Retained title"
    )

    const excluded = setProductVariationCombinationIncluded(
      customized,
      target.identity,
      false
    )
    expect(getProductVariationCombinations(excluded)).toHaveLength(1)
    expect(excluded.rows[1]).toMatchObject({
      included: false,
      dTag: target.dTag,
      title: "Retained title",
    })

    const restoredAvailability = setProductVariationCombinationIncluded(
      excluded,
      target.identity,
      true
    )
    expect(restoredAvailability.rows[1]).toMatchObject({
      included: true,
      dTag: target.dTag,
      title: "Retained title",
    })
  })

  it("restores excluded option values after publish and reopen", () => {
    const authored = variationForm([
      { key: "size", values: "S, M" },
      { key: "color", values: "Red, Blue" },
    ])
    const availableRow = authored.rows.find(
      ({ specifications }) =>
        specifications[0]?.value === "M" && specifications[1]?.value === "Red"
    )!
    const sparse = {
      ...authored,
      rows: authored.rows.map((row) => ({
        ...row,
        included: row.identity === availableRow.identity,
      })),
    }
    const initial = buildProductFamilyChangePlan({
      parentDTag: "sparse-shirt",
      baseProduct: baseProduct({ title: "Sparse Shirt" }),
      variations: sparse,
      currency: "USD",
      now: NOW,
    })
    const family = toFamily(initial)
    const published = getProductVariationFormState(
      family.root,
      family.variations
    )

    expect(published.state.axes.map(({ values }) => values)).toEqual([
      "M",
      "Red",
    ])

    const reopened = mergeProductVariationAuthoringState(published, sparse)
    const matrix = getProductVariationMatrix(reopened.state)
    expect(reopened.state.axes.map(({ values }) => values)).toEqual([
      "S, M",
      "Red, Blue",
    ])
    expect(matrix).toHaveLength(4)
    expect(matrix.filter(({ included }) => included)).toHaveLength(1)

    const restoredRow = matrix.find(
      ({ specifications }) =>
        specifications[0]?.value === "S" && specifications[1]?.value === "Blue"
    )!
    const restored = setProductVariationCombinationIncluded(
      reopened.state,
      restoredRow.identity,
      true
    )
    const updated = buildProductFamilyChangePlan({
      parentDTag: "sparse-shirt",
      baseProduct: family.root.product,
      variations: restored,
      currency: "USD",
      existing: family,
      now: NOW + 60_000,
    })

    expect(updated.desired).toHaveLength(3)
    expect(updated.publish).toHaveLength(1)
    expect(updated.publish[0]?.product.specifications).toEqual(
      restoredRow.specifications
    )
  })

  it("takes obsolete rows out of availability when definitions change", () => {
    const initial = variationForm([{ key: "option", values: "one, two" }])
    const updated = updateProductVariationAxis(
      initial,
      initial.axes[0]!.id,
      "values",
      "one, three"
    )
    const beforeSelection = getProductVariationMatrix(updated)
    const newCombination = beforeSelection.find(
      ({ specifications }) => specifications[0]?.value === "three"
    )
    if (!newCombination) throw new Error("Expected the new combination")

    expect(
      getProductVariationCombinations(updated).map(
        ({ specifications }) => specifications[0]?.value
      )
    ).toEqual(["one"])
    expect(beforeSelection.filter(({ included }) => included)).toHaveLength(1)

    const selected = setProductVariationCombinationIncluded(
      updated,
      newCombination.identity,
      true
    )
    expect(
      getProductVariationCombinations(selected).map(
        ({ specifications }) => specifications[0]?.value
      )
    ).toEqual(["one", "three"])
    expect(getProductVariationFormError(selected, "USD")).toBeNull()
    expect(
      selected.rows.find(
        ({ specifications }) => specifications[0]?.value === "two"
      )?.included
    ).toBe(false)

    const obsoleteIdentity = initial.rows.find(
      ({ specifications }) => specifications[0]?.value === "two"
    )!.identity
    const obsoleteRestore = setProductVariationCombinationIncluded(
      selected,
      obsoleteIdentity,
      true
    )
    expect(
      obsoleteRestore.rows.find(
        ({ specifications }) => specifications[0]?.value === "two"
      )?.included
    ).toBe(false)
  })

  it("keeps included stock zero distinct from an excluded combination", () => {
    const state = sizeVariationForm("A, B")
    const first = state.rows[0]!
    const second = state.rows[1]!
    const withZeroStock = updateProductVariationOverride(
      state,
      first.identity,
      "stock",
      "0"
    )
    const sparse = setProductVariationCombinationIncluded(
      withZeroStock,
      second.identity,
      false
    )
    const plan = buildProductFamilyChangePlan({
      parentDTag: "zero-stock",
      baseProduct: baseProduct(),
      variations: sparse,
      currency: "USD",
      now: NOW,
    })

    expect(plan.desired).toHaveLength(2)
    expect(plan.desired[1]?.product.stock).toBe(0)
    expect(plan.desired[1]?.product.specifications).toEqual(
      first.specifications
    )
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
    expect(getProductVariationFormError(state, "USD")).toContain(
      "75 combinations"
    )
  })

  it("can exclude an existing row while the Cartesian matrix is oversized", () => {
    const values = Array.from({ length: 8 }, (_, index) => `value-${index + 1}`)
    const initial = variationForm([
      { key: "option-a", values: values.join(", ") },
      { key: "option-b", values: values.join(", ") },
    ])
    const target = initial.rows.find(
      ({ specifications }) => specifications[1]?.value === "value-2"
    )!
    const oversized = updateProductVariationAxis(
      initial,
      initial.axes[1]!.id,
      "values",
      `${values.slice(1).join(", ")}, value-9, value-10`
    )

    expect(getProductVariationCartesianCount(oversized)).toBe(72)
    expect(getProductVariationMatrix(oversized)).toEqual([])
    expect(getProductVariationCombinations(oversized)).toHaveLength(56)
    expect(
      oversized.rows.filter(
        ({ specifications }) => specifications[1]?.value === "value-1"
      )
    ).toHaveLength(8)
    expect(
      oversized.rows
        .filter(({ specifications }) => specifications[1]?.value === "value-1")
        .every(({ included }) => !included)
    ).toBe(true)

    const excluded = setProductVariationCombinationIncluded(
      oversized,
      target.identity,
      false
    )

    expect(
      excluded.rows.find(({ identity }) => identity === target.identity)
        ?.included
    ).toBe(false)
    expect(getProductVariationCombinations(excluded)).toHaveLength(55)

    const restoredWhileOversized = setProductVariationCombinationIncluded(
      excluded,
      target.identity,
      true
    )
    expect(
      restoredWhileOversized.rows.find(
        ({ identity }) => identity === target.identity
      )?.included
    ).toBe(true)

    const missingIdentity = variationForm([
      { key: "option-a", values: "value-1" },
      { key: "option-b", values: "value-9" },
    ]).rows[0]!.identity
    const unchanged = setProductVariationCombinationIncluded(
      oversized,
      missingIdentity,
      true
    )
    expect(unchanged.rows).toHaveLength(oversized.rows.length)
    expect(
      unchanged.rows.some(({ identity }) => identity === missingIdentity)
    ).toBe(false)
  })

  it("can toggle an existing row while an option definition is incomplete", () => {
    const initial = variationForm([{ key: "option", values: "one, two" }])
    const target = {
      ...initial.rows[0]!,
      dTag: "existing-option-one",
      title: "Retained title",
    }
    const customized = {
      ...initial,
      rows: [target, ...initial.rows.slice(1)],
    }
    const incomplete = updateProductVariationAxis(
      customized,
      customized.axes[0]!.id,
      "key",
      ""
    )

    expect(getProductVariationMatrix(incomplete)).toEqual([])

    const excluded = setProductVariationCombinationIncluded(
      incomplete,
      target.identity,
      false
    )
    const restoredWhileIncomplete = setProductVariationCombinationIncluded(
      excluded,
      target.identity,
      true
    )
    const excludedAgain = setProductVariationCombinationIncluded(
      restoredWhileIncomplete,
      target.identity,
      false
    )
    const repaired = updateProductVariationAxis(
      excludedAgain,
      excludedAgain.axes[0]!.id,
      "key",
      "option"
    )
    const matrixRow = getProductVariationMatrix(repaired).find(
      ({ identity }) => identity === target.identity
    )
    const restored = setProductVariationCombinationIncluded(
      repaired,
      target.identity,
      true
    )

    expect(
      excluded.rows.find(({ identity }) => identity === target.identity)
        ?.included
    ).toBe(false)
    expect(
      restoredWhileIncomplete.rows.find(
        ({ identity }) => identity === target.identity
      )
    ).toMatchObject({
      included: true,
      dTag: "existing-option-one",
      title: "Retained title",
    })
    expect(matrixRow).toMatchObject({
      included: false,
      dTag: "existing-option-one",
      title: "Retained title",
    })
    expect(
      restored.rows.find(({ identity }) => identity === target.identity)
    ).toMatchObject({
      included: true,
      dTag: "existing-option-one",
      title: "Retained title",
    })

    const missingIdentity = variationForm([{ key: "option", values: "three" }])
      .rows[0]!.identity
    const unchanged = setProductVariationCombinationIncluded(
      incomplete,
      missingIdentity,
      true
    )
    expect(unchanged.rows).toHaveLength(incomplete.rows.length)
    expect(
      unchanged.rows.some(({ identity }) => identity === missingIdentity)
    ).toBe(false)
  })

  it("excludes every stored duplicate for the selected combination", () => {
    const initial = variationForm([{ key: "option", values: "one, two" }])
    const target = initial.rows[0]!
    const duplicateState = {
      ...initial,
      rows: [
        { ...target, included: false },
        { ...target, included: true, dTag: "duplicate" },
        ...initial.rows.slice(1),
      ],
    }

    const excluded = setProductVariationCombinationIncluded(
      duplicateState,
      target.identity,
      false
    )

    expect(
      excluded.rows
        .filter(({ identity }) => identity === target.identity)
        .map(({ included }) => included)
    ).toEqual([false, false])
    expect(
      getProductVariationMatrix(excluded).find(
        ({ identity }) => identity === target.identity
      )?.included
    ).toBe(false)

    const restored = setProductVariationCombinationIncluded(
      excluded,
      target.identity,
      true
    )
    expect(
      restored.rows
        .filter(({ identity }) => identity === target.identity)
        .map(({ included }) => included)
    ).toEqual([false, true])
    expect(
      getProductVariationMatrix(restored).find(
        ({ identity }) => identity === target.identity
      )?.included
    ).toBe(true)
  })

  it("supports a neutral availability matrix with more than twelve values", () => {
    const values = Array.from(
      { length: 14 },
      (_, index) => `value-${index + 1}`
    )
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("option-a", "first, second", 0),
        createProductVariationAxis("option-b", values.join(", "), 1),
      ],
    }

    const matrix = getProductVariationMatrix(state)
    expect(matrix).toHaveLength(28)
    expect(matrix.every(({ included }) => !included)).toBe(true)
    expect(generateProductVariationRows(state).rows).toHaveLength(28)
  })

  it("matches reordered specifications and keeps tuple identities collision-safe", () => {
    const state = variationForm([
      { key: "a", values: "b|c:d, b" },
      { key: "c", values: "e, d|c:e" },
    ])
    const reordered = reconcileProductVariationForm({
      ...state,
      rows: state.rows.map((row) => ({
        ...row,
        identity: "stale",
        specifications: [...row.specifications].reverse(),
      })),
    })
    const matrix = getProductVariationMatrix(reordered)

    expect(matrix).toHaveLength(4)
    expect(new Set(matrix.map(({ identity }) => identity)).size).toBe(4)
    expect(matrix.every(({ included }) => included)).toBe(true)
  })

  it("keeps reordered tuple identity stable for distinct Unicode keys", () => {
    const state = variationForm([
      { key: "a", values: "x" },
      { key: "á", values: "x" },
    ])
    const originalIdentity = state.rows[0]!.identity
    const reordered = reconcileProductVariationForm({
      ...state,
      rows: [
        {
          ...state.rows[0]!,
          specifications: [...state.rows[0]!.specifications].reverse(),
        },
      ],
    })

    expect(reordered.rows[0]?.identity).toBe(originalIdentity)
    expect(getProductVariationMatrix(reordered)[0]?.included).toBe(true)
  })

  it("keeps punctuation-bearing values opaque and distinct", () => {
    const state: ProductVariationFormState = {
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [
        createProductVariationAxis("option", "left · value, left  ·  value", 0),
      ],
    }
    const matrix = getProductVariationMatrix(state)

    expect(
      matrix.map(({ specifications }) => specifications[0]?.value)
    ).toEqual(["left · value", "left  ·  value"])
    expect(new Set(matrix.map(({ identity }) => identity)).size).toBe(2)
  })

  it("loads existing drafts with every stored row included", () => {
    const state = sizeVariationForm("A, B")
    const storedRows: Array<Record<string, unknown>> = state.rows.map(
      (row) => ({ ...row })
    )
    for (const row of storedRows) delete row.included
    const stored = {
      ...state,
      rows: storedRows,
    }

    const parsed = parseProductVariationFormState(stored)

    expect(parsed?.rows.every(({ included }) => included)).toBe(true)
  })
})
