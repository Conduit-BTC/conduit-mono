import {
  canonicalizeProductTags,
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  getProductShippingZoneAddress,
  getProductShippingZoneDTag,
  type ProductFulfillmentIntent,
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
import { getProductStockInputError } from "./productStock"

export const MIN_PRODUCT_TAG_COUNT = 3
export const RECOMMENDED_MIN_PRODUCT_TAG_COUNT = 5
export const RECOMMENDED_MAX_PRODUCT_TAG_COUNT = 12
export const MAX_PRODUCT_TAG_COUNT = 24
export const MAX_PRODUCT_TAG_LENGTH = 40

export interface ProductPublishFormValues {
  title: string
  price: string
  stock: string
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
  product: Pick<ProductSchema, "shippingOptionDTag">,
  presetAvailable: boolean
): boolean {
  return (
    presetAvailable &&
    product.shippingOptionDTag === CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
  )
}

export function getProductShippingPricingMode(
  product: Pick<
    ProductSchema,
    "format" | "shippingOptionId" | "sourceShippingCost" | "shippingCostSats"
  >
): ProductShippingPricingMode {
  const hasFixedShippingCost =
    typeof product.sourceShippingCost?.amount === "number" ||
    typeof product.shippingCostSats === "number"
  return product.format === "physical" &&
    !product.shippingOptionId &&
    !hasFixedShippingCost
    ? "coordinate_after_order"
    : "fixed"
}

export function buildProductShippingMetadata(
  merchantPubkey: string,
  productDTag: string,
  intent: ProductFulfillmentIntent
): Pick<
  ProductSchema,
  | "shippingOptionId"
  | "shippingOptionDTag"
  | "shippingOptionIds"
  | "shippingOptionDTags"
  | "shippingCountries"
  | "shippingCountryRules"
> {
  if (intent.kind !== "fixed_standard") return {}
  const shippingOptionIds = intent.zones.map((zone) =>
    getProductShippingZoneAddress(merchantPubkey, productDTag, zone.countries)
  )
  const shippingOptionDTags = intent.zones.map((zone) =>
    getProductShippingZoneDTag(productDTag, zone.countries)
  )
  const countries = Array.from(
    new Set(intent.zones.flatMap((zone) => zone.countries))
  ).sort()

  return {
    shippingOptionId: shippingOptionIds[0],
    shippingOptionDTag: shippingOptionDTags[0],
    shippingOptionIds,
    shippingOptionDTags,
    shippingCountries: countries,
    shippingCountryRules: countries.map((code) => ({
      code,
      name: code,
      restrictTo: [],
      exclude: [],
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
  | "title"
  | "price"
  | "stock"
  | "imageUrl"
  | "tags"
  | "shippingCost"
  | "shippingZone"

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
    errors.stock ??
    errors.imageUrl ??
    errors.tags ??
    errors.shippingCost ??
    errors.shippingZone ??
    null
  )
}

export function validateProductPublishForm(
  form: ProductPublishFormValues,
  options: {
    hasPresetShippingZone: boolean
    presetShippingConfig?: ShippingConfig
  }
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

  const stockError = getProductStockInputError(form.stock)
  if (stockError) addError(errors, "stock", stockError)

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
  }

  if (hasFixedShipping) {
    const hasShippingZone = form.usePresetShippingZone
      ? options.hasPresetShippingZone
      : isShippingComplete(form.customShippingConfig)
    const selectedShippingConfig = form.usePresetShippingZone
      ? options.presetShippingConfig
      : form.customShippingConfig
    if (!hasShippingZone || !selectedShippingConfig) {
      addError(
        errors,
        "shippingZone",
        form.usePresetShippingZone
          ? "Attach your preset shipping zone before publishing a physical product with a fixed shipping cost."
          : "Add at least one custom shipping destination before publishing a physical product with a fixed shipping cost."
      )
    } else {
      if (
        selectedShippingConfig.countries.some(
          (country) =>
            country.restrictTo.length > 0 || country.exclude.length > 0
        )
      ) {
        addError(
          errors,
          "shippingZone",
          "Fixed checkout supports country destinations only. Remove postal restrictions or coordinate shipping after the order."
        )
      }
      const invalidRate = selectedShippingConfig.countries.find((country) => {
        if (!country.rate) return false
        if (country.rate.currency.trim().toUpperCase() !== currency) {
          return true
        }
        try {
          normalizePublishableProductShippingCost(country.rate.amount, currency)
          return false
        } catch {
          return true
        }
      })
      if (invalidRate) {
        addError(
          errors,
          "shippingZone",
          `The ${invalidRate.code} zone rate must be non-negative, use ${currency}, and fit its supported precision.`
        )
      }
      const missingRate = selectedShippingConfig.countries.find(
        (country) => !country.rate
      )
      if (missingRate && !shippingCostInput) {
        addError(
          errors,
          "shippingCost",
          `Add a rate for ${missingRate.code}, or enter a product fallback shipping amount.`
        )
      }
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
