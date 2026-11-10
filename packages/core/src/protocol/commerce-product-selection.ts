import type { Product } from "../types"
import { normalizePublicMediaUrl } from "../network-target-safety"
import {
  evaluateListingAvailability,
  isMerchantHiddenOnlyListingAvailable,
  isListingMarketVisible,
  type ListingAvailabilityContext,
  type ListingAvailabilityEvaluation,
} from "./listing-availability"
import {
  prepareProductCatalog,
  type PreparedProductFamily,
  type ProductFamilyReadEvidence,
} from "./product-family"
import {
  prepareProductDeletionResolver,
  type ProductDeletionEvidence,
} from "./product-deletion"
import { decodeProductReference } from "./product-reference"
import { compareReplaceableEventFrontiers } from "./signed-event"
import { isVerifiedNostrEvent } from "./verified-public-event"

export interface CommerceProductRecord {
  product: Product
  availability?: ListingAvailabilityEvaluation
  family?: PreparedProductFamily<CommerceProductRecord>
  /** In-memory evidence behind exact family eligibility, never extra results. */
  exactReadContext?: RetainedProductFamilyContext
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt: number
  sourceRelayUrls?: string[]
}

interface RetainedProductFamilyContext {
  /** Raw revisions, without nested projections; shared by one family's results. */
  records: CommerceProductRecord[]
  includeMarketHidden?: boolean
  includeMerchantHiddenProductIds?: readonly string[]
}

interface ProductSelectionOptions {
  includeMarketHidden?: boolean
  includeMerchantHiddenProductIds?: readonly string[]
}

// Product selection does no relay or storage I/O. The commerce facade supplies
// its clock so read metadata and test-controlled time retain the same semantics.
function isValidProductImageUrl(url: string | undefined): boolean {
  return normalizePublicMediaUrl(url) !== null
}

export function hasMarketProductImage(
  product: Pick<Product, "images">
): boolean {
  return product.images.some((image) => isValidProductImageUrl(image.url))
}

export function withListingAvailability(
  record: Omit<CommerceProductRecord, "availability"> & {
    availability?: ListingAvailabilityEvaluation
  }
): CommerceProductRecord {
  return {
    ...record,
    availability:
      record.availability ?? evaluateListingAvailability(record.product),
  }
}

export function isMarketRenderableRecord(
  record: CommerceProductRecord
): boolean {
  if (record.product.type === "variable" && record.family?.state !== "ready") {
    return false
  }
  return isListingMarketVisible(
    record.availability ?? evaluateListingAvailability(record.product)
  )
}

function prepareVariationGroups(
  records: CommerceProductRecord[],
  now: () => number,
  readEvidence: ProductFamilyReadEvidence = {
    source: records.some((record) => (record.sourceRelayUrls?.length ?? 0) > 0)
      ? "commerce"
      : "local_cache",
    fetchedAt: now(),
    stale: false,
    degraded: false,
    capped: false,
  }
): CommerceProductRecord[] {
  const catalog = prepareProductCatalog(records, readEvidence)

  return catalog.items.flatMap((item) => {
    if (item.kind === "simple") return [item.record]

    const { parent } = item.family
    const eligibleVariationRecords = item.family.children.filter((variation) =>
      isListingMarketVisible(
        evaluateListingAvailability(variation.product, {
          variationGroupRole: "variation",
          hasGroupImage: true,
        })
      )
    )
    const hasGroupImage =
      hasMarketProductImage(parent.product) ||
      eligibleVariationRecords.some((variation) =>
        hasMarketProductImage(variation.product)
      )
    const variations = eligibleVariationRecords
      .filter((variation) =>
        isListingMarketVisible(
          evaluateListingAvailability(variation.product, {
            variationGroupRole: "variation",
            hasGroupImage,
          })
        )
      )
      .sort(
        (left, right) =>
          left.eventCreatedAt - right.eventCreatedAt ||
          left.addressId.localeCompare(right.addressId)
      )
    if (variations.length === 0) {
      return [
        {
          ...parent,
          family: item.family,
          availability: evaluateListingAvailability(parent.product, {
            variationGroupRole: "parent",
            hasGroupImage,
          }),
        },
      ]
    }

    const prepared = prepareProductCatalog(
      [parent, ...variations],
      readEvidence
    ).items[0]
    if (prepared?.kind !== "family") return []

    return [
      {
        ...parent,
        family: prepared.family,
        availability: evaluateListingAvailability(parent.product, {
          variationGroupRole: "parent",
          hasGroupImage,
        }),
      },
    ]
  })
}

export function withProductFamilyReadEvidence(
  records: CommerceProductRecord[],
  meta: Omit<ProductFamilyReadEvidence, "capped"> & { capped?: boolean }
): CommerceProductRecord[] {
  const readEvidence: ProductFamilyReadEvidence = {
    source: meta.source,
    fetchedAt: meta.fetchedAt,
    stale: meta.stale,
    degraded: meta.degraded,
    capped: meta.capped ?? false,
  }
  return records.map((record) =>
    record.family
      ? {
          ...record,
          family: { ...record.family, readEvidence },
        }
      : record
  )
}

export function withProductFamilyRecordReadEvidence(
  record: CommerceProductRecord | null,
  meta: Omit<ProductFamilyReadEvidence, "capped"> & { capped?: boolean }
): CommerceProductRecord | null {
  return record
    ? (withProductFamilyReadEvidence([record], meta)[0] ?? null)
    : null
}

export function filterProductRecordsForRead(
  records: CommerceProductRecord[],
  options: {
    includeMarketHidden?: boolean
    groupVariations?: boolean
  },
  now: () => number
): CommerceProductRecord[] {
  if (options.includeMarketHidden && options.groupVariations !== true) {
    return records
  }

  const prepared =
    options.groupVariations === false
      ? records
      : prepareVariationGroups(records, now)
  return options.includeMarketHidden
    ? prepared
    : prepared.filter(isMarketRenderableRecord)
}

/** Preserve the inputs to family eligibility after projecting exact targets.
 * Local deletions can then reuse the same selector without another relay read. */
export function filterExactProductRecordsForRead(
  records: CommerceProductRecord[],
  wanted: ReadonlySet<string>,
  options: ProductSelectionOptions,
  now: () => number
): CommerceProductRecord[] {
  const selected = selectExactProductRecordsForRead(
    records,
    wanted,
    options,
    now
  )
  const contexts = new Map<string, RetainedProductFamilyContext>()
  for (const record of selected) {
    const parentAddress = getVariationParentAddress(record)
    if (parentAddress && !contexts.has(parentAddress)) {
      contexts.set(parentAddress, {
        records: [],
        includeMarketHidden: options.includeMarketHidden,
      })
    }
  }
  if (contexts.size === 0) return selected
  for (const record of records) {
    const parentAddress = getVariationParentAddress(record)
    const context = parentAddress ? contexts.get(parentAddress) : undefined
    if (!context) continue
    // Keep evidence separate from nested result projections.
    const candidate = { ...record }
    delete candidate.family
    delete candidate.exactReadContext
    context.records.push(candidate)
  }
  const hiddenAddresses = new Set(
    (options.includeMerchantHiddenProductIds ?? [])
      .map((id) => getProductLookupIds(id).addressId)
      .filter((id): id is string => !!id)
  )
  for (const context of contexts.values()) {
    context.includeMerchantHiddenProductIds = context.records
      .map((record) => record.addressId)
      .filter((address) => hiddenAddresses.has(address))
  }
  return selected.map((record) => {
    const parentAddress = getVariationParentAddress(record)
    return parentAddress
      ? { ...record, exactReadContext: contexts.get(parentAddress) }
      : record
  })
}

function selectExactProductRecordsForRead(
  records: CommerceProductRecord[],
  wanted: ReadonlySet<string>,
  options: ProductSelectionOptions,
  now: () => number
): CommerceProductRecord[] {
  const targets = records.filter((record) => wanted.has(record.addressId))
  const preparedByAddress = new Map(
    prepareVariationGroups(records, now).map((record) => [
      record.addressId,
      record,
    ])
  )
  if (options.includeMarketHidden) {
    return targets.map((target) =>
      target.product.type === "variable"
        ? (preparedByAddress.get(target.addressId) ?? target)
        : target
    )
  }

  const merchantHiddenAddresses = new Set(
    (options.includeMerchantHiddenProductIds ?? [])
      .map((productId) => getProductLookupIds(productId).addressId)
      .filter((addressId): addressId is string => !!addressId)
  )
  const merchantHiddenByAddress =
    merchantHiddenAddresses.size > 0
      ? prepareMerchantHiddenExactRecords(records, merchantHiddenAddresses, now)
      : new Map<string, CommerceProductRecord>()

  return targets.flatMap((target) => {
    if (merchantHiddenAddresses.has(target.addressId)) {
      const allowed = merchantHiddenByAddress.get(target.addressId)
      return allowed ? [allowed] : []
    }
    if (target.product.type === "simple") {
      return isMarketRenderableRecord(target) ? [target] : []
    }
    if (target.product.type === "variable") {
      const prepared = preparedByAddress.get(target.addressId)
      return prepared && isMarketRenderableRecord(prepared) ? [prepared] : []
    }

    const parent = target.product.parentProductId
      ? preparedByAddress.get(target.product.parentProductId)
      : undefined
    const variation = parent?.family?.children.find(
      (candidate) => candidate.product.id === target.product.id
    )
    if (!parent || !isMarketRenderableRecord(parent) || !variation) return []

    return [
      {
        ...target,
        availability: evaluateListingAvailability(variation.product, {
          variationGroupRole: "variation",
          hasGroupImage: true,
        }),
      },
    ]
  })
}

function isMerchantHiddenExactRecordAllowed(
  record: CommerceProductRecord,
  context?: ListingAvailabilityContext
): boolean {
  return isMerchantHiddenOnlyListingAvailable(
    evaluateListingAvailability(record.product, context)
  )
}

function prepareMerchantHiddenExactRecords(
  records: CommerceProductRecord[],
  allowedAddresses: ReadonlySet<string>,
  now: () => number
): Map<string, CommerceProductRecord> {
  const prepared = new Map<string, CommerceProductRecord>()
  const catalog = prepareProductCatalog(records, {
    source: records.some((record) => (record.sourceRelayUrls?.length ?? 0) > 0)
      ? "commerce"
      : "local_cache",
    fetchedAt: now(),
    stale: false,
    degraded: false,
    capped: false,
  })

  for (const item of catalog.items) {
    if (item.kind === "simple") {
      if (
        allowedAddresses.has(item.record.addressId) &&
        isMerchantHiddenExactRecordAllowed(item.record)
      ) {
        prepared.set(item.record.addressId, item.record)
      }
      continue
    }

    const parent = item.family.parent
    const parentAllowed = allowedAddresses.has(parent.addressId)
    const structuralContext: ListingAvailabilityContext = {
      variationGroupRole: "parent",
      hasGroupImage: true,
    }
    if (!isMerchantHiddenExactRecordAllowed(parent, structuralContext)) {
      continue
    }

    const ownImageChildContext: ListingAvailabilityContext = {
      variationGroupRole: "variation",
      hasGroupImage: true,
    }
    const structurallyAllowedChildren = item.family.children.filter(
      (child) =>
        allowedAddresses.has(child.addressId) &&
        isMerchantHiddenExactRecordAllowed(child, ownImageChildContext)
    )
    const hasGroupImage =
      (parentAllowed && hasMarketProductImage(parent.product)) ||
      structurallyAllowedChildren.some((child) =>
        hasMarketProductImage(child.product)
      )
    const childContext: ListingAvailabilityContext = {
      variationGroupRole: "variation",
      hasGroupImage,
    }
    const children = structurallyAllowedChildren
      .filter((child) =>
        isMerchantHiddenExactRecordAllowed(child, childContext)
      )
      .map((child) => ({
        ...child,
        availability: evaluateListingAvailability(child.product, childContext),
      }))

    // An accepted child can be rendered atomically without accepting its
    // parent. The parent still proves family structure and availability, but an
    // unaccepted parent or sibling cannot donate an image or enter the result.
    for (const child of children) {
      prepared.set(child.addressId, child)
    }

    if (!parentAllowed) continue
    const parentContext: ListingAvailabilityContext = {
      variationGroupRole: "parent",
      hasGroupImage,
    }
    if (!isMerchantHiddenExactRecordAllowed(parent, parentContext)) continue

    const rebuilt = prepareProductCatalog(
      [
        {
          ...parent,
          family: undefined,
          availability: evaluateListingAvailability(
            parent.product,
            parentContext
          ),
        },
        ...children,
      ],
      item.family.readEvidence
    ).items[0]
    if (rebuilt?.kind !== "family" || rebuilt.family.state !== "ready") {
      continue
    }

    const parentRecord: CommerceProductRecord = {
      ...rebuilt.family.parent,
      family: rebuilt.family,
    }
    prepared.set(parentRecord.addressId, parentRecord)
  }

  return prepared
}

/** Re-project only existing targets after merging stronger local dependencies.
 * A changed family is browse evidence until its exact read is completed again. */
export function reconcileProductRecordsWithRevisions(
  records: CommerceProductRecord[],
  revisions: readonly CommerceProductRecord[],
  now: () => number
): CommerceProductRecord[] {
  const winners = new Map<string, CommerceProductRecord>()
  for (const revision of revisions) {
    const previous = winners.get(revision.addressId)
    if (!previous || shouldReplaceProductRecord(previous, revision))
      winners.set(revision.addressId, revision)
  }
  const replace = (record: CommerceProductRecord) => {
    const candidate = winners.get(record.addressId)
    return candidate &&
      candidate.eventId !== record.eventId &&
      shouldReplaceProductRecord(record, candidate)
      ? candidate
      : record
  }
  const contexts = new Map<
    RetainedProductFamilyContext,
    Map<string, CommerceProductRecord> | null
  >()
  const result = records.flatMap((record) => {
    const context = record.exactReadContext
    if (context) {
      if (!contexts.has(context)) {
        const next = context.records.map(replace)
        contexts.set(
          context,
          next.every((candidate, index) => candidate === context.records[index])
            ? null
            : new Map(
                filterExactProductRecordsForRead(
                  next,
                  new Set(next.map((candidate) => candidate.addressId)),
                  context,
                  now
                ).map((candidate) => [candidate.addressId, candidate])
              )
        )
      }
      const prepared = contexts.get(context)
      if (!prepared) return [record]
      const next = prepared.get(record.addressId)
      if (!next) return []
      return [
        next.family && record.family
          ? {
              ...next,
              family: {
                ...next.family,
                readEvidence: {
                  ...record.family.readEvidence,
                  stale: true,
                  degraded: true,
                },
              },
            }
          : next,
      ]
    }
    const inputs = record.family
      ? [record.family.parent, ...record.family.children]
      : [record]
    const next = inputs.map(replace)
    if (next.every((candidate, index) => candidate === inputs[index]))
      return [record]
    const selected = filterExactProductRecordsForRead(
      next,
      new Set([record.addressId]),
      {},
      now
    )
    return selected.map((candidate) =>
      candidate.family && record.family
        ? {
            ...candidate,
            family: {
              ...candidate.family,
              readEvidence: {
                ...record.family.readEvidence,
                stale: true,
                degraded: true,
              },
            },
          }
        : candidate
    )
  })
  return result.length === records.length &&
    result.every((record, index) => record === records[index])
    ? records
    : result
}

/** Remove only records contradicted by observed NIP-09 evidence. Rebuild
 * affected family choices and summaries while retaining their read provenance. */
export function reconcileProductRecordsWithDeletions(
  records: CommerceProductRecord[],
  evidence: readonly ProductDeletionEvidence[],
  now: () => number
): CommerceProductRecord[] {
  const resolveDeletion = prepareProductDeletionResolver(evidence)
  const deleted = (record: CommerceProductRecord) =>
    resolveDeletion({
      authorPubkey: record.product.pubkey,
      eventId: record.eventId,
      addressId: record.dTag ? record.addressId : null,
      createdAt: record.eventCreatedAt,
    }).deleted
  // Multiple exact targets may share a family. Re-evaluate it once per snapshot.
  const resolvedContexts = new Map<
    RetainedProductFamilyContext,
    Map<string, CommerceProductRecord> | null
  >()
  const reconciled = records.flatMap((record) => {
    if (deleted(record)) return []
    const context = record.exactReadContext
    if (context) {
      if (!resolvedContexts.has(context)) {
        const remaining = context.records.filter(
          (candidate) => !deleted(candidate)
        )
        resolvedContexts.set(
          context,
          remaining.length === context.records.length
            ? null
            : new Map(
                filterExactProductRecordsForRead(
                  remaining,
                  new Set(remaining.map((candidate) => candidate.addressId)),
                  context,
                  now
                ).map((candidate) => [candidate.addressId, candidate])
              )
        )
      }
      const resolved = resolvedContexts.get(context)
      if (!resolved) return [record]
      const next = resolved.get(record.addressId)
      if (!next) return []
      return [
        next.family && record.family
          ? {
              ...next,
              family: {
                ...next.family,
                readEvidence: record.family.readEvidence,
              },
            }
          : next,
      ]
    }
    if (!record.family) return [record]
    if (deleted(record.family.parent)) return []
    const children = record.family.children.filter((child) => !deleted(child))
    if (children.length === record.family.children.length) return [record]
    const hasGroupImage =
      hasMarketProductImage(record.family.parent.product) ||
      children.some((child) => hasMarketProductImage(child.product))
    const parent = {
      ...record.family.parent,
      family: undefined,
      availability: evaluateListingAvailability(record.family.parent.product, {
        variationGroupRole: "parent",
        hasGroupImage,
      }),
    }
    const prepared = prepareProductCatalog(
      [
        parent,
        ...children.map((child) => ({
          ...child,
          availability: evaluateListingAvailability(child.product, {
            variationGroupRole: "variation",
            hasGroupImage,
          }),
        })),
      ],
      record.family.readEvidence
    ).items.find((item) => item.kind === "family")
    if (prepared?.kind !== "family") return []
    return [
      { ...record, availability: parent.availability, family: prepared.family },
    ]
  })
  return reconciled.length === records.length &&
    reconciled.every((record, index) => record === records[index])
    ? records
    : reconciled
}

export function shouldReplaceProductRecord(
  existing: CommerceProductRecord,
  candidate: CommerceProductRecord
): boolean {
  const existingVerified = isVerifiedNostrEvent(
    existing.product.signedProductEvent
  )
  const candidateVerified = isVerifiedNostrEvent(
    candidate.product.signedProductEvent
  )
  if (existingVerified !== candidateVerified) return candidateVerified
  return (
    compareReplaceableEventFrontiers(
      {
        createdAt: candidate.eventCreatedAt,
        eventId:
          candidate.eventId !== candidate.addressId
            ? candidate.eventId
            : undefined,
      },
      {
        createdAt: existing.eventCreatedAt,
        eventId:
          existing.eventId !== existing.addressId
            ? existing.eventId
            : undefined,
      }
    ) >= 0
  )
}

export function mergeProductRecordSources(
  existing: CommerceProductRecord,
  candidate: CommerceProductRecord
): CommerceProductRecord {
  const candidateWins = shouldReplaceProductRecord(existing, candidate)
  const winner = candidateWins ? candidate : existing
  const loser = candidateWins ? existing : candidate
  return {
    ...winner,
    sourceRelayUrls: uniqueStrings([
      ...(winner.sourceRelayUrls ?? []),
      ...(loser.sourceRelayUrls ?? []),
    ]),
  }
}

export function parseAddress(
  productId: string
): { kind: number; pubkey: string; d: string; relayHints: string[] } | null {
  const reference = decodeProductReference(productId)
  if (!reference) return null
  return {
    kind: reference.kind,
    pubkey: reference.authorPubkey,
    d: reference.dTag,
    relayHints: reference.relayHints ?? [],
  }
}

export function getProductLookupIds(productId: string): {
  decodedId: string
  addressId: string | null
  address: {
    kind: number
    pubkey: string
    d: string
    relayHints: string[]
  } | null
} {
  let decodedId = productId
  try {
    decodedId = decodeURIComponent(productId)
  } catch {
    // Keep malformed percent encoding as an invalid product reference.
  }
  const address = parseAddress(productId)
  const addressId = address
    ? `${address.kind}:${address.pubkey}:${address.d}`
    : null
  return { decodedId, addressId, address }
}

function uniqueStrings(
  values: readonly (string | undefined | null)[]
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])
  )
}

export function getVariationParentAddress(
  target: CommerceProductRecord
): string | undefined {
  if (target.product.type === "simple") return undefined
  return target.product.type === "variable"
    ? target.addressId
    : target.product.parentProductId
}

function isProductRecordInFamily(
  record: CommerceProductRecord,
  parentAddress: string
): boolean {
  return (
    record.addressId === parentAddress ||
    record.product.parentProductId === parentAddress
  )
}

export function selectLatestProductRecordsByAddress(
  records: readonly CommerceProductRecord[]
): Map<string, CommerceProductRecord> {
  const selected = new Map<string, CommerceProductRecord>()
  for (const record of records) {
    const existing = selected.get(record.addressId)
    selected.set(
      record.addressId,
      existing ? mergeProductRecordSources(existing, record) : record
    )
  }
  return selected
}

export function hasCompleteLiveVariationGroupCoverage(input: {
  target: CommerceProductRecord
  groupRead: {
    records: CommerceProductRecord[]
    degraded: boolean
  }
  knownRecords: CommerceProductRecord[]
  directRecords: CommerceProductRecord[]
}): boolean {
  if (input.target.product.type === "simple") return true
  if (input.groupRead.degraded) return false

  const parentAddress = getVariationParentAddress(input.target)
  if (!parentAddress) return false

  const liveByAddress = selectLatestProductRecordsByAddress([
    ...input.directRecords,
    ...input.groupRead.records,
  ])
  const selectedByAddress = selectLatestProductRecordsByAddress([
    ...input.knownRecords,
    ...input.directRecords,
    ...input.groupRead.records,
  ])
  const knownFamilyAddressIds = new Set(
    Array.from(selectedByAddress.values())
      .filter((record) => isProductRecordInFamily(record, parentAddress))
      .map((record) => record.addressId)
  )
  knownFamilyAddressIds.add(input.target.addressId)
  knownFamilyAddressIds.add(parentAddress)

  return Array.from(knownFamilyAddressIds).every((addressId) => {
    const selected = selectedByAddress.get(addressId)
    const live = liveByAddress.get(addressId)
    return !!selected && !!live && selected.eventId === live.eventId
  })
}
