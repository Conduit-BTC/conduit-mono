import { compareCommercePrices } from "../pricing"
import type { Product } from "../types"
import { EVENT_KINDS } from "./kinds"
import { NostrSignerError } from "./nostr-event-signer"
import { canonicalizeProductTags } from "./products"
import {
  filterProductRecordsForRead,
  withProductFamilyReadEvidence,
  withProductFamilyRecordReadEvidence,
  getProductLookupIds,
  mergeProductRecordSources,
  type CommerceProductRecord,
} from "./commerce-product-selection"
import {
  cacheProductRecords,
  filterDeletedProductRecords,
  mergeDeletionTimestamps,
  getCachedProductRecords,
  getLocalProductDeletionTimestamps,
  type CachedProductReadOptions,
  type DeletionTimestamps,
} from "./commerce-product-cache"
import type {
  CommerceFreshnessMeta,
  CommerceQueryMeta,
  CommerceReadPolicy,
  CommerceReadSource,
  CommerceResult,
  CommerceSortMode,
  MarketplaceProductsQuery,
  MerchantStorefrontQuery,
  ProductDetailQuery,
} from "./commerce"

/** Existing transport and facade metadata remain composed by commerce.ts. */
export interface StorefrontReadDependencies {
  readonly fetchPublicProductRecords: (query: {
    retainRevisions: boolean
    authors: string[]
    authenticatedPubkey?: string | null
    accountPubkey?: string | null
    shouldContinue?: () => boolean
    limit: number
    readPolicy?: CommerceReadPolicy
    deletionCandidates: CommerceProductRecord[]
    deletionReadPolicy?: CommerceReadPolicy
    deletionFallbackWhenEmpty: boolean
    onTransportStatus: (degraded: boolean, capped: boolean) => void
    onReadCoverage: (coverage: "complete" | "partial" | "unavailable") => void
  }) => Promise<CommerceProductRecord[]>
  readonly mergeCachedAndLiveProductRecords: (input: {
    cached: CommerceProductRecord[]
    live: CommerceProductRecord[]
    deletionTimestamps: DeletionTimestamps
  }) => CommerceProductRecord[]
  readonly createMeta: (
    source: "commerce" | "local_cache",
    options?: Partial<CommerceFreshnessMeta>
  ) => CommerceQueryMeta
  readonly now: () => number
}

/** Existing product transport, family coverage and metadata stay facade-owned. */
export interface ProductDetailReadDependencies {
  readonly fetchPublicProductRecords: (query: {
    authors?: string[]
    ids?: string[]
    dTags?: string[]
    accountPubkey?: string | null
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    extraRelayUrls?: readonly string[]
    deletionCandidates: CommerceProductRecord[]
    limit?: number
    onTransportStatus: (degraded: boolean, capped: boolean) => void
  }) => Promise<CommerceProductRecord[]>
  readonly fetchVariationGroupRecords: (
    target: CommerceProductRecord,
    accountPubkey?: string | null,
    authenticatedPubkey?: string | null,
    shouldContinue?: () => boolean,
    relayHints?: readonly string[]
  ) => Promise<{
    records: CommerceProductRecord[]
    degraded: boolean
    capped: boolean
  }>
  readonly fetchDeletionTimestampsForProductRecords: (
    records: readonly CommerceProductRecord[],
    authorPubkeys?: readonly string[],
    accountPubkey?: string | null,
    authenticatedPubkey?: string | null,
    shouldContinue?: () => boolean
  ) => Promise<DeletionTimestamps>
  readonly mergeCachedAndLiveProductRecords: StorefrontReadDependencies["mergeCachedAndLiveProductRecords"]
  readonly hasCompleteLiveVariationGroupCoverage: (input: {
    target: CommerceProductRecord
    groupRead: { records: CommerceProductRecord[]; degraded: boolean }
    knownRecords: CommerceProductRecord[]
    directRecords: CommerceProductRecord[]
  }) => boolean
  readonly getMerchantStorefront: (
    query: MerchantStorefrontQuery
  ) => Promise<CommerceResult<CommerceProductRecord[]>>
  readonly createMeta: (
    source: CommerceReadSource,
    options?: Partial<CommerceFreshnessMeta>
  ) => CommerceQueryMeta
  readonly now: () => number
}

const PRODUCT_RAW_EVENT_LIMIT_DEFAULT = 600
const PRODUCT_RAW_EVENT_LIMIT_FLOOR = 100
const PRODUCT_RAW_EVENT_LIMIT_MAX = 1_200
const PRODUCT_RAW_EVENT_OVERFETCH_FACTOR = 6

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

export function createProductQueryMatcher(
  query: MarketplaceProductsQuery
): (record: CommerceProductRecord) => boolean {
  const textQuery = normalizeText(query.textQuery)
  const authors = query.authorPubkeys?.length
    ? new Set(query.authorPubkeys)
    : null
  const tags = query.tags?.length
    ? new Set(canonicalizeProductTags(query.tags))
    : null
  return ({ product }) => {
    if (authors && !authors.has(product.pubkey)) return false
    if (query.merchantPubkey && product.pubkey !== query.merchantPubkey)
      return false
    if (textQuery) {
      const haystack =
        `${product.title}\n${product.summary ?? ""}`.toLowerCase()
      if (!haystack.includes(textQuery)) return false
    }
    if (
      tags &&
      !canonicalizeProductTags(product.tags).some((tag) => tags.has(tag))
    )
      return false
    return true
  }
}

export function sortProducts(
  records: CommerceProductRecord[],
  sort: CommerceSortMode | undefined
): CommerceProductRecord[] {
  const items = [...records]
  const familySummaryPrice = (record: CommerceProductRecord): Product =>
    record.family?.priceSummary.minimum?.product ?? record.product
  switch (sort) {
    case "price_asc":
      return items.sort(
        (a, b) =>
          compareCommercePrices(
            familySummaryPrice(a),
            familySummaryPrice(b),
            null,
            "asc"
          ) || b.product.updatedAt - a.product.updatedAt
      )
    case "price_desc":
      return items.sort(
        (a, b) =>
          compareCommercePrices(
            familySummaryPrice(a),
            familySummaryPrice(b),
            null,
            "desc"
          ) || b.product.updatedAt - a.product.updatedAt
      )
    case "updated_at_desc":
      return items.sort(
        (a, b) =>
          b.product.updatedAt - a.product.updatedAt ||
          b.eventCreatedAt - a.eventCreatedAt
      )
    case "newest":
    default:
      return items.sort(
        (a, b) =>
          b.eventCreatedAt - a.eventCreatedAt ||
          b.product.updatedAt - a.product.updatedAt
      )
  }
}

export function applyProductLimit(
  records: CommerceProductRecord[],
  limit: number | undefined
): CommerceProductRecord[] {
  return limit === undefined ? records : records.slice(0, limit)
}

export function getProductRawEventLimit(
  displayLimit: number | undefined
): number {
  if (
    displayLimit === undefined ||
    !Number.isFinite(displayLimit) ||
    displayLimit <= 0
  ) {
    return PRODUCT_RAW_EVENT_LIMIT_DEFAULT
  }

  return Math.min(
    PRODUCT_RAW_EVENT_LIMIT_MAX,
    Math.max(
      PRODUCT_RAW_EVENT_LIMIT_FLOOR,
      Math.ceil(displayLimit) * PRODUCT_RAW_EVENT_OVERFETCH_FACTOR
    )
  )
}

export async function getMerchantStorefront(
  query: MerchantStorefrontQuery,
  dependencies: StorefrontReadDependencies
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const {
    fetchPublicProductRecords,
    mergeCachedAndLiveProductRecords,
    createMeta,
    now,
  } = dependencies
  const cached = await getCachedProductRecords(query.merchantPubkey, {
    includeStale: true,
    includeMarketHidden: true,
  })

  try {
    let transportDegraded = false
    let readCapped = false
    let productReadCoverage: "complete" | "partial" | "unavailable" =
      "unavailable"
    const rawEventLimit = getProductRawEventLimit(query.limit)
    const liveRecords = await fetchPublicProductRecords({
      retainRevisions: true,
      authors: [query.merchantPubkey],
      authenticatedPubkey: query.authenticatedPubkey,
      accountPubkey: query.accountPubkey,
      shouldContinue: query.shouldContinue,
      limit: rawEventLimit,
      readPolicy: query.readPolicy,
      deletionCandidates: cached,
      deletionReadPolicy: query.deletionReadPolicy,
      // Merchant reads preserve the pre-existing broad kind-5 fallback unless
      // a latency-sensitive caller (such as Market storefront hydration)
      // explicitly opts out.
      deletionFallbackWhenEmpty: query.deletionFallbackWhenEmpty !== false,
      onReadCoverage: (coverage) => {
        productReadCoverage = coverage
      },
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    })
    const deletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey
    )
    const mergedRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: liveRecords,
      deletionTimestamps,
    })

    await cacheProductRecords(mergedRecords)
    const currentDeletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey
    )
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const currentRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: liveRecords,
      deletionTimestamps: currentDeletionTimestamps,
    })
    const sorted = sortProducts(
      filterProductRecordsForRead(
        currentRecords,
        {
          includeMarketHidden: query.includeMarketHidden,
          groupVariations: query.includeMarketHidden ? false : true,
        },
        now
      ).filter(
        createProductQueryMatcher({
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
          sort: query.sort,
          limit: query.limit,
        })
      ),
      query.sort
    )
    const filtered = applyProductLimit(sorted, query.limit)

    const meta =
      liveRecords.length === 0 && filtered.length > 0
        ? createMeta("local_cache", { stale: true, degraded: true })
        : createMeta("commerce", {
            capped: readCapped || liveRecords.length >= rawEventLimit,
            degraded:
              transportDegraded ||
              readCapped ||
              liveRecords.length >= rawEventLimit,
          })
    return {
      data: withProductFamilyReadEvidence(filtered, meta),
      meta: { ...meta, productReadCoverage },
    }
  } catch (error) {
    if (query.shouldContinue?.() === false) throw error
    const deletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey
    )
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const currentCache = mergeCachedAndLiveProductRecords({
      cached,
      live: [],
      deletionTimestamps,
    })
    const filteredCache = sortProducts(
      filterProductRecordsForRead(
        currentCache,
        {
          includeMarketHidden: query.includeMarketHidden,
          groupVariations: query.includeMarketHidden ? false : true,
        },
        now
      ).filter(
        createProductQueryMatcher({
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
        })
      ),
      query.sort
    )

    // An empty resolved fallback is meaningful when signed evidence removed
    // the captured products. Rejecting would leave callers' old paint intact.
    if (filteredCache.length > 0 || currentCache.length < cached.length) {
      const meta = createMeta("local_cache", { stale: true, degraded: true })
      return {
        data: withProductFamilyReadEvidence(
          applyProductLimit(filteredCache, query.limit),
          meta
        ),
        meta,
      }
    }

    throw error
  }
}

export async function getCachedMerchantStorefront(
  query: MerchantStorefrontQuery,
  options: CachedProductReadOptions,
  dependencies: StorefrontReadDependencies
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const { createMeta, now } = dependencies
  const readOptions = {
    ...options,
    includeMarketHidden: true,
  }
  const cached = applyProductLimit(
    sortProducts(
      filterProductRecordsForRead(
        await getCachedProductRecords(query.merchantPubkey, readOptions),
        {
          includeMarketHidden: query.includeMarketHidden,
          groupVariations: query.includeMarketHidden ? false : true,
        },
        now
      ).filter(
        createProductQueryMatcher({
          merchantPubkey: query.merchantPubkey,
          textQuery: query.textQuery,
          tags: query.tag ? [query.tag] : undefined,
          sort: query.sort,
        })
      ),
      query.sort
    ),
    query.limit
  )

  const meta = createMeta("local_cache", {
    stale: true,
    degraded: cached.length > 0,
  })
  return { data: withProductFamilyReadEvidence(cached, meta), meta }
}

function uniqueStrings(
  values: readonly (string | undefined | null)[]
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])
  )
}

function findProductDetailRecord(
  now: () => number,
  records: CommerceProductRecord[],
  lookupIds: string[],
  includeMarketHidden?: boolean,
  preparedRecords?: CommerceProductRecord[]
): CommerceProductRecord | null {
  const prepared =
    preparedRecords ??
    filterProductRecordsForRead(
      records,
      {
        includeMarketHidden,
        groupVariations: true,
      },
      now
    )
  const target =
    records.find(
      (item) =>
        lookupIds.includes(item.product.id) ||
        lookupIds.includes(item.addressId) ||
        lookupIds.includes(item.eventId)
    ) ?? null

  if (!target) {
    return (
      prepared.find(
        (item) =>
          lookupIds.includes(item.product.id) ||
          lookupIds.includes(item.addressId) ||
          lookupIds.includes(item.eventId) ||
          item.family?.children.some((variation) =>
            lookupIds.includes(variation.product.id)
          )
      ) ?? null
    )
  }

  const displayAddress =
    target.product.type === "variation"
      ? target.product.parentProductId
      : target.addressId
  if (displayAddress) {
    const display = prepared.find((item) => item.addressId === displayAddress)
    const includesTargetVariation =
      target.product.type !== "variation" ||
      display?.family?.children.some(
        (variation) => variation.product.id === target.product.id
      )
    if (display && includesTargetVariation) return display
  }

  return includeMarketHidden ? target : null
}

export async function getProductDetail(
  query: ProductDetailQuery,
  dependencies: ProductDetailReadDependencies
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const {
    fetchPublicProductRecords,
    fetchVariationGroupRecords,
    fetchDeletionTimestampsForProductRecords,
    mergeCachedAndLiveProductRecords,
    hasCompleteLiveVariationGroupCoverage,
    getMerchantStorefront,
    createMeta,
    now,
  } = dependencies

  const { decodedId, addressId, address } = getProductLookupIds(query.productId)

  try {
    if (address && addressId && address.kind === EVENT_KINDS.PRODUCT) {
      const cached = await getCachedProductRecords(address.pubkey, {
        includeStale: true,
        includeMarketHidden: true,
      })
      let directReadDegraded = false
      let directReadCapped = false
      const direct = await fetchPublicProductRecords({
        authors: [address.pubkey],
        dTags: [address.d],
        accountPubkey: query.authenticatedPubkey,
        authenticatedPubkey: query.authenticatedPubkey,
        shouldContinue: query.shouldContinue,
        extraRelayUrls: address.relayHints,
        deletionCandidates: cached,
        limit: 10,
        onTransportStatus: (degraded, capped) => {
          directReadDegraded ||= degraded
          directReadCapped ||= capped
        },
      })
      const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
        address.pubkey
      )
      const locallyVisibleDirect = filterDeletedProductRecords(
        direct,
        localDeletionTimestamps
      )
      const locallyMerged = mergeCachedAndLiveProductRecords({
        cached,
        live: locallyVisibleDirect,
        deletionTimestamps: localDeletionTimestamps,
      })
      const targetCandidate =
        locallyMerged.find((item) => item.addressId === addressId) ?? null
      const groupRead = targetCandidate
        ? await fetchVariationGroupRecords(
            targetCandidate,
            query.authenticatedPubkey,
            query.authenticatedPubkey,
            query.shouldContinue,
            address.relayHints
          )
        : { records: [], degraded: false, capped: false }
      const relayDeletionTimestamps =
        await fetchDeletionTimestampsForProductRecords(
          [...cached, ...direct, ...groupRead.records],
          [address.pubkey],
          query.authenticatedPubkey,
          query.authenticatedPubkey,
          query.shouldContinue
        )
      const deletionTimestamps = mergeDeletionTimestamps(
        relayDeletionTimestamps,
        localDeletionTimestamps
      )
      const directVisible = filterDeletedProductRecords(
        direct,
        deletionTimestamps
      )
      const groupVisible = filterDeletedProductRecords(
        groupRead.records,
        deletionTimestamps
      )
      const merged = mergeCachedAndLiveProductRecords({
        cached,
        live: [...directVisible, ...groupVisible],
        deletionTimestamps,
      })
      await cacheProductRecords(merged)
      const record = findProductDetailRecord(
        now,
        merged,
        [addressId],
        query.includeMarketHidden
      )
      if (record) {
        const selectedDirectTarget = merged.find(
          (candidate) => candidate.addressId === addressId
        )
        const hasLiveDirectTarget =
          !!selectedDirectTarget &&
          directVisible.some(
            (candidate) =>
              candidate.addressId === addressId &&
              candidate.eventId === selectedDirectTarget.eventId
          )
        const hasCompleteGroupCoverage =
          record.product.type === "simple"
            ? true
            : !!targetCandidate &&
              hasCompleteLiveVariationGroupCoverage({
                target: targetCandidate,
                groupRead: { ...groupRead, records: groupVisible },
                knownRecords: filterDeletedProductRecords(
                  cached,
                  deletionTimestamps
                ),
                directRecords: directVisible,
              })
        const completeLiveRead =
          hasLiveDirectTarget &&
          !directReadDegraded &&
          !directReadCapped &&
          hasCompleteGroupCoverage
        const hasLiveEvidence =
          directVisible.length > 0 || groupVisible.length > 0
        const meta = hasLiveEvidence
          ? createMeta("commerce", {
              stale: !completeLiveRead,
              degraded: !completeLiveRead,
              capped: groupRead.capped || directReadCapped,
            })
          : createMeta("local_cache", {
              stale: true,
              degraded: true,
            })
        return {
          data: withProductFamilyRecordReadEvidence(record, meta),
          meta,
        }
      }

      const storefront = await getMerchantStorefront({
        merchantPubkey: address.pubkey,
        includeMarketHidden: query.includeMarketHidden,
        accountPubkey: query.authenticatedPubkey,
        authenticatedPubkey: query.authenticatedPubkey,
        shouldContinue: query.shouldContinue,
      })
      const fallbackRecord =
        storefront.data.find(
          (item) =>
            item.addressId === addressId ||
            item.family?.children.some(
              (variation) => variation.product.id === addressId
            )
        ) ?? null
      const meta = { ...storefront.meta, fetchedAt: now() }
      return {
        data: withProductFamilyRecordReadEvidence(fallbackRecord, meta),
        meta,
      }
    }

    if (/^[0-9a-f]{64}$/i.test(decodedId)) {
      const cached = (
        await getCachedProductRecords(undefined, {
          includeStale: true,
          includeMarketHidden: query.includeMarketHidden,
        })
      ).filter(
        (record) =>
          record.eventId === decodedId || record.product.id === decodedId
      )
      let directReadDegraded = false
      let directReadCapped = false
      const records = await fetchPublicProductRecords({
        ids: [decodedId],
        accountPubkey: query.authenticatedPubkey,
        authenticatedPubkey: query.authenticatedPubkey,
        shouldContinue: query.shouldContinue,
        deletionCandidates: cached,
        onTransportStatus: (degraded, capped) => {
          directReadDegraded ||= degraded
          directReadCapped ||= capped
        },
      })
      const target = records[0] ?? null
      const groupRead = target
        ? await fetchVariationGroupRecords(
            target,
            query.authenticatedPubkey,
            query.authenticatedPubkey,
            query.shouldContinue
          )
        : { records: [], degraded: false, capped: false }
      // The direct event is also a member of the family read. Merge repeated
      // observations before tuple validation so one signed child cannot
      // conflict with itself; distinct signed events remain independent.
      const fetchedByEventId = new Map<string, CommerceProductRecord>()
      for (const candidate of [...records, ...groupRead.records]) {
        const existing = fetchedByEventId.get(candidate.eventId)
        fetchedByEventId.set(
          candidate.eventId,
          existing ? mergeProductRecordSources(existing, candidate) : candidate
        )
      }
      const fetched = [...fetchedByEventId.values()]
      const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
        undefined,
        uniqueStrings(fetched.map((record) => record.product.pubkey))
      )
      const relayDeletionTimestamps =
        await fetchDeletionTimestampsForProductRecords(
          fetched,
          undefined,
          query.authenticatedPubkey,
          query.authenticatedPubkey,
          query.shouldContinue
        )
      const deletionTimestamps = mergeDeletionTimestamps(
        relayDeletionTimestamps,
        localDeletionTimestamps
      )
      const visibleRecords = filterDeletedProductRecords(
        fetched,
        deletionTimestamps
      )
      await cacheProductRecords(visibleRecords)
      const record = findProductDetailRecord(
        now,
        visibleRecords,
        [decodedId],
        query.includeMarketHidden
      )
      const meta = createMeta("public", {
        stale: directReadDegraded || directReadCapped || groupRead.degraded,
        degraded: directReadDegraded || directReadCapped || groupRead.degraded,
        capped: directReadCapped || groupRead.capped,
      })
      return {
        data: withProductFamilyRecordReadEvidence(record, meta),
        meta,
      }
    }
  } catch (error) {
    if (query.shouldContinue?.() === false) throw error
    const cached = await getCachedProductRecords(undefined, {
      includeStale: true,
      includeMarketHidden: true,
    })
    const lookupIds = [decodedId, addressId].filter(
      (lookupId): lookupId is string => !!lookupId
    )
    const record = findProductDetailRecord(
      now,
      cached,
      lookupIds,
      query.includeMarketHidden
    )
    if (record) {
      const meta = createMeta("local_cache", { stale: true, degraded: true })
      return {
        data: withProductFamilyRecordReadEvidence(record, meta),
        meta,
      }
    }
    throw error
  }

  const cached = await getCachedProductRecords(undefined, {
    includeStale: true,
    includeMarketHidden: true,
  })
  const lookupIds = [decodedId, addressId].filter(
    (lookupId): lookupId is string => !!lookupId
  )
  const record = findProductDetailRecord(
    now,
    cached,
    lookupIds,
    query.includeMarketHidden
  )
  const meta = createMeta(record ? "local_cache" : "public", {
    stale: !!record,
    degraded: !!record,
  })
  return {
    data: withProductFamilyRecordReadEvidence(record, meta),
    meta,
  }
}

export async function getCachedProductDetail(
  query: ProductDetailQuery,
  options: CachedProductReadOptions = { includeStale: true },
  dependencies: Pick<ProductDetailReadDependencies, "createMeta" | "now">
): Promise<CommerceResult<CommerceProductRecord | null>> {
  const { createMeta, now } = dependencies

  const { decodedId, addressId } = getProductLookupIds(query.productId)
  const cached = await getCachedProductRecords(undefined, {
    ...options,
    includeMarketHidden: true,
  })
  const lookupIds = [decodedId, addressId].filter(
    (lookupId): lookupId is string => !!lookupId
  )
  const record = findProductDetailRecord(
    now,
    cached,
    lookupIds,
    query.includeMarketHidden
  )

  const meta = createMeta(record ? "local_cache" : "public", {
    stale: !!record,
    degraded: !!record,
  })
  return {
    data: withProductFamilyRecordReadEvidence(record, meta),
    meta,
  }
}

export async function getCachedProductsByIds(
  productIds: readonly string[],
  options: CachedProductReadOptions = { includeStale: true },
  dependencies: Pick<ProductDetailReadDependencies, "createMeta" | "now">
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const { createMeta, now } = dependencies

  const lookups = productIds.map(getProductLookupIds)
  const authors = uniqueStrings(
    lookups.flatMap(({ address }) =>
      address?.kind === EVENT_KINDS.PRODUCT ? [address.pubkey] : []
    )
  )
  const cached =
    authors.length > 0
      ? await getCachedProductRecords(
          undefined,
          { ...options, includeMarketHidden: true },
          authors
        )
      : []
  const prepared = filterProductRecordsForRead(
    cached,
    {
      includeMarketHidden: options.includeMarketHidden,
      groupVariations: true,
    },
    now
  )
  const records = new Map<string, CommerceProductRecord>()
  for (const { decodedId, addressId } of lookups) {
    const record = findProductDetailRecord(
      now,
      cached,
      [decodedId, addressId].filter((id): id is string => !!id),
      options.includeMarketHidden,
      prepared
    )
    if (record) records.set(record.addressId, record)
  }
  const meta = createMeta("local_cache", {
    stale: true,
    degraded: true,
  })
  return {
    data: [...records.values()].map((record) =>
      withProductFamilyRecordReadEvidence(record, meta)!
    ),
    meta,
  }
}
