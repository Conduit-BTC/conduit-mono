import { compareCommercePrices } from "../pricing"
import type { Product } from "../types"
import { NostrSignerError } from "./nostr-event-signer"
import { canonicalizeProductTags } from "./products"
import {
  filterProductRecordsForRead,
  withProductFamilyReadEvidence,
  type CommerceProductRecord,
} from "./commerce-product-selection"
import {
  cacheProductRecords,
  getCachedProductRecords,
  getLocalProductDeletionTimestamps,
  type CachedProductReadOptions,
  type DeletionTimestamps,
} from "./commerce-product-cache"
import type {
  CommerceFreshnessMeta,
  CommerceQueryMeta,
  CommerceReadPolicy,
  CommerceResult,
  CommerceSortMode,
  MarketplaceProductsQuery,
  MerchantStorefrontQuery,
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
