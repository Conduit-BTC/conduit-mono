import type { ShippingConfig } from "./readiness"
import { isShippingComplete } from "./readiness"
import {
  normalizePublishableProductPrice,
  normalizePublishableProductShippingCost,
  type ProductFulfillmentFormat,
} from "./productPriceForm"

export const MIN_PRODUCT_TAG_COUNT = 3
export const MAX_PRODUCT_TAG_COUNT = 12
export const MAX_PRODUCT_TAG_LENGTH = 40

export interface ProductPublishFormValues {
  title: string
  price: string
  currency: string
  format: ProductFulfillmentFormat
  shippingCost: string
  usePresetShippingZone: boolean
  customShippingConfig: ShippingConfig
  imageUrl: string
  tags: string
}

export type ProductPublishFormField =
  "title" | "price" | "imageUrl" | "tags" | "shippingCost" | "shippingZone"

export interface ProductPublishFormValidation {
  canPublish: boolean
  errors: Partial<Record<ProductPublishFormField, string>>
  firstError: string | null
  tags: string[]
}

export interface ProductTagEditResult {
  tags: string[]
  rejected: {
    duplicates: string[]
    tooLong: string[]
    tooMany: string[]
  }
}

function normalizeProductTag(tag: string): string {
  return tag.trim().toLowerCase()
}

export function parseProductTags(tagsCsv: string): string[] {
  const seen = new Set<string>()

  return tagsCsv
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => {
      const normalized = normalizeProductTag(tag)
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
}

export function formatProductTags(tags: string[]): string {
  return parseProductTags(tags.join(",")).join(", ")
}

export function addProductTags(
  currentTagsCsv: string,
  input: string
): ProductTagEditResult {
  const tags = parseProductTags(currentTagsCsv)
  const seen = new Set(tags.map(normalizeProductTag))
  const rejected: ProductTagEditResult["rejected"] = {
    duplicates: [],
    tooLong: [],
    tooMany: [],
  }

  const candidates = input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    const normalized = normalizeProductTag(candidate)
    if (seen.has(normalized)) {
      rejected.duplicates.push(candidate)
      continue
    }
    if (candidate.length > MAX_PRODUCT_TAG_LENGTH) {
      rejected.tooLong.push(candidate)
      continue
    }
    if (tags.length >= MAX_PRODUCT_TAG_COUNT) {
      rejected.tooMany.push(candidate)
      continue
    }

    tags.push(candidate)
    seen.add(normalized)
  }

  return { tags, rejected }
}

export function removeProductTagAtIndex(
  currentTagsCsv: string,
  index: number
): string[] {
  const tags = parseProductTags(currentTagsCsv)
  if (index < 0 || index >= tags.length) return tags

  return tags.filter((_, tagIndex) => tagIndex !== index)
}

export function getProductTagEditFeedback(
  result: ProductTagEditResult
): string | null {
  if (result.rejected.tooLong.length > 0) {
    return `Keep each tag to ${MAX_PRODUCT_TAG_LENGTH} characters or fewer.`
  }
  if (result.rejected.tooMany.length > 0) {
    return `Use ${MAX_PRODUCT_TAG_COUNT} tags or fewer.`
  }
  if (result.rejected.duplicates.length > 0) {
    return "Tag already added."
  }
  return null
}

function addError(
  errors: Partial<Record<ProductPublishFormField, string>>,
  field: ProductPublishFormField,
  message: string
): void {
  errors[field] = message
}

function firstError(
  errors: Partial<Record<ProductPublishFormField, string>>
): string | null {
  return (
    errors.title ??
    errors.price ??
    errors.imageUrl ??
    errors.tags ??
    errors.shippingCost ??
    errors.shippingZone ??
    null
  )
}

export function validateProductPublishForm(
  form: ProductPublishFormValues,
  options: { hasPresetShippingZone: boolean }
): ProductPublishFormValidation {
  const errors: Partial<Record<ProductPublishFormField, string>> = {}
  const title = form.title.trim()
  const currency = form.currency.trim().toUpperCase() || "USD"
  const imageUrl = form.imageUrl.trim()
  const tags = parseProductTags(form.tags)
  const isDigital = form.format === "digital"
  const shippingCostInput = isDigital ? "" : form.shippingCost.trim()

  if (!title) {
    addError(errors, "title", "Add a product title.")
  }

  try {
    normalizePublishableProductPrice(Number(form.price), currency)
  } catch (error) {
    addError(
      errors,
      "price",
      error instanceof Error ? error.message : "Price must be greater than zero"
    )
  }

  if (!imageUrl) {
    addError(
      errors,
      "imageUrl",
      "Image URL is required for Market-visible products."
    )
  } else if (!/^https:\/\//i.test(imageUrl)) {
    addError(errors, "imageUrl", "Image URL must start with https://")
  }

  if (tags.length < MIN_PRODUCT_TAG_COUNT) {
    addError(
      errors,
      "tags",
      `Add at least ${MIN_PRODUCT_TAG_COUNT} distinct tags.`
    )
  } else if (tags.length > MAX_PRODUCT_TAG_COUNT) {
    addError(errors, "tags", `Use ${MAX_PRODUCT_TAG_COUNT} tags or fewer.`)
  } else if (tags.some((tag) => tag.length > MAX_PRODUCT_TAG_LENGTH)) {
    addError(
      errors,
      "tags",
      `Keep each tag to ${MAX_PRODUCT_TAG_LENGTH} characters or fewer.`
    )
  }

  if (shippingCostInput) {
    try {
      normalizePublishableProductShippingCost(
        Number(shippingCostInput),
        currency
      )
    } catch (error) {
      addError(
        errors,
        "shippingCost",
        error instanceof Error
          ? error.message
          : "Shipping must be a non-negative amount or blank."
      )
    }

    const hasShippingZone = form.usePresetShippingZone
      ? options.hasPresetShippingZone
      : isShippingComplete(form.customShippingConfig)
    if (!hasShippingZone) {
      addError(
        errors,
        "shippingZone",
        form.usePresetShippingZone
          ? "Attach your preset shipping zone before publishing a physical product with a fixed shipping cost."
          : "Add at least one custom shipping destination before publishing a physical product with a fixed shipping cost."
      )
    }
  }

  const first = firstError(errors)
  return {
    canPublish: !first,
    errors,
    firstError: first,
    tags,
  }
}

export function canSubmitProductForm(
  validation: ProductPublishFormValidation,
  options: { isEditing: boolean; hasProductChanges: boolean }
): boolean {
  return (
    validation.canPublish && (!options.isEditing || options.hasProductChanges)
  )
}
