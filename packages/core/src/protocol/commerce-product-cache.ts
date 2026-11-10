import { liveQuery } from "dexie"
import { db, type CachedProduct, type CachedProductTombstone } from "../db"
import type { Product } from "../types"
import {
  canonicalizeProductTags,
  getProductProtocolImages,
  normalizeProductSummaryForDisplay,
  parseProductEvent,
} from "./products"
import { EVENT_KINDS } from "./kinds"
import { evaluateListingAvailability } from "./listing-availability"
import {
  withListingAvailability,
  isMarketRenderableRecord,
  shouldReplaceProductRecord,
  mergeProductRecordSources,
  type CommerceProductRecord,
} from "./commerce-product-selection"
import {
  isProductDeletedByNip09,
  parseProductAddressCoordinate,
  productDeletionAddressKey,
  productDeletionEventKey as scopedProductDeletionEventKey,
  validateProductDeletionEvent,
  type ProductDeletionEvidence,
} from "./product-deletion"
import {
  verifySignedEventBatches,
  attachEventSourceRelayUrl,
  getEventSourceRelayUrls,
} from "./relay-reader"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  sameSignedPublicEvent,
  admitPublicEvent,
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"

const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60_000

export interface CachedProductReadOptions {
  includeStale?: boolean
  includeMarketHidden?: boolean
}

export interface ProductCacheTestOverrides {
  now?: () => number
  getCachedProducts?: (
    merchantPubkey?: string,
    authorPubkeys?: readonly string[],
    selection?: { ids?: readonly string[]; parentIds?: readonly string[] }
  ) => Promise<CachedProduct[]>
  putCachedProducts?: (rows: CachedProduct[]) => Promise<void>
  getCachedProductTombstones?: (
    merchantPubkey?: string,
    authorPubkeys?: readonly string[]
  ) => Promise<CachedProductTombstone[]>
  putCachedProductTombstones?: (rows: CachedProductTombstone[]) => Promise<void>
}

let productCacheTestOverrides: ProductCacheTestOverrides = {}
const volatileProductSourceRelayUrls = new Map<string, string[]>()
const volatileProductTombstones = new Map<string, CachedProductTombstone>()

export function __setProductCacheTestOverrides(
  overrides: ProductCacheTestOverrides
): void {
  productCacheTestOverrides = { ...productCacheTestOverrides, ...overrides }
}

export function __resetProductCacheTestOverrides(): void {
  productCacheTestOverrides = {}
  volatileProductSourceRelayUrls.clear()
  volatileProductTombstones.clear()
  resetLocalProductDeletionObservation()
  resetLocalProductRevisionObservation()
}

function now(): number {
  return productCacheTestOverrides.now?.() ?? Date.now()
}

function getTagValue(
  tags: readonly (readonly string[])[] | undefined,
  name: string
): string | null {
  if (!tags) return null
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
}

function toEventCreatedAtSeconds(
  event: Pick<SignedPublicNostrEvent, "created_at">
): number {
  return event.created_at ?? 0
}

function uniqueStrings(
  values: readonly (string | undefined | null)[]
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])
  )
}

function toCachedProduct(record: CommerceProductRecord) {
  const { product } = record
  return {
    id: product.id,
    pubkey: product.pubkey,
    title: product.title,
    summary: product.summary,
    price: product.price,
    currency: product.currency,
    priceSats: product.priceSats,
    sourcePrice: product.sourcePrice,
    priceEvidenceMalformed: product.priceEvidenceMalformed,
    type: product.type,
    parentProductId: product.parentProductId,
    specifications: product.specifications,
    format: product.format,
    signedProductEvent: product.signedProductEvent,
    shippingWeightGrams: product.shippingWeightGrams,
    shippingWeightAllowanceGrams: product.shippingWeightAllowanceGrams,
    shippingHandling: product.shippingHandling,
    shippingAdjustmentsMalformed: product.shippingAdjustmentsMalformed,
    shippingDimensionsCm: product.shippingDimensionsCm,
    shippingCostSats: product.shippingCostSats,
    sourceShippingCost: product.sourceShippingCost,
    shippingOptionId: product.shippingOptionId,
    shippingOptionDTag: product.shippingOptionDTag,
    shippingOptionLaunchUnsupported: product.shippingOptionId
      ? product.shippingOptionLaunchUnsupported === true
      : undefined,
    shippingOptionRefs: product.shippingOptionRefs,
    collectionRefs: product.collectionRefs,
    eventMarketRefs: product.eventMarketRefs,
    shippingCountries: product.shippingCountries,
    shippingCountryRules: product.shippingCountryRules,
    visibility: product.visibility,
    stock: product.stock,
    images: getProductProtocolImages(product),
    tags: canonicalizeProductTags(product.tags),
    publicZapEnabled: product.publicZapEnabled,
    zapMessagePolicy: product.zapMessagePolicy,
    publicZapPolicyKnown: product.publicZapPolicyKnown,
    supplierAllocation: product.supplierAllocation,
    eventGuestContactOptional: product.eventGuestContactOptional,
    location: product.location,
    geohash: product.geohash,
    eventId: record.eventId,
    eventCreatedAt: record.eventCreatedAt,
    dTag: record.dTag ?? undefined,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    sourceRelayUrls: record.sourceRelayUrls,
    cachedAt: now(),
  }
}

function fromCachedProduct(row: CachedProduct): CommerceProductRecord {
  const zapMessagePolicy =
    row.zapMessagePolicy === "custom" ? row.zapMessagePolicy : "generic_only"
  const hasShippingOptionReference =
    typeof row.shippingOptionId === "string" && row.shippingOptionId.length > 0
  const tags = canonicalizeProductTags(row.tags)
  const summary = normalizeProductSummaryForDisplay(row.summary, {
    title: row.title,
    priceInfo: {
      price: row.sourcePrice?.amount ?? row.price,
      currency: row.sourcePrice?.currency ?? row.currency,
    },
    tags,
  })
  const product: Product = {
    id: row.id,
    ...(row.eventId && row.eventId !== row.id
      ? { sourceEventId: row.eventId }
      : {}),
    pubkey: row.pubkey,
    title: row.title,
    summary,
    price: row.price,
    currency: row.currency,
    priceSats: row.priceSats,
    sourcePrice: row.sourcePrice,
    priceEvidenceMalformed: row.priceEvidenceMalformed,
    type: row.type ?? "simple",
    parentProductId: row.parentProductId,
    specifications: row.specifications ?? [],
    format: row.format ?? "physical",
    signedProductEvent: isVerifiedNostrEvent(row.signedProductEvent)
      ? row.signedProductEvent
      : undefined,
    shippingWeightGrams: row.shippingWeightGrams,
    shippingWeightAllowanceGrams: row.shippingWeightAllowanceGrams,
    shippingHandling: row.shippingHandling,
    shippingAdjustmentsMalformed: row.shippingAdjustmentsMalformed,
    shippingDimensionsCm: row.shippingDimensionsCm,
    shippingCostSats: row.shippingCostSats,
    sourceShippingCost: row.sourceShippingCost,
    shippingOptionId: row.shippingOptionId,
    shippingOptionDTag: row.shippingOptionDTag,
    shippingOptionLaunchUnsupported: hasShippingOptionReference
      ? typeof row.shippingOptionLaunchUnsupported === "boolean"
        ? row.shippingOptionLaunchUnsupported
        : true
      : undefined,
    shippingOptionRefs: row.shippingOptionRefs,
    collectionRefs: row.collectionRefs,
    eventMarketRefs: row.eventMarketRefs,
    shippingCountries: row.shippingCountries,
    shippingCountryRules: row.shippingCountryRules,
    visibility: row.visibility ?? "public",
    stock: row.stock,
    images: getProductProtocolImages({ images: row.images ?? [] }),
    tags,
    publicZapEnabled: row.publicZapEnabled ?? true,
    zapMessagePolicy,
    publicZapPolicyKnown: row.publicZapPolicyKnown ?? false,
    supplierAllocation: row.supplierAllocation,
    eventGuestContactOptional: row.eventGuestContactOptional,
    location: row.location,
    geohash: row.geohash,
    createdAt: row.createdAt ?? row.cachedAt,
    updatedAt: row.updatedAt ?? row.cachedAt,
  }

  // Cache rows written before the signed d-tag was stored are intentionally
  // treated as exact-event-only legacy records. Reconstructing a coordinate
  // from a display/cache id could broaden a deletion beyond signed metadata.
  const cachedAddress = parseProductAddressCoordinate(row.id)
  const dTag =
    typeof row.dTag === "string" &&
    cachedAddress?.authorPubkey === row.pubkey.toLowerCase() &&
    cachedAddress.dTag === row.dTag
      ? row.dTag
      : null
  const sourceRelayUrls = uniqueStrings([
    ...(row.sourceRelayUrls ?? []),
    ...(volatileProductSourceRelayUrls.get(product.id) ?? []),
  ])
  return withListingAvailability({
    product,
    eventId: row.eventId ?? product.id,
    addressId: product.id,
    dTag,
    eventCreatedAt: row.eventCreatedAt ?? Math.floor(product.createdAt / 1000),
    sourceRelayUrls: sourceRelayUrls.length > 0 ? sourceRelayUrls : undefined,
  })
}

async function readmitProductRows(
  rows: readonly CachedProduct[]
): Promise<CachedProduct[]> {
  const signed = rows.flatMap((row) =>
    row.signedProductEvent ? [row.signedProductEvent] : []
  )
  const admitted = await verifySignedEventBatches(signed)
  const byId = new Map(admitted.map((event) => [event.id, event]))
  return rows.flatMap<CachedProduct>((row) => {
    const raw = row.signedProductEvent
    if (!raw) return [{ ...row, signedProductEvent: undefined }]
    const event = byId.get(raw.id)
    if (!event || !sameSignedPublicEvent(raw, event)) return []
    const record = dedupeProductEvents([event])[0]
    if (
      !record ||
      record.addressId !== row.id ||
      record.product.pubkey !== row.pubkey
    )
      return []
    // Persisted projections and identity fields are display data. Rebuild all
    // product authority from the exact admitted bytes; provenance stays separate.
    return [
      {
        ...toCachedProduct(record),
        cachedAt: row.cachedAt,
        sourceRelayUrls: row.sourceRelayUrls,
      },
    ]
  })
}

export async function loadCachedProducts(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<CachedProduct[]> {
  return readmitProductRows(
    await loadRawCachedProducts(merchantPubkey, authorPubkeys)
  )
}

async function loadRawCachedProducts(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<CachedProduct[]> {
  if (productCacheTestOverrides.getCachedProducts) {
    return await productCacheTestOverrides.getCachedProducts(
      merchantPubkey,
      authorPubkeys
    )
  }

  if (merchantPubkey) {
    return await db.products.where("pubkey").equals(merchantPubkey).toArray()
  }

  // Perspective catalog reads scope to a known author set; hit the `pubkey`
  // index instead of scanning + filtering the whole products table in JS.
  if (authorPubkeys && authorPubkeys.length > 0) {
    return await db.products
      .where("pubkey")
      .anyOf(authorPubkeys as string[])
      .toArray()
  }

  return await db.products.toArray()
}

function cachedProductEventCreatedAt(row: CachedProduct): number {
  return (
    row.eventCreatedAt ??
    Math.floor((row.updatedAt ?? row.createdAt ?? 0) / 1000)
  )
}

function shouldReplaceCachedProduct(
  existing: CachedProduct,
  candidate: CachedProduct
): boolean {
  const existingVerified = isVerifiedNostrEvent(existing.signedProductEvent)
  const candidateVerified = isVerifiedNostrEvent(candidate.signedProductEvent)
  if (existingVerified !== candidateVerified) return candidateVerified
  const existingCreatedAt = cachedProductEventCreatedAt(existing)
  const candidateCreatedAt = cachedProductEventCreatedAt(candidate)
  if (candidateCreatedAt !== existingCreatedAt) {
    return candidateCreatedAt > existingCreatedAt
  }

  if (candidate.eventId && existing.eventId) {
    return candidate.eventId <= existing.eventId
  }
  if (candidate.eventId) return true
  if (existing.eventId) return false
  return candidate.cachedAt >= existing.cachedAt
}

function selectCachedProductUpdates(
  rows: CachedProduct[],
  existingRows: CachedProduct[]
): CachedProduct[] {
  const ids = new Set(rows.map((row) => row.id))
  const selected = new Map(
    existingRows.filter((row) => ids.has(row.id)).map((row) => [row.id, row])
  )
  const changed = new Map<string, CachedProduct>()

  for (const row of rows) {
    const existing = selected.get(row.id)
    if (!existing) {
      selected.set(row.id, row)
      changed.set(row.id, row)
      continue
    }
    const candidateWins = shouldReplaceCachedProduct(existing, row)
    const winner = candidateWins ? row : existing
    const loser = candidateWins ? existing : row
    const sourceRelayUrls = uniqueStrings([
      ...(winner.sourceRelayUrls ?? []),
      ...(loser.sourceRelayUrls ?? []),
    ])
    const merged = {
      ...winner,
      sourceRelayUrls,
      dTag: winner.dTag ?? existing.dTag ?? row.dTag,
      cachedAt: Math.max(existing.cachedAt, row.cachedAt),
    }
    if (
      candidateWins ||
      sourceRelayUrls.length !== (existing.sourceRelayUrls?.length ?? 0) ||
      merged.dTag !== existing.dTag ||
      merged.cachedAt !== existing.cachedAt
    ) {
      selected.set(row.id, merged)
      changed.set(row.id, merged)
    }
  }

  return Array.from(changed.values())
}

async function storeCachedProducts(rows: CachedProduct[]): Promise<void> {
  if (rows.length === 0) return
  let selectedRows = rows
  try {
    if (productCacheTestOverrides.putCachedProducts) {
      const existingRows = await readmitProductRows(
        productCacheTestOverrides.getCachedProducts
          ? await productCacheTestOverrides.getCachedProducts()
          : []
      )
      const rowsToStore = selectCachedProductUpdates(rows, existingRows)
      const ids = new Set(rows.map((row) => row.id))
      selectedRows = [
        ...existingRows.filter((row) => ids.has(row.id)),
        ...rowsToStore,
      ]
      retainLocalProductRevisionEvidence(selectedRows)
      if (rowsToStore.length > 0)
        await productCacheTestOverrides.putCachedProducts(rowsToStore)
    } else {
      const ids = Array.from(new Set(rows.map((row) => row.id)))
      // Worker admission must finish outside the IndexedDB transaction. Retry
      // if another tab changed any row while its signed bytes were checked.
      let stored = false
      for (let attempt = 0; attempt < 4 && !stored; attempt++) {
        const rawRows = await db.products.bulkGet(ids)
        const expected = JSON.stringify(rawRows)
        const admittedRows = await readmitProductRows(
          rawRows.filter((row): row is CachedProduct => row !== undefined)
        )
        stored = await db.transaction("rw", db.products, async () => {
          const current = await db.products.bulkGet(ids)
          if (JSON.stringify(current) !== expected) return false
          const rowsToStore = selectCachedProductUpdates(rows, admittedRows)
          selectedRows = [...admittedRows, ...rowsToStore]
          retainLocalProductRevisionEvidence(selectedRows)
          if (rowsToStore.length > 0) await db.products.bulkPut(rowsToStore)
          return true
        })
      }
      if (!stored) throw new Error("Product cache changed during verification")
    }
    for (const row of selectedRows) {
      const pending = volatileProductRevisionRows.get(row.id)
      if (pending && shouldReplaceCachedProduct(pending, row)) {
        volatileProductRevisionRows.delete(row.id)
      }
    }
  } catch (error) {
    for (const row of selectedRows) {
      const pending = volatileProductRevisionRows.get(row.id)
      if (!pending || shouldReplaceCachedProduct(pending, row)) {
        volatileProductRevisionRows.set(row.id, row)
      }
    }
    retainLocalProductRevisionEvidence(selectedRows)
    throw error
  } finally {
    pruneLocalProductRevisionEvidence()
  }
}

function clearPersistedVolatileProductSourceRelayUrls(
  addressId: string,
  persistedRelayUrls: readonly string[]
): void {
  const pendingRelayUrls = volatileProductSourceRelayUrls.get(addressId)
  if (!pendingRelayUrls) return
  const persistedRelaySet = new Set(persistedRelayUrls)
  const remainingRelayUrls = pendingRelayUrls.filter(
    (relayUrl) => !persistedRelaySet.has(relayUrl)
  )
  if (remainingRelayUrls.length > 0) {
    volatileProductSourceRelayUrls.set(addressId, remainingRelayUrls)
  } else {
    volatileProductSourceRelayUrls.delete(addressId)
  }
}

async function flushVolatileProductSourceRelayUrls(
  rows: readonly CachedProduct[]
): Promise<CachedProduct[]> {
  const pendingRows = rows.flatMap((row) => {
    const pendingRelayUrls = volatileProductSourceRelayUrls.get(row.id)
    if (!pendingRelayUrls || pendingRelayUrls.length === 0) return []
    return [
      {
        row: {
          ...row,
          sourceRelayUrls: uniqueStrings([
            ...(row.sourceRelayUrls ?? []),
            ...pendingRelayUrls,
          ]),
        },
        pendingRelayUrls: [...pendingRelayUrls],
      },
    ]
  })
  if (pendingRows.length === 0) return [...rows]
  const pendingById = new Map(
    pendingRows.map(({ row }) => [row.id, row] as const)
  )
  const rowsWithPendingProvenance = rows.map(
    (row) => pendingById.get(row.id) ?? row
  )

  try {
    await storeCachedProducts(pendingRows.map(({ row }) => row))
  } catch {
    return rowsWithPendingProvenance
  }
  for (const { row, pendingRelayUrls } of pendingRows) {
    clearPersistedVolatileProductSourceRelayUrls(row.id, pendingRelayUrls)
  }
  return rowsWithPendingProvenance
}

function productTombstoneIdForAddress(addressId: string): string {
  return `a:${addressId}`
}

function productTombstoneIdForEvent(pubkey: string, eventId: string): string {
  return `e:${pubkey}:${eventId}`
}

function tombstonesFromDeletionEvent(
  event: SignedPublicNostrEvent,
  options: { observedLocally: boolean }
): CachedProductTombstone[] {
  if (!event.pubkey) throw new Error("Deletion event pubkey is required")
  if (!event.id) throw new Error("Deletion event id is required")

  const deletedAt = toEventCreatedAtSeconds(event)
  const rows = new Map<string, CachedProductTombstone>()
  const cachedAt = now()
  const sourceRelayUrls = getEventSourceRelayUrls(event)
  const validated = isVerifiedNostrEvent(event)
    ? validateProductDeletionEvent(event)
    : null
  if (!validated) {
    throw new Error("Expected a valid signed product deletion event")
  }
  const { evidence, signedEvent } = validated

  for (const item of evidence) {
    const id =
      item.target === "event"
        ? productTombstoneIdForEvent(item.authorPubkey, item.eventId)
        : productTombstoneIdForAddress(item.addressId)
    rows.set(id, {
      id,
      pubkey: item.authorPubkey,
      ...(item.target === "event"
        ? { eventId: item.eventId }
        : { addressId: item.addressId }),
      deletedAt,
      deletionEventId: event.id,
      signedEvent,
      sourceRelayUrls,
      observedLocally: options.observedLocally,
      cachedAt,
    })
  }

  return Array.from(rows.values())
}

async function loadCachedProductTombstones(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<CachedProductTombstone[]> {
  const rows = await loadRawCachedProductTombstones(
    merchantPubkey,
    authorPubkeys
  )
  const result: CachedProductTombstone[] = []
  for (const row of rows) {
    if (!row.signedEvent) continue
    const admission = await admitPublicEvent(row.signedEvent)
    if (admission.status === "unavailable" || admission.status === "cancelled")
      throw new Error("Stored deletion verification unavailable")
    if (admission.status !== "verified") continue
    for (const url of row.sourceRelayUrls ?? [])
      attachEventSourceRelayUrl(admission.event, url)
    const derived = tombstonesFromDeletionEvent(admission.event, {
      observedLocally: row.observedLocally === true,
    })
    result.push(
      ...derived.filter(
        (item) => item.id === row.id && item.pubkey === row.pubkey
      )
    )
  }
  return result
}

async function loadRawCachedProductTombstones(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<CachedProductTombstone[]> {
  if (productCacheTestOverrides.getCachedProductTombstones) {
    return await productCacheTestOverrides.getCachedProductTombstones(
      merchantPubkey,
      authorPubkeys
    )
  }

  if (merchantPubkey) {
    return await db.productTombstones
      .where("pubkey")
      .equals(merchantPubkey)
      .toArray()
  }

  if (authorPubkeys && authorPubkeys.length > 0) {
    return await db.productTombstones
      .where("pubkey")
      .anyOf(authorPubkeys as string[])
      .toArray()
  }

  return await db.productTombstones.toArray()
}

function selectCachedProductTombstoneUpdates(
  rows: CachedProductTombstone[],
  existingRows: CachedProductTombstone[]
): CachedProductTombstone[] {
  const ids = Array.from(new Set(rows.map((row) => row.id)))
  const selected = new Map(
    existingRows
      .filter((row) => ids.includes(row.id))
      .map((row) => [row.id, row])
  )
  const changed = new Map<string, CachedProductTombstone>()

  for (const row of rows) {
    const existing = selected.get(row.id)
    if (!existing) {
      selected.set(row.id, row)
      changed.set(row.id, row)
      continue
    }

    const candidateWins =
      row.deletedAt > existing.deletedAt ||
      (row.deletedAt === existing.deletedAt &&
        row.deletionEventId <= existing.deletionEventId)
    const winner = candidateWins ? row : existing
    const sourceRelayUrls = uniqueStrings([
      ...(existing.sourceRelayUrls ?? []),
      ...(row.sourceRelayUrls ?? []),
    ])
    const merged: CachedProductTombstone = {
      ...winner,
      sourceRelayUrls,
      observedLocally:
        existing.observedLocally === true || row.observedLocally === true,
      cachedAt: Math.max(existing.cachedAt, row.cachedAt),
    }
    if (
      candidateWins ||
      sourceRelayUrls.length !== (existing.sourceRelayUrls?.length ?? 0) ||
      merged.observedLocally !== existing.observedLocally
    ) {
      selected.set(row.id, merged)
      changed.set(row.id, merged)
    }
  }

  return Array.from(changed.values())
}

/** Selected local product revisions, scoped to a retained catalog's dependencies. */
export type LocalProductRevisionSnapshot = Readonly<{
  status: "loading" | "ready" | "unavailable"
  records: readonly CommerceProductRecord[]
}>

type LocalProductRevisionObserver = {
  ids: Set<string>
  status: LocalProductRevisionSnapshot["status"]
  listener: (snapshot: LocalProductRevisionSnapshot) => void
  subscription?: { unsubscribe(): void }
}
const localProductRevisionObservers = new Set<LocalProductRevisionObserver>()
const localProductRevisionRecords = new Map<string, CommerceProductRecord>()
// Failed saves remain evidence even with no retained query. Successful rows are
// retained only while a consumer references them; IndexedDB owns durable storage.
const volatileProductRevisionRows = new Map<string, CachedProduct>()

function notifyLocalProductRevisionObserver(
  observer: LocalProductRevisionObserver
): void {
  try {
    observer.listener({
      status: observer.status,
      records: [...observer.ids].flatMap((id) => {
        const record = localProductRevisionRecords.get(id)
        return record ? [record] : []
      }),
    })
  } catch {
    console.warn("Local product revision observer failed")
  }
}

function retainLocalProductRevisionEvidence(
  rows: readonly CachedProduct[]
): void {
  const changed = new Set<string>()
  for (const row of rows) {
    if (!isVerifiedNostrEvent(row.signedProductEvent)) continue
    const candidate = fromCachedProduct(row)
    const existing = localProductRevisionRecords.get(candidate.addressId)
    if (
      existing &&
      (existing.eventId === candidate.eventId ||
        !shouldReplaceProductRecord(existing, candidate))
    )
      continue
    localProductRevisionRecords.set(candidate.addressId, candidate)
    changed.add(candidate.addressId)
  }
  for (const observer of localProductRevisionObservers) {
    if ([...changed].some((id) => observer.ids.has(id))) {
      notifyLocalProductRevisionObserver(observer)
    }
  }
}

function pruneLocalProductRevisionEvidence(): void {
  const retained = new Set(volatileProductRevisionRows.keys())
  for (const observer of localProductRevisionObservers) {
    for (const id of observer.ids) retained.add(id)
  }
  for (const id of localProductRevisionRecords.keys()) {
    if (!retained.has(id)) localProductRevisionRecords.delete(id)
  }
}

/** Local I/O only: primary-key reads observe relevant cross-tab commits without
 * rescanning the product table. Same-tab writes also deliver failed-save evidence. */
export function subscribeLocalProductRevisionChanges(
  addressIds: readonly string[],
  listener: (snapshot: LocalProductRevisionSnapshot) => void
): () => void {
  const observer: LocalProductRevisionObserver = {
    ids: new Set(addressIds),
    status: addressIds.length ? "loading" : "ready",
    listener,
  }
  localProductRevisionObservers.add(observer)
  notifyLocalProductRevisionObserver(observer)
  if (observer.ids.size > 0) {
    const ids = [...observer.ids]
    const load = async (): Promise<CachedProduct[]> => {
      if (productCacheTestOverrides.getCachedProducts) {
        return (await productCacheTestOverrides.getCachedProducts()).filter(
          (row) => observer.ids.has(row.id)
        )
      }
      return (await db.products.bulkGet(ids)).filter(
        (row): row is CachedProduct => !!row
      )
    }
    const delivery = {
      next: (rows: CachedProduct[]) => {
        if (!localProductRevisionObservers.has(observer)) return
        retainLocalProductRevisionEvidence(rows)
        observer.status = "ready"
        notifyLocalProductRevisionObserver(observer)
      },
      error: () => {
        if (!localProductRevisionObservers.has(observer)) return
        observer.status = "unavailable"
        notifyLocalProductRevisionObserver(observer)
      },
    }
    if (
      productCacheTestOverrides.getCachedProducts ||
      typeof indexedDB === "undefined"
    ) {
      void load().then(readmitProductRows).then(delivery.next, delivery.error)
    } else
      observer.subscription = liveQuery(async () =>
        readmitProductRows(await load())
      ).subscribe(delivery)
  }
  return () => {
    localProductRevisionObservers.delete(observer)
    observer.subscription?.unsubscribe()
    pruneLocalProductRevisionEvidence()
  }
}

function resetLocalProductRevisionObservation(): void {
  for (const observer of localProductRevisionObservers)
    observer.subscription?.unsubscribe()
  localProductRevisionObservers.clear()
  localProductRevisionRecords.clear()
  volatileProductRevisionRows.clear()
}

/** Local signed deletion evidence shared by retained query projections. */
export type LocalProductDeletionSnapshot = Readonly<{
  status: "loading" | "ready" | "unavailable"
  revision: number
  evidence: readonly ProductDeletionEvidence[]
}>

let localProductDeletionSnapshot: LocalProductDeletionSnapshot = {
  status: "loading",
  revision: 0,
  evidence: [],
}
const localProductDeletionListeners = new Set<
  (snapshot: LocalProductDeletionSnapshot) => void
>()
let localProductDeletionSubscription: { unsubscribe(): void } | undefined
let localProductDeletionObservationGeneration = 0

export function getLocalProductDeletionSnapshot(): LocalProductDeletionSnapshot {
  return localProductDeletionSnapshot
}

function notifyLocalProductDeletionListeners(): void {
  for (const listener of localProductDeletionListeners) {
    try {
      listener(localProductDeletionSnapshot)
    } catch {
      // A view observer must not interrupt retention of signed evidence or
      // prevent another observer from revoking its previous projection.
      console.warn("Local product deletion observer failed")
    }
  }
}

function setLocalProductDeletionStatus(
  status: LocalProductDeletionSnapshot["status"]
): void {
  if (localProductDeletionSnapshot.status === status) return
  localProductDeletionSnapshot = { ...localProductDeletionSnapshot, status }
  notifyLocalProductDeletionListeners()
}

function retainLocalProductDeletionEvidence(
  rows: readonly CachedProductTombstone[]
): void {
  const frontier = deletionTimestampsFromTombstones(rows)
  for (const evidence of localProductDeletionSnapshot.evidence) {
    const key =
      evidence.target === "event"
        ? scopedProductDeletionEventKey(evidence.authorPubkey, evidence.eventId)
        : productDeletionAddressKey(evidence.addressId)
    if (key)
      setLatestDeletionEvidence(
        evidence.target === "event" ? frontier.byEventId : frontier.byAddressId,
        key,
        evidence
      )
  }
  const evidence = [
    ...frontier.byEventId.entries(),
    ...frontier.byAddressId.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => item)
  if (
    JSON.stringify(evidence) ===
    JSON.stringify(localProductDeletionSnapshot.evidence)
  )
    return
  localProductDeletionSnapshot = {
    ...localProductDeletionSnapshot,
    revision: localProductDeletionSnapshot.revision + 1,
    evidence,
  }
  notifyLocalProductDeletionListeners()
}

/** Observe local storage only. Dexie includes committed writes from other
 * same-origin browser contexts; in-process observations also include validated
 * evidence whose persistence is still pending or unavailable. */
export function subscribeLocalProductDeletionChanges(
  listener: (snapshot: LocalProductDeletionSnapshot) => void
): () => void {
  localProductDeletionListeners.add(listener)
  if (!localProductDeletionSubscription) {
    const generation = ++localProductDeletionObservationGeneration
    setLocalProductDeletionStatus("loading")
    const observer = {
      next: (rows: CachedProductTombstone[]) => {
        if (generation !== localProductDeletionObservationGeneration) return
        retainLocalProductDeletionEvidence([
          ...rows,
          ...volatileProductTombstones.values(),
        ])
        setLocalProductDeletionStatus("ready")
      },
      error: () => {
        if (generation !== localProductDeletionObservationGeneration) return
        setLocalProductDeletionStatus("unavailable")
      },
    }
    if (
      productCacheTestOverrides.getCachedProductTombstones ||
      typeof indexedDB === "undefined"
    ) {
      // Dexie liveQuery intentionally stays silent when IndexedDB is absent.
      // A local-only read still settles initial readiness and test repositories.
      localProductDeletionSubscription = { unsubscribe() {} }
      void loadCachedProductTombstones().then(observer.next, observer.error)
    } else {
      localProductDeletionSubscription = liveQuery(() =>
        loadCachedProductTombstones()
      ).subscribe(observer)
    }
  }
  listener(localProductDeletionSnapshot)
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    localProductDeletionListeners.delete(listener)
    if (localProductDeletionListeners.size === 0) {
      ++localProductDeletionObservationGeneration
      localProductDeletionSubscription?.unsubscribe()
      localProductDeletionSubscription = undefined
    }
  }
}

function resetLocalProductDeletionObservation(): void {
  ++localProductDeletionObservationGeneration
  localProductDeletionSubscription?.unsubscribe()
  localProductDeletionSubscription = undefined
  localProductDeletionListeners.clear()
  localProductDeletionSnapshot = {
    status: "loading",
    revision: 0,
    evidence: [],
  }
}

async function storeCachedProductTombstones(
  rows: CachedProductTombstone[]
): Promise<void> {
  if (rows.length === 0) return

  if (productCacheTestOverrides.putCachedProductTombstones) {
    const existingRows = productCacheTestOverrides.getCachedProductTombstones
      ? await productCacheTestOverrides.getCachedProductTombstones()
      : []
    const rowsToStore = selectCachedProductTombstoneUpdates(rows, existingRows)
    if (rowsToStore.length > 0)
      await productCacheTestOverrides.putCachedProductTombstones(rowsToStore)
    retainLocalProductDeletionEvidence([...existingRows, ...rowsToStore])
    return
  }

  const ids = Array.from(new Set(rows.map((row) => row.id)))
  const selectedRows = await db.transaction(
    "rw",
    db.productTombstones,
    async () => {
      const existingRows = (await db.productTombstones.bulkGet(ids)).filter(
        (row): row is CachedProductTombstone => row !== undefined
      )
      const rowsToStore = selectCachedProductTombstoneUpdates(
        rows,
        existingRows
      )
      if (rowsToStore.length > 0) {
        await db.productTombstones.bulkPut(rowsToStore)
      }
      // An older incoming row may cause no write. Still publish the stronger
      // persisted winner before a retained catalog can project this observation.
      return [...existingRows, ...rowsToStore]
    }
  )
  retainLocalProductDeletionEvidence(selectedRows)
}

function rememberVolatileProductTombstones(
  rows: readonly CachedProductTombstone[]
): void {
  const updates = selectCachedProductTombstoneUpdates(
    [...rows],
    Array.from(volatileProductTombstones.values())
  )
  for (const row of updates) {
    volatileProductTombstones.set(row.id, row)
  }
  retainLocalProductDeletionEvidence(rows)
}

async function flushVolatileProductTombstones(): Promise<boolean> {
  const pendingRows = Array.from(volatileProductTombstones.values())
  if (pendingRows.length === 0) return true

  try {
    await storeCachedProductTombstones(pendingRows)
  } catch {
    return false
  }

  for (const row of pendingRows) {
    // A concurrent read may have observed newer evidence for the same target
    // while persistence was in flight. Only clear the exact row we flushed.
    if (volatileProductTombstones.get(row.id) === row) {
      volatileProductTombstones.delete(row.id)
    }
  }
  return true
}

function deletionTimestampsFromTombstones(
  tombstones: readonly CachedProductTombstone[]
): DeletionTimestamps {
  const byEventId = new Map<string, ProductDeletionEvidence>()
  const byAddressId = new Map<string, ProductDeletionEvidence>()

  for (const tombstone of tombstones) {
    if (tombstone.eventId) {
      const key = scopedProductDeletionEventKey(
        tombstone.pubkey,
        tombstone.eventId
      )
      if (key) {
        setLatestDeletionEvidence(byEventId, key, {
          target: "event",
          deletionEventId: tombstone.deletionEventId,
          authorPubkey: tombstone.pubkey,
          deletedAt: tombstone.deletedAt,
          eventId: tombstone.eventId,
        })
      }
    }
    if (tombstone.addressId) {
      const key = productDeletionAddressKey(tombstone.addressId)
      if (key) {
        setLatestDeletionEvidence(byAddressId, key, {
          target: "address",
          deletionEventId: tombstone.deletionEventId,
          authorPubkey: tombstone.pubkey,
          deletedAt: tombstone.deletedAt,
          addressId: tombstone.addressId,
        })
      }
    }
  }

  return { byEventId, byAddressId }
}

export function mergeDeletionTimestamps(
  ...frontiers: readonly DeletionTimestamps[]
): DeletionTimestamps {
  const byEventId = new Map<string, ProductDeletionEvidence>()
  const byAddressId = new Map<string, ProductDeletionEvidence>()

  for (const frontier of frontiers) {
    for (const [key, evidence] of frontier.byEventId) {
      setLatestDeletionEvidence(byEventId, key, evidence)
    }
    for (const [key, evidence] of frontier.byAddressId) {
      setLatestDeletionEvidence(byAddressId, key, evidence)
    }
  }

  return { byEventId, byAddressId }
}

async function mergeObservedDeletionTimestampsWithLocal(
  observed: DeletionTimestamps,
  authors: readonly string[]
): Promise<DeletionTimestamps> {
  try {
    return mergeDeletionTimestamps(
      await getLocalProductDeletionTimestamps(undefined, authors),
      observed
    )
  } catch {
    // If the local database is unavailable after relay validation, the
    // in-memory frontier is still authoritative for this read.
    return observed
  }
}

export async function getLocalProductDeletionTimestamps(
  merchantPubkey?: string,
  authorPubkeys?: readonly string[]
): Promise<DeletionTimestamps> {
  const authorSet =
    authorPubkeys && authorPubkeys.length > 0
      ? new Set(authorPubkeys)
      : undefined
  const volatileRows = Array.from(volatileProductTombstones.values()).filter(
    (row) =>
      (!merchantPubkey || row.pubkey === merchantPubkey) &&
      (!authorSet || authorSet.has(row.pubkey))
  )
  let persistedRows: CachedProductTombstone[] = []
  try {
    persistedRows = await loadCachedProductTombstones(
      merchantPubkey,
      authorPubkeys
    )
  } catch (error) {
    if (volatileRows.length === 0) throw error
  }
  return deletionTimestampsFromTombstones([...persistedRows, ...volatileRows])
}

export function filterDeletedProductRecords(
  records: CommerceProductRecord[],
  deletionTimestamps: DeletionTimestamps
): CommerceProductRecord[] {
  return records.filter(
    (record) => !isRecordDeletedByNip09(record, deletionTimestamps)
  )
}

export async function cacheSignedProductListingEvent(
  input: SignedPublicNostrEvent | { rawEvent(): unknown },
  options: {
    sourceRelayUrls?: readonly string[]
    persistence?: "required" | "best_effort"
  } = {}
): Promise<CommerceProductRecord> {
  // Local publishing compatibility; relay reads already provide plain events.
  const rawEvent = (
    "rawEvent" in input ? input.rawEvent() : input
  ) as SignedPublicNostrEvent
  const admission = await admitPublicEvent(rawEvent)
  if (admission.status !== "verified")
    throw new Error(
      "Expected a valid signed event; admission " + admission.status
    )
  const event = admission.event
  for (const relayUrl of getEventSourceRelayUrls(input))
    attachEventSourceRelayUrl(event, relayUrl)
  if (
    event.kind !== EVENT_KINDS.PRODUCT ||
    !event.id ||
    !event.sig ||
    !isVerifiedNostrEvent(event)
  ) {
    throw new Error("Expected a valid signed product listing event")
  }

  for (const relayUrl of options.sourceRelayUrls ?? []) {
    attachEventSourceRelayUrl(event, relayUrl)
  }

  const [record] = dedupeProductEvents([event])
  if (!record) throw new Error("Could not parse signed product listing event")

  const sourceRelayUrls = uniqueStrings(record.sourceRelayUrls ?? [])
  if (sourceRelayUrls.length > 0) {
    volatileProductSourceRelayUrls.set(
      record.addressId,
      uniqueStrings([
        ...(volatileProductSourceRelayUrls.get(record.addressId) ?? []),
        ...sourceRelayUrls,
      ])
    )
  }

  try {
    await cacheProductRecords([record])
  } catch (error) {
    if (options.persistence !== "best_effort" || sourceRelayUrls.length === 0) {
      throw error
    }
  }
  return record
}

/** Pure admitted projection for a product-write transaction; no crypto or I/O. */
export function projectSignedProductListingForLocalCommit(
  signedEvent: VerifiedNostrEvent
): CachedProduct {
  if (
    signedEvent.kind !== EVENT_KINDS.PRODUCT ||
    !isVerifiedNostrEvent(signedEvent)
  ) {
    throw new Error("Expected a valid signed product listing event")
  }
  const [record] = dedupeProductEvents([signedEvent])
  if (!record) throw new Error("Could not parse signed product listing event")
  return toCachedProduct(record)
}

/** Pure NIP-09 projection for the same atomic local product-write transaction. */
export function projectSignedProductDeletionForLocalCommit(
  signedEvent: VerifiedNostrEvent
): CachedProductTombstone[] {
  return tombstonesFromDeletionEvent(signedEvent, {
    observedLocally: true,
  })
}

export async function cacheSignedProductDeletionEvent(
  input: SignedPublicNostrEvent | { rawEvent(): unknown }
): Promise<CachedProductTombstone[]> {
  // Local publishing compatibility; relay reads already provide plain events.
  const rawEvent = (
    "rawEvent" in input ? input.rawEvent() : input
  ) as SignedPublicNostrEvent
  const admission = await admitPublicEvent(rawEvent)
  if (admission.status !== "verified")
    throw new Error(
      "Expected a valid signed event; admission " + admission.status
    )
  const event = admission.event
  for (const relayUrl of getEventSourceRelayUrls(input))
    attachEventSourceRelayUrl(event, relayUrl)
  const tombstones = tombstonesFromDeletionEvent(event, {
    observedLocally: true,
  })
  if (tombstones.length === 0) {
    throw new Error("Deletion event does not contain a valid product target")
  }
  // A validated local observation revokes old projections even if durable
  // storage fails. Preserve the write error so callers still retry persistence.
  rememberVolatileProductTombstones(tombstones)
  const pending = tombstones.map((row) =>
    volatileProductTombstones.get(row.id)!
  )
  await storeCachedProductTombstones(pending)
  for (const row of pending) {
    // Do not clear stronger evidence observed while this write was in flight.
    if (volatileProductTombstones.get(row.id) === row) {
      volatileProductTombstones.delete(row.id)
    }
  }
  return tombstones
}

export async function getCachedProductRecords(
  merchantPubkey?: string,
  options: CachedProductReadOptions = {},
  authorPubkeys?: readonly string[]
): Promise<CommerceProductRecord[]> {
  const rows = await flushVolatileProductSourceRelayUrls(
    await loadCachedProducts(merchantPubkey, authorPubkeys)
  )
  const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
    merchantPubkey,
    authorPubkeys
  )
  return rows
    .filter(
      (row) =>
        options.includeStale || now() - row.cachedAt < PRODUCT_CACHE_TTL_MS
    )
    .map(fromCachedProduct)
    .filter(
      (record) => !isRecordDeletedByNip09(record, localDeletionTimestamps)
    )
    .filter(
      (record) =>
        options.includeMarketHidden || isMarketRenderableRecord(record)
    )
}

/** Read only exact targets and same-author family context before normalization. */
export async function getCachedExactProductRecords(
  productIds: readonly string[],
  knownRecords: readonly CommerceProductRecord[] = []
): Promise<CommerceProductRecord[]> {
  const targets = new Set(productIds)
  const authors = uniqueStrings(
    productIds.flatMap((id) => {
      const coordinate = parseProductAddressCoordinate(id)
      return coordinate ? [coordinate.authorPubkey] : []
    })
  )
  const readRows = async (
    selectedAuthors: readonly string[],
    selection: { ids?: readonly string[]; parentIds?: readonly string[] }
  ): Promise<CachedProduct[]> => {
    const ids = new Set(selection.ids)
    const parents = new Set(selection.parentIds)
    const authorSet = new Set(selectedAuthors)
    const matches = (row: CachedProduct) =>
      authorSet.has(row.pubkey) &&
      parseProductAddressCoordinate(row.id)?.authorPubkey === row.pubkey &&
      (ids.has(row.id) ||
        (!!row.parentProductId && parents.has(row.parentProductId)))
    if (productCacheTestOverrides.getCachedProducts) {
      // Existing fixtures may ignore the optional native-query selection.
      return (
        await productCacheTestOverrides.getCachedProducts(
          undefined,
          selectedAuthors,
          selection
        )
      ).filter(matches)
    }
    if (selection.ids) {
      return (await db.products.bulkGet([...ids])).filter(
        (row): row is CachedProduct => row !== undefined && matches(row)
      )
    }
    return db.products
      .where("pubkey")
      .anyOf([...selectedAuthors])
      .filter(matches)
      .toArray()
  }
  // Keep reading prior context IDs even after a sibling changes parent/type;
  // its newer signed row must supersede the retained family membership.
  const readIds = uniqueStrings([
    ...productIds,
    ...knownRecords.map((record) => record.addressId),
  ])
  const direct = await readRows(authors, { ids: readIds })
  const parentIds = new Set<string>()
  const discoverFamily = (
    id: string,
    pubkey: string,
    type: string | undefined,
    parentId: string | undefined
  ) => {
    if (!targets.has(id)) return
    if (type === "variable") parentIds.add(id)
    if (type === "variation" && parentId) {
      const parent = parseProductAddressCoordinate(parentId)
      if (parent?.authorPubkey === pubkey) parentIds.add(parentId)
    }
  }
  for (const row of direct)
    discoverFamily(row.id, row.pubkey, row.type, row.parentProductId)
  // A live target can reveal a family even if its cache write failed or the
  // retained target still describes an older simple listing.
  for (const record of knownRecords)
    discoverFamily(
      record.addressId,
      record.product.pubkey,
      record.product.type,
      record.product.parentProductId
    )
  const contextRows = [...direct]
  if (parentIds.size > 0) {
    const missingParents = [...parentIds].filter((id) => !readIds.includes(id))
    const familyAuthors = uniqueStrings(
      [...parentIds].map(
        (id) => parseProductAddressCoordinate(id)!.authorPubkey
      )
    )
    if (missingParents.length > 0)
      contextRows.push(
        ...(await readRows(familyAuthors, { ids: missingParents }))
      )
    contextRows.push(
      ...(await readRows(familyAuthors, { parentIds: [...parentIds] }))
    )
  }
  const rows = await flushVolatileProductSourceRelayUrls([
    ...new Map(contextRows.map((row) => [row.id, row])).values(),
  ])
  const deletions = await getLocalProductDeletionTimestamps(undefined, authors)
  return filterDeletedProductRecords(rows.map(fromCachedProduct), deletions)
}

export async function cacheProductRecords(
  records: CommerceProductRecord[]
): Promise<void> {
  if (records.length === 0) return
  const recordsWithVolatileProvenance = records.map((record) => {
    const sourceRelayUrls = uniqueStrings([
      ...(record.sourceRelayUrls ?? []),
      ...(volatileProductSourceRelayUrls.get(record.addressId) ?? []),
    ])
    return {
      ...record,
      sourceRelayUrls: sourceRelayUrls.length > 0 ? sourceRelayUrls : undefined,
    }
  })
  await storeCachedProducts(recordsWithVolatileProvenance.map(toCachedProduct))
  for (const record of recordsWithVolatileProvenance) {
    clearPersistedVolatileProductSourceRelayUrls(
      record.addressId,
      record.sourceRelayUrls ?? []
    )
  }
}

export type DeletionTimestamps = {
  byEventId: Map<string, ProductDeletionEvidence>
  byAddressId: Map<string, ProductDeletionEvidence>
}

function setLatestDeletionEvidence(
  map: Map<string, ProductDeletionEvidence>,
  key: string,
  value: ProductDeletionEvidence
): void {
  const existing = map.get(key)
  if (
    !existing ||
    value.deletedAt > existing.deletedAt ||
    (value.deletedAt === existing.deletedAt &&
      value.deletionEventId <= existing.deletionEventId)
  ) {
    map.set(key, value)
  }
}

function isDeletedByNip09(
  event: Pick<SignedPublicNostrEvent, "id" | "pubkey" | "created_at">,
  addressId: string | null,
  deletionTimestamps: DeletionTimestamps
): boolean {
  const createdAt = toEventCreatedAtSeconds(event)
  const eventKey = event.id
    ? scopedProductDeletionEventKey(event.pubkey, event.id)
    : null
  const addressKey = addressId ? productDeletionAddressKey(addressId) : null
  const evidence = [
    ...(eventKey && deletionTimestamps.byEventId.get(eventKey)
      ? [deletionTimestamps.byEventId.get(eventKey)!]
      : []),
    ...(addressKey && deletionTimestamps.byAddressId.get(addressKey)
      ? [deletionTimestamps.byAddressId.get(addressKey)!]
      : []),
  ]
  return isProductDeletedByNip09(
    {
      authorPubkey: event.pubkey,
      eventId: event.id,
      addressId,
      createdAt,
    },
    evidence
  )
}

const MAX_PRODUCT_PARSE_CACHE = 20_000
const productParseCache = new Map<
  string,
  {
    event: SignedPublicNostrEvent
    parsed: ReturnType<typeof parseProductEvent>
    availability: ReturnType<typeof evaluateListingAvailability>
  }
>()

// Reuse parsed projections only while all signed fields match the original
// snapshot. An id alone cannot admit mutated or unverified signed bytes.
function parseAndPrepareProductEvent(event: VerifiedNostrEvent) {
  const cached = event.id ? productParseCache.get(event.id) : undefined
  if (cached && sameSignedPublicEvent(cached.event, event)) return cached
  const parsed = parseProductEvent(event)
  const entry = {
    event,
    parsed,
    availability: evaluateListingAvailability(parsed),
  }
  if (event.id) {
    if (productParseCache.size >= MAX_PRODUCT_PARSE_CACHE) {
      const oldest = productParseCache.keys().next().value
      if (oldest !== undefined) productParseCache.delete(oldest)
    }
    productParseCache.set(event.id, entry)
  }
  return entry
}

export function dedupeProductEvents(
  events: SignedPublicNostrEvent[],
  deletionTimestamps?: DeletionTimestamps,
  retainRevisions = false
): CommerceProductRecord[] {
  const byKey = new Map<string, CommerceProductRecord>()

  for (const event of events) {
    try {
      if (!isVerifiedNostrEvent(event))
        throw new Error("Product event must be admitted")
      const { parsed, availability } = parseAndPrepareProductEvent(event)

      const dTag = getTagValue(event.tags ?? [], "d")
      const addressId = dTag ? `30402:${event.pubkey}:${dTag}` : parsed.id

      if (
        deletionTimestamps &&
        isDeletedByNip09(event, dTag ? addressId : null, deletionTimestamps)
      ) {
        continue
      }

      const candidate: CommerceProductRecord = {
        product: {
          ...parsed,
          ...(event.id ? { sourceEventId: event.id } : {}),
        },
        availability,
        eventId: event.id,
        addressId,
        dTag,
        eventCreatedAt: toEventCreatedAtSeconds(event),
        sourceRelayUrls: getEventSourceRelayUrls(event),
      }

      // Catalog reads keep revisions until the last asynchronous write settles.
      // An exact deletion may invalidate the newest event without deleting its
      // older, still-valid coordinate candidate.
      const key = retainRevisions && event.id ? event.id : addressId
      const existing = byKey.get(key)
      if (!existing) byKey.set(key, candidate)
      else byKey.set(key, mergeProductRecordSources(existing, candidate))
    } catch {
      // ignore malformed product events
    }
  }

  return Array.from(byKey.values())
}

export function isRecordDeletedByNip09(
  record: CommerceProductRecord,
  deletionTimestamps: DeletionTimestamps
): boolean {
  return isDeletedByNip09(
    {
      id: record.eventId,
      pubkey: record.product.pubkey,
      created_at: record.eventCreatedAt,
    },
    record.dTag ? record.addressId : null,
    deletionTimestamps
  )
}

export async function retainObservedProductDeletions(
  deletionEvents: readonly SignedPublicNostrEvent[],
  authors: readonly string[]
): Promise<DeletionTimestamps> {
  const observedTombstones: CachedProductTombstone[] = []
  for (const deletion of deletionEvents) {
    try {
      observedTombstones.push(
        ...tombstonesFromDeletionEvent(deletion, { observedLocally: false })
      )
    } catch {
      // Relay data is untrusted. Invalid signatures and malformed targets
      // never become durable deletion evidence.
    }
  }
  const observedDeletionTimestamps =
    deletionTimestampsFromTombstones(observedTombstones)
  rememberVolatileProductTombstones(observedTombstones)
  if (!(await flushVolatileProductTombstones())) {
    // The current read must still honor deletion evidence that was already
    // cryptographically validated. The volatile frontier is monotonic and is
    // retried on later reads; returning stale cache here would resurrect the
    // observed product.
  }

  // Persisted evidence is monotonic: an empty later relay response cannot
  // revoke a deletion that was already observed and validated.
  return await mergeObservedDeletionTimestampsWithLocal(
    observedDeletionTimestamps,
    authors
  )
}
