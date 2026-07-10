import type { ProductZapMessagePolicy } from "@conduit/core"
import type { ShippingConfig } from "./readiness"
import { isShippingComplete } from "./readiness"
import {
  normalizePublishableProductPrice,
  normalizePublishableProductShippingCost,
  parsePlainDecimalAmount,
  type ProductFulfillmentFormat,
  type ProductShippingPricingMode,
} from "./productPriceForm"

export const MIN_PRODUCT_TAG_COUNT = 3

export interface ProductPublishFormValues {
  title: string
  price: string
  currency: string
  format: ProductFulfillmentFormat
  shippingPricingMode: ProductShippingPricingMode
  shippingCost: string
  usePresetShippingZone: boolean
  customShippingConfig: ShippingConfig
  imageUrl: string
  tags: string
}

export interface MerchantProductFormValues extends ProductPublishFormValues {
  summary: string
  publicZapEnabled: boolean
  zapMessagePolicy: ProductZapMessagePolicy
}

export function reconcileProductFormShippingPreset(
  form: MerchantProductFormValues,
  hasPresetShippingZone: boolean
): MerchantProductFormValues {
  if (
    form.usePresetShippingZone &&
    (!hasPresetShippingZone || form.format === "digital")
  ) {
    return { ...form, usePresetShippingZone: false }
  }

  return form
}

export type ProductPublishFormField =
  "title" | "price" | "imageUrl" | "tags" | "shippingCost" | "shippingZone"

export interface ProductPublishFormValidation {
  canPublish: boolean
  errors: Partial<Record<ProductPublishFormField, string>>
  firstError: string | null
  tags: string[]
}

export function parseProductTags(tagsCsv: string): string[] {
  const seen = new Set<string>()

  return tagsCsv
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => {
      const normalized = tag.toLowerCase()
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
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
  const hasFixedShipping = !isDigital && form.shippingPricingMode === "fixed"
  const shippingCostInput = hasFixedShipping ? form.shippingCost.trim() : ""

  if (!title) {
    addError(errors, "title", "Add a product title.")
  }

  try {
    normalizePublishableProductPrice(
      parsePlainDecimalAmount(form.price, "Price"),
      currency
    )
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
  }

  if (hasFixedShipping && !shippingCostInput) {
    addError(
      errors,
      "shippingCost",
      "Enter 0 for included shipping or a fixed amount, or choose coordinate shipping after the order."
    )
  }

  if (shippingCostInput) {
    try {
      normalizePublishableProductShippingCost(
        parsePlainDecimalAmount(shippingCostInput, "Shipping"),
        currency
      )
    } catch (error) {
      addError(
        errors,
        "shippingCost",
        error instanceof Error
          ? error.message
          : "Shipping must be a non-negative amount."
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
