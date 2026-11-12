import { compareCommercePrices } from "../pricing"
import type { Product } from "../types"
import { EVENT_KINDS } from "./kinds"
import { NostrSignerError } from "./nostr-event-signer"
import { canonicalizeProductTags } from "./products"
import type { PublicReadScope } from "./public-feed-read-scope"
import {
  filterProductRecordsForRead,
  filterExactProductRecordsForRead,
  selectLatestProductRecordsByAddress,
  getVariationParentAddress,
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
  getCachedExactProductRecords,
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
  ProductsByIdsOptions,
  ProductsByIdsResult,
} from "./commerce"

/** Existing transport and facade metadata remain composed by commerce.ts. */
export interface StorefrontReadDependencies {
  readonly fetchPublicProductRecords: (query: {
    readScope?: PublicReadScope
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
    readScope?: PublicReadScope
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
    relayHints?: readonly string[],
    readScope?: PublicReadScope
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
    shouldContinue?: () => boolean,
    readScope?: PublicReadScope
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
      readScope: query.readScope,
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
        readScope: query.readScope,
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
            address.relayHints,
            query.readScope
          )
        : { records: [], degraded: false, capped: false }
      const relayDeletionTimestamps =
        await fetchDeletionTimestampsForProductRecords(
          [...cached, ...direct, ...groupRead.records],
          [address.pubkey],
          query.authenticatedPubkey,
          query.authenticatedPubkey,
          query.shouldContinue,
          query.readScope
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
        readScope: query.readScope,
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
        readScope: query.readScope,
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
            query.shouldContinue,
            undefined,
            query.readScope
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
          query.shouldContinue,
          query.readScope
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

interface MarketplacePublicReadQuery {
  readScope?: PublicReadScope
  retainRevisions?: boolean
  authors?: string[]
  deletionCandidates?: CommerceProductRecord[]
  authenticatedPubkey?: string | null
  accountPubkey?: string | null
  signal?: AbortSignal
  shouldContinue?: () => boolean
  searchText?: string
  limit?: number
  readPolicy?: CommerceReadPolicy
  onTransportStatus?: (degraded: boolean, capped: boolean) => void
  onReadCoverage?: (coverage: "complete" | "partial" | "unavailable") => void
  localDeletionEvidenceOnly?: boolean
}
/** Transport and exact-read authority remain composed by the commerce facade. */
export interface MarketplaceReadDependencies {
  readonly fetchPublicProductRecords: (
    query: MarketplacePublicReadQuery
  ) => Promise<CommerceProductRecord[]>
  readonly fetchPublicProductRecordsProgressive: (
    query: MarketplacePublicReadQuery,
    onRecords: (
      records: CommerceProductRecord[],
      relayUrl: string
    ) => void | Promise<void>
  ) => Promise<CommerceProductRecord[]>
  readonly mergeCachedAndLiveProductRecords: StorefrontReadDependencies["mergeCachedAndLiveProductRecords"]
  readonly readProductsByIds: (
    ids: string[],
    options: ProductsByIdsOptions,
    verifiedRecords?: readonly CommerceProductRecord[]
  ) => Promise<ProductsByIdsResult>
  readonly createMeta: (
    source: CommerceReadSource,
    options?: Partial<CommerceFreshnessMeta>,
    sortModes?: CommerceSortMode[]
  ) => CommerceQueryMeta
  readonly getSearchRelayUrls: () => string[]
  readonly rethrowProductReadAuthorityChange: (
    error: unknown,
    shouldContinue?: () => boolean
  ) => void
  readonly now: () => number
}

/** Ranked discovery is independent of a broad catalog sweep. Only the returned
 * coordinates and their family context can survive into this response. */
function projectRankedProductSearch(
  now: () => number,
  hits: CommerceProductRecord[],
  records: CommerceProductRecord[],
  query: MarketplaceProductsQuery
): CommerceProductRecord[] {
  records = [...selectLatestProductRecordsByAddress(records).values()]
  const wanted = new Set(hits.map((record) => record.addressId))
  const byAddress = new Map(records.map((record) => [record.addressId, record]))
  const eligible = new Set(
    filterExactProductRecordsForRead(records, wanted, {}, now).map(
      (record) => record.addressId
    )
  )
  const ranks = new Map<string, number>()
  const matchesQuery = createProductQueryMatcher({
    ...query,
    textQuery: undefined,
  })
  hits.forEach((hit, index) => {
    const current = byAddress.get(hit.addressId)
    if (!current || !eligible.has(current.addressId)) return
    const address = getVariationParentAddress(current) ?? current.addressId
    if (!ranks.has(address)) ranks.set(address, index)
  })
  return applyProductLimit(
    filterProductRecordsForRead(records, {}, now)
      .filter((record) => ranks.has(record.addressId) && matchesQuery(record))
      .sort(
        (left, right) =>
          ranks.get(left.addressId)! - ranks.get(right.addressId)!
      ),
    query.limit
  )
}

async function getRankedMarketplaceProducts(
  query: MarketplaceProductsQuery,
  dependencies: MarketplaceReadDependencies
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const {
    fetchPublicProductRecords,
    mergeCachedAndLiveProductRecords,
    readProductsByIds,
    createMeta,
    getSearchRelayUrls,
    now,
  } = dependencies

  const assertCurrent = () => {
    query.signal?.throwIfAborted()
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
  }
  assertCurrent()
  const authors = query.merchantPubkey
    ? [query.merchantPubkey]
    : query.authorPubkeys
  const allowedAuthors = authors ? new Set(authors) : null
  const transport: { coverage: "complete" | "partial" | "unavailable" } = {
    coverage: "unavailable",
  }
  let capped = false
  // Keep relay capabilities minimal. Perspective/merchant/category eligibility
  // is a client filter of this one ranked response, never independently ranked chunks.
  const hits = (
    await fetchPublicProductRecords({
      readScope: query.readScope,
      searchText: query.textQuery!.trim(),
      accountPubkey: query.accountPubkey,
      authenticatedPubkey: query.authenticatedPubkey,
      signal: query.signal,
      shouldContinue: query.shouldContinue,
      limit: 100,
      localDeletionEvidenceOnly: true,
      readPolicy: {
        maxRelays: 1,
        connectTimeoutMs: 2_000,
        fetchTimeoutMs: 3_000,
      },
      onTransportStatus: (_, value) => {
        capped = value
      },
      onReadCoverage: (value) => {
        transport.coverage = value
      },
    })
  ).filter(
    (record) =>
      record.dTag !== null &&
      (!allowedAuthors || allowedAuthors.has(record.product.pubkey))
  )
  assertCurrent()
  if (transport.coverage === "unavailable")
    throw new Error("Product search is unavailable")
  const wanted = hits.map((record) => record.addressId)
  const cached = await getCachedExactProductRecords(wanted, hits).catch(
    () => []
  )
  assertCurrent()
  const deletions = await getLocalProductDeletionTimestamps(
    undefined,
    uniqueStrings(hits.map((record) => record.product.pubkey))
  )
  const initialRecords = mergeCachedAndLiveProductRecords({
    cached,
    live: hits,
    deletionTimestamps: deletions,
  })
  const resultFor = (
    records: CommerceProductRecord[],
    refreshing: boolean,
    refreshMeta?: CommerceQueryMeta
  ): CommerceResult<CommerceProductRecord[]> => {
    const partial =
      capped ||
      !!allowedAuthors ||
      !!query.tags?.length ||
      transport.coverage !== "complete"
    const meta = createMeta(
      "public",
      {
        stale: refreshing || !!refreshMeta?.stale,
        degraded: partial || refreshing || !!refreshMeta?.degraded,
        capped: capped || !!refreshMeta?.capped,
      },
      []
    )
    meta.productSearch = {
      coverage: partial ? "partial" : transport.coverage,
      tagScopeVerified: !query.tags?.length,
      relayUrls: getSearchRelayUrls(),
    }
    return {
      data: withProductFamilyReadEvidence(
        projectRankedProductSearch(now, hits, records, query),
        meta
      ),
      meta,
    }
  }
  assertCurrent()
  const initial = resultFor(initialRecords, wanted.length > 0)
  query.onProgress?.(initial)
  assertCurrent()
  if (wanted.length === 0) return initial
  // Seed the existing exact-product reader with verified discovery evidence.
  // Cards have already painted; revisions/deletions/family context arrive lazily.
  try {
    await cacheProductRecords(initialRecords)
  } catch {
    // A failed seed write must not prevent live revision/deletion reads.
  }
  assertCurrent()
  const project = (snapshot: ProductsByIdsResult) =>
    resultFor(
      snapshot.data.flatMap(
        (record) =>
          record.exactReadContext?.records ?? [
            record,
            ...(record.family
              ? [record.family.parent, ...record.family.children]
              : []),
          ]
      ),
      !!snapshot.meta.stale,
      snapshot.meta
    )
  try {
    const refreshed = await readProductsByIds(
      wanted,
      {
        readScope: query.readScope,
        accountPubkey: query.accountPubkey,
        authenticatedPubkey: query.authenticatedPubkey,
        signal: query.signal,
        shouldContinue: () =>
          !query.signal?.aborted && query.shouldContinue?.() !== false,
        relayHintsByAddressId: Object.fromEntries(
          hits.map((record) => [record.addressId, record.sourceRelayUrls])
        ),
        onProgress: query.onProgress
          ? (snapshot) => {
              assertCurrent()
              query.onProgress?.(project(snapshot))
            }
          : undefined,
      },
      initialRecords
    )
    assertCurrent()
    return project(refreshed)
  } catch {
    assertCurrent()
    return initial
  }
}

export async function getMarketplaceProducts(
  query: MarketplaceProductsQuery = {},
  dependencies: MarketplaceReadDependencies
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const {
    fetchPublicProductRecords,
    mergeCachedAndLiveProductRecords,
    createMeta,
    now,
  } = dependencies

  if (
    !query.merchantPubkey &&
    query.authorPubkeys &&
    query.authorPubkeys.length === 0
  ) {
    return {
      data: [],
      meta: {
        ...createMeta("public"),
        ...(query.searchIndex && query.textQuery?.trim()
          ? {
              productSearch: {
                coverage: "complete" as const,
                relayUrls: [],
                tagScopeVerified: true,
              },
            }
          : {}),
      },
    }
  }

  if (query.searchIndex && query.textQuery?.trim()) {
    return getRankedMarketplaceProducts(query, dependencies)
  }

  try {
    query.signal?.throwIfAborted()
    const authorPubkeys = query.merchantPubkey
      ? [query.merchantPubkey]
      : query.authorPubkeys
    const cached = await getCachedProductRecords(
      query.merchantPubkey,
      { includeStale: true, includeMarketHidden: true },
      query.authorPubkeys
    )
    const rawEventLimit = getProductRawEventLimit(query.limit)
    let transportDegraded = false
    let readCapped = false
    const fetchedRecords = await fetchPublicProductRecords({
      readScope: query.readScope,
      retainRevisions: true,
      authors: authorPubkeys ? uniqueStrings(authorPubkeys) : undefined,
      authenticatedPubkey: query.authenticatedPubkey,
      accountPubkey: query.accountPubkey,
      signal: query.signal,
      shouldContinue: query.shouldContinue,
      deletionCandidates: cached,
      limit: rawEventLimit,
      readPolicy: query.readPolicy,
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    })
    query.signal?.throwIfAborted()
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const deletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey,
      query.authorPubkeys
    )
    query.signal?.throwIfAborted()
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const records = mergeCachedAndLiveProductRecords({
      cached,
      live: fetchedRecords,
      deletionTimestamps,
    })
    await cacheProductRecords(records)
    query.signal?.throwIfAborted()
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")

    const finalDeletionTimestamps = await getLocalProductDeletionTimestamps(
      query.merchantPubkey,
      query.authorPubkeys
    )
    query.signal?.throwIfAborted()
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const currentRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: fetchedRecords,
      deletionTimestamps: finalDeletionTimestamps,
    })
    const filtered = applyProductLimit(
      sortProducts(
        filterProductRecordsForRead(currentRecords, {}, now).filter(
          createProductQueryMatcher(query)
        ),
        query.sort
      ),
      query.limit
    )

    const meta = createMeta("public", {
      capped: readCapped || fetchedRecords.length >= rawEventLimit,
      degraded:
        transportDegraded ||
        readCapped ||
        fetchedRecords.length >= rawEventLimit,
    })
    return { data: withProductFamilyReadEvidence(filtered, meta), meta }
  } catch (error) {
    if (query.signal?.aborted || query.shouldContinue?.() === false) throw error
    const cached = applyProductLimit(
      sortProducts(
        filterProductRecordsForRead(
          await getCachedProductRecords(
            query.merchantPubkey,
            { includeStale: true, includeMarketHidden: true },
            query.authorPubkeys
          ),
          {},
          now
        ).filter(createProductQueryMatcher(query)),
        query.sort
      ),
      query.limit
    )

    if (cached.length > 0) {
      const meta = createMeta("local_cache", { stale: true, degraded: true })
      return { data: withProductFamilyReadEvidence(cached, meta), meta }
    }

    throw error
  }
}

export async function getMarketplaceProductsProgressive(
  query: MarketplaceProductsQuery = {},
  onProgress: (
    result: CommerceResult<CommerceProductRecord[]>,
    relayUrl: string
  ) => void,
  dependencies: MarketplaceReadDependencies
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const {
    fetchPublicProductRecordsProgressive,
    mergeCachedAndLiveProductRecords,
    rethrowProductReadAuthorityChange,
    createMeta,
    now,
  } = dependencies

  query.signal?.throwIfAborted()
  if (
    !query.merchantPubkey &&
    query.authorPubkeys &&
    query.authorPubkeys.length === 0
  ) {
    const empty = {
      data: [],
      meta: createMeta("public"),
    }
    onProgress(empty, "none")
    return empty
  }

  const authorPubkeys = query.merchantPubkey
    ? [query.merchantPubkey]
    : query.authorPubkeys
  const limit = query.limit
  const cached = await getCachedProductRecords(
    query.merchantPubkey,
    { includeStale: true, includeMarketHidden: true },
    query.authorPubkeys
  )
  const rawEventLimit = getProductRawEventLimit(limit)
  let transportDegraded = false
  let readCapped = false
  const localDeletionTimestamps = await getLocalProductDeletionTimestamps(
    query.merchantPubkey,
    query.authorPubkeys
  )
  const matchesQuery = createProductQueryMatcher(query)
  const toResult = (
    records: CommerceProductRecord[],
    options: { degraded?: boolean; capped?: boolean } = {},
    deletionTimestamps: DeletionTimestamps = localDeletionTimestamps
  ) => {
    const filteredRecords = mergeCachedAndLiveProductRecords({
      cached,
      live: records,
      deletionTimestamps,
    })
    const data = applyProductLimit(
      sortProducts(
        filterProductRecordsForRead(filteredRecords, {}, now).filter(
          matchesQuery
        ),
        query.sort
      ),
      limit
    )
    const meta = createMeta("public", {
      capped: (options.capped ?? readCapped) || records.length >= rawEventLimit,
      degraded:
        (options.degraded ?? readCapped) || records.length >= rawEventLimit,
    })
    return { data: withProductFamilyReadEvidence(data, meta), meta }
  }

  // Persist validated public revisions as they arrive. Leaving the page must
  // not discard every batch just because another relay or deletion read waits.
  // Writes remain serialized and use the existing monotonic cache/tombstones.
  const persistedSignatures = new Map<string, string>()
  let progressiveCacheWrite = Promise.resolve()
  let progressiveCacheFailed = false
  const persistProgress = (records: CommerceProductRecord[]) => {
    progressiveCacheWrite = progressiveCacheWrite.then(async () => {
      query.signal?.throwIfAborted()
      if (query.shouldContinue?.() === false)
        throw new NostrSignerError("authority_changed")
      const changed = records.filter((record) => {
        const signature = JSON.stringify([
          record.eventId,
          record.sourceRelayUrls ?? [],
        ])
        return persistedSignatures.get(record.eventId) !== signature
      })
      try {
        await cacheProductRecords(changed)
        for (const record of changed) {
          persistedSignatures.set(
            record.eventId,
            JSON.stringify([record.eventId, record.sourceRelayUrls ?? []])
          )
        }
      } catch (error) {
        rethrowProductReadAuthorityChange(error, query.shouldContinue)
        // Final persistence retries the full frontier. Interim write failure
        // marks coverage degraded rather than stopping deletion reconciliation.
        progressiveCacheFailed = true
      }
    })
    return progressiveCacheWrite
  }

  const liveRecords = new Map<string, CommerceProductRecord>()
  const publishProgress = async (
    records: CommerceProductRecord[],
    relayUrl: string
  ): Promise<void> => {
    for (const record of records) {
      liveRecords.set(record.eventId, record)
    }
    await persistProgress(records)
    query.signal?.throwIfAborted()
    if (query.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const currentDeletions = await getLocalProductDeletionTimestamps(
      query.merchantPubkey,
      query.authorPubkeys
    )
    query.signal?.throwIfAborted()
    // Until every planned relay settles, this snapshot remains incomplete.
    onProgress(
      toResult(
        Array.from(liveRecords.values()),
        { degraded: true, capped: readCapped },
        currentDeletions
      ),
      relayUrl
    )
  }

  const fetchedRecords = await fetchPublicProductRecordsProgressive(
    {
      readScope: query.readScope,
      retainRevisions: true,
      authors:
        authorPubkeys && authorPubkeys.length > 0
          ? uniqueStrings(authorPubkeys)
          : undefined,
      authenticatedPubkey: query.authenticatedPubkey,
      accountPubkey: query.accountPubkey,
      shouldContinue: query.shouldContinue,
      signal: query.signal,
      deletionCandidates: cached,
      limit: rawEventLimit,
      readPolicy: query.readPolicy,
      onTransportStatus: (degraded, capped) => {
        transportDegraded ||= degraded
        readCapped ||= capped
      },
    },
    publishProgress
  )

  query.signal?.throwIfAborted()
  const currentDeletionTimestamps = await getLocalProductDeletionTimestamps(
    query.merchantPubkey,
    query.authorPubkeys
  )
  const records = mergeCachedAndLiveProductRecords({
    cached,
    live: fetchedRecords,
    deletionTimestamps: currentDeletionTimestamps,
  })
  // Final resolution must follow writes that can yield to a new deletion. A
  // failed cache write still needs to retract the previous progressive paint;
  // preserve its rejection after delivering the resolved snapshot.
  let cacheFailure: { reason: unknown } | undefined
  try {
    await cacheProductRecords(records)
    progressiveCacheFailed = false
  } catch (reason) {
    cacheFailure = { reason }
  }
  query.signal?.throwIfAborted()
  const finalDeletionTimestamps = await getLocalProductDeletionTimestamps(
    query.merchantPubkey,
    query.authorPubkeys
  )
  const result = toResult(
    fetchedRecords,
    {
      degraded:
        transportDegraded ||
        progressiveCacheFailed ||
        readCapped ||
        fetchedRecords.length >= rawEventLimit,
      capped: readCapped || fetchedRecords.length >= rawEventLimit,
    },
    finalDeletionTimestamps
  )
  query.signal?.throwIfAborted()
  if (query.shouldContinue?.() === false)
    throw new NostrSignerError("authority_changed")
  onProgress(result, "deletion-frontier")
  if (cacheFailure) throw cacheFailure.reason
  return result
}

export async function getCachedMarketplaceProducts(
  query: MarketplaceProductsQuery = {},
  options: CachedProductReadOptions = { includeStale: true },
  dependencies: MarketplaceReadDependencies
): Promise<CommerceResult<CommerceProductRecord[]>> {
  const { createMeta, now } = dependencies

  if (
    !query.merchantPubkey &&
    query.authorPubkeys &&
    query.authorPubkeys.length === 0
  ) {
    return {
      data: [],
      meta: createMeta("local_cache", {
        stale: true,
      }),
    }
  }

  const cached = applyProductLimit(
    sortProducts(
      filterProductRecordsForRead(
        await getCachedProductRecords(
          query.merchantPubkey,
          { ...options, includeMarketHidden: true },
          query.authorPubkeys
        ),
        {},
        now
      ).filter(createProductQueryMatcher(query)),
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
