import {
  buildProductListingEventDraft,
  canonicalizeProductPrice,
  type ProductSchema,
} from "@conduit/core"
import {
  formatProductAmountInput,
  isPlainDecimalInput,
  normalizePublishableProductPrice,
  parsePlainDecimalAmount,
} from "./productPriceForm"
import {
  getProductStockInputError,
  parseProductStockInput,
} from "./productStock"

export const MAX_PRODUCT_VARIATION_AXIS_VALUES = 12
export const MAX_PRODUCT_VARIATION_COUNT = 64
export const MAX_PRODUCT_VARIATION_VALUE_LENGTH = 40

export type ProductVariationAxis = "size" | "color"

export interface ProductVariationOverride {
  identity: string
  dTag?: string
  price: string
  stock: string
}

export interface ProductVariationFormState {
  enabled: boolean
  sizeOptions: string
  colorOptions: string
  overrides: ProductVariationOverride[]
}

export interface ProductVariationCombination {
  identity: string
  label: string
  specifications: ProductSchema["specifications"]
  dTag?: string
  price: string
  stock: string
}

export interface ProductListingRecordLike {
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt: number
  product: ProductSchema
}

export interface ProductListingFamily<
  TRecord extends ProductListingRecordLike = ProductListingRecordLike,
> {
  root: TRecord
  variations: TRecord[]
  orphanVariation: boolean
}

export interface ProductVariationFormResult {
  state: ProductVariationFormState
  supported: boolean
  reason?: string
}

export interface ProductFamilyPublishTarget<
  TRecord extends ProductListingRecordLike = ProductListingRecordLike,
> {
  dTag: string
  product: ProductSchema
  existing?: TRecord
}

export interface ProductFamilyChangePlan<
  TRecord extends ProductListingRecordLike = ProductListingRecordLike,
> {
  desired: ProductFamilyPublishTarget<TRecord>[]
  publish: ProductFamilyPublishTarget<TRecord>[]
  remove: TRecord[]
}

interface ParsedVariationAxis {
  values: string[]
  duplicates: string[]
  tooLong: string[]
}

export function createEmptyProductVariationForm(): ProductVariationFormState {
  return {
    enabled: false,
    sizeOptions: "",
    colorOptions: "",
    overrides: [],
  }
}

export function parseProductVariationFormState(
  value: unknown
): ProductVariationFormState | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as {
    enabled?: unknown
    sizeOptions?: unknown
    colorOptions?: unknown
    overrides?: unknown
  }
  if (
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.sizeOptions !== "string" ||
    typeof candidate.colorOptions !== "string" ||
    !Array.isArray(candidate.overrides)
  ) {
    return null
  }

  const overrides: ProductVariationOverride[] = []
  for (const valueOverride of candidate.overrides) {
    if (!valueOverride || typeof valueOverride !== "object") return null
    const override = valueOverride as {
      identity?: unknown
      dTag?: unknown
      price?: unknown
      stock?: unknown
    }
    if (
      typeof override.identity !== "string" ||
      (override.dTag !== undefined && typeof override.dTag !== "string") ||
      typeof override.price !== "string" ||
      !isPlainDecimalInput(override.price) ||
      typeof override.stock !== "string" ||
      !/^\d*$/.test(override.stock)
    ) {
      return null
    }
    overrides.push({
      identity: override.identity,
      ...(override.dTag ? { dTag: override.dTag } : {}),
      price: override.price,
      stock: override.stock,
    })
  }

  return reconcileProductVariationForm({
    enabled: candidate.enabled,
    sizeOptions: candidate.sizeOptions,
    colorOptions: candidate.colorOptions,
    overrides,
  })
}

function parseVariationAxis(input: string): ParsedVariationAxis {
  const values: string[] = []
  const duplicates: string[] = []
  const tooLong: string[] = []
  const seen = new Set<string>()

  for (const rawValue of input.split(",")) {
    const value = rawValue.trim()
    if (!value) continue

    const identity = value.toLowerCase()
    if (seen.has(identity)) {
      duplicates.push(value)
      continue
    }
    seen.add(identity)

    if (value.length > MAX_PRODUCT_VARIATION_VALUE_LENGTH) {
      tooLong.push(value)
      continue
    }
    values.push(value)
  }

  return { values, duplicates, tooLong }
}

function getCombinationIdentity(
  specifications: ProductSchema["specifications"]
): string {
  return specifications
    .map(
      ({ key, value }) =>
        `${key.trim().toLowerCase()}:${value.trim().toLowerCase()}`
    )
    .join("|")
}

function getCombinationLabel(
  specifications: ProductSchema["specifications"]
): string {
  return specifications.map(({ value }) => value).join(" / ")
}

export function getProductVariationCombinations(
  state: ProductVariationFormState
): ProductVariationCombination[] {
  const sizes = parseVariationAxis(state.sizeOptions).values
  const colors = parseVariationAxis(state.colorOptions).values
  const overrideByIdentity = new Map(
    state.overrides.map((override) => [override.identity, override])
  )
  const specifications: ProductSchema["specifications"][] =
    sizes.length > 0 && colors.length > 0
      ? sizes.flatMap((size) =>
          colors.map((color) => [
            { key: "size", value: size },
            { key: "color", value: color },
          ])
        )
      : sizes.length > 0
        ? sizes.map((size) => [{ key: "size", value: size }])
        : colors.map((color) => [{ key: "color", value: color }])

  return specifications.map((combinationSpecifications) => {
    const identity = getCombinationIdentity(combinationSpecifications)
    const override = overrideByIdentity.get(identity)
    return {
      identity,
      label: getCombinationLabel(combinationSpecifications),
      specifications: combinationSpecifications,
      dTag: override?.dTag,
      price: override?.price ?? "",
      stock: override?.stock ?? "",
    }
  })
}

export function reconcileProductVariationForm(
  state: ProductVariationFormState
): ProductVariationFormState {
  return {
    ...state,
    overrides: getProductVariationCombinations(state).map((combination) => ({
      identity: combination.identity,
      ...(combination.dTag ? { dTag: combination.dTag } : {}),
      price: combination.price,
      stock: combination.stock,
    })),
  }
}

export function updateProductVariationOverride(
  state: ProductVariationFormState,
  identity: string,
  field: "price" | "stock",
  value: string
): ProductVariationFormState {
  const reconciled = reconcileProductVariationForm(state)
  return {
    ...reconciled,
    overrides: reconciled.overrides.map((override) =>
      override.identity === identity
        ? { ...override, [field]: value }
        : override
    ),
  }
}

export function getProductVariationFormError(
  state: ProductVariationFormState,
  currency: string
): string | null {
  if (!state.enabled) return null

  const sizeAxis = parseVariationAxis(state.sizeOptions)
  const colorAxis = parseVariationAxis(state.colorOptions)
  if (sizeAxis.duplicates.length > 0 || colorAxis.duplicates.length > 0) {
    return "Remove duplicate size or color values."
  }
  if (sizeAxis.tooLong.length > 0 || colorAxis.tooLong.length > 0) {
    return `Keep each size or color value to ${MAX_PRODUCT_VARIATION_VALUE_LENGTH} characters or fewer.`
  }
  if (
    sizeAxis.values.length > MAX_PRODUCT_VARIATION_AXIS_VALUES ||
    colorAxis.values.length > MAX_PRODUCT_VARIATION_AXIS_VALUES
  ) {
    return `Use ${MAX_PRODUCT_VARIATION_AXIS_VALUES} values or fewer per option.`
  }

  const combinations = getProductVariationCombinations(state)
  if (combinations.length === 0) {
    return "Add at least one size or color."
  }
  if (combinations.length > MAX_PRODUCT_VARIATION_COUNT) {
    return `Keep the generated variation count to ${MAX_PRODUCT_VARIATION_COUNT} or fewer.`
  }

  for (const combination of combinations) {
    if (combination.price.trim()) {
      try {
        normalizePublishableProductPrice(
          parsePlainDecimalAmount(
            combination.price,
            `${combination.label} price`
          ),
          currency
        )
      } catch (error) {
        return error instanceof Error
          ? error.message
          : `Enter a valid price for ${combination.label}.`
      }
    }

    const stockError = getProductStockInputError(combination.stock)
    if (stockError) return `${combination.label}: ${stockError}`
  }

  return null
}

function slugifyVariationValue(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "option"
  )
}

function stableIdentityHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function buildProductVariationDTag(
  parentDTag: string,
  combination: Pick<ProductVariationCombination, "identity" | "specifications">
): string {
  const optionSlug = combination.specifications
    .map(({ value }) => slugifyVariationValue(value))
    .join("-")
    .slice(0, 80)
  return `${parentDTag}-${optionSlug}-${stableIdentityHash(
    combination.identity
  )}`
}

export function buildProductVariationTitle(
  parentTitle: string,
  combinationLabel: string
): string {
  const suffix = ` - ${combinationLabel}`
  const availableParentLength = Math.max(1, 200 - suffix.length)
  return `${parentTitle.slice(0, availableParentLength).trim()}${suffix}`.slice(
    0,
    200
  )
}

function getProductPriceInput(product: ProductSchema): {
  amount: number
  currency: string
} {
  return {
    amount: product.sourcePrice?.amount ?? product.price,
    currency:
      product.sourcePrice?.normalizedCurrency ??
      product.currency.trim().toUpperCase(),
  }
}

function getSpecificationValue(
  product: ProductSchema,
  axis: ProductVariationAxis
): string | undefined {
  return product.specifications.find(
    ({ key }) => key.trim().toLowerCase() === axis
  )?.value
}

function getSharedVariationProductProjection(product: ProductSchema): unknown {
  return {
    summary: product.summary,
    format: product.format,
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
    visibility: product.visibility,
    images: product.images,
    tags: product.tags,
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    location: product.location,
  }
}

function productsShareVariationFields(
  parent: ProductSchema,
  variation: ProductSchema
): boolean {
  return (
    JSON.stringify(getSharedVariationProductProjection(parent)) ===
    JSON.stringify(getSharedVariationProductProjection(variation))
  )
}

export function getProductVariationFormState<
  TRecord extends ProductListingRecordLike,
>(parent: TRecord, variations: readonly TRecord[]): ProductVariationFormResult {
  if (parent.product.type === "simple" && variations.length === 0) {
    return {
      state: createEmptyProductVariationForm(),
      supported: true,
    }
  }
  if (parent.product.type !== "variable") {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason:
        parent.product.type === "variation"
          ? "This variation has no reachable variable parent."
          : "This product type is not supported by the constrained editor.",
    }
  }
  if (!parent.dTag || variations.length === 0) {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason: "This variable product has no reachable variation listings.",
    }
  }
  if (parent.product.specifications.length > 0) {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason:
        "This variable parent uses product specifications outside the constrained option model.",
    }
  }

  const sizeValues: string[] = []
  const colorValues: string[] = []
  const seenSizes = new Set<string>()
  const seenColors = new Set<string>()
  const seenCombinations = new Set<string>()
  const parentPrice = getProductPriceInput(parent.product)
  const overrides: ProductVariationOverride[] = []

  for (const variation of variations) {
    const size = getSpecificationValue(variation.product, "size")
    const color = getSpecificationValue(variation.product, "color")
    const recognizedSpecifications = variation.product.specifications.filter(
      ({ key }) => {
        const normalized = key.trim().toLowerCase()
        return normalized === "size" || normalized === "color"
      }
    )
    const sizeSpecificationCount = recognizedSpecifications.filter(
      ({ key }) => key.trim().toLowerCase() === "size"
    ).length
    const colorSpecificationCount = recognizedSpecifications.filter(
      ({ key }) => key.trim().toLowerCase() === "color"
    ).length
    if (
      variation.product.type !== "variation" ||
      variation.product.pubkey !== parent.product.pubkey ||
      variation.product.parentProductId !== parent.addressId ||
      !variation.dTag ||
      recognizedSpecifications.length !==
        variation.product.specifications.length ||
      recognizedSpecifications.length === 0 ||
      sizeSpecificationCount > 1 ||
      colorSpecificationCount > 1 ||
      !productsShareVariationFields(parent.product, variation.product)
    ) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason:
          "This family uses variation fields that the constrained size/color editor cannot preserve.",
      }
    }

    const specifications: ProductSchema["specifications"] = [
      ...(size ? [{ key: "size", value: size }] : []),
      ...(color ? [{ key: "color", value: color }] : []),
    ]
    const identity = getCombinationIdentity(specifications)
    if (!identity || seenCombinations.has(identity)) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason: "This family has duplicate or incomplete option combinations.",
      }
    }
    seenCombinations.add(identity)

    if (
      variation.product.title !==
      buildProductVariationTitle(
        parent.product.title,
        getCombinationLabel(specifications)
      )
    ) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason:
          "This family uses custom variation titles that the constrained editor cannot preserve.",
      }
    }

    if (size && !seenSizes.has(size.toLowerCase())) {
      seenSizes.add(size.toLowerCase())
      sizeValues.push(size)
    }
    if (color && !seenColors.has(color.toLowerCase())) {
      seenColors.add(color.toLowerCase())
      colorValues.push(color)
    }

    const variationPrice = getProductPriceInput(variation.product)
    if (variationPrice.currency !== parentPrice.currency) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason:
          "This family uses more than one currency and cannot be edited safely.",
      }
    }

    overrides.push({
      identity,
      dTag: variation.dTag,
      price:
        variationPrice.amount === parentPrice.amount
          ? ""
          : formatProductAmountInput(variationPrice.amount),
      stock:
        variation.product.stock === parent.product.stock
          ? ""
          : typeof variation.product.stock === "number"
            ? String(variation.product.stock)
            : "",
    })
  }

  const expectedCombinationCount =
    (sizeValues.length || 1) * (colorValues.length || 1)
  if (expectedCombinationCount !== variations.length) {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason:
        "This family does not contain the complete size/color combination set.",
    }
  }

  return {
    supported: true,
    state: reconcileProductVariationForm({
      enabled: true,
      sizeOptions: sizeValues.join(", "),
      colorOptions: colorValues.join(", "),
      overrides,
    }),
  }
}

export function groupProductVariationRecords<
  TRecord extends ProductListingRecordLike,
>(records: readonly TRecord[]): ProductListingFamily<TRecord>[] {
  const recordsByAddress = new Map(
    records.map((record) => [record.addressId, record])
  )
  const variationsByParent = new Map<string, TRecord[]>()
  const assignedVariations = new Set<string>()

  for (const record of records) {
    const parentProductId = record.product.parentProductId
    if (record.product.type !== "variation" || !parentProductId) continue

    const parent = recordsByAddress.get(parentProductId)
    if (
      !parent ||
      parent.product.type !== "variable" ||
      parent.product.pubkey !== record.product.pubkey
    ) {
      continue
    }
    const siblings = variationsByParent.get(parentProductId) ?? []
    siblings.push(record)
    variationsByParent.set(parentProductId, siblings)
    assignedVariations.add(record.addressId)
  }

  return records
    .filter((record) => !assignedVariations.has(record.addressId))
    .map((record) => ({
      root: record,
      variations: variationsByParent.get(record.addressId) ?? [],
      orphanVariation: record.product.type === "variation",
    }))
}

function getListingDraftFingerprint(
  record: Pick<ProductFamilyPublishTarget, "dTag" | "product">
): string {
  const draft = buildProductListingEventDraft({
    product: record.product,
    dTag: record.dTag,
    clientAppId: "merchant",
  })
  return JSON.stringify([draft.kind, draft.content, draft.tags])
}

function buildVariationProduct(
  parent: ProductSchema,
  parentDTag: string,
  combination: ProductVariationCombination,
  currency: string,
  existing: ProductListingRecordLike | undefined,
  now: number
): ProductSchema {
  const dTag =
    combination.dTag ??
    buildProductVariationDTag(parentDTag, {
      identity: combination.identity,
      specifications: combination.specifications,
    })
  let product: ProductSchema = {
    ...parent,
    id: `30402:${parent.pubkey}:${dTag}`,
    title: buildProductVariationTitle(parent.title, combination.label),
    type: "variation",
    parentProductId: `30402:${parent.pubkey}:${parentDTag}`,
    specifications: combination.specifications,
    stock: combination.stock.trim()
      ? parseProductStockInput(combination.stock)
      : parent.stock,
    createdAt: existing?.product.createdAt ?? now,
    updatedAt: now,
  }

  if (combination.price.trim()) {
    const overrideAmount = normalizePublishableProductPrice(
      parsePlainDecimalAmount(combination.price, `${combination.label} price`),
      currency
    )
    product = canonicalizeProductPrice({
      ...product,
      price: overrideAmount,
      currency,
      priceSats: undefined,
      sourcePrice: undefined,
    })
  }

  return product
}

export function buildProductFamilyChangePlan<
  TRecord extends ProductListingRecordLike,
>(input: {
  parentDTag: string
  baseProduct: ProductSchema
  variations: ProductVariationFormState
  currency: string
  existing?: ProductListingFamily<TRecord>
  now?: number
}): ProductFamilyChangePlan<TRecord> {
  const now = input.now ?? Date.now()
  const parentDTag = input.parentDTag.trim()
  if (!parentDTag) throw new Error("Product d tag is required")

  const existingByDTag = new Map<string, TRecord>()
  if (input.existing?.root.dTag) {
    existingByDTag.set(input.existing.root.dTag, input.existing.root)
  }
  for (const variation of input.existing?.variations ?? []) {
    if (variation.dTag) existingByDTag.set(variation.dTag, variation)
  }

  const parentProduct: ProductSchema = {
    ...input.baseProduct,
    id: `30402:${input.baseProduct.pubkey}:${parentDTag}`,
    type: input.variations.enabled ? "variable" : "simple",
    parentProductId: undefined,
    specifications: [],
  }
  const desired: ProductFamilyPublishTarget<TRecord>[] = [
    {
      dTag: parentDTag,
      product: parentProduct,
      existing: existingByDTag.get(parentDTag),
    },
  ]

  if (input.variations.enabled) {
    for (const combination of getProductVariationCombinations(
      input.variations
    )) {
      const dTag =
        combination.dTag ??
        buildProductVariationDTag(parentDTag, {
          identity: combination.identity,
          specifications: combination.specifications,
        })
      const existing = existingByDTag.get(dTag)
      desired.push({
        dTag,
        product: buildVariationProduct(
          parentProduct,
          parentDTag,
          { ...combination, dTag },
          input.currency,
          existing,
          now
        ),
        existing,
      })
    }
  }

  const desiredDTags = new Set(desired.map(({ dTag }) => dTag))
  const remove = (input.existing?.variations ?? []).filter(
    (variation) => !!variation.dTag && !desiredDTags.has(variation.dTag)
  )
  const publish = desired.filter((target) => {
    if (!target.existing?.dTag) return true
    return (
      getListingDraftFingerprint(target) !==
      getListingDraftFingerprint({
        dTag: target.existing.dTag,
        product: target.existing.product,
      })
    )
  })

  return { desired, publish, remove }
}
