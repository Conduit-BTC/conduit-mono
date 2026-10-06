import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type CommerceProductRecord,
  type CommerceQueryMeta,
  type CommerceReadPolicy,
  type CommerceResult,
  extractFollowPubkeys,
  type FollowListResult,
  getFollowPubkeys,
  getCachedMarketplaceProducts,
  getCachedMerchantStorefront,
  getCachedProductDetail,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getMerchantStorefront,
  getProductDetail,
  isListingMarketVisible,
  normalizePubkey,
  peekRetainedOwnFollowListSnapshot,
  readRetainedOwnFollowListSnapshot,
  subscribeToProductCacheChanges,
  type ListingAvailabilityEvaluation,
  type PreparedProductFamily,
  type Product,
  useAuth,
  useConduitSession,
} from "@conduit/core"
import {
  DEFAULT_MARKET_CATALOG_SOURCE,
  getCatalogAuthorKey,
  getCatalogAuthorPubkeys,
  getProductCatalogQueryKey,
  isProductDiscoveryReadIncomplete,
  isPerspectiveMarketplaceRead,
  refreshProductCatalogSources,
  retainedFollowSnapshotSupersedesLive,
  resolvePerspectiveAuthorPubkeys,
  type PerspectiveAuthorSource,
  type ProductCatalogSourceMode,
  type ProductCatalogReadInput,
} from "../lib/productCatalogRead"
import { MARKET_MERCHANT_PUBKEYS } from "../lib/marketMerchants"
import { getProductSourceRelayHintsByPubkey } from "../lib/clientHydration"
import {
  createProgressiveCatalogQuery,
  hasAuthoritativeQuerySnapshot,
  selectProgressiveProductFrontier,
} from "../lib/progressiveProductFrontier"

// One bounded progressive pass paints from cumulative callbacks while retaining
// the wider catalog coverage previously reserved for a second full scan.
const CATALOG_COMPLETION_READ_POLICY: CommerceReadPolicy = {
  maxRelays: 12,
  connectTimeoutMs: 4_000,
  fetchTimeoutMs: 8_000,
}
const STOREFRONT_DELETION_READ_POLICY: CommerceReadPolicy = {
  maxRelays: 8,
  connectTimeoutMs: 800,
  fetchTimeoutMs: 1_200,
}
type SortOption = "newest" | "price_asc" | "price_desc"

type ProgressiveListQuery =
  | {
      scope: "marketplace"
      catalogSource?: ProductCatalogSourceMode
      merchantPubkey?: string
      perspectivePubkey?: string | null
      authenticatedPubkey?: string | null
      /** Signed-in account used only for final-I/O whole-relay exclusions. */
      accountPubkey?: string | null
      seedAuthorPubkeys?: string[]
      textQuery?: string
      tags?: string[]
      sort?: SortOption
      limit?: number
      enabled?: boolean
      /** Resolve scope/cache while a ranked search owns product network reads. */
      networkEnabled?: boolean
      /** Resolve scope without preparing display products for selector metadata. */
      cacheEnabled?: boolean
    }
  | {
      scope: "storefront"
      merchantPubkey: string
      authenticatedPubkey?: string | null
      /** Signed-in account used only for final-I/O whole-relay exclusions. */
      accountPubkey?: string | null
      textQuery?: string
      tag?: string
      sort?: SortOption
      limit?: number
      enabled?: boolean
    }

export interface ProgressiveProductsResult {
  products: Product[]
  /** Retained cache records preserve signed metadata for local reconciliation. */
  cachedProductRecords: CommerceProductRecord[]
  familiesByProductId: Record<
    string,
    PreparedProductFamily<CommerceProductRecord>
  >
  meta: CommerceQueryMeta | null
  profileRelayHintsByPubkey: Record<string, string[]>
  /** Resolved author boundary for this catalog; undefined while unresolved. */
  catalogAuthorPubkeys: string[] | undefined
  cachedCount: number
  networkCount: number
  firstDegreeAuthorCount: number
  fallbackAuthorCount: number
  authorSource: PerspectiveAuthorSource
  catalogSource: ProductCatalogSourceMode
  followLookupStatus: "idle" | "loading" | "ready" | "error"
  hydrationStage: "cache" | "resolving_follows" | "first_degree"
  isInitialLoading: boolean
  isHydrating: boolean
  isRefreshPaused: boolean
  isShowingCache: boolean
  discoveryStale: boolean
  error: unknown
  refetch: () => Promise<void>
}

function toProducts(
  result: CommerceResult<CommerceProductRecord[]> | undefined
): Product[] {
  return result?.data.map((record) => record.product) ?? []
}

function getFamiliesByProductId(
  ...results: Array<CommerceResult<CommerceProductRecord[]> | undefined>
): Record<string, PreparedProductFamily<CommerceProductRecord>> {
  const families: Record<
    string,
    PreparedProductFamily<CommerceProductRecord>
  > = {}
  for (const result of results) {
    for (const record of result?.data ?? []) {
      if (record.family) families[record.product.id] = record.family
    }
  }
  return families
}

function dedupeProducts(products: Product[]): Product[] {
  const byId = new Map<string, Product>()
  for (const product of products) {
    if (!byId.has(product.id)) byId.set(product.id, product)
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt)
}

function uniquePubkeys(pubkeys: readonly string[]): string[] {
  return Array.from(
    new Set(pubkeys.map(normalizePubkey).filter(Boolean) as string[])
  )
}

async function fetchCachedList(
  input: ProgressiveListQuery,
  authorPubkeys?: string[]
) {
  if (input.scope === "marketplace") {
    const readsPerspectiveCatalog = isPerspectiveMarketplaceRead(input)

    return await getCachedMarketplaceProducts({
      merchantPubkey: input.merchantPubkey,
      authorPubkeys,
      textQuery: readsPerspectiveCatalog ? undefined : input.textQuery,
      tags: readsPerspectiveCatalog ? undefined : input.tags,
      sort: readsPerspectiveCatalog ? "newest" : input.sort,
      limit: input.limit,
    })
  }

  return await getCachedMerchantStorefront({
    merchantPubkey: input.merchantPubkey,
    textQuery: input.textQuery,
    tag: input.tag,
    sort: input.sort,
    limit: input.limit,
  })
}

async function fetchNetworkList(
  input: ProgressiveListQuery,
  authorPubkeys?: string[],
  readPolicy?: CommerceReadPolicy,
  shouldContinue?: () => boolean
) {
  if (input.scope === "marketplace") {
    const readsPerspectiveCatalog = isPerspectiveMarketplaceRead(input)

    return await getMarketplaceProducts({
      merchantPubkey: input.merchantPubkey,
      authorPubkeys,
      authenticatedPubkey: input.authenticatedPubkey,
      accountPubkey: input.accountPubkey,
      shouldContinue,
      textQuery: readsPerspectiveCatalog ? undefined : input.textQuery,
      tags: readsPerspectiveCatalog ? undefined : input.tags,
      sort: readsPerspectiveCatalog ? "newest" : input.sort,
      limit: input.limit,
      readPolicy,
    })
  }

  return await getMerchantStorefront({
    merchantPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    accountPubkey: input.accountPubkey,
    shouldContinue,
    textQuery: input.textQuery,
    tag: input.tag,
    sort: input.sort,
    limit: input.limit,
    deletionReadPolicy: STOREFRONT_DELETION_READ_POLICY,
    deletionFallbackWhenEmpty: false,
  })
}

export function useProgressiveProducts(
  input: ProgressiveListQuery
): ProgressiveProductsResult {
  const { authGeneration } = useAuth()
  const session = useConduitSession()
  const queryClient = useQueryClient()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const queryEnabled = input.enabled ?? true
  const perspectiveMarketplaceRead = isPerspectiveMarketplaceRead(input)
  const catalogSource: ProductCatalogSourceMode =
    input.scope === "marketplace"
      ? (input.catalogSource ?? DEFAULT_MARKET_CATALOG_SOURCE)
      : "following"
  const perspectivePubkey =
    input.scope === "marketplace" && !input.merchantPubkey
      ? normalizePubkey(input.perspectivePubkey)
      : null
  const authenticatedPubkey = normalizePubkey(input.authenticatedPubkey)
  const finalIoAccountPubkey = normalizePubkey(
    input.accountPubkey ?? input.authenticatedPubkey
  )
  const usesPerspectiveGraph =
    input.scope === "marketplace" && !!perspectivePubkey
  const firstDegreeDiscoveryEnabled =
    queryEnabled && usesPerspectiveGraph && catalogSource !== "conduit"
  const networkEnabled =
    input.scope !== "marketplace" || input.networkEnabled !== false
  const streamsNetwork =
    queryEnabled && networkEnabled && input.scope === "marketplace"
  const rawSeedAuthorPubkeys =
    input.scope === "marketplace"
      ? (input.seedAuthorPubkeys ??
        (catalogSource === "conduit" ? MARKET_MERCHANT_PUBKEYS : undefined))
      : undefined
  const seededAuthors = useMemo(
    () =>
      rawSeedAuthorPubkeys?.length
        ? uniquePubkeys(rawSeedAuthorPubkeys)
        : undefined,
    [rawSeedAuthorPubkeys]
  )
  const retainedFirstDegreeDiscoveryEnabled =
    firstDegreeDiscoveryEnabled &&
    perspectivePubkey === authenticatedPubkey &&
    !seededAuthors
  const firstDegreeQuery = useQuery({
    queryKey: [
      "market-perspective-follows",
      perspectivePubkey,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      getFollowPubkeys({
        pubkey: perspectivePubkey!,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled: firstDegreeDiscoveryEnabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const data = query.state.data as FollowListResult | undefined
      return data && !data.meta.eventObserved ? 5_000 : false
    },
  })
  const retainedFirstDegreeQuery = useQuery({
    queryKey: [
      "market-perspective-follows",
      "retained",
      perspectivePubkey,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      readRetainedOwnFollowListSnapshot(perspectivePubkey!, { signal }),
    enabled: retainedFirstDegreeDiscoveryEnabled,
    initialData: () =>
      retainedFirstDegreeDiscoveryEnabled
        ? peekRetainedOwnFollowListSnapshot(perspectivePubkey!)
        : undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  const retainedFirstDegreeSnapshot = useMemo(
    () =>
      (retainedFirstDegreeDiscoveryEnabled
        ? peekRetainedOwnFollowListSnapshot(perspectivePubkey!)
        : undefined) ??
      retainedFirstDegreeQuery.data ??
      undefined,
    [
      perspectivePubkey,
      retainedFirstDegreeDiscoveryEnabled,
      retainedFirstDegreeQuery.data,
    ]
  )
  const retainedFirstDegreeAuthors = useMemo(
    () =>
      retainedFirstDegreeSnapshot
        ? extractFollowPubkeys(retainedFirstDegreeSnapshot.event.tags)
        : undefined,
    [retainedFirstDegreeSnapshot]
  )

  const fallbackPerspectiveAuthors = useMemo(
    () =>
      usesPerspectiveGraph && !seededAuthors
        ? MARKET_MERCHANT_PUBKEYS
        : undefined,
    [seededAuthors, usesPerspectiveGraph]
  )
  const resolveFirstDegreeAuthors = useCallback(
    (result: FollowListResult | undefined, followLookupSettled: boolean) => {
      const retainedSupersedesLive = retainedFollowSnapshotSupersedesLive(
        result?.meta.eventObserved ? result.event : undefined,
        retainedFirstDegreeSnapshot?.event
      )
      return resolvePerspectiveAuthorPubkeys({
        usesPerspectiveGraph,
        sourceMode: catalogSource,
        perspectivePubkey,
        refreshedAuthorPubkeys:
          result?.meta.eventObserved && !retainedSupersedesLive
            ? result.data
            : undefined,
        seedAuthorPubkeys: seededAuthors,
        cachedAuthorPubkeys: retainedFirstDegreeAuthors,
        fallbackAuthorPubkeys: fallbackPerspectiveAuthors,
        followLookupSettled,
      })
    },
    [
      catalogSource,
      fallbackPerspectiveAuthors,
      perspectivePubkey,
      retainedFirstDegreeAuthors,
      retainedFirstDegreeSnapshot,
      seededAuthors,
      usesPerspectiveGraph,
    ]
  )
  const firstDegreeResolution = useMemo(
    () =>
      resolveFirstDegreeAuthors(
        firstDegreeQuery.data,
        firstDegreeQuery.isSuccess ||
          firstDegreeQuery.isError ||
          retainedFirstDegreeSnapshot !== undefined
      ),
    [
      firstDegreeQuery.data,
      firstDegreeQuery.isError,
      firstDegreeQuery.isSuccess,
      retainedFirstDegreeSnapshot,
      resolveFirstDegreeAuthors,
    ]
  )
  const firstDegreeReadIncomplete =
    firstDegreeDiscoveryEnabled &&
    isProductDiscoveryReadIncomplete(firstDegreeQuery.data?.meta)
  const firstDegreeReadUnconfirmed =
    firstDegreeDiscoveryEnabled &&
    firstDegreeQuery.isSuccess &&
    !firstDegreeQuery.data.meta.eventObserved
  const retainedFirstDegreeSupersedesLive =
    retainedFirstDegreeDiscoveryEnabled &&
    retainedFollowSnapshotSupersedesLive(
      firstDegreeQuery.data?.meta.eventObserved
        ? firstDegreeQuery.data.event
        : undefined,
      retainedFirstDegreeSnapshot?.event
    )
  const firstDegreeAuthors = firstDegreeResolution.authorPubkeys
  const usingFallbackPerspective = firstDegreeResolution.source === "fallback"
  const fallbackAuthorCount = fallbackPerspectiveAuthors?.length ?? 0
  const fallbackAuthorSet = useMemo(
    () => new Set(fallbackPerspectiveAuthors ?? []),
    [fallbackPerspectiveAuthors]
  )
  const followLookupStatus = !firstDegreeDiscoveryEnabled
    ? "idle"
    : firstDegreeQuery.isError
      ? "error"
      : firstDegreeQuery.isSuccess
        ? "ready"
        : "loading"

  const personalizedAuthorCount =
    usingFallbackPerspective || catalogSource === "conduit"
      ? 0
      : (firstDegreeAuthors?.filter((pubkey) => !fallbackAuthorSet.has(pubkey))
          .length ?? 0)

  const catalogReady =
    !perspectiveMarketplaceRead || firstDegreeAuthors !== undefined
  const resolvedCatalogAuthorPubkeys =
    getCatalogAuthorPubkeys(firstDegreeAuthors)
  const catalogAuthorKey = getCatalogAuthorKey(resolvedCatalogAuthorPubkeys)
  const catalogAuthorPubkeys = useMemo(() => {
    if (catalogAuthorKey === "unscoped") return undefined
    const encoded = catalogAuthorKey.slice("authors:".length)
    return encoded ? encoded.split(",") : []
  }, [catalogAuthorKey])
  const catalogDiscoveryKey = useMemo(
    () =>
      JSON.stringify([
        ...getProductCatalogQueryKey(
          input as ProductCatalogReadInput,
          "network"
        ),
        catalogAuthorKey,
        finalIoAccountPubkey ?? "guest",
        authenticatedPubkey ?? "guest",
        authGeneration,
        session.relayScope ?? "no-relay-scope",
      ]),
    [
      authGeneration,
      authenticatedPubkey,
      catalogAuthorKey,
      finalIoAccountPubkey,
      input,
      session.relayScope,
    ]
  )
  const catalogTextQuery = perspectiveMarketplaceRead
    ? undefined
    : input.textQuery
  const catalogSort = perspectiveMarketplaceRead ? "newest" : input.sort
  const marketplaceTags =
    input.scope === "marketplace" && !perspectiveMarketplaceRead
      ? input.tags
      : undefined
  const canReadCache =
    queryEnabled &&
    catalogReady &&
    (input.scope !== "marketplace" || input.cacheEnabled !== false)

  const cachedQuery = useQuery({
    queryKey: [
      ...getProductCatalogQueryKey(input as ProductCatalogReadInput, "cache"),
      catalogAuthorKey,
    ],
    queryFn: () => fetchCachedList(input, catalogAuthorPubkeys),
    enabled: canReadCache,
    staleTime: 15_000,
  })

  const refetchCached = cachedQuery.refetch
  useEffect(() => {
    if (input.scope !== "marketplace" || networkEnabled || !canReadCache) return
    // Page catalog reads commit after their progressive callbacks. Observe
    // those local commits, including cart reads, without another relay stream.
    return subscribeToProductCacheChanges({
      onChange: () => void refetchCached(),
      onError: () => void refetchCached(),
    })
  }, [input.scope, networkEnabled, canReadCache, refetchCached])

  const firstNetworkQuery = useQuery({
    queryKey: [
      ...getProductCatalogQueryKey(input as ProductCatalogReadInput, "network"),
      "catalog",
      catalogAuthorKey,
      finalIoAccountPubkey ?? "guest",
    ],
    queryFn: ({ signal }) =>
      fetchNetworkList(
        input,
        catalogAuthorPubkeys,
        undefined,
        () => !signal.aborted && authGenerationRef.current === authGeneration
      ),
    enabled: queryEnabled && networkEnabled && catalogReady && !streamsNetwork,
    staleTime: 20_000,
  })

  // A cache-only consumer must use the refreshed local frontier. A retained
  // sibling network query can still contain a product deleted since that read.
  const hasNetworkResult =
    networkEnabled &&
    !streamsNetwork &&
    hasAuthoritativeQuerySnapshot({
      hasData: firstNetworkQuery.data !== undefined,
      isPlaceholderData: firstNetworkQuery.isPlaceholderData,
    })
  const authoritativeNetworkResult = hasNetworkResult
    ? firstNetworkQuery.data
    : undefined
  const firstProducts = useMemo(
    () => toProducts(authoritativeNetworkResult),
    [authoritativeNetworkResult]
  )
  const mergedNetworkProducts = useMemo(
    () => dedupeProducts(firstProducts),
    [firstProducts]
  )
  const cachedProducts = useMemo(
    () => toProducts(cachedQuery.data),
    [cachedQuery.data]
  )
  const progressiveQueryKey = useMemo(
    () => ["progressive-products", "stream", catalogDiscoveryKey] as const,
    [catalogDiscoveryKey]
  )
  const progressiveQuery = useQuery({
    queryKey: progressiveQueryKey,
    // The commerce owner supplies prepared immutable snapshots. Recursively
    // comparing every signed tag and product field on every arrival repeats
    // catalog work on the UI thread; publish that prepared snapshot directly.
    structuralSharing: false,
    queryFn: createProgressiveCatalogQuery<
      CommerceResult<CommerceProductRecord[]>
    >({
      queryClient,
      queryKey: progressiveQueryKey,
      isCurrent: () => authGenerationRef.current === authGeneration,
      read: async (onProgress, signal) => {
        if (input.scope !== "marketplace") {
          throw new Error("Progressive catalog requires marketplace scope")
        }
        const shouldContinue = () =>
          !signal.aborted && authGenerationRef.current === authGeneration
        return await getMarketplaceProductsProgressive(
          {
            merchantPubkey: input.merchantPubkey,
            authorPubkeys: catalogAuthorPubkeys,
            textQuery: catalogTextQuery,
            tags: marketplaceTags,
            sort: catalogSort,
            limit: input.limit,
            authenticatedPubkey,
            accountPubkey: finalIoAccountPubkey,
            shouldContinue,
            signal,
            readPolicy: CATALOG_COMPLETION_READ_POLICY,
          },
          onProgress
        )
      },
    }),
    enabled: streamsNetwork && catalogReady,
    staleTime: 60_000,
    retry: false,
  })
  const hasAuthoritativeProgressiveSnapshot =
    streamsNetwork &&
    catalogReady &&
    hasAuthoritativeQuerySnapshot({
      hasData: progressiveQuery.data !== undefined,
      isPlaceholderData: progressiveQuery.isPlaceholderData,
    })
  const activeProgressiveResult = hasAuthoritativeProgressiveSnapshot
    ? progressiveQuery.data
    : undefined
  const accumulatedProducts = useMemo(
    () => toProducts(activeProgressiveResult),
    [activeProgressiveResult]
  )

  const refetchFirstNetwork = firstNetworkQuery.refetch
  const refetchProgressive = progressiveQuery.refetch
  const refetchPerspectiveAuthors = firstDegreeQuery.refetch
  const refetch = useCallback(async () => {
    await refreshProductCatalogSources({
      queryEnabled,
      networkEnabled,
      catalogReady,
      streamsNetwork,
      usesPerspectiveGraph,
      catalogSource,
      refreshPerspectiveAuthors: async () => {
        try {
          const result = await refetchPerspectiveAuthors()
          if (result.isError || !result.data) return false
          const nextResolution = resolveFirstDegreeAuthors(result.data, true)
          const nextCatalogAuthorPubkeys = getCatalogAuthorPubkeys(
            nextResolution.authorPubkeys
          )
          const nextCatalogAuthorKey = getCatalogAuthorKey(
            nextCatalogAuthorPubkeys
          )
          return nextCatalogAuthorKey !== catalogAuthorKey
        } catch {
          return false
        }
      },
      restartNetworkStream: () => refetchProgressive({ cancelRefetch: false }),
      refreshNetwork: refetchFirstNetwork,
      refreshCache: refetchCached,
    })
  }, [
    catalogAuthorKey,
    catalogReady,
    catalogSource,
    queryEnabled,
    networkEnabled,
    refetchCached,
    refetchFirstNetwork,
    refetchProgressive,
    refetchPerspectiveAuthors,
    resolveFirstDegreeAuthors,
    streamsNetwork,
    usesPerspectiveGraph,
  ])

  const products = networkEnabled
    ? selectProgressiveProductFrontier({
        hasAuthoritativeProgressiveSnapshot,
        hasAuthoritativeNetworkSnapshot: hasNetworkResult,
        progressiveProducts: accumulatedProducts,
        networkProducts: mergedNetworkProducts,
        cachedProducts,
      })
    : cachedProducts
  const cachedCount = cachedQuery.data?.data.length ?? 0
  const isResolvingPerspectiveGraph =
    perspectiveMarketplaceRead && !catalogReady
  const networkCount = Math.max(
    activeProgressiveResult?.data.length ?? 0,
    mergedNetworkProducts.length
  )
  const profileRelayHintsByPubkey = useMemo(
    () =>
      getProductSourceRelayHintsByPubkey(
        cachedQuery.data,
        authoritativeNetworkResult,
        activeProgressiveResult
      ),
    [activeProgressiveResult, authoritativeNetworkResult, cachedQuery.data]
  )
  const familiesByProductId = useMemo(
    () =>
      getFamiliesByProductId(
        cachedQuery.data,
        authoritativeNetworkResult,
        activeProgressiveResult
      ),
    [activeProgressiveResult, authoritativeNetworkResult, cachedQuery.data]
  )
  const hydrationStage = isResolvingPerspectiveGraph
    ? "resolving_follows"
    : networkCount > 0 || firstNetworkQuery.data
      ? "first_degree"
      : "cache"
  return {
    products,
    cachedProductRecords: cachedQuery.data?.data ?? [],
    familiesByProductId,
    meta:
      activeProgressiveResult?.meta ??
      authoritativeNetworkResult?.meta ??
      cachedQuery.data?.meta ??
      null,
    profileRelayHintsByPubkey,
    catalogAuthorPubkeys,
    cachedCount,
    networkCount,
    firstDegreeAuthorCount: personalizedAuthorCount,
    fallbackAuthorCount,
    authorSource: firstDegreeResolution.source,
    catalogSource,
    followLookupStatus,
    hydrationStage,
    isInitialLoading:
      products.length === 0 &&
      (isResolvingPerspectiveGraph ||
        (firstDegreeDiscoveryEnabled && firstDegreeQuery.isPending) ||
        (canReadCache && cachedQuery.isPending) ||
        (queryEnabled &&
          networkEnabled &&
          catalogReady &&
          !streamsNetwork &&
          firstNetworkQuery.isPending) ||
        (streamsNetwork && catalogReady && progressiveQuery.isFetching)),
    isHydrating:
      isResolvingPerspectiveGraph ||
      (firstDegreeDiscoveryEnabled && firstDegreeQuery.isFetching) ||
      firstNetworkQuery.isFetching ||
      (streamsNetwork && catalogReady && progressiveQuery.isFetching),
    isRefreshPaused:
      (firstDegreeDiscoveryEnabled && firstDegreeQuery.isPaused) ||
      (streamsNetwork ? progressiveQuery.isPaused : firstNetworkQuery.isPaused),
    isShowingCache:
      !hasNetworkResult &&
      !hasAuthoritativeProgressiveSnapshot &&
      networkCount === 0 &&
      cachedCount > 0,
    discoveryStale:
      firstDegreeReadIncomplete ||
      firstDegreeReadUnconfirmed ||
      retainedFirstDegreeSupersedesLive,
    error:
      firstNetworkQuery.error ??
      progressiveQuery.error ??
      (firstDegreeDiscoveryEnabled ? firstDegreeQuery.error : null) ??
      cachedQuery.error,
    refetch,
  }
}

export function useProgressiveProductDetail(productId: string): {
  product: Product | null
  family: PreparedProductFamily<CommerceProductRecord> | null
  listingAvailability: ListingAvailabilityEvaluation | null
  isMarketVisible: boolean
  meta: CommerceQueryMeta | null
  profileRelayHintsByPubkey: Record<string, string[]>
  sourceRelayUrls: string[]
  isInitialLoading: boolean
  isHydrating: boolean
  isRefreshPaused: boolean
  isShowingCache: boolean
  error: unknown
  refetch: () => Promise<void>
} {
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const cachedQuery = useQuery({
    queryKey: ["progressive-product", "cache", productId],
    queryFn: () =>
      getCachedProductDetail(
        { productId },
        { includeStale: true, includeMarketHidden: true }
      ),
    staleTime: 15_000,
  })

  const networkQuery = useQuery({
    queryKey: [
      "progressive-product",
      "network",
      session.relayScope ?? "no-relay-scope",
      productId,
    ],
    queryFn: ({ signal }) =>
      getProductDetail({
        productId,
        includeMarketHidden: true,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    staleTime: 20_000,
  })

  const hasNetworkResult = hasAuthoritativeQuerySnapshot({
    hasData: networkQuery.data !== undefined,
    isPlaceholderData: networkQuery.isPlaceholderData,
  })
  const active = hasNetworkResult ? networkQuery.data : cachedQuery.data
  const product = active?.data?.product ?? null
  const family = active?.data?.family ?? null
  const listingAvailability = active?.data?.availability ?? null
  const sourceRelayUrls = active?.data?.sourceRelayUrls ?? []
  const isMarketVisible = listingAvailability
    ? isListingMarketVisible(listingAvailability)
    : true
  const profileRelayHintsByPubkey =
    product && sourceRelayUrls.length
      ? { [product.pubkey]: sourceRelayUrls }
      : {}
  const refetchCachedDetail = cachedQuery.refetch
  const refetchNetworkDetail = networkQuery.refetch
  const refetch = useCallback(async () => {
    await Promise.all([refetchCachedDetail(), refetchNetworkDetail()])
  }, [refetchCachedDetail, refetchNetworkDetail])

  return {
    product,
    family,
    listingAvailability,
    isMarketVisible,
    meta: active?.meta ?? null,
    profileRelayHintsByPubkey,
    sourceRelayUrls,
    isInitialLoading: isProductDetailInitialLoading({
      product,
      cachePending: cachedQuery.isPending,
      networkPending: networkQuery.isPending,
      networkFetching: networkQuery.isFetching,
    }),
    isHydrating: networkQuery.isFetching,
    isRefreshPaused: networkQuery.isPaused,
    isShowingCache: active === cachedQuery.data && !!product,
    error: networkQuery.error ?? cachedQuery.error,
    refetch,
  }
}

export function isProductDetailInitialLoading({
  product,
  cachePending,
  networkPending,
  networkFetching,
}: {
  product: Product | null
  cachePending: boolean
  networkPending: boolean
  networkFetching: boolean
}): boolean {
  return !product && (cachePending || networkPending || networkFetching)
}
