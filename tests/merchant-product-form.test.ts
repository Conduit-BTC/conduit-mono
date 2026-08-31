import { describe, expect, it } from "bun:test"
import { compileProductFulfillmentIntent } from "@conduit/core"
import {
  addProductTags,
  buildProductShippingMetadata,
  canUseZeroProductPrice,
  canSubmitProductForm,
  formatProductTags,
  getProductShippingPricingMode,
  getProductTagEditFeedback,
  MAX_PRODUCT_TAG_COUNT,
  MAX_PRODUCT_TAG_LENGTH,
  MIN_PRODUCT_TAG_COUNT,
  parseProductTags,
  RECOMMENDED_MAX_PRODUCT_TAG_COUNT,
  RECOMMENDED_MIN_PRODUCT_TAG_COUNT,
  reconcileProductFormShippingPreset,
  removeProductTagAtIndex,
  isProductUsingPresetShippingZone,
  validateProductPublishForm,
  type MerchantProductFormValues,
  type ProductPublishFormValues,
} from "../apps/merchant/src/lib/productForm"
import {
  createProductVariationAxis,
  createEmptyProductVariationForm,
  generateProductVariationRows,
} from "../apps/merchant/src/lib/productVariations"

function form(
  overrides: Partial<ProductPublishFormValues> = {}
): ProductPublishFormValues {
  return {
    title: "Pocket Node",
    price: "25",
    stock: "",
    currency: "USD",
    format: "physical",
    shippingPricingMode: "coordinate_after_order",
    shippingCost: "",
    usePresetShippingZone: false,
    customShippingConfig: { countries: [] },
    imageUrl: "https://cdn.conduit.market/pocket-node.png",
    tags: "gear, hardware, demo",
    ...overrides,
  }
}

function validate(
  values: ProductPublishFormValues,
  hasPresetShippingZone = false,
  allowZeroPrice = false
) {
  return validateProductPublishForm(values, {
    hasPresetShippingZone,
    allowZeroPrice,
  })
}

describe("merchant product form validation", () => {
  it("uses one product-scoped wire identity for preset and custom fixed shipping", () => {
    const fixedIntent = {
      kind: "fixed_standard" as const,
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
    }
    const presetMetadata = buildProductShippingMetadata(
      "merchant",
      "pocket-node",
      fixedIntent
    )
    const customMetadata = buildProductShippingMetadata(
      "merchant",
      "pocket-node",
      fixedIntent
    )

    expect(presetMetadata).toEqual({
      shippingOptionId: "30406:merchant:pocket-node-shipping-standard",
      shippingOptionDTag: "pocket-node-shipping-standard",
      shippingOptionIds: ["30406:merchant:pocket-node-shipping-standard"],
      shippingOptionDTags: ["pocket-node-shipping-standard"],
      shippingCountries: ["US"],
      shippingCountryRules: [
        {
          code: "US",
          name: "US",
          restrictTo: [],
          exclude: [],
        },
      ],
    })
    expect(customMetadata).toEqual(presetMetadata)
    expect(isProductUsingPresetShippingZone(presetMetadata, true)).toBe(false)
  })

  it("compiles saved per-destination preset rates into product shipping options", () => {
    const presetShippingConfig = {
      countries: [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: [],
          rate: { amount: "5", currency: "USD" },
        },
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
          rate: { amount: "9", currency: "USD" },
        },
      ],
    }
    const validation = validateProductPublishForm(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "",
        usePresetShippingZone: true,
      }),
      {
        hasPresetShippingZone: true,
        presetShippingConfig,
      }
    )
    const intent = compileProductFulfillmentIntent({
      format: "physical",
      shippingPricingMode: "fixed",
      currency: "USD",
      destinations: presetShippingConfig.countries.map(
        ({ rate, ...destination }) => ({
          ...destination,
          rate: { amount: Number(rate.amount), currency: rate.currency },
        })
      ),
    })
    const metadata = buildProductShippingMetadata(
      "merchant",
      "pocket-node",
      intent
    )

    expect(validation.canPublish).toBe(true)
    expect(metadata.shippingOptionIds).toHaveLength(2)
    expect(metadata.shippingOptionDTags).toHaveLength(2)
    expect(metadata.shippingCountries).toEqual(["CA", "US"])
  })

  it("rejects preset rates that would be rounded for their currency", () => {
    const validateRate = (amount: string, currency: string) =>
      validateProductPublishForm(
        form({
          currency,
          shippingPricingMode: "fixed",
          shippingCost: "",
          usePresetShippingZone: true,
        }),
        {
          hasPresetShippingZone: true,
          presetShippingConfig: {
            countries: [
              {
                code: "US",
                name: "United States",
                restrictTo: [],
                exclude: [],
                rate: { amount, currency },
              },
            ],
          },
        }
      )

    expect(validateRate("6.666", "USD").errors.shippingZone).toContain(
      "USD supports up to 2 decimal places"
    )
    expect(validateRate("1.5", "SATS").errors.shippingZone).toContain(
      "SATS amounts must be whole numbers"
    )
  })

  it("does not emit shipping metadata for order-first fulfillment", () => {
    const metadata = buildProductShippingMetadata("merchant", "pocket-node", {
      kind: "coordinate_after_order",
    })

    expect(metadata).toEqual({})
  })

  it("keeps an unresolved canonical shipping reference in fixed mode", () => {
    expect(
      getProductShippingPricingMode({
        format: "physical",
        shippingOptionId: "30406:merchant:pocket-node-shipping-standard",
      })
    ).toBe("fixed")
    expect(
      getProductShippingPricingMode({
        format: "physical",
      })
    ).toBe("coordinate_after_order")
    expect(
      getProductShippingPricingMode({
        format: "physical",
        shippingCostSats: 5,
      })
    ).toBe("fixed")
  })

  it("keeps tag recommendations advisory within the publishable range", () => {
    expect(MIN_PRODUCT_TAG_COUNT).toBe(3)
    expect(RECOMMENDED_MIN_PRODUCT_TAG_COUNT).toBe(5)
    expect(RECOMMENDED_MAX_PRODUCT_TAG_COUNT).toBe(12)
    expect(MAX_PRODUCT_TAG_COUNT).toBe(24)

    expect(validate(form({ tags: "one, two, three" })).canPublish).toBe(true)
  })

  it("reconciles restored drafts with current shipping readiness", () => {
    const values: MerchantProductFormValues = {
      ...form({ usePresetShippingZone: true }),
      summary: "",
      fulfillment: "ship",
      eventMarketReference: "",
      eventHandoffMode: "merchant_handoff",
      merchantPickupTitle: "Merchant booth pickup",
      merchantPickupLocation: "",
      merchantPickupGeohash: "",
      merchantPickupCountry: "US",
      publicZapEnabled: true,
      zapMessagePolicy: "generic_only",
    }

    expect(reconcileProductFormShippingPreset(values, false)).toEqual({
      ...values,
      usePresetShippingZone: false,
    })
    expect(
      reconcileProductFormShippingPreset({ ...values, format: "digital" }, true)
        .usePresetShippingZone
    ).toBe(false)
    expect(reconcileProductFormShippingPreset(values, true)).toBe(values)
  })

  it("keeps a blank create form invalid", () => {
    const validation = validate(
      form({
        title: "",
        price: "0",
        imageUrl: "",
        tags: "",
      })
    )

    expect(validation.canPublish).toBe(false)
    expect(validation.errors.title).toBe("Add a product title.")
    expect(validation.errors.price).toContain("greater than zero")
    expect(validation.errors.imageUrl).toContain("Image URL is required")
    expect(validation.errors.tags).toContain(
      `at least ${MIN_PRODUCT_TAG_COUNT} distinct tags`
    )
  })

  it("does not make unrelated dropdown changes publishable", () => {
    const validation = validate(
      form({
        title: "",
        format: "digital",
        price: "0",
        imageUrl: "",
        tags: "",
      })
    )

    expect(validation.canPublish).toBe(false)
    expect(validation.firstError).toBe("Add a product title.")
  })

  it("allows valid create fields with optional summary omitted", () => {
    const validation = validate(form())

    expect(validation.canPublish).toBe(true)
    expect(validation.tags).toEqual(["gear", "hardware", "demo"])
  })

  it("accepts blank or whole-number stock and rejects unsafe inventory", () => {
    expect(validate(form({ stock: "" })).canPublish).toBe(true)
    expect(validate(form({ stock: "0" })).canPublish).toBe(true)
    expect(validate(form({ stock: "12" })).canPublish).toBe(true)

    expect(validate(form({ stock: "2.5" })).errors.stock).toBe(
      "Stock must be a whole number or left blank."
    )
    expect(
      validate(form({ stock: String(Number.MAX_SAFE_INTEGER + 1) })).errors
        .stock
    ).toBe("Stock must be a non-negative safe integer.")
  })

  it("requires complete, valid variation options before publishing", () => {
    const missingOptions = validate(
      form({
        variations: {
          ...createEmptyProductVariationForm(),
          enabled: true,
        },
      })
    )
    const validOptions = validate(
      form({
        variations: generateProductVariationRows({
          ...createEmptyProductVariationForm(),
          enabled: true,
          axes: [createProductVariationAxis("size", "S, M, L, XL")],
        }),
      })
    )

    expect(missingOptions.canPublish).toBe(false)
    expect(missingOptions.errors.variations).toContain("name")
    expect(validOptions.canPublish).toBe(true)
  })

  it("canonicalizes and dedupes tags case-insensitively", () => {
    expect(parseProductTags("Gear, gear, , HARDWARE, Demo, hardware")).toEqual([
      "gear",
      "hardware",
      "demo",
    ])

    const validation = validate(form({ tags: "gear, Gear, hardware" }))

    expect(validation.canPublish).toBe(false)
    expect(validation.errors.tags).toContain(
      `at least ${MIN_PRODUCT_TAG_COUNT} distinct tags`
    )
  })

  it("adds comma-separated tag chips while rejecting duplicates predictably", () => {
    const result = addProductTags("Gear, hardware", "Demo, gear, Field Kit")

    expect(result.tags).toEqual(["gear", "hardware", "demo", "field kit"])
    expect(result.rejected.duplicates).toEqual(["gear"])
    expect(getProductTagEditFeedback(result)).toBe("Tag already added.")
    expect(formatProductTags(result.tags)).toBe(
      "gear, hardware, demo, field kit"
    )
    expect(removeProductTagAtIndex(formatProductTags(result.tags), 1)).toEqual([
      "gear",
      "demo",
      "field kit",
    ])
  })

  it("enforces explicit tag count and visible length limits", () => {
    const currentTags = Array.from(
      { length: MAX_PRODUCT_TAG_COUNT },
      (_, index) => `tag-${index + 1}`
    ).join(", ")
    const tooMany = addProductTags(currentTags, "overflow")
    const tooLongTag = "x".repeat(MAX_PRODUCT_TAG_LENGTH + 1)
    const tooLong = addProductTags("", tooLongTag)

    expect(tooMany.tags).toHaveLength(MAX_PRODUCT_TAG_COUNT)
    expect(tooMany.rejected.tooMany).toEqual(["overflow"])
    expect(getProductTagEditFeedback(tooMany)).toBe(
      `Use ${MAX_PRODUCT_TAG_COUNT} tags or fewer.`
    )
    expect(tooLong.tags).toEqual([])
    expect(tooLong.rejected.tooLong).toEqual([tooLongTag])
    expect(getProductTagEditFeedback(tooLong)).toBe(
      `Keep each tag to ${MAX_PRODUCT_TAG_LENGTH} characters or fewer.`
    )
  })

  it("blocks publish when hydrated tags exceed count or length limits", () => {
    const tooManyTags = Array.from(
      { length: MAX_PRODUCT_TAG_COUNT + 1 },
      (_, index) => `tag-${index + 1}`
    ).join(", ")
    const tooLongTag = "x".repeat(MAX_PRODUCT_TAG_LENGTH + 1)

    const tooMany = validate(form({ tags: tooManyTags }))
    const tooLong = validate(form({ tags: `gear, hardware, ${tooLongTag}` }))

    expect(tooMany.canPublish).toBe(false)
    expect(tooMany.errors.tags).toBe(
      `Use ${MAX_PRODUCT_TAG_COUNT} tags or fewer.`
    )
    expect(tooLong.canPublish).toBe(false)
    expect(tooLong.errors.tags).toBe(
      `Keep each tag to ${MAX_PRODUCT_TAG_LENGTH} characters or fewer.`
    )
  })
  it("blocks invalid prices and non-https image URLs", () => {
    const zeroPrice = validate(form({ price: "0" }))
    const httpImage = validate(
      form({ imageUrl: "http://example.com/item.png" })
    )

    expect(zeroPrice.canPublish).toBe(false)
    expect(zeroPrice.errors.price).toContain("greater than zero")
    expect(httpImage.canPublish).toBe(false)
    expect(httpImage.errors.imageUrl).toBe("Image URL must start with https://")
  })

  it("blocks private-network image destinations", () => {
    const privateImage = validate(
      form({ imageUrl: "https://192.168.1.20/item.png" })
    )

    expect(privateImage.canPublish).toBe(false)
    expect(privateImage.errors.imageUrl).toBe(
      "Image URL must use a public network destination."
    )
  })

  it("requires an explicit verified pickup lane before accepting zero", () => {
    const defaultNative = validate(form({ price: "0", currency: "SATS" }))
    const verifiedNative = validate(
      form({ price: "0", currency: "SATS" }),
      false,
      true
    )
    const verifiedFiat = validate(
      form({ price: "0", currency: "USD" }),
      false,
      true
    )

    expect(defaultNative.errors.price).toContain("greater than zero")
    expect(verifiedNative.canPublish).toBe(true)
    expect(verifiedFiat.errors.price).toContain("BTC-native")
  })

  it("recognizes only explicit verified merchant or organizer pickup as zero-price eligible", () => {
    for (const handoffMode of [
      "merchant_handoff",
      "organizer_handoff",
    ] as const) {
      expect(
        canUseZeroProductPrice({
          fulfillment: "local_pickup",
          handoffMode,
          evidenceVerified: true,
        })
      ).toBe(true)
    }

    for (const candidate of [
      {
        fulfillment: "local_pickup",
        handoffMode: "merchant_handoff",
        evidenceVerified: false,
      },
      {
        fulfillment: "ship",
        handoffMode: "merchant_handoff",
        evidenceVerified: true,
      },
      {
        fulfillment: "digital",
        handoffMode: "organizer_handoff",
        evidenceVerified: true,
      },
      {
        fulfillment: "local_pickup",
        handoffMode: "unsupported",
        evidenceVerified: true,
      },
    ]) {
      expect(canUseZeroProductPrice(candidate)).toBe(false)
    }
  })

  it("rejects exponent and signed amount syntax", () => {
    const exponentPrice = validate(form({ price: "1e3" }))
    const exponentShipping = validate(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "1e3",
      })
    )

    expect(exponentPrice.errors.price).toContain(
      "digits and a decimal point only"
    )
    expect(exponentShipping.errors.shippingCost).toContain(
      "digits and a decimal point only"
    )
  })

  it("rejects price and shipping precision that would be rounded", () => {
    const roundedPrice = validate(form({ price: "6.666" }))
    const roundedShipping = validate(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "6.666",
      })
    )

    expect(roundedPrice.errors.price).toContain(
      "USD supports up to 2 decimal places"
    )
    expect(roundedShipping.errors.shippingCost).toContain(
      "USD supports up to 2 decimal places"
    )
  })

  it("requires physical sellers to choose fixed or coordinated shipping", () => {
    const blankFixed = validate(
      form({ shippingPricingMode: "fixed", shippingCost: "" })
    )
    const coordinated = validate(
      form({
        shippingPricingMode: "coordinate_after_order",
        shippingCost: "",
      })
    )
    const digital = validate(
      form({
        format: "digital",
        shippingPricingMode: "fixed",
        shippingCost: "",
      })
    )

    expect(blankFixed.errors.shippingCost).toContain(
      "Enter 0 for included shipping"
    )
    expect(coordinated.canPublish).toBe(true)
    expect(digital.canPublish).toBe(true)
  })

  it("requires a shipping zone when physical fixed shipping is set", () => {
    const missingPreset = validate(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "5",
        usePresetShippingZone: true,
      }),
      false
    )
    const withPreset = validate(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "5",
        usePresetShippingZone: true,
      }),
      true
    )
    const withCustom = validate(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "5",
        usePresetShippingZone: false,
        customShippingConfig: {
          countries: [
            {
              code: "US",
              name: "United States",
              restrictTo: [],
              exclude: [],
            },
          ],
        },
      }),
      false
    )

    expect(missingPreset.canPublish).toBe(false)
    expect(missingPreset.errors.shippingZone).toContain(
      "Attach your preset shipping zone"
    )
    expect(withPreset.canPublish).toBe(true)
    expect(withCustom.canPublish).toBe(true)
  })

  it("treats zero as fixed included shipping and still requires a zone", () => {
    const missingZone = validate(
      form({ shippingPricingMode: "fixed", shippingCost: "0" })
    )
    const withPreset = validate(
      form({
        shippingPricingMode: "fixed",
        shippingCost: "0",
        usePresetShippingZone: true,
      }),
      true
    )

    expect(missingZone.errors.shippingZone).toContain(
      "custom shipping destination"
    )
    expect(withPreset.canPublish).toBe(true)
  })

  it("keeps unchanged edits disabled separately from validity", () => {
    const validation = validate(form())

    expect(
      canSubmitProductForm(validation, {
        isEditing: true,
        hasProductChanges: false,
      })
    ).toBe(false)
    expect(
      canSubmitProductForm(validation, {
        isEditing: true,
        hasProductChanges: true,
      })
    ).toBe(true)
    expect(
      canSubmitProductForm(validation, {
        isEditing: false,
        hasProductChanges: false,
      })
    ).toBe(true)
  })
})
