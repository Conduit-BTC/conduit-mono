import {
  canonicalizeProductTags,
  compileProductFulfillmentIntent,
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  getFixedShippingOptionAddresses,
  getFixedShippingOptionDTags,
  getFixedShippingRateZones,
  normalizePublicMediaUrl,
  type ProductFulfillmentIntent,
  type ProductSchema,
  type ProductZapMessagePolicy,
  type EventMarketHandoffMode,
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
import {
  getProductVariationFormError,
  type ProductVariationFormState,
} from "./productVariations"

export const MIN_PRODUCT_TAG_COUNT = 3
export const RECOMMENDED_MIN_PRODUCT_TAG_COUNT = 5
export const RECOMMENDED_MAX_PRODUCT_TAG_COUNT = 12
export const MAX_PRODUCT_TAG_COUNT = 24
export const MAX_PRODUCT_TAG_LENGTH = 40

export type ProductFulfillmentChoice = "digital" | "ship" | "local_pickup"

export function canUseZeroProductPrice(input: {
  fulfillment: unknown
  handoffMode: unknown
  evidenceVerified: boolean
}): boolean {
  return (
    input.evidenceVerified &&
    input.fulfillment === "local_pickup" &&
    (input.handoffMode === "merchant_handoff" ||
      input.handoffMode === "organizer_handoff")
  )
}

export interface ProductPublishFormValues {
  title: string
  price: string
  stock: string
  variations?: ProductVariationFormState
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
  variations: ProductVariationFormState
  fulfillment: ProductFulfillmentChoice
  eventMarketReference: string
  eventHandoffMode: EventMarketHandoffMode
  merchantPickupTitle: string
  merchantPickupLocation: string
  merchantPickupGeohash: string
  merchantPickupCountry: string
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
    | "format"
    | "shippingOptionId"
    | "shippingOptionIds"
    | "sourceShippingCost"
    | "shippingCostSats"
  >
): ProductShippingPricingMode {
  const hasFixedShippingCost =
    typeof product.sourceShippingCost?.amount === "number" ||
    typeof product.shippingCostSats === "number"
  return product.format === "physical" &&
    !product.shippingOptionId &&
    !product.shippingOptionIds?.length &&
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
  const shippingOptionIds = getFixedShippingOptionAddresses(
    merchantPubkey,
    productDTag,
    intent
  )
  const shippingOptionDTags = getFixedShippingOptionDTags(productDTag, intent)
  const shippingCountryRules = getFixedShippingRateZones(intent).flatMap(
    (zone) =>
      zone.countryRules.map((rule) => ({
        ...rule,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
        ...(rule.includeSubdivisions
          ? { includeSubdivisions: [...rule.includeSubdivisions] }
          : {}),
        ...(rule.excludeSubdivisions
          ? { excludeSubdivisions: [...rule.excludeSubdivisions] }
          : {}),
      }))
  )

  return {
    shippingOptionId: shippingOptionIds[0],
    shippingOptionDTag: shippingOptionDTags[0],
    shippingOptionIds,
    shippingOptionDTags,
    shippingCountries: Array.from(
      new Set(shippingCountryRules.map((rule) => rule.code))
    ).sort(),
    shippingCountryRules,
  }
}

export function reconcileProductFormShippingPreset(
  form: MerchantProductFormValues,
  hasPresetShippingZone: boolean
): MerchantProductFormValues {
  if (
    form.usePresetShippingZone &&
    (!hasPresetShippingZone ||
      form.format === "digital" ||
      form.fulfillment !== "ship")
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
  | "variations"
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
    errors.variations ??
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
    allowZeroPrice?: boolean
    destinationPolicyV1Enabled?: boolean
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
  const selectedShippingConfig = form.usePresetShippingZone
    ? options.presetShippingConfig
    : form.customShippingConfig
  const allDestinationsHaveRates =
    (selectedShippingConfig?.countries.length ?? 0) > 0 &&
    selectedShippingConfig!.countries.every((country) =>
      country.rate?.amount.trim()
    )

  if (!title) {
    addError(errors, "title", "Add a product title.")
  }

  try {
    normalizePublishableProductPrice(
      parsePlainDecimalAmount(form.price, "Price"),
      currency,
      { allowZero: options.allowZeroPrice }
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

  if (form.variations) {
    const variationError = getProductVariationFormError(
      form.variations,
      currency
    )
    if (variationError) addError(errors, "variations", variationError)
  }

  if (!imageUrl) {
    addError(
      errors,
      "imageUrl",
      "Image URL is required for Market-visible products."
    )
  } else if (!/^https:\/\//i.test(imageUrl)) {
    addError(errors, "imageUrl", "Image URL must start with https://")
  } else if (!normalizePublicMediaUrl(imageUrl)) {
    addError(
      errors,
      "imageUrl",
      "Image URL must use a public network destination."
    )
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

  if (hasFixedShipping && !shippingCostInput && !allDestinationsHaveRates) {
    addError(
      errors,
      "shippingCost",
      "Enter 0 for included shipping or a fixed amount, or choose coordinate shipping after the order."
    )
  }

  if (hasFixedShipping) {
    try {
      if (shippingCostInput) {
        normalizePublishableProductShippingCost(
          parsePlainDecimalAmount(shippingCostInput, "Shipping"),
          currency
        )
      }
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
    } else {
      if (
        selectedShippingConfig?.countries.some(
          (country) =>
            country.restrictTo.length > 0 ||
            country.exclude.length > 0 ||
            (country.includeSubdivisions?.length ?? 0) > 0 ||
            (country.excludeSubdivisions?.length ?? 0) > 0
        ) &&
        !options.destinationPolicyV1Enabled
      ) {
        addError(
          errors,
          "shippingZone",
          "Detailed destination policies are available only in the preview rollout. Remove subdivision/postal rules or coordinate shipping after the order."
        )
      }

      if (selectedShippingConfig) {
        try {
          compileProductFulfillmentIntent({
            format: "physical",
            shippingPricingMode: "fixed",
            amount: shippingCostInput
              ? parsePlainDecimalAmount(shippingCostInput, "Shipping")
              : undefined,
            currency,
            destinations: selectedShippingConfig.countries.map(
              ({ rate, ...destination }) => {
                if (!rate) return destination
                const amount = parsePlainDecimalAmount(
                  rate.amount,
                  `${destination.name} shipping`
                )
                return {
                  ...destination,
                  rate: {
                    amount: normalizePublishableProductShippingCost(
                      amount,
                      rate.currency
                    ),
                    currency: rate.currency,
                  },
                }
              }
            ),
            allowExperimentalDestinationPolicy:
              options.destinationPolicyV1Enabled,
          })
        } catch (error) {
          addError(
            errors,
            "shippingZone",
            error instanceof Error
              ? error.message
              : "Shipping destinations and rates are invalid."
          )
        }
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
