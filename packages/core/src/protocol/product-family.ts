import type { Product } from "../types"
import { compareCommercePrices } from "../pricing"
import { getProductImageCandidates } from "./products"

export interface ProductFamilyRecord {
  product: Product
  eventId: string
  addressId: string
  eventCreatedAt: number
  sourceRelayUrls?: string[]
}

export interface ProductFamilyReadEvidence {
  source: "commerce" | "public" | "local_cache"
  fetchedAt: number
  stale: boolean
  degraded: boolean
  capped: boolean
}

export interface ProductFamilyAxis {
  key: string
  label: string
  values: string[]
}

export interface ProductFamilyDiagnostic {
  code:
    | "duplicate_specification_key"
    | "missing_specification_key"
    | "duplicate_specification_tuple"
  addressId: string
  keys?: string[]
}

export interface ProductFamilyPriceSummary<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
> {
  minimum: TRecord | null
  maximum: TRecord | null
  varies: boolean
}

export interface ProductFamilyInventorySummary {
  tracking: "tracked" | "partial" | "untracked"
  availability: "available" | "sold_out" | "unavailable"
  totalStock?: number
}

export interface PreparedProductFamily<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
> {
  parent: TRecord
  children: TRecord[]
  axes: ProductFamilyAxis[]
  state: "ready" | "parent_only"
  readEvidence: ProductFamilyReadEvidence
  diagnostics: ProductFamilyDiagnostic[]
  priceSummary: ProductFamilyPriceSummary<TRecord>
  inventorySummary: ProductFamilyInventorySummary
}

export type ProductCatalogItem<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
> =
  | {
      kind: "simple"
      record: TRecord
    }
  | {
      kind: "family"
      family: PreparedProductFamily<TRecord>
    }

export interface UnresolvedProductFamilyRecord<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
> {
  kind: "orphan"
  record: TRecord
  parentProductId?: string
}

export interface PreparedProductCatalog<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
> {
  items: ProductCatalogItem<TRecord>[]
  unresolved: UnresolvedProductFamilyRecord<TRecord>[]
}

export interface ProductFamilySelectionInput {
  productId?: string
  specifications?: readonly Product["specifications"][number][]
}

export interface ProductSelectionImageProjection {
  images: Product["images"]
  source: "selected" | "parent" | "none"
  sourceProductId?: string
}

export type PurchasableSelectionResult<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
> =
  | {
      status: "selected"
      record: TRecord
      selectedSpecifications: Product["specifications"]
      imageProjection: ProductSelectionImageProjection
    }
  | {
      status: "selection_required"
      compatibleRecords: TRecord[]
    }
  | {
      status: "unavailable"
      reason:
        "family_unavailable" | "invalid_selection" | "no_match" | "sold_out"
    }

const NATURAL_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
})

function normalizeSpecificationPart(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
}

function prepareFamilyAxes<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(children: readonly TRecord[]): ProductFamilyAxis[] {
  const axes = new Map<
    string,
    {
      key: string
      label: string
      values: Map<string, string>
    }
  >()

  for (const child of children) {
    for (const specification of child.product.specifications) {
      const label = specification.key.trim()
      const value = specification.value.trim()
      const key = normalizeSpecificationPart(label)
      const normalizedValue = normalizeSpecificationPart(value)
      if (!key || !normalizedValue) continue

      const axis = axes.get(key) ?? {
        key,
        label,
        values: new Map<string, string>(),
      }
      if (!axis.values.has(normalizedValue)) {
        axis.values.set(normalizedValue, value)
      }
      axes.set(key, axis)
    }
  }

  return Array.from(axes.values())
    .sort((left, right) => NATURAL_COLLATOR.compare(left.key, right.key))
    .map((axis) => ({
      key: axis.key,
      label: axis.label,
      values: Array.from(axis.values.values()).sort(NATURAL_COLLATOR.compare),
    }))
}

function prepareFamilyChildren<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(
  children: readonly TRecord[]
): {
  children: TRecord[]
  diagnostics: ProductFamilyDiagnostic[]
} {
  const diagnostics: ProductFamilyDiagnostic[] = []
  const candidates: Array<{
    record: TRecord
    valuesByKey: Map<string, string>
    keys: string[]
    signature: string
  }> = []

  for (const record of children) {
    const valuesByKey = new Map<string, string>()
    const duplicateKeys = new Set<string>()
    for (const specification of record.product.specifications) {
      const key = normalizeSpecificationPart(specification.key)
      const value = specification.value.trim()
      if (!key || !value) continue
      if (valuesByKey.has(key)) {
        duplicateKeys.add(key)
        continue
      }
      valuesByKey.set(key, value)
    }
    if (duplicateKeys.size > 0) {
      diagnostics.push({
        code: "duplicate_specification_key",
        addressId: record.addressId,
        keys: Array.from(duplicateKeys).sort(NATURAL_COLLATOR.compare),
      })
      continue
    }

    const keys = Array.from(valuesByKey.keys()).sort(NATURAL_COLLATOR.compare)
    candidates.push({
      record,
      valuesByKey,
      keys,
      signature: keys.join("\u0000"),
    })
  }

  const signatureCounts = new Map<string, number>()
  for (const candidate of candidates) {
    signatureCounts.set(
      candidate.signature,
      (signatureCounts.get(candidate.signature) ?? 0) + 1
    )
  }
  const expectedSignature =
    Array.from(signatureCounts.entries()).sort(
      ([leftSignature, leftCount], [rightSignature, rightCount]) =>
        rightCount - leftCount ||
        NATURAL_COLLATOR.compare(leftSignature, rightSignature)
    )[0]?.[0] ?? ""
  const expectedKeys = expectedSignature
    ? expectedSignature.split("\u0000")
    : []
  const completeCandidates = candidates.filter((candidate) => {
    if (candidate.signature === expectedSignature) return true
    diagnostics.push({
      code: "missing_specification_key",
      addressId: candidate.record.addressId,
      keys: expectedKeys.filter((key) => !candidate.valuesByKey.has(key)),
    })
    return false
  })

  const recordsByTuple = new Map<string, typeof completeCandidates>()
  for (const candidate of completeCandidates) {
    const tuple = expectedKeys
      .map((key) =>
        normalizeSpecificationPart(candidate.valuesByKey.get(key) ?? "")
      )
      .join("\u0000")
    const tupleRecords = recordsByTuple.get(tuple) ?? []
    tupleRecords.push(candidate)
    recordsByTuple.set(tuple, tupleRecords)
  }

  const accepted: Array<{ record: TRecord; tuple: string }> = []
  for (const [tuple, tupleRecords] of recordsByTuple) {
    if (tupleRecords.length === 1) {
      accepted.push({ record: tupleRecords[0]!.record, tuple })
      continue
    }
    for (const candidate of tupleRecords) {
      diagnostics.push({
        code: "duplicate_specification_tuple",
        addressId: candidate.record.addressId,
        keys: expectedKeys,
      })
    }
  }

  accepted.sort(
    (left, right) =>
      NATURAL_COLLATOR.compare(left.tuple, right.tuple) ||
      left.record.addressId.localeCompare(right.record.addressId)
  )

  return {
    children: accepted.map((candidate) => candidate.record),
    diagnostics,
  }
}

function prepareFamilyPriceSummary<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(children: readonly TRecord[]): ProductFamilyPriceSummary<TRecord> {
  const availableChildren = children.filter(
    (child) => child.product.stock !== 0
  )
  const ordered = [
    ...(availableChildren.length > 0 ? availableChildren : children),
  ].sort(
    (left, right) =>
      compareCommercePrices(left.product, right.product) ||
      left.addressId.localeCompare(right.addressId)
  )
  const minimum = ordered[0] ?? null
  const maximum = ordered.at(-1) ?? null
  return {
    minimum,
    maximum,
    varies:
      minimum !== null &&
      maximum !== null &&
      compareCommercePrices(minimum.product, maximum.product) !== 0,
  }
}

function prepareFamilyInventorySummary<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(children: readonly TRecord[]): ProductFamilyInventorySummary {
  if (children.length === 0) {
    return { tracking: "untracked", availability: "unavailable" }
  }

  const trackedStocks = children.flatMap((child) =>
    typeof child.product.stock === "number" ? [child.product.stock] : []
  )
  if (trackedStocks.length === 0) {
    return { tracking: "untracked", availability: "available" }
  }
  if (trackedStocks.length !== children.length) {
    return {
      tracking: "partial",
      availability:
        trackedStocks.some((stock) => stock > 0) ||
        trackedStocks.length < children.length
          ? "available"
          : "sold_out",
    }
  }

  const totalStock = trackedStocks.reduce((sum, stock) => sum + stock, 0)
  return {
    tracking: "tracked",
    availability: totalStock > 0 ? "available" : "sold_out",
    totalStock,
  }
}

export function prepareProductCatalog<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(
  records: readonly TRecord[],
  readEvidence: ProductFamilyReadEvidence
): PreparedProductCatalog<TRecord> {
  const variableParents = new Map(
    records
      .filter((record) => record.product.type === "variable")
      .map((record) => [record.addressId, record])
  )
  const childrenByParent = new Map<string, TRecord[]>()
  const unresolved: UnresolvedProductFamilyRecord<TRecord>[] = []

  for (const record of records) {
    if (record.product.type !== "variation") continue

    const parentProductId = record.product.parentProductId
    const parent = parentProductId
      ? variableParents.get(parentProductId)
      : undefined
    if (!parent || parent.product.pubkey !== record.product.pubkey) {
      unresolved.push({
        kind: "orphan",
        record,
        parentProductId,
      })
      continue
    }

    const children = childrenByParent.get(parent.addressId) ?? []
    children.push(record)
    childrenByParent.set(parent.addressId, children)
  }

  const items = records.flatMap<ProductCatalogItem<TRecord>>((record) => {
    if (record.product.type === "variation") return []
    if (record.product.type === "simple") {
      return [{ kind: "simple", record }]
    }

    const linkedChildren = [
      ...(childrenByParent.get(record.addressId) ?? []),
    ].sort(
      (left, right) =>
        left.eventCreatedAt - right.eventCreatedAt ||
        left.addressId.localeCompare(right.addressId)
    )
    const preparedChildren = prepareFamilyChildren(linkedChildren)
    return [
      {
        kind: "family",
        family: {
          parent: record,
          children: preparedChildren.children,
          axes: prepareFamilyAxes(preparedChildren.children),
          state: preparedChildren.children.length > 0 ? "ready" : "parent_only",
          readEvidence,
          diagnostics: preparedChildren.diagnostics,
          priceSummary: prepareFamilyPriceSummary(preparedChildren.children),
          inventorySummary: prepareFamilyInventorySummary(
            preparedChildren.children
          ),
        },
      },
    ]
  })

  return { items, unresolved }
}

function getSelectionImageProjection<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(record: TRecord, parent?: TRecord): ProductSelectionImageProjection {
  const selectedImages = getProductImageCandidates(record.product)
  if (selectedImages.length > 0) {
    return {
      images: selectedImages,
      source: "selected",
      sourceProductId: record.addressId,
    }
  }
  const parentImages = parent ? getProductImageCandidates(parent.product) : []
  if (parent && parentImages.length > 0) {
    return {
      images: parentImages,
      source: "parent",
      sourceProductId: parent.addressId,
    }
  }
  return { images: [], source: "none" }
}

function selectedResult<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(record: TRecord, parent?: TRecord): PurchasableSelectionResult<TRecord> {
  if (record.product.stock === 0) {
    return { status: "unavailable", reason: "sold_out" }
  }
  return {
    status: "selected",
    record,
    selectedSpecifications: [...record.product.specifications],
    imageProjection: getSelectionImageProjection(record, parent),
  }
}

export function resolvePurchasableSelection<
  TRecord extends ProductFamilyRecord = ProductFamilyRecord,
>(
  item: ProductCatalogItem<TRecord>,
  selection: ProductFamilySelectionInput = {}
): PurchasableSelectionResult<TRecord> {
  if (item.kind === "simple") {
    if (
      (selection.productId &&
        selection.productId !== item.record.addressId &&
        selection.productId !== item.record.product.id) ||
      (selection.specifications?.length ?? 0) > 0
    ) {
      return { status: "unavailable", reason: "no_match" }
    }
    return selectedResult(item.record)
  }

  const { family } = item
  if (family.state !== "ready") {
    return { status: "unavailable", reason: "family_unavailable" }
  }

  if (selection.productId) {
    const record = family.children.find(
      (candidate) =>
        candidate.addressId === selection.productId ||
        candidate.product.id === selection.productId
    )
    if (!record) return { status: "unavailable", reason: "no_match" }
    return selectedResult(record, family.parent)
  }

  const selectedValues = new Map<string, string>()
  for (const specification of selection.specifications ?? []) {
    const key = normalizeSpecificationPart(specification.key)
    const value = normalizeSpecificationPart(specification.value)
    if (!key || !value || selectedValues.has(key)) {
      return { status: "unavailable", reason: "invalid_selection" }
    }
    selectedValues.set(key, value)
  }
  const knownKeys = new Set(family.axes.map((axis) => axis.key))
  if (Array.from(selectedValues.keys()).some((key) => !knownKeys.has(key))) {
    return { status: "unavailable", reason: "invalid_selection" }
  }

  const compatibleRecords = family.children.filter((record) =>
    Array.from(selectedValues.entries()).every(([key, value]) =>
      record.product.specifications.some(
        (specification) =>
          normalizeSpecificationPart(specification.key) === key &&
          normalizeSpecificationPart(specification.value) === value
      )
    )
  )
  if (compatibleRecords.length === 0) {
    return { status: "unavailable", reason: "no_match" }
  }
  if (selectedValues.size !== family.axes.length) {
    return { status: "selection_required", compatibleRecords }
  }
  if (compatibleRecords.length !== 1) {
    return { status: "unavailable", reason: "invalid_selection" }
  }

  return selectedResult(compatibleRecords[0]!, family.parent)
}
