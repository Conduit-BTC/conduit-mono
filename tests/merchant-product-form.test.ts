import { describe, expect, it } from "bun:test"
import {
  addProductTags,
  buildProductShippingMetadata,
  canSubmitProductForm,
  formatProductTags,
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
    imageUrl: "https://example.com/pocket-node.png",
    tags: "gear, hardware, demo",
    ...overrides,
  }
}

function validate(
  values: ProductPublishFormValues,
  hasPresetShippingZone = false
) {
  return validateProductPublishForm(values, { hasPresetShippingZone })
}

describe("merchant product form validation", () => {
  it("round-trips preset-backed fixed shipping without losing its association", () => {
    const metadata = buildProductShippingMetadata("merchant", true, {
      countries: [
        {
          code: "US",
          name: "United States",
          restrictTo: ["787**"],
          exclude: ["78799"],
        },
      ],
    })

    expect(metadata).toEqual({
      shippingOptionId: "30406:merchant:conduit-default",
      shippingOptionDTag: "conduit-default",
      shippingCountries: ["US"],
      shippingCountryRules: [
        {
          code: "US",
          name: "United States",
          restrictTo: ["787**"],
          exclude: ["78799"],
        },
      ],
    })
    expect(isProductUsingPresetShippingZone(metadata, true)).toBe(true)
    expect(isProductUsingPresetShippingZone(metadata, false)).toBe(false)
  })

  it("keeps custom fixed shipping detached from the shared preset", () => {
    const metadata = buildProductShippingMetadata("merchant", false, {
      countries: [
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
      ],
    })

    expect(metadata.shippingOptionId).toBeUndefined()
    expect(metadata.shippingOptionDTag).toBeUndefined()
    expect(metadata.shippingCountries).toEqual(["CA"])
    expect(isProductUsingPresetShippingZone(metadata, true)).toBe(false)
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
