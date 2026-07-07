import { describe, expect, it } from "bun:test"
import {
  addProductTags,
  canSubmitProductForm,
  formatProductTags,
  getProductTagEditFeedback,
  MAX_PRODUCT_TAG_COUNT,
  MAX_PRODUCT_TAG_LENGTH,
  MIN_PRODUCT_TAG_COUNT,
  parseProductTags,
  removeProductTagAtIndex,
  validateProductPublishForm,
  type ProductPublishFormValues,
} from "../apps/merchant/src/lib/productForm"

function form(
  overrides: Partial<ProductPublishFormValues> = {}
): ProductPublishFormValues {
  return {
    title: "Pocket Node",
    price: "25",
    currency: "USD",
    format: "physical",
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

  it("dedupes tags case-insensitively and preserves first-entered casing", () => {
    expect(parseProductTags("Gear, gear, , HARDWARE, Demo, hardware")).toEqual([
      "Gear",
      "HARDWARE",
      "Demo",
    ])

    const validation = validate(form({ tags: "gear, Gear, hardware" }))

    expect(validation.canPublish).toBe(false)
    expect(validation.errors.tags).toContain(
      `at least ${MIN_PRODUCT_TAG_COUNT} distinct tags`
    )
  })

  it("adds comma-separated tag chips while rejecting duplicates predictably", () => {
    const result = addProductTags("Gear, hardware", "Demo, gear, Field Kit")

    expect(result.tags).toEqual(["Gear", "hardware", "Demo", "Field Kit"])
    expect(result.rejected.duplicates).toEqual(["gear"])
    expect(getProductTagEditFeedback(result)).toBe("Tag already added.")
    expect(formatProductTags(result.tags)).toBe(
      "Gear, hardware, Demo, Field Kit"
    )
    expect(removeProductTagAtIndex(formatProductTags(result.tags), 1)).toEqual([
      "Gear",
      "Demo",
      "Field Kit",
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

  it("requires a shipping zone when physical fixed shipping is set", () => {
    const missingPreset = validate(
      form({
        shippingCost: "5",
        usePresetShippingZone: true,
      }),
      false
    )
    const withPreset = validate(
      form({
        shippingCost: "5",
        usePresetShippingZone: true,
      }),
      true
    )
    const withCustom = validate(
      form({
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
