import { describe, expect, test } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildShippingPolicyEventDraft,
  getMerchantShippingPolicyCoordinate,
  type ShippingPolicyV1,
  parseShippingOptionEvent,
  productSchema,
  type ShippingPolicy,
} from "../packages/core/src"
import {
  applyProductFulfillmentIntentForPublication,
  prepareProductPublicationListings,
  getProductPreservedFulfillmentFields,
} from "../apps/merchant/src/lib/product-publishing"
import {
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  createProductVariationAxis,
  generateProductVariationRows,
  getProductVariationFormState,
} from "../apps/merchant/src/lib/productVariations"
import { getMerchantSetupReadiness } from "../apps/merchant/src/lib/readiness"
import { validateProductPublishForm } from "../apps/merchant/src/lib/productForm"
import {
  buildShippingPolicyFromDraft,
  createShippingPolicyDraft,
  getProductShippingMeasurements,
  shippingPolicyToDraft,
} from "../apps/merchant/src/lib/shippingPolicyForm"

const secret = generateSecretKey()
const pubkey = getPublicKey(secret)
const policy: ShippingPolicy = {
  version: 2,
  title: "Custom rates",
  originCountry: "US",
  currency: "USD",
  domestic: {
    rules: [
      {
        country: "US",
        bands: [
          { maxWeightGrams: 500, priceMinor: 500 },
          { maxWeightGrams: 1000, priceMinor: 800 },
        ],
      },
    ],
    freeShippingThresholdMinor: 10000,
  },
  international: {
    rules: [
      { country: "CA", bands: [{ maxWeightGrams: 1000, priceMinor: 1500 }] },
    ],
    freeShippingThresholdMinor: 20000,
  },
}
const draft = buildShippingPolicyEventDraft({ policy })
const event = finalizeEvent({ ...draft, created_at: 20 }, secret)
const option = parseShippingOptionEvent(new NDKEvent(undefined, event))!
const product = productSchema.parse({
  id: `30402:${pubkey}:one`,
  pubkey,
  title: "Product one",
  price: 20,
  currency: "USD",
  shippingWeightGrams: 250,
  shippingWeightAllowanceGrams: 50,
  shippingHandling: {
    amount: 1.25,
    currency: "USD",
    normalizedCurrency: "USD",
  },
  format: "physical",
  createdAt: 1,
  updatedAt: 1,
})
const tableIntent = {
  kind: "weight_table" as const,
  policyCoordinate: getMerchantShippingPolicyCoordinate(pubkey),
  policyEventId: event.id,
}
const dependencies = {
  getShippingOptions: async () => [option],
  getEventMarketPickups: async () => [],
}

describe("merchant shipping table authoring", () => {
  test("round-trips editable domestic and international rate cards with exact minor-unit money", () => {
    expect(buildShippingPolicyFromDraft(shippingPolicyToDraft(policy))).toEqual(
      policy
    )
    const form = shippingPolicyToDraft(policy)
    form.domestic.rules[0]!.bands[0]!.price = "0.001"
    expect(() => buildShippingPolicyFromDraft(form)).toThrow()
  })
  test("upgrading old tables removes policy buffers while existing product terms remain preserved", () => {
    const oldPolicy: ShippingPolicyV1 = {
      ...policy,
      version: 1,
      weightAllowanceGrams: 100,
      handlingMinor: 25,
    }
    const upgraded = buildShippingPolicyFromDraft(
      shippingPolicyToDraft(oldPolicy)
    )
    expect(upgraded).toEqual(policy)
    expect(getProductPreservedFulfillmentFields(product)).toMatchObject({
      shippingWeightGrams: 250,
      shippingWeightAllowanceGrams: 50,
      shippingHandling: product.shippingHandling,
    })
  })
  test("validates product packing weights and exact handling precision in the product currency", () => {
    expect(
      getProductShippingMeasurements({
        shippingWeightGrams: "250",
        shippingWeightAllowanceGrams: "50",
        shippingHandling: "1.25",
        currency: "USD",
      })
    ).toEqual({
      shippingWeightGrams: 250,
      shippingWeightAllowanceGrams: 50,
      shippingHandling: {
        amount: 1.25,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
    expect(() =>
      getProductShippingMeasurements({ shippingWeightAllowanceGrams: "0.5" })
    ).toThrow()
    expect(() =>
      getProductShippingMeasurements({
        shippingHandling: "0.001",
        currency: "USD",
      })
    ).toThrow()
    const custom = shippingPolicyToDraft(policy)
    custom.domestic.rules.push({
      ...custom.domestic.rules[0]!,
      customArea: true,
    })
    expect(() => buildShippingPolicyFromDraft(custom)).toThrow("Choose a state")
  })
  test("does not infer rates from an empty draft or permit conflicting areas/band boundaries", () => {
    expect(() =>
      buildShippingPolicyFromDraft(createShippingPolicyDraft())
    ).toThrow()
    const form = shippingPolicyToDraft(policy)
    form.domestic.rules[0]!.bands[1]!.maxWeight = "500"
    expect(() => buildShippingPolicyFromDraft(form)).toThrow()
    const duplicate = shippingPolicyToDraft(policy)
    duplicate.domestic.rules.push({
      ...duplicate.domestic.rules[0]!,
      id: "duplicate",
    })
    expect(() => buildShippingPolicyFromDraft(duplicate)).toThrow()
  })
  test("requires whole positive shipping weight and all advisory dimensions when one is supplied", () => {
    expect(
      getProductShippingMeasurements({
        shippingWeightGrams: "250",
        shippingLengthCm: "12.5",
        shippingWidthCm: "10",
        shippingHeightCm: "5",
      })
    ).toEqual({
      shippingWeightGrams: 250,
      shippingDimensionsCm: { length: 12.5, width: 10, height: 5 },
    })
    expect(() =>
      getProductShippingMeasurements({ shippingWeightGrams: "0" })
    ).toThrow()
    expect(() =>
      getProductShippingMeasurements({ shippingWeightGrams: "0.5" })
    ).toThrow()
    expect(() =>
      getProductShippingMeasurements({ shippingLengthCm: "12" })
    ).toThrow()
  })
  test("table products require weight while fixed compatibility remains weight-optional", () => {
    const form = {
      title: "Example",
      price: "20",
      stock: "",
      currency: "USD",
      format: "physical" as const,
      shippingCost: "",
      shippingPricingMode: "weight_table" as const,
      usePresetShippingZone: false,
      customShippingConfig: { countries: [] },
      tags: "one, two, three",
      images: [{ url: "https://media.conduit.market/table-product.png" }],
    }
    expect(
      validateProductPublishForm(form, { hasPresetShippingZone: false }).errors
        .shippingWeight
    ).toContain("shipping weight")
    expect(
      validateProductPublishForm(form, { hasPresetShippingZone: false })
        .firstError
    ).toContain("shipping weight")
    expect(
      validateProductPublishForm(
        { ...form, format: "digital", shippingWeightGrams: "invalid" },
        { hasPresetShippingZone: false }
      ).canPublish
    ).toBe(true)
    expect(
      validateProductPublishForm(
        { ...form, shippingWeightGrams: "invalid" },
        { hasPresetShippingZone: false, skipShippingMeasurements: true }
      ).canPublish
    ).toBe(true)
    expect(
      validateProductPublishForm(
        { ...form, shippingWeightGrams: "250" },
        { hasPresetShippingZone: false }
      ).canPublish
    ).toBe(true)
  })
  test("verifies the exact merchant policy before preparing two product references", async () => {
    const second = {
      ...product,
      id: `30402:${pubkey}:two`,
      title: "Product two",
      shippingWeightGrams: 400,
    }
    const prepared = await prepareProductPublicationListings(
      [
        { product, dTag: "one", fulfillmentIntent: tableIntent },
        { product: second, dTag: "two", fulfillmentIntent: tableIntent },
      ],
      { merchantPubkey: pubkey },
      dependencies
    )
    expect(prepared).toHaveLength(2)
    for (const listing of prepared) {
      const result = applyProductFulfillmentIntentForPublication({
        product: listing.product,
        merchantPubkey: pubkey,
        productDTag: listing.dTag,
        intent: listing.fulfillmentIntent,
      })
      expect(result.shippingOptionId).toBe(
        getMerchantShippingPolicyCoordinate(pubkey)
      )
      expect(result.shippingCostSats).toBeUndefined()
      expect(result.shippingWeightGrams).toBeGreaterThan(0)
    }
  })
  test("a changed or unavailable policy blocks publication while independent currencies remain a merchant choice", async () => {
    const listing = { product, dTag: "one", fulfillmentIntent: tableIntent }
    await expect(
      prepareProductPublicationListings(
        [
          {
            ...listing,
            fulfillmentIntent: {
              ...tableIntent,
              policyEventId: "0".repeat(64),
            },
          },
        ],
        { merchantPubkey: pubkey },
        dependencies
      )
    ).rejects.toThrow("rates changed")
    await expect(
      prepareProductPublicationListings(
        [listing],
        { merchantPubkey: pubkey },
        { ...dependencies, getShippingOptions: async () => [] }
      )
    ).rejects.toThrow("could not be verified")
    await expect(
      prepareProductPublicationListings(
        [{ ...listing, product: { ...product, currency: "EUR" } }],
        { merchantPubkey: pubkey },
        dependencies
      )
    ).resolves.toHaveLength(1)
  })
  test("ordinary table product edits retain the reference while allowing newer policy revisions", async () => {
    const baseline = applyProductFulfillmentIntentForPublication({
      product,
      merchantPubkey: pubkey,
      productDTag: "one",
      intent: tableIntent,
    })
    const newerEvent = finalizeEvent({ ...draft, created_at: 21 }, secret)
    const newerOption = parseShippingOptionEvent(
      new NDKEvent(undefined, newerEvent)
    )!
    const prepared = await prepareProductPublicationListings(
      [
        {
          product: { ...baseline, title: "Updated title" },
          dTag: "one",
          fulfillmentIntent: { kind: "preserve_existing", baseline },
        },
      ],
      { merchantPubkey: pubkey },
      { ...dependencies, getShippingOptions: async () => [newerOption] }
    )
    expect(prepared[0]!.fulfillmentIntent).toEqual({
      ...tableIntent,
      policyEventId: newerEvent.id,
    })
    const manual = applyProductFulfillmentIntentForPublication({
      product: baseline,
      merchantPubkey: pubkey,
      productDTag: "one",
      intent: { kind: "coordinate_after_order" },
    })
    expect(manual.shippingOptionId).toBeUndefined()
    // Shared policy remains unchanged; switching one product generates no withdrawal.
    expect(option.eventId).toBe(event.id)
  })
  test("table variations inherit measurements and remain editable after publication", async () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("Size", "Small, Large", 0)],
    })
    const initial = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: product,
      variations: state,
      currency: "USD",
      fulfillmentIntent: tableIntent,
      authoringCountries: [],
    })
    const records = initial.desired.map((target, index) => {
      const published = applyProductFulfillmentIntentForPublication({
        product: target.product,
        merchantPubkey: pubkey,
        productDTag: target.dTag,
        intent: target.fulfillmentIntent,
      })
      expect(published.shippingWeightGrams).toBe(250)
      expect(published.shippingWeightAllowanceGrams).toBe(50)
      expect(published.shippingHandling).toEqual(product.shippingHandling)
      return {
        product: published,
        dTag: target.dTag,
        addressId: published.id,
        eventId: `event-${index}`,
        eventCreatedAt: 20,
      }
    })
    const family = {
      root: records[0]!,
      variations: records.slice(1),
      orphanVariation: false,
    }
    const restored = getProductVariationFormState(
      family.root,
      family.variations
    )
    expect(restored.supported).toBe(true)
    expect(
      restored.state.rows.every(
        (row) => row.inheritShipping && !row.shippingResolution
      )
    ).toBe(true)
    const changed = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: { ...family.root.product, shippingWeightGrams: 300 },
      variations: restored.state,
      currency: "USD",
      fulfillmentIntent: tableIntent,
      authoringCountries: [],
      existing: family,
    })
    const prepared = await prepareProductPublicationListings(
      changed.publish,
      { merchantPubkey: pubkey },
      dependencies
    )
    expect(prepared).toHaveLength(3)
    expect(
      prepared.every((target) => target.product.shippingWeightGrams === 300)
    ).toBe(true)
  })
  test("verified published tables complete shipping setup without a fixed-price zone", () => {
    const input = { profile: null, shippingConfig: { countries: [] } }
    expect(getMerchantSetupReadiness(input).shippingComplete).toBe(false)
    const ready = getMerchantSetupReadiness({
      ...input,
      shippingPolicyReady: true,
    })
    expect(ready.shippingComplete).toBe(true)
    expect(ready.missingAreas).not.toContain("shipping")
  })
})
