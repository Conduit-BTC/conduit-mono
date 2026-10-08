import { describe, expect, test } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildShippingPolicyEventDraft,
  buildProductListingEventDraft,
  getMerchantShippingPolicyCoordinate,
  type ShippingPolicyV1,
  parseShippingOptionEvent,
  productSchema,
  parseProductEvent,
  quoteShippingPolicy,
  shippingMoneyToMinorUnits,
  getCurrencyFractionDigits,
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
  getProductVariationFormError,
  parseProductVariationFormState,
  reconcileProductVariationDraftResolution,
  updateProductVariationMeasurements,
} from "../apps/merchant/src/lib/productVariations"
import { getMerchantSetupReadiness } from "../apps/merchant/src/lib/readiness"
import { validateProductPublishForm } from "../apps/merchant/src/lib/productForm"
import { admitFixture } from "./helpers/public-event"
import {
  buildShippingPolicyFromDraft,
  changeShippingPolicyOrigin,
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
const option = parseShippingOptionEvent(await admitFixture(event))!
option.readSource = "relay"
option.readCoverage = "complete"
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
  test("changing origin clears domestic constraints and requires custom areas to be remapped", () => {
    const original = shippingPolicyToDraft({
      ...policy,
      domestic: {
        rules: [
          policy.domestic!.rules[0]!,
          {
            country: "US",
            subdivision: "US-CA",
            postalPrefix: "94",
            bands: [{ maxWeightGrams: 1000, priceMinor: 900 }],
          },
          {
            country: "US",
            postalPrefix: "98",
            bands: [{ maxWeightGrams: 1000, priceMinor: 700 }],
          },
        ],
      },
      international: null,
    })
    expect(changeShippingPolicyOrigin(original, "US")).toBe(original)
    const changed = changeShippingPolicyOrigin(original, "CA")
    expect(changed.domestic.rules[1]).toMatchObject({
      country: "CA",
      customArea: true,
      subdivision: "",
      postalPrefix: "",
    })
    expect(changed.domestic.rules[2]).toMatchObject({
      country: "CA",
      customArea: true,
      subdivision: "",
      postalPrefix: "",
    })
    expect(changed.domestic.rules[1]!.bands).toEqual(
      original.domestic.rules[1]!.bands
    )
    expect(changed.international).toBe(original.international)
    expect(() => buildShippingPolicyFromDraft(changed)).toThrow(
      "Choose a state or enter a postal prefix"
    )
    expect(original.domestic.rules[1]!.postalPrefix).toBe("94")
    changed.domestic.rules[1]!.subdivision = "BC"
    changed.domestic.rules[2]!.postalPrefix = "V6"
    const remapped = buildShippingPolicyFromDraft(changed)
    expect(remapped.domestic!.rules[1]).toMatchObject({
      country: "CA",
      subdivision: "CABC",
    })
    expect(remapped.domestic!.rules[2]).toMatchObject({
      country: "CA",
      postalPrefix: "V6",
    })
    const removed = changeShippingPolicyOrigin(original, "CA")
    removed.domestic.rules = removed.domestic.rules.filter(
      (rule) => !rule.customArea
    )
    expect(buildShippingPolicyFromDraft(removed).domestic!.rules).toHaveLength(
      1
    )
  })

  test.each(["7", "0"])(
    "rejects fixed variation charge %s under a table before publication planning",
    (shippingCost) => {
      const state = generateProductVariationRows({
        ...createEmptyProductVariationForm(),
        enabled: true,
        axes: [createProductVariationAxis("Size", "Small", 0)],
      })
      state.rows[0] = {
        ...state.rows[0]!,
        inheritShipping: false,
        shippingCost,
      }
      const restored = parseProductVariationFormState(
        JSON.parse(JSON.stringify(state))
      )!
      const message =
        "Small: Fixed variation prices cannot be combined with table shipping. Select Use table, clear the variation shipping price to coordinate after ordering, or change Shipping pricing to Fixed price per item."
      expect(
        getProductVariationFormError(restored, "USD", {
          shippingPricingMode: "weight_table",
          baseFormat: "physical",
        })
      ).toBe(message)
      expect(() =>
        buildProductFamilyChangePlan({
          parentDTag: "one",
          baseProduct: product,
          variations: restored,
          currency: "USD",
          fulfillmentIntent: tableIntent,
          authoringCountries: [],
        })
      ).toThrow(message)
      expect(
        getProductVariationFormError(restored, "USD", {
          shippingPricingMode: "weight_table",
          baseFormat: "physical",
          preserveExistingFulfillment: true,
        })
      ).toBeNull()
    }
  )

  test.each(["table", "coordinate", "digital"] as const)(
    "recovers an unsupported override by choosing %s",
    async (choice) => {
      const state = generateProductVariationRows({
        ...createEmptyProductVariationForm(),
        enabled: true,
        shareShippingMeasurements: true,
        axes: [createProductVariationAxis("Size", "Small", 0)],
      })
      state.rows[0] = {
        ...state.rows[0]!,
        inheritShipping: choice === "table",
        shippingCost: choice === "coordinate" ? "" : "7",
        format: choice === "digital" ? "digital" : "inherit",
      }
      expect(
        getProductVariationFormError(state, "USD", {
          shippingPricingMode: "weight_table",
          baseFormat: "physical",
        })
      ).toBeNull()
      const plan = buildProductFamilyChangePlan({
        parentDTag: "one",
        baseProduct: product,
        variations: state,
        currency: "USD",
        fulfillmentIntent: tableIntent,
        authoringCountries: [],
      })
      const prepared = await prepareProductPublicationListings(
        plan.publish,
        { merchantPubkey: pubkey },
        dependencies
      )
      const child = prepared.find(
        ({ product }) => product.type === "variation"
      )!
      expect(child.fulfillmentIntent.kind).toBe(
        choice === "table"
          ? "weight_table"
          : choice === "coordinate"
            ? "coordinate_after_order"
            : "digital"
      )
      const published = applyProductFulfillmentIntentForPublication({
        product: child.product,
        merchantPubkey: pubkey,
        productDTag: child.dTag,
        intent: child.fulfillmentIntent,
      })
      const signed = finalizeEvent(
        {
          ...buildProductListingEventDraft({
            product: published,
            dTag: child.dTag,
          }),
          created_at: 21,
        },
        secret
      )
      expect(
        signed.tags.filter(([name]) => name === "shipping_option")
      ).toEqual(
        choice === "table"
          ? [["shipping_option", tableIntent.policyCoordinate]]
          : []
      )
    }
  )

  test("switching to fixed shipping keeps the explicit variation price and destinations", () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("Size", "Small", 0)],
    })
    state.rows[0] = {
      ...state.rows[0]!,
      inheritShipping: false,
      shippingCost: "7",
    }
    expect(
      getProductVariationFormError(state, "USD", {
        shippingPricingMode: "fixed",
        baseFormat: "physical",
      })
    ).toBeNull()
    const plan = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: product,
      variations: state,
      currency: "USD",
      fulfillmentIntent: {
        kind: "fixed_standard",
        amount: 5,
        currency: "USD",
        countries: ["US"],
      },
      authoringCountries: ["US"],
    })
    expect(
      plan.desired.find(({ product }) => product.type === "variation")!
        .fulfillmentIntent
    ).toEqual({
      kind: "fixed_standard",
      amount: 7,
      currency: "USD",
      countries: ["US"],
    })
  })

  test("round-trips editable domestic and international rate cards with exact minor-unit money", () => {
    expect(buildShippingPolicyFromDraft(shippingPolicyToDraft(policy))).toEqual(
      policy
    )
    const form = shippingPolicyToDraft(policy)
    form.domestic.rules[0]!.bands[0]!.price = "0.001"
    expect(() => buildShippingPolicyFromDraft(form)).toThrow()
  })
  test.each(["SATS", "MSATS", "JPY", "USD", "KWD", "BTC"])(
    "preserves %s prices and thresholds through edit and signed republication",
    async (currency) => {
      for (const minor of [
        0,
        1,
        12345,
        Number.MAX_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const exactPolicy: ShippingPolicy = {
          ...policy,
          currency,
          domestic: {
            rules: [
              {
                country: "US",
                bands: [{ maxWeightGrams: 500, priceMinor: minor }],
              },
            ],
            freeShippingThresholdMinor: minor,
          },
          international: {
            rules: [
              {
                country: "CA",
                bands: [{ maxWeightGrams: 500, priceMinor: minor }],
              },
            ],
            freeShippingThresholdMinor: minor,
          },
        }
        const editable = shippingPolicyToDraft(exactPolicy)
        editable.title = "Updated title"
        const rebuilt = buildShippingPolicyFromDraft(editable)
        expect(rebuilt).toEqual({ ...exactPolicy, title: "Updated title" })
        const republished = finalizeEvent(
          {
            ...buildShippingPolicyEventDraft({ policy: rebuilt }),
            created_at: 30,
          },
          secret
        )
        expect(
          parseShippingOptionEvent(await admitFixture(republished))
            ?.shippingPolicy
        ).toEqual(rebuilt)
      }
    }
  )
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
  test.each(["SATS", "MSATS", "JPY", "USD", "KWD", "CLF", "BTC"])(
    "preserves every accepted %s handling minor unit through signed product parsing and quoting",
    async (currency) => {
      const digits = getCurrencyFractionDigits(currency)
      const exactText = (minor: number) => {
        const text = String(minor).padStart(digits + 1, "0")
        return digits
          ? `${text.slice(0, -digits)}.${text.slice(-digits)}`
          : text
      }
      const losesMaximum = ["USD", "KWD", "BTC"].includes(currency)
      if (losesMaximum) {
        expect(() =>
          getProductShippingMeasurements({
            currency,
            shippingHandling: exactText(Number.MAX_SAFE_INTEGER),
          })
        ).toThrow("preserve exactly")
      }
      const exactPolicy: ShippingPolicy = {
        version: 2,
        title: "Handling boundary",
        originCountry: "US",
        currency,
        domestic: {
          rules: [
            {
              country: "US",
              bands: [{ maxWeightGrams: 500_000, priceMinor: 0 }],
            },
          ],
        },
        international: null,
      }
      const policyEvent = finalizeEvent(
        {
          ...buildShippingPolicyEventDraft({ policy: exactPolicy }),
          created_at: 30,
        },
        secret
      )
      for (const minor of [
        0,
        1,
        12345,
        Number.MAX_SAFE_INTEGER - 1,
        ...(losesMaximum ? [] : [Number.MAX_SAFE_INTEGER]),
      ]) {
        const measurements = getProductShippingMeasurements({
          currency,
          shippingWeightGrams: "250",
          shippingHandling: exactText(minor),
        })
        expect(
          shippingMoneyToMinorUnits(
            measurements.shippingHandling!.amount,
            currency
          )
        ).toBe(minor)
        const price = currency === "MSATS" ? 1000 : 1
        const quantity = currency === "MSATS" && minor === 1 ? 1000 : 1
        const signed = finalizeEvent(
          {
            ...buildProductListingEventDraft({
              product: {
                ...product,
                ...measurements,
                price,
                currency,
                shippingWeightAllowanceGrams: undefined,
                shippingOptionId: tableIntent.policyCoordinate,
              },
              dTag: "one",
            }),
            created_at: 31,
          },
          secret
        )
        const parsed = parseProductEvent(await admitFixture(signed))!
        expect(
          shippingMoneyToMinorUnits(parsed.shippingHandling!.amount, currency)
        ).toBe(minor)
        const result = quoteShippingPolicy({
          policy: exactPolicy,
          policyCoordinate: tableIntent.policyCoordinate,
          policyEventId: policyEvent.id,
          policyCreatedAt: policyEvent.created_at,
          merchantPubkey: pubkey,
          policyEvent: await admitFixture(policyEvent),
          destination: { country: "US" },
          rateInput: {
            rate: minor <= 12345 ? 10_000 : 1_000_000_000_000,
            fetchedAt: Date.now(),
            source: "env",
            fiatUsdRates: { JPY: 1, KWD: 1, CLF: 1 },
            fiatSource: "env",
          },
          items: [
            {
              productId: parsed.id,
              productEventId: signed.id,
              productCreatedAt: signed.created_at,
              productEvent: await admitFixture(signed),
              currency,
              quantity,
              weightGrams: parsed.shippingWeightGrams,
              shippingHandling: parsed.shippingHandling,
              subtotalMinor:
                shippingMoneyToMinorUnits(price, currency) * quantity,
            },
          ],
        })
        expect(result.status).toBe("quoted")
        if (result.status !== "quoted") throw new Error(result.status)
        expect(result.quote.handlingMinor).toBe(minor * quantity)
        expect(result.quote.amountMinor).toBe(minor * quantity)
        if (result.quote.version !== 2) throw new Error("Expected v2 terms")
        expect(
          shippingMoneyToMinorUnits(
            result.quote.items[0]!.shippingHandling!.amount,
            currency
          )
        ).toBe(minor)
      }
    }
  )
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
      await admitFixture(newerEvent)
    )!
    newerOption.readSource = "relay"
    newerOption.readCoverage = "complete"
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
  test.each(["repair", "remove"] as const)(
    "explicitly %ss malformed parent and variation adjustments before signed republication",
    async (action) => {
      const terms: ShippingPolicy = {
        version: 2,
        title: "Repair rates",
        originCountry: "US",
        currency: "SATS",
        domestic: {
          rules: [
            {
              country: "US",
              bands: [{ maxWeightGrams: 1000, priceMinor: 100 }],
            },
          ],
        },
        international: null,
      }
      const policyEvent = finalizeEvent(
        { ...buildShippingPolicyEventDraft({ policy: terms }), created_at: 20 },
        secret
      )
      const current = parseShippingOptionEvent(await admitFixture(policyEvent))!
      current.readSource = "relay"
      current.readCoverage = "complete"
      const records = await Promise.all(
        ["one", "one-small"].map(async (dTag, index) => {
          const source = {
            ...product,
            id: `30402:${pubkey}:${dTag}`,
            type: index === 0 ? ("variable" as const) : ("variation" as const),
            parentProductId: index === 0 ? undefined : `30402:${pubkey}:one`,
            specifications:
              index === 0 ? [] : [{ key: "Size", value: "Small" }],
            price: 1000,
            currency: "SATS",
            sourcePrice: undefined,
            shippingWeightAllowanceGrams: undefined,
            shippingHandling: undefined,
            shippingOptionId: tableIntent.policyCoordinate,
          }
          const draft = buildProductListingEventDraft({ product: source, dTag })
          const signed = finalizeEvent(
            {
              ...draft,
              tags: [...draft.tags, ["conduit_shipping_adjustments", "1", "{"]],
              created_at: 21,
            },
            secret
          )
          const parsed = parseProductEvent(await admitFixture(signed))!
          expect(parsed.shippingAdjustmentsMalformed).toBe(true)
          return {
            product: parsed,
            dTag,
            addressId: parsed.id,
            eventId: signed.id,
            eventCreatedAt: signed.created_at,
          }
        })
      )
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
      expect(() =>
        buildProductFamilyChangePlan({
          parentDTag: "one",
          baseProduct: { ...family.root.product, title: "Title-only edit" },
          variations: restored.state,
          currency: "SATS",
          fulfillmentIntent: {
            kind: "preserve_existing",
            baseline: family.root.product,
          },
          authoringCountries: [],
          existing: family,
        })
      ).toThrow("repair or remove")
      const fields = {
        shippingWeightGrams: "250",
        shippingWeightAllowanceGrams: action === "repair" ? "50" : "",
        shippingHandling: action === "repair" ? "25" : "",
      }
      const change = buildProductFamilyChangePlan({
        parentDTag: "one",
        baseProduct: {
          ...family.root.product,
          ...getProductShippingMeasurements({ ...fields, currency: "SATS" }),
          shippingAdjustmentsMalformed: undefined,
        },
        variations: {
          ...restored.state,
          rows: restored.state.rows.map((row) => ({ ...row, ...fields })),
        },
        currency: "SATS",
        fulfillmentIntent: { ...tableIntent, policyEventId: policyEvent.id },
        authoringCountries: [],
        existing: family,
      })
      expect(change.publish).toHaveLength(2)
      const prepared = await prepareProductPublicationListings(
        change.publish,
        { merchantPubkey: pubkey },
        { ...dependencies, getShippingOptions: async () => [current] }
      )
      const items = await Promise.all(
        prepared.map(async (target) => {
          expect(target.product.shippingAdjustmentsMalformed).toBeUndefined()
          const signed = finalizeEvent(
            {
              ...buildProductListingEventDraft({
                product: applyProductFulfillmentIntentForPublication({
                  product: target.product,
                  merchantPubkey: pubkey,
                  productDTag: target.dTag,
                  intent: target.fulfillmentIntent,
                }),
                dTag: target.dTag,
              }),
              created_at: 22,
            },
            secret
          )
          const parsed = parseProductEvent(await admitFixture(signed))!
          expect(parsed.shippingAdjustmentsMalformed).toBeUndefined()
          expect(parsed.shippingHandling?.amount).toBe(
            action === "repair" ? 25 : undefined
          )
          expect(parsed.shippingWeightAllowanceGrams).toBe(
            action === "repair" ? 50 : undefined
          )
          return {
            productId: parsed.id,
            productEventId: signed.id,
            productCreatedAt: signed.created_at,
            productEvent: await admitFixture(signed),
            currency: "SATS",
            quantity: 1,
            weightGrams: parsed.shippingWeightGrams,
            shippingWeightAllowanceGrams: parsed.shippingWeightAllowanceGrams,
            shippingHandling: parsed.shippingHandling,
            subtotalMinor: 1000,
          }
        })
      )
      const result = quoteShippingPolicy({
        policy: terms,
        policyCoordinate: tableIntent.policyCoordinate,
        policyEventId: policyEvent.id,
        policyCreatedAt: policyEvent.created_at,
        merchantPubkey: pubkey,
        policyEvent: await admitFixture(policyEvent),
        destination: { country: "US" },
        rateInput: { rate: 10000, fetchedAt: Date.now(), source: "env" },
        items,
      })
      expect(result.status).toBe("quoted")
      if (result.status !== "quoted") throw new Error(result.status)
      expect(result.quote.handlingMinor).toBe(action === "repair" ? 50 : 0)
      expect(result.quote.amountMinor).toBe(action === "repair" ? 150 : 100)
    }
  )
  test("table variations share measurements only with an explicit authoring choice", async () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("Size", "Small, Large", 0)],
    })
    state.shareShippingMeasurements = true
    state.rows = state.rows.map((row) => ({
      ...row,
      shippingWeightAllowanceGrams: "50",
      shippingHandling: "1.25",
    }))
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
    expect(restored.state.shareShippingMeasurements).not.toBe(true)
    expect(
      restored.state.rows.every(
        (row) => row.inheritShipping && !row.shippingResolution
      )
    ).toBe(true)
    const changed = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: { ...family.root.product, shippingWeightGrams: 300 },
      variations: { ...restored.state, shareShippingMeasurements: true },
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
  test("family edits preserve distinct table measurements and packing adjustments", async () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("Size", "Small, Large", 0)],
    })
    state.rows = state.rows.map((row, index) => ({
      ...row,
      shippingWeightGrams: String(200 + index * 300),
      shippingWeightAllowanceGrams: String(20 + index * 30),
      shippingHandling: String(1 + index),
      shippingLengthCm: String(10 + index),
      shippingWidthCm: "5",
      shippingHeightCm: "2",
    }))
    const initial = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: product,
      variations: state,
      currency: "USD",
      fulfillmentIntent: tableIntent,
      authoringCountries: [],
    })
    const records = initial.desired.map((target, index) => ({
      ...target,
      addressId: target.product.id,
      eventId: `existing-${index}`,
      eventCreatedAt: 20,
    }))
    const family = {
      root: records[0]!,
      variations: records.slice(1),
      orphanVariation: false,
    }
    const restored = getProductVariationFormState(
      family.root,
      family.variations
    )
    expect(restored.state.shareShippingMeasurements).not.toBe(true)
    const change = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: {
        ...family.root.product,
        title: "Edited family",
        shippingWeightGrams: 900,
      },
      variations: restored.state,
      currency: "USD",
      fulfillmentIntent: tableIntent,
      authoringCountries: [],
      existing: family,
    })
    const prepared = await prepareProductPublicationListings(
      change.publish,
      { merchantPubkey: pubkey },
      dependencies
    )
    const children = prepared.filter(
      ({ product }) => product.type === "variation"
    )
    expect(children.map(({ product }) => product.shippingWeightGrams)).toEqual([
      200, 500,
    ])
    expect(
      children.map(({ product }) => product.shippingWeightAllowanceGrams)
    ).toEqual([20, 50])
    expect(
      children.map(({ product }) => product.shippingHandling?.amount)
    ).toEqual([1, 2])
    expect(
      children.map(({ product }) => product.shippingDimensionsCm?.length)
    ).toEqual([10, 11])
    const shared = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: {
        ...family.root.product,
        shippingWeightGrams: 900,
        shippingDimensionsCm: { length: 30, width: 20, height: 10 },
      },
      variations: { ...restored.state, shareShippingMeasurements: true },
      currency: "USD",
      fulfillmentIntent: tableIntent,
      authoringCountries: [],
      existing: family,
    })
    const sharedChildren = (
      await prepareProductPublicationListings(
        shared.publish,
        { merchantPubkey: pubkey },
        dependencies
      )
    ).filter(({ product }) => product.type === "variation")
    expect(
      sharedChildren.map(({ product }) => product.shippingWeightGrams)
    ).toEqual([900, 900])
    expect(
      sharedChildren.every(
        ({ product }) => product.shippingDimensionsCm?.length === 30
      )
    ).toBe(true)
    expect(
      sharedChildren.map(({ product }) => product.shippingHandling?.amount)
    ).toEqual([1, 2])
    const wire = buildProductListingEventDraft({
      product: sharedChildren[0]!.product,
      dTag: sharedChildren[0]!.dTag,
    })
    expect(wire.tags).toContainEqual(["weight", "900", "g"])
    expect(wire.tags).toContainEqual(["dim", "30x20x10", "cm"])
  })
  test("individual table rows require weights and complete optional dimensions; drafts retain the explicit choice", () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      axes: [createProductVariationAxis("Size", "Small, Large", 0)],
    })
    const options = {
      shippingPricingMode: "weight_table",
      baseFormat: "physical",
    }
    expect(getProductVariationFormError(state, "USD", options)).toContain(
      "Small: Add a shipping weight"
    )
    const one = updateProductVariationMeasurements(
      state,
      state.rows[0]!.identity,
      { shippingWeightGrams: "250", shippingLengthCm: "10" }
    )
    expect(getProductVariationFormError(one, "USD", options)).toContain(
      "All three dimensions"
    )
    const complete = { ...one, shareShippingMeasurements: true }
    expect(getProductVariationFormError(complete, "USD", options)).toBeNull()
    expect(
      parseProductVariationFormState(JSON.parse(JSON.stringify(complete)))
    ).toMatchObject(complete)
    expect(
      parseProductVariationFormState({
        ...complete,
        shareShippingMeasurements: "yes",
      })
    ).toBeNull()
    expect(() =>
      buildProductFamilyChangePlan({
        parentDTag: "one",
        baseProduct: product,
        variations: state,
        currency: "USD",
        fulfillmentIntent: tableIntent,
        authoringCountries: [],
      })
    ).toThrow("Add a shipping weight")
    const published = {
      supported: true,
      state: {
        ...state,
        rows: state.rows.map((row) => ({
          ...row,
          shippingWeightGrams: "400",
          shippingHandling: "2",
        })),
      },
    }
    expect(
      reconcileProductVariationDraftResolution(published, state).rows[0]
    ).toMatchObject({ shippingWeightGrams: "400", shippingHandling: "2" })
  })
  test("digital variations publish without inherited physical adjustment tags", async () => {
    const state = generateProductVariationRows({
      ...createEmptyProductVariationForm(),
      enabled: true,
      shareShippingMeasurements: true,
      axes: [createProductVariationAxis("Edition", "Printed, Download", 0)],
    })
    state.rows[1] = {
      ...state.rows[1]!,
      format: "digital",
      shippingWeightGrams: "invalid",
      shippingHandling: "invalid",
      shippingWeightAllowanceGrams: "invalid",
    }
    const plan = buildProductFamilyChangePlan({
      parentDTag: "one",
      baseProduct: product,
      variations: state,
      currency: "USD",
      fulfillmentIntent: tableIntent,
      authoringCountries: [],
    })
    const prepared = await prepareProductPublicationListings(
      plan.publish,
      { merchantPubkey: pubkey },
      dependencies
    )
    const digital = prepared.find(
      ({ product }) => product.format === "digital"
    )!
    const signed = finalizeEvent(
      {
        ...buildProductListingEventDraft({
          product: digital.product,
          dTag: digital.dTag,
        }),
        created_at: 21,
      },
      secret
    )
    expect(
      signed.tags.some(([name]) =>
        [
          "weight",
          "dim",
          "conduit_shipping_adjustments",
          "shipping_option",
        ].includes(name)
      )
    ).toBe(false)
    expect(digital.product.shippingHandling).toBeUndefined()
    expect(digital.product.shippingWeightAllowanceGrams).toBeUndefined()
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
