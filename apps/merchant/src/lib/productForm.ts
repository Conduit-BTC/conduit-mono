import {
  canonicalizeProductTags,
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  getShippingOptionAddress,
  type ProductSchema,
  type ProductZapMessagePolicy,
} from "@conduit/core"
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
export const RECOMMENDED_MIN_PRODUCT_TAG_COUNT = 5
export const RECOMMENDED_MAX_PRODUCT_TAG_COUNT = 12
export const MAX_PRODUCT_TAG_COUNT = 24
export const MAX_PRODUCT_TAG_LENGTH = 40

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

export function isProductUsingPresetShippingZone(
  product: Pick<ProductSchema, "shippingOptionId">,
  presetAvailable: boolean
): boolean {
  return presetAvailable && !!product.shippingOptionId
}

export function buildProductShippingMetadata(
  merchantPubkey: string,
  usePresetShippingZone: boolean,
  shippingConfig: ShippingConfig
): Pick<
  ProductSchema,
  | "shippingOptionId"
  | "shippingOptionDTag"
  | "shippingCountries"
  | "shippingCountryRules"
> {
  if (!isShippingComplete(shippingConfig)) return {}

  return {
    ...(usePresetShippingZone
      ? {
          shippingOptionId: getShippingOptionAddress(merchantPubkey),
          shippingOptionDTag: CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
        }
      : {}),
    shippingCountries: shippingConfig.countries.map((country) => country.code),
    shippingCountryRules: shippingConfig.countries.map((country) => ({
      code: country.code,
      name: country.name,
      restrictTo: country.restrictTo,
      exclude: country.exclude,
    })),
  }
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

export interface ProductTagEditResult {
  tags: string[]
  rejected: {
    duplicates: string[]
    tooLong: string[]
    tooMany: string[]
  }
}

export function parseProductTags(tagsCsv: string): string[] {
  return canonicalizeProductTags(tagsCsv.split(","))
}

export function formatProductTags(tags: string[]): string {
  return parseProductTags(tags.join(",")).join(", ")
}

export function addProductTags(
  currentTagsCsv: string,
  input: string
): ProductTagEditResult {
  const tags = parseProductTags(currentTagsCsv)
  const seen = new Set(tags)
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
    const canonicalTag = canonicalizeProductTags([candidate])[0]
    if (!canonicalTag) continue
    if (seen.has(canonicalTag)) {
      rejected.duplicates.push(candidate)
      continue
    }
    if (canonicalTag.length > MAX_PRODUCT_TAG_LENGTH) {
      rejected.tooLong.push(candidate)
      continue
    }
    if (tags.length >= MAX_PRODUCT_TAG_COUNT) {
      rejected.tooMany.push(candidate)
      continue
    }

    tags.push(canonicalTag)
    seen.add(canonicalTag)
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
  } else if (tags.length > MAX_PRODUCT_TAG_COUNT) {
    addError(errors, "tags", `Use ${MAX_PRODUCT_TAG_COUNT} tags or fewer.`)
  } else if (tags.some((tag) => tag.length > MAX_PRODUCT_TAG_LENGTH)) {
    addError(
      errors,
      "tags",
      `Keep each tag to ${MAX_PRODUCT_TAG_LENGTH} characters or fewer.`
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
