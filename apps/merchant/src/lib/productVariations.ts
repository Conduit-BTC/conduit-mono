import {
  buildProductListingEventDraft,
  canonicalizeProductPrice,
  type ProductImage,
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

export const MAX_PRODUCT_VARIATION_AXES = 3
export const MAX_PRODUCT_VARIATION_AXIS_VALUES = 12
export const MAX_PRODUCT_VARIATION_COUNT = 64
export const MAX_PRODUCT_VARIATION_VALUE_LENGTH = 40

export interface ProductVariationAxis {
  id: string
  key: string
  values: string
}

export interface ProductVariationRow {
  identity: string
  dTag?: string
  specifications: ProductSchema["specifications"]
  title: string
  price: string
  stock: string
  inheritStock: boolean
  imageUrls: string
  inheritImages: boolean
  format: "inherit" | "physical" | "digital"
  shippingCost: string
  inheritShipping: boolean
}

/** Compatibility name retained for draft and call-site locality. */
export type ProductVariationOverride = ProductVariationRow

export interface ProductVariationFormState {
  enabled: boolean
  axes: ProductVariationAxis[]
  rows: ProductVariationRow[]
}

export interface ProductVariationCombination extends ProductVariationRow {
  label: string
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

const NATURAL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

function normalizePart(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
}

function axisId(key: string, index = 0): string {
  const normalized = normalizePart(key).replace(/[^a-z0-9]+/g, "-")
  return `axis-${normalized || "option"}-${index}`
}

export function createProductVariationAxis(
  key: string,
  values = "",
  index = 0
): ProductVariationAxis {
  return { id: axisId(key, index), key, values }
}

export function createEmptyProductVariationForm(): ProductVariationFormState {
  return {
    enabled: false,
    axes: [createProductVariationAxis("size")],
    rows: [],
  }
}

function parseVariationAxis(input: string): ParsedVariationAxis {
  const values: string[] = []
  const duplicates: string[] = []
  const tooLong: string[] = []
  const seen = new Set<string>()

  for (const rawValue of input.split(",")) {
    const value = rawValue.trim()
    if (!value) continue
    const identity = normalizePart(value)
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
    .map(({ key, value }) => `${normalizePart(key)}:${normalizePart(value)}`)
    .join("|")
}

function getCombinationLabel(
  specifications: ProductSchema["specifications"]
): string {
  return specifications.map(({ value }) => value).join(" / ")
}

function createVariationRow(
  specifications: ProductSchema["specifications"],
  existing?: Partial<ProductVariationRow>
): ProductVariationRow {
  return {
    identity: getCombinationIdentity(specifications),
    specifications: specifications.map((specification) => ({
      ...specification,
    })),
    title: "",
    price: "",
    stock: "",
    inheritStock: true,
    imageUrls: "",
    inheritImages: true,
    format: "inherit",
    shippingCost: "",
    inheritShipping: true,
    ...existing,
  }
}

function parseNewVariationRow(value: unknown): ProductVariationRow | null {
  if (!value || typeof value !== "object") return null
  const row = value as Partial<Record<keyof ProductVariationRow, unknown>>
  if (
    typeof row.identity !== "string" ||
    (row.dTag !== undefined && typeof row.dTag !== "string") ||
    !Array.isArray(row.specifications) ||
    typeof row.title !== "string" ||
    typeof row.price !== "string" ||
    !isPlainDecimalInput(row.price) ||
    typeof row.stock !== "string" ||
    !/^\d*$/.test(row.stock) ||
    typeof row.inheritStock !== "boolean" ||
    typeof row.imageUrls !== "string" ||
    typeof row.inheritImages !== "boolean" ||
    !["inherit", "physical", "digital"].includes(String(row.format)) ||
    typeof row.shippingCost !== "string" ||
    !isPlainDecimalInput(row.shippingCost) ||
    typeof row.inheritShipping !== "boolean"
  ) {
    return null
  }
  const specifications: ProductSchema["specifications"] = []
  for (const specification of row.specifications) {
    if (!specification || typeof specification !== "object") return null
    const candidate = specification as { key?: unknown; value?: unknown }
    if (
      typeof candidate.key !== "string" ||
      typeof candidate.value !== "string"
    ) {
      return null
    }
    specifications.push({ key: candidate.key, value: candidate.value })
  }
  return createVariationRow(specifications, {
    identity: getCombinationIdentity(specifications),
    ...(row.dTag ? { dTag: row.dTag } : {}),
    title: row.title,
    price: row.price,
    stock: row.stock,
    inheritStock: row.inheritStock,
    imageUrls: row.imageUrls,
    inheritImages: row.inheritImages,
    format: row.format as ProductVariationRow["format"],
    shippingCost: row.shippingCost,
    inheritShipping: row.inheritShipping,
  })
}

function migrateLegacyVariationState(
  candidate: Record<string, unknown>
): ProductVariationFormState | null {
  if (
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.sizeOptions !== "string" ||
    typeof candidate.colorOptions !== "string" ||
    !Array.isArray(candidate.overrides)
  ) {
    return null
  }
  const axes = [
    ...(candidate.sizeOptions.trim()
      ? [createProductVariationAxis("size", candidate.sizeOptions, 0)]
      : []),
    ...(candidate.colorOptions.trim()
      ? [createProductVariationAxis("color", candidate.colorOptions, 1)]
      : []),
  ]
  const base: ProductVariationFormState = {
    enabled: candidate.enabled,
    axes: axes.length > 0 ? axes : [createProductVariationAxis("size")],
    rows: [],
  }
  const generated = generateProductVariationRows(base)
  const overrides = new Map<
    string,
    { dTag?: string; price: string; stock: string }
  >()
  for (const value of candidate.overrides) {
    if (!value || typeof value !== "object") return null
    const override = value as Record<string, unknown>
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
    overrides.set(override.identity, {
      ...(override.dTag ? { dTag: override.dTag } : {}),
      price: override.price,
      stock: override.stock,
    })
  }
  return {
    ...generated,
    rows: generated.rows.map((row) => {
      const override = overrides.get(row.identity)
      return override
        ? {
            ...row,
            ...override,
            inheritStock: override.stock.trim().length === 0,
          }
        : row
    }),
  }
}

export function parseProductVariationFormState(
  value: unknown
): ProductVariationFormState | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.axes) || !Array.isArray(candidate.rows)) {
    return migrateLegacyVariationState(candidate)
  }
  if (typeof candidate.enabled !== "boolean") return null

  const axes: ProductVariationAxis[] = []
  for (const valueAxis of candidate.axes) {
    if (!valueAxis || typeof valueAxis !== "object") return null
    const axis = valueAxis as Record<string, unknown>
    if (
      typeof axis.id !== "string" ||
      typeof axis.key !== "string" ||
      typeof axis.values !== "string"
    ) {
      return null
    }
    axes.push({ id: axis.id, key: axis.key, values: axis.values })
  }
  const rows: ProductVariationRow[] = []
  for (const valueRow of candidate.rows) {
    const row = parseNewVariationRow(valueRow)
    if (!row) return null
    rows.push(row)
  }
  return reconcileProductVariationForm({
    enabled: candidate.enabled,
    axes,
    rows,
  })
}

function buildAxisCombinations(
  axes: readonly ProductVariationAxis[]
): ProductSchema["specifications"][] {
  const usableAxes = axes
    .map((axis) => ({
      key: axis.key.trim(),
      values: parseVariationAxis(axis.values).values,
    }))
    .filter((axis) => axis.key && axis.values.length > 0)
  if (usableAxes.length === 0) return []

  return usableAxes.reduce<ProductSchema["specifications"][]>(
    (combinations, axis) =>
      combinations.flatMap((combination) =>
        axis.values.map((value) => [...combination, { key: axis.key, value }])
      ),
    [[]]
  )
}

export function getProductVariationCartesianCount(
  state: Pick<ProductVariationFormState, "axes">
): number {
  const counts = state.axes
    .map((axis) => ({
      key: axis.key.trim(),
      valueCount: parseVariationAxis(axis.values).values.length,
    }))
    .filter((axis) => axis.key && axis.valueCount > 0)
    .map((axis) => axis.valueCount)
  if (counts.length === 0) return 0
  return counts.reduce((total, count) => total * count, 1)
}

export function generateProductVariationRows(
  state: ProductVariationFormState
): ProductVariationFormState {
  if (getProductVariationCartesianCount(state) > MAX_PRODUCT_VARIATION_COUNT) {
    return state
  }
  const rowsByIdentity = new Map(state.rows.map((row) => [row.identity, row]))
  const rows = [...state.rows]
  for (const specifications of buildAxisCombinations(state.axes)) {
    const identity = getCombinationIdentity(specifications)
    if (rowsByIdentity.has(identity)) continue
    const row = createVariationRow(specifications)
    rows.push(row)
    rowsByIdentity.set(identity, row)
  }
  return { ...state, rows }
}

export function reconcileProductVariationForm(
  state: ProductVariationFormState
): ProductVariationFormState {
  return {
    enabled: state.enabled,
    axes: state.axes.map((axis, index) => ({
      id: axis.id || axisId(axis.key, index),
      key: axis.key,
      values: axis.values,
    })),
    rows: state.rows.map((row) =>
      createVariationRow(row.specifications, {
        ...row,
        identity: getCombinationIdentity(row.specifications),
      })
    ),
  }
}

export function updateProductVariationAxis(
  state: ProductVariationFormState,
  id: string,
  field: "key" | "values",
  value: string
): ProductVariationFormState {
  return {
    ...state,
    axes: state.axes.map((axis) =>
      axis.id === id ? { ...axis, [field]: value } : axis
    ),
  }
}

export function addProductVariationAxis(
  state: ProductVariationFormState,
  key = ""
): ProductVariationFormState {
  if (state.axes.length >= MAX_PRODUCT_VARIATION_AXES) return state
  const nextIndex = state.axes.length
  return {
    ...state,
    axes: [...state.axes, createProductVariationAxis(key, "", nextIndex)],
  }
}

export function removeProductVariationAxis(
  state: ProductVariationFormState,
  id: string
): ProductVariationFormState {
  return { ...state, axes: state.axes.filter((axis) => axis.id !== id) }
}

export function removeProductVariationRow(
  state: ProductVariationFormState,
  identity: string
): ProductVariationFormState {
  return {
    ...state,
    rows: state.rows.filter((row) => row.identity !== identity),
  }
}

export function updateProductVariationOverride(
  state: ProductVariationFormState,
  identity: string,
  field: "title" | "price" | "stock" | "imageUrls" | "format" | "shippingCost",
  value: string
): ProductVariationFormState {
  return {
    ...state,
    rows: state.rows.map((row) => {
      if (row.identity !== identity) return row
      if (field === "stock") {
        return { ...row, stock: value, inheritStock: false }
      }
      if (field === "imageUrls") {
        return { ...row, imageUrls: value, inheritImages: false }
      }
      if (field === "shippingCost") {
        return { ...row, shippingCost: value, inheritShipping: false }
      }
      return { ...row, [field]: value }
    }),
  }
}

export function updateProductVariationInheritance(
  state: ProductVariationFormState,
  identity: string,
  field: "inheritStock" | "inheritImages" | "inheritShipping",
  value: boolean
): ProductVariationFormState {
  return {
    ...state,
    rows: state.rows.map((row) =>
      row.identity === identity ? { ...row, [field]: value } : row
    ),
  }
}

export function getProductVariationCombinations(
  state: ProductVariationFormState
): ProductVariationCombination[] {
  return state.rows.map((row) => ({
    ...row,
    label: getCombinationLabel(row.specifications),
  }))
}

function parseImageUrls(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter(Boolean)
}

function isSafeImageUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

export function getProductVariationFormError(
  state: ProductVariationFormState,
  currency: string
): string | null {
  if (!state.enabled) return null
  if (state.axes.length === 0) return "Add at least one option axis."
  if (state.axes.length > MAX_PRODUCT_VARIATION_AXES) {
    return `Use ${MAX_PRODUCT_VARIATION_AXES} option axes or fewer.`
  }

  const seenKeys = new Set<string>()
  const expectedKeys: string[] = []
  const allowedValuesByKey = new Map<string, Set<string>>()
  for (const axis of state.axes) {
    const key = normalizePart(axis.key)
    const parsed = parseVariationAxis(axis.values)
    if (!key) return "Give every option axis a name."
    if (seenKeys.has(key)) return "Use a different name for each option axis."
    seenKeys.add(key)
    expectedKeys.push(key)
    allowedValuesByKey.set(
      key,
      new Set(parsed.values.map((value) => normalizePart(value)))
    )
    if (parsed.duplicates.length > 0) {
      return `Remove duplicate values from ${axis.key.trim()}.`
    }
    if (parsed.tooLong.length > 0) {
      return `Keep each ${axis.key.trim()} value to ${MAX_PRODUCT_VARIATION_VALUE_LENGTH} characters or fewer.`
    }
    if (parsed.values.length === 0) {
      return `Add at least one value for ${axis.key.trim()}.`
    }
    if (parsed.values.length > MAX_PRODUCT_VARIATION_AXIS_VALUES) {
      return `Use ${MAX_PRODUCT_VARIATION_AXIS_VALUES} values or fewer for ${axis.key.trim()}.`
    }
  }

  if (state.rows.length === 0) {
    return "Generate or add at least one variation row."
  }
  if (state.rows.length > MAX_PRODUCT_VARIATION_COUNT) {
    return `Keep the variation count to ${MAX_PRODUCT_VARIATION_COUNT} or fewer.`
  }

  const seenIdentities = new Set<string>()
  for (const row of state.rows) {
    const rowKeys = row.specifications.map(({ key }) => normalizePart(key))
    if (
      rowKeys.length !== expectedKeys.length ||
      new Set(rowKeys).size !== rowKeys.length ||
      [...rowKeys].sort(NATURAL_COLLATOR.compare).join("|") !==
        [...expectedKeys].sort(NATURAL_COLLATOR.compare).join("|")
    ) {
      return `${getCombinationLabel(row.specifications) || "A variation"} is missing or duplicates an option axis.`
    }
    for (const specification of row.specifications) {
      const key = normalizePart(specification.key)
      if (
        !allowedValuesByKey.get(key)?.has(normalizePart(specification.value))
      ) {
        return `${getCombinationLabel(row.specifications) || "A variation"} uses a value that is not listed for ${specification.key.trim()}.`
      }
    }
    const identity = getCombinationIdentity(row.specifications)
    if (seenIdentities.has(identity)) {
      return `${getCombinationLabel(row.specifications)} duplicates another variation row.`
    }
    seenIdentities.add(identity)
    if (row.title.trim().length > 200) {
      return `${getCombinationLabel(row.specifications)} title must be 200 characters or fewer.`
    }
    if (row.price.trim()) {
      try {
        normalizePublishableProductPrice(
          parsePlainDecimalAmount(
            row.price,
            `${getCombinationLabel(row.specifications)} price`
          ),
          currency
        )
      } catch (error) {
        return error instanceof Error
          ? error.message
          : `Enter a valid price for ${getCombinationLabel(row.specifications)}.`
      }
    }
    if (!row.inheritStock) {
      const stockError = getProductStockInputError(row.stock)
      if (stockError) {
        return `${getCombinationLabel(row.specifications)}: ${stockError}`
      }
    }
    if (
      !row.inheritImages &&
      parseImageUrls(row.imageUrls).some((url) => !isSafeImageUrl(url))
    ) {
      return `${getCombinationLabel(row.specifications)} images must use HTTPS URLs.`
    }
    if (!row.inheritShipping && row.shippingCost.trim()) {
      try {
        parsePlainDecimalAmount(
          row.shippingCost,
          `${getCombinationLabel(row.specifications)} shipping cost`
        )
      } catch (error) {
        return error instanceof Error
          ? error.message
          : `Enter a valid shipping cost for ${getCombinationLabel(row.specifications)}.`
      }
    }
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

function getShippingProjection(product: ProductSchema) {
  return {
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
  }
}

function imagesMatch(
  left: ProductSchema["images"],
  right: ProductSchema["images"]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function getProductVariationFormState<
  TRecord extends ProductListingRecordLike,
>(parent: TRecord, variations: readonly TRecord[]): ProductVariationFormResult {
  if (parent.product.type === "simple" && variations.length === 0) {
    return { state: createEmptyProductVariationForm(), supported: true }
  }
  if (parent.product.type !== "variable") {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason:
        parent.product.type === "variation"
          ? "This variation has no reachable variable parent."
          : "This product type is not supported by the family editor.",
    }
  }
  if (!parent.dTag || variations.length === 0) {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason: "This variable product has no reachable variation listings.",
    }
  }
  if (variations.length > MAX_PRODUCT_VARIATION_COUNT) {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason: `This family has more than ${MAX_PRODUCT_VARIATION_COUNT} children.`,
    }
  }

  const firstSpecifications = variations[0]?.product.specifications ?? []
  const expectedKeys = firstSpecifications.map(({ key }) => normalizePart(key))
  if (
    expectedKeys.length === 0 ||
    expectedKeys.length > MAX_PRODUCT_VARIATION_AXES ||
    new Set(expectedKeys).size !== expectedKeys.length
  ) {
    return {
      state: createEmptyProductVariationForm(),
      supported: false,
      reason: "This family has duplicate or missing specification keys.",
    }
  }

  const valuesByKey = new Map<string, string[]>()
  const seenValuesByKey = new Map<string, Set<string>>()
  const seenRows = new Set<string>()
  const parentPrice = getProductPriceInput(parent.product)
  const parentShipping = JSON.stringify(getShippingProjection(parent.product))
  const rows: ProductVariationRow[] = []

  for (const variation of variations) {
    const specifications = variation.product.specifications
    const keys = specifications.map(({ key }) => normalizePart(key))
    if (
      variation.product.type !== "variation" ||
      variation.product.pubkey !== parent.product.pubkey ||
      variation.product.parentProductId !== parent.addressId ||
      !variation.dTag ||
      keys.length !== expectedKeys.length ||
      new Set(keys).size !== keys.length ||
      [...keys].sort(NATURAL_COLLATOR.compare).join("|") !==
        [...expectedKeys].sort(NATURAL_COLLATOR.compare).join("|")
    ) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason:
          "This family has a child with duplicate, missing, or mismatched specification keys.",
      }
    }
    const identity = getCombinationIdentity(specifications)
    if (seenRows.has(identity)) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason: "This family has duplicate variation combinations.",
      }
    }
    seenRows.add(identity)

    for (const specification of specifications) {
      const key = normalizePart(specification.key)
      const valueIdentity = normalizePart(specification.value)
      const seen = seenValuesByKey.get(key) ?? new Set<string>()
      const values = valuesByKey.get(key) ?? []
      if (!seen.has(valueIdentity)) {
        seen.add(valueIdentity)
        values.push(specification.value)
      }
      seenValuesByKey.set(key, seen)
      valuesByKey.set(key, values)
    }

    const variationPrice = getProductPriceInput(variation.product)
    if (variationPrice.currency !== parentPrice.currency) {
      return {
        state: createEmptyProductVariationForm(),
        supported: false,
        reason: "This family uses more than one currency.",
      }
    }
    const inheritStock = variation.product.stock === parent.product.stock
    const inheritImages = imagesMatch(
      variation.product.images,
      parent.product.images
    )
    const inheritShipping =
      JSON.stringify(getShippingProjection(variation.product)) ===
      parentShipping
    const shippingAmount =
      variation.product.sourceShippingCost?.amount ??
      variation.product.shippingCostSats

    rows.push(
      createVariationRow(specifications, {
        dTag: variation.dTag,
        title: variation.product.title,
        price:
          variationPrice.amount === parentPrice.amount
            ? ""
            : formatProductAmountInput(variationPrice.amount),
        stock:
          inheritStock || typeof variation.product.stock !== "number"
            ? ""
            : String(variation.product.stock),
        inheritStock,
        imageUrls: variation.product.images.map(({ url }) => url).join("\n"),
        inheritImages,
        format:
          variation.product.format === parent.product.format
            ? "inherit"
            : variation.product.format,
        shippingCost:
          inheritShipping || shippingAmount === undefined
            ? ""
            : formatProductAmountInput(shippingAmount),
        inheritShipping,
      })
    )
  }

  const axes = firstSpecifications.map((specification, index) =>
    createProductVariationAxis(
      specification.key,
      (valuesByKey.get(normalizePart(specification.key)) ?? []).join(", "),
      index
    )
  )
  return {
    supported: true,
    state: reconcileProductVariationForm({ enabled: true, axes, rows }),
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

function copyShippingProjection(
  product: ProductSchema,
  projection: ReturnType<typeof getShippingProjection>
): ProductSchema {
  const next = { ...product }
  for (const key of [
    "shippingCostSats",
    "sourceShippingCost",
    "shippingOptionId",
    "shippingOptionDTag",
    "shippingCountries",
    "shippingCountryRules",
  ] as const) {
    if (projection[key] === undefined) {
      delete next[key]
    } else {
      Object.assign(next, { [key]: projection[key] })
    }
  }
  return next
}

function buildVariationImages(
  row: ProductVariationRow,
  existing: ProductListingRecordLike | undefined,
  parent: ProductSchema
): ProductImage[] {
  if (row.inheritImages) return parent.images.map((image) => ({ ...image }))
  const existingAltByUrl = new Map(
    existing?.product.images.map((image) => [image.url, image.alt]) ?? []
  )
  return parseImageUrls(row.imageUrls).map((url) => ({
    url,
    ...(existingAltByUrl.get(url) ? { alt: existingAltByUrl.get(url) } : {}),
  }))
}

function buildVariationProduct(
  parent: ProductSchema,
  parentDTag: string,
  row: ProductVariationCombination,
  currency: string,
  existing: ProductListingRecordLike | undefined,
  now: number
): ProductSchema {
  const dTag =
    row.dTag ??
    buildProductVariationDTag(parentDTag, {
      identity: row.identity,
      specifications: row.specifications,
    })
  let product: ProductSchema = {
    ...(existing?.product ?? parent),
    id: `30402:${parent.pubkey}:${dTag}`,
    pubkey: parent.pubkey,
    title:
      row.title.trim() || buildProductVariationTitle(parent.title, row.label),
    type: "variation",
    parentProductId: `30402:${parent.pubkey}:${parentDTag}`,
    specifications: row.specifications.map((specification) => ({
      ...specification,
    })),
    stock: row.inheritStock ? parent.stock : parseProductStockInput(row.stock),
    images: buildVariationImages(row, existing, parent),
    format: row.format === "inherit" ? parent.format : row.format,
    createdAt: existing?.product.createdAt ?? now,
    updatedAt: now,
  }

  if (!row.price.trim()) {
    product = {
      ...product,
      price: parent.price,
      currency: parent.currency,
      priceSats: parent.priceSats,
      sourcePrice: parent.sourcePrice,
    }
  } else {
    const overrideAmount = normalizePublishableProductPrice(
      parsePlainDecimalAmount(row.price, `${row.label} price`),
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

  if (row.inheritShipping) {
    product = copyShippingProjection(product, getShippingProjection(parent))
  } else if (row.shippingCost.trim()) {
    const amount = parsePlainDecimalAmount(
      row.shippingCost,
      `${row.label} shipping cost`
    )
    product = {
      ...product,
      shippingCostSats:
        currency.trim().toUpperCase() === "SATS"
          ? Math.round(amount)
          : undefined,
      sourceShippingCost:
        currency.trim().toUpperCase() === "SATS"
          ? undefined
          : {
              amount,
              currency,
              normalizedCurrency: currency.trim().toUpperCase(),
            },
    }
  } else {
    product = copyShippingProjection(product, {
      shippingCostSats: undefined,
      sourceShippingCost: undefined,
      shippingOptionId: undefined,
      shippingOptionDTag: undefined,
      shippingCountries: undefined,
      shippingCountryRules: undefined,
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
    specifications: input.variations.enabled
      ? input.baseProduct.specifications
      : [],
  }
  const desired: ProductFamilyPublishTarget<TRecord>[] = [
    {
      dTag: parentDTag,
      product: parentProduct,
      existing: existingByDTag.get(parentDTag),
    },
  ]

  if (input.variations.enabled) {
    for (const row of getProductVariationCombinations(input.variations)) {
      const dTag =
        row.dTag ??
        buildProductVariationDTag(parentDTag, {
          identity: row.identity,
          specifications: row.specifications,
        })
      const existing = existingByDTag.get(dTag)
      desired.push({
        dTag,
        product: buildVariationProduct(
          parentProduct,
          parentDTag,
          { ...row, dTag },
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
