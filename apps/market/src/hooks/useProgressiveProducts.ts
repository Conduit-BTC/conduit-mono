import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
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
  type ListingSafetyEvaluation,
  type PreparedProductFamily,
  type Product,
} from "@conduit/core"
import {
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
import { getDefaultMarketPerspectiveFollowPubkeys } from "../lib/defaultMarketPerspective"
import { getProductSourceRelayHintsByPubkey } from "../lib/clientHydration"
import {
  canCarryAuthoritativeProgressiveSnapshot,
  hasAuthoritativeQuerySnapshot,
  replaceProgressiveProductFrontier,
  runProgressiveReadPass,
  selectAuthoritativeQueryFrontier,
  selectProgressiveProductFrontier,
} from "../lib/progressiveProductFrontier"

// Keep the live fanout narrow: 32 relays x fast+completion passes opens far
// more sockets than the catalog needs and floods the browser with connection
// errors against dead NIP-65 hint relays. A small fast set paints quickly; the
// completion pass widens modestly for coverage.
const PERSPECTIVE_STREAM_READ_POLICY: CommerceReadPolicy = {
  maxRelays: 8,
  connectTimeoutMs: 1_200,
  fetchTimeoutMs: 2_500,
}
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
      seedAuthorPubkeys?: string[]
      textQuery?: string
      tags?: string[]
      sort?: SortOption
      limit?: number
      enabled?: boolean
    }
  | {
      scope: "storefront"
      merchantPubkey: string
      authenticatedPubkey?: string | null
      textQuery?: string
      tag?: string
      sort?: SortOption
      limit?: number
      enabled?: boolean
    }

export interface ProgressiveProductsResult {
  products: Product[]
  familiesByProductId: Record<
    string,
    PreparedProductFamily<CommerceProductRecord>
  >
  meta: CommerceQueryMeta | null
  profileRelayHintsByPubkey: Record<string, string[]>
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
  refetch: () => void
}

type ProductAccumulatorState = {
  key: string
  catalogKey: string
  catalogSource: ProductCatalogSourceMode
  products: Product[]
}

type ProgressiveReadState = {
  key: string
  catalogKey: string
  isFetching: boolean
  count: number
  meta: CommerceQueryMeta | null
  error: unknown
  latestResult?: CommerceResult<CommerceProductRecord[]>
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

function hasSameProductsByReference(a: Product[], b: Product[]): boolean {
  return (
    a.length === b.length && a.every((product, index) => product === b[index])
  )
}

function mergeProducts(existing: Product[], incoming: Product[]): Product[] {
  if (incoming.length === 0) return existing

  const merged = dedupeProducts([...incoming, ...existing])
  return hasSameProductsByReference(existing, merged) ? existing : merged
}

function uniquePubkeys(pubkeys: readonly string[]): string[] {
  return Array.from(
    new Set(pubkeys.map(normalizePubkey).filter(Boolean) as string[])
  )
}

function nextProductAccumulatorState(
  current: ProductAccumulatorState,
  next: ProductAccumulatorState
): ProductAccumulatorState {
  return current.key === next.key &&
    current.catalogKey === next.catalogKey &&
    current.catalogSource === next.catalogSource &&
    current.products === next.products
    ? current
    : next
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
  readPolicy?: CommerceReadPolicy
) {
  if (input.scope === "marketplace") {
    const readsPerspectiveCatalog = isPerspectiveMarketplaceRead(input)

    return await getMarketplaceProducts({
      merchantPubkey: input.merchantPubkey,
      authorPubkeys,
      authenticatedPubkey: input.authenticatedPubkey,
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
  const queryEnabled = input.enabled ?? true
  const perspectiveMarketplaceRead = isPerspectiveMarketplaceRead(input)
  const catalogSource: ProductCatalogSourceMode =
    input.scope === "marketplace"
      ? (input.catalogSource ?? "following")
      : "following"
  const perspectivePubkey =
    input.scope === "marketplace" && !input.merchantPubkey
      ? normalizePubkey(input.perspectivePubkey)
      : null
  const authenticatedPubkey = normalizePubkey(input.authenticatedPubkey)
  const usesPerspectiveGraph =
    input.scope === "marketplace" && !!perspectivePubkey
  const firstDegreeDiscoveryEnabled =
    queryEnabled && usesPerspectiveGraph && catalogSource !== "conduit"
  const streamsNetwork = queryEnabled && input.scope === "marketplace"
  const rawSeedAuthorPubkeys =
    input.scope === "marketplace" ? input.seedAuthorPubkeys : undefined
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
    queryFn: () =>
      getFollowPubkeys({
        pubkey: perspectivePubkey!,
        authenticatedPubkey,
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
        ? getDefaultMarketPerspectiveFollowPubkeys()
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
  // Versioning the discovery key with the refresh nonce starts a fresh relay
  // pass. The settled frontier remains authoritative during that handoff so a
  // stale cache cannot resurrect listings while the replacement read starts.
  const [refreshNonce, setRefreshNonce] = useState(0)
  const catalogDiscoveryKey = useMemo(
    () =>
      JSON.stringify([
        ...getProductCatalogQueryKey(
          input as ProductCatalogReadInput,
          "network"
        ),
        catalogAuthorKey,
      ]),
    [catalogAuthorKey, input]
  )
  const discoveryKey = useMemo(
    () => JSON.stringify([catalogDiscoveryKey, refreshNonce]),
    [catalogDiscoveryKey, refreshNonce]
  )
  const catalogTextQuery = perspectiveMarketplaceRead
    ? undefined
    : input.textQuery
  const catalogSort = perspectiveMarketplaceRead ? "newest" : input.sort
  const marketplaceTags =
    input.scope === "marketplace" && !perspectiveMarketplaceRead
      ? input.tags
      : undefined
  const inputTagsKey =
    input.scope === "marketplace"
      ? (marketplaceTags ?? []).join(",")
      : (input.tag ?? "")
  const [productAccumulator, setProductAccumulator] =
    useState<ProductAccumulatorState>({
      key: discoveryKey,
      catalogKey: catalogDiscoveryKey,
      catalogSource,
      products: [],
    })
  const [progressiveRead, setProgressiveRead] = useState<ProgressiveReadState>({
    key: discoveryKey,
    catalogKey: catalogDiscoveryKey,
    isFetching: false,
    count: 0,
    meta: null,
    error: null,
  })
  const canCarryProgressiveSnapshot = canCarryAuthoritativeProgressiveSnapshot({
    previousCatalogKey: progressiveRead.catalogKey,
    nextCatalogKey: catalogDiscoveryKey,
    hasSnapshot: progressiveRead.latestResult !== undefined,
  })
  const hasAuthoritativeProgressiveSnapshot =
    progressiveRead.latestResult !== undefined &&
    (progressiveRead.key === discoveryKey || canCarryProgressiveSnapshot)

  const canReadCache = queryEnabled && catalogReady

  const cachedQuery = useQuery({
    queryKey: [
      ...getProductCatalogQueryKey(input as ProductCatalogReadInput, "cache"),
      catalogAuthorKey,
    ],
    queryFn: () => fetchCachedList(input, catalogAuthorPubkeys),
    enabled: canReadCache,
    staleTime: 15_000,
  })

  const firstNetworkQuery = useQuery({
    queryKey: [
      ...getProductCatalogQueryKey(input as ProductCatalogReadInput, "network"),
      "catalog",
      catalogAuthorKey,
    ],
    queryFn: () => fetchNetworkList(input, catalogAuthorPubkeys),
    enabled: queryEnabled && catalogReady && !streamsNetwork,
    staleTime: 20_000,
  })

  const hasNetworkResult = hasAuthoritativeQuerySnapshot({
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
  const canUseCarriedProducts =
    perspectiveMarketplaceRead &&
    productAccumulator.catalogSource === catalogSource &&
    canCarryAuthoritativeProgressiveSnapshot({
      previousCatalogKey: productAccumulator.catalogKey,
      nextCatalogKey: catalogDiscoveryKey,
      hasSnapshot: productAccumulator.products.length > 0,
    })
  const accumulatedProducts =
    productAccumulator.key === discoveryKey || canUseCarriedProducts
      ? productAccumulator.products
      : []

  useEffect(() => {
    setProductAccumulator((current) => {
      const carryProducts =
        perspectiveMarketplaceRead &&
        current.catalogSource === catalogSource &&
        canCarryAuthoritativeProgressiveSnapshot({
          previousCatalogKey: current.catalogKey,
          nextCatalogKey: catalogDiscoveryKey,
          hasSnapshot: current.products.length > 0,
        })
      const products = carryProducts ? current.products : []
      return nextProductAccumulatorState(current, {
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        catalogSource,
        products,
      })
    })
    setProgressiveRead((current) => {
      const carrySnapshot = canCarryAuthoritativeProgressiveSnapshot({
        previousCatalogKey: current.catalogKey,
        nextCatalogKey: catalogDiscoveryKey,
        hasSnapshot: current.latestResult !== undefined,
      })
      if (
        current.key === discoveryKey &&
        current.catalogKey === catalogDiscoveryKey &&
        !current.isFetching &&
        current.error === null
      ) {
        return current
      }
      return {
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        isFetching: false,
        count: carrySnapshot ? current.count : 0,
        meta: carrySnapshot ? current.meta : null,
        error: null,
        latestResult: carrySnapshot ? current.latestResult : undefined,
      }
    })
  }, [
    catalogDiscoveryKey,
    catalogSource,
    discoveryKey,
    perspectiveMarketplaceRead,
  ])

  useEffect(() => {
    if (
      cachedProducts.length === 0 ||
      hasNetworkResult ||
      hasAuthoritativeProgressiveSnapshot
    ) {
      return
    }
    setProductAccumulator((current) => {
      const products = mergeProducts(
        current.key === discoveryKey ? current.products : [],
        cachedProducts
      )
      return nextProductAccumulatorState(current, {
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        catalogSource,
        products,
      })
    })
  }, [
    cachedProducts,
    catalogDiscoveryKey,
    catalogSource,
    discoveryKey,
    hasAuthoritativeProgressiveSnapshot,
    hasNetworkResult,
  ])

  useEffect(() => {
    if (!hasNetworkResult) return
    setProductAccumulator((current) => {
      const products = replaceProgressiveProductFrontier(
        current.key === discoveryKey ? current.products : [],
        mergedNetworkProducts
      )
      return nextProductAccumulatorState(current, {
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        catalogSource,
        products,
      })
    })
  }, [
    mergedNetworkProducts,
    catalogDiscoveryKey,
    catalogSource,
    discoveryKey,
    hasNetworkResult,
  ])

  useEffect(() => {
    if (!streamsNetwork || !catalogReady || input.scope !== "marketplace") {
      return undefined
    }

    let cancelled = false
    let flushHandle: number | null = null
    let pendingResult: CommerceResult<CommerceProductRecord[]> | null = null
    const completionRead = perspectiveMarketplaceRead
    setProgressiveRead((current) => {
      const carrySnapshot = canCarryAuthoritativeProgressiveSnapshot({
        previousCatalogKey: current.catalogKey,
        nextCatalogKey: catalogDiscoveryKey,
        hasSnapshot: current.latestResult !== undefined,
      })
      return {
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        isFetching: true,
        count:
          current.key === discoveryKey || carrySnapshot ? current.count : 0,
        meta:
          current.key === discoveryKey || carrySnapshot ? current.meta : null,
        error: null,
        latestResult:
          current.key === discoveryKey || carrySnapshot
            ? current.latestResult
            : undefined,
      }
    })

    // Every progressive callback is an authoritative cumulative frontier.
    // Replace the previous snapshot so a later tombstone can retract a product
    // that an earlier relay callback already emitted.
    const applyResult = (
      result: CommerceResult<CommerceProductRecord[]>,
      isFetching: boolean
    ) => {
      const incoming = toProducts(result)
      setProductAccumulator((current) =>
        nextProductAccumulatorState(current, {
          key: discoveryKey,
          catalogKey: catalogDiscoveryKey,
          catalogSource,
          products: replaceProgressiveProductFrontier(
            current.key === discoveryKey ? current.products : [],
            incoming
          ),
        })
      )
      setProgressiveRead({
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        isFetching,
        count: result.data.length,
        meta: result.meta,
        error: null,
        latestResult: result,
      })
    }

    const flushProgress = () => {
      flushHandle = null
      if (cancelled || !pendingResult) return
      const result = pendingResult
      pendingResult = null
      applyResult(result, true)
    }
    const scheduleFlush = () => {
      if (cancelled || flushHandle !== null) return
      flushHandle =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(flushProgress)
          : (setTimeout(flushProgress, 16) as unknown as number)
    }
    const cancelScheduledFlush = () => {
      if (flushHandle === null) return
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(flushHandle)
      } else {
        clearTimeout(flushHandle)
      }
      flushHandle = null
      pendingResult = null
    }

    const readCatalog = async (
      readPolicy: CommerceReadPolicy
    ): Promise<CommerceResult<CommerceProductRecord[]>> =>
      await getMarketplaceProductsProgressive(
        {
          merchantPubkey: input.merchantPubkey,
          authorPubkeys: catalogAuthorPubkeys,
          textQuery: catalogTextQuery,
          tags: marketplaceTags,
          sort: catalogSort,
          limit: input.limit,
          authenticatedPubkey,
          readPolicy,
        },
        (result) => {
          if (cancelled) return
          pendingResult = result
          scheduleFlush()
        }
      )

    void runProgressiveReadPass({
      readFast: () => readCatalog(PERSPECTIVE_STREAM_READ_POLICY),
      readCompletion: completionRead
        ? () => readCatalog(CATALOG_COMPLETION_READ_POLICY)
        : undefined,
      commitResult: (result, isFetching) => {
        if (cancelled) return
        cancelScheduledFlush()
        applyResult(result, isFetching)
      },
      shouldContinue: () => !cancelled,
    }).catch((error) => {
      if (cancelled) return
      const lastPendingResult = pendingResult
      cancelScheduledFlush()
      if (lastPendingResult) applyResult(lastPendingResult, true)
      setProgressiveRead((current) => ({
        key: discoveryKey,
        catalogKey: catalogDiscoveryKey,
        isFetching: false,
        count: current.catalogKey === catalogDiscoveryKey ? current.count : 0,
        meta: current.catalogKey === catalogDiscoveryKey ? current.meta : null,
        error,
        latestResult:
          current.catalogKey === catalogDiscoveryKey
            ? current.latestResult
            : undefined,
      }))
    })

    return () => {
      cancelled = true
      cancelScheduledFlush()
    }
  }, [
    catalogAuthorKey,
    catalogAuthorPubkeys,
    catalogReady,
    catalogDiscoveryKey,
    catalogSort,
    catalogSource,
    catalogTextQuery,
    discoveryKey,
    input.limit,
    input.merchantPubkey,
    input.scope,
    inputTagsKey,
    marketplaceTags,
    perspectiveMarketplaceRead,
    authenticatedPubkey,
    streamsNetwork,
  ])

  const refetchCached = cachedQuery.refetch
  const refetchFirstNetwork = firstNetworkQuery.refetch
  const refetchPerspectiveAuthors = firstDegreeQuery.refetch
  const refetch = useCallback(() => {
    void refreshProductCatalogSources({
      queryEnabled,
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
      restartNetworkStream: () => setRefreshNonce((nonce) => nonce + 1),
      refreshNetwork: refetchFirstNetwork,
      refreshCache: refetchCached,
    })
  }, [
    catalogAuthorKey,
    catalogReady,
    catalogSource,
    queryEnabled,
    refetchCached,
    refetchFirstNetwork,
    refetchPerspectiveAuthors,
    resolveFirstDegreeAuthors,
    streamsNetwork,
    usesPerspectiveGraph,
  ])

  const products = selectProgressiveProductFrontier({
    hasAuthoritativeProgressiveSnapshot,
    hasAuthoritativeNetworkSnapshot: hasNetworkResult,
    progressiveProducts: accumulatedProducts,
    networkProducts: mergedNetworkProducts,
    cachedProducts,
  })
  const cachedCount = cachedQuery.data?.data.length ?? 0
  const isResolvingPerspectiveGraph =
    perspectiveMarketplaceRead && !catalogReady
  const liveNetworkCount =
    progressiveRead.key === discoveryKey
      ? Math.max(progressiveRead.count, mergedNetworkProducts.length)
      : mergedNetworkProducts.length
  const networkCount = Math.max(liveNetworkCount, accumulatedProducts.length)
  const activeProgressiveResult = hasAuthoritativeProgressiveSnapshot
    ? progressiveRead.latestResult
    : undefined
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
    : progressiveRead.count > 0 || firstNetworkQuery.data
      ? "first_degree"
      : "cache"
  // A changed author set or manual nonce renders before the stream effect can
  // mark its replacement read as fetching. Keep that handoff visibly busy.
  const isRestartingProgressiveRead =
    streamsNetwork && catalogReady && progressiveRead.key !== discoveryKey

  return {
    products,
    familiesByProductId,
    meta:
      (hasAuthoritativeProgressiveSnapshot ? progressiveRead.meta : null) ??
      authoritativeNetworkResult?.meta ??
      cachedQuery.data?.meta ??
      null,
    profileRelayHintsByPubkey,
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
          catalogReady &&
          !streamsNetwork &&
          firstNetworkQuery.isPending) ||
        isRestartingProgressiveRead ||
        (progressiveRead.key === discoveryKey && progressiveRead.isFetching)),
    isHydrating:
      isResolvingPerspectiveGraph ||
      (firstDegreeDiscoveryEnabled && firstDegreeQuery.isFetching) ||
      firstNetworkQuery.isFetching ||
      isRestartingProgressiveRead ||
      (progressiveRead.key === discoveryKey && progressiveRead.isFetching),
    isRefreshPaused:
      (firstDegreeDiscoveryEnabled && firstDegreeQuery.isPaused) ||
      (!streamsNetwork && firstNetworkQuery.isPaused),
    isShowingCache:
      !hasNetworkResult &&
      !hasAuthoritativeProgressiveSnapshot &&
      progressiveRead.count === 0 &&
      cachedCount > 0,
    discoveryStale:
      firstDegreeReadIncomplete ||
      firstDegreeReadUnconfirmed ||
      retainedFirstDegreeSupersedesLive,
    error:
      firstNetworkQuery.error ??
      (progressiveRead.key === discoveryKey ? progressiveRead.error : null) ??
      (firstDegreeDiscoveryEnabled ? firstDegreeQuery.error : null) ??
      cachedQuery.error,
    refetch,
  }
}

export function useProgressiveProductDetail(productId: string): {
  product: Product | null
  family: PreparedProductFamily<CommerceProductRecord> | null
  listingSafety: ListingSafetyEvaluation | null
  isMarketVisible: boolean
  meta: CommerceQueryMeta | null
  profileRelayHintsByPubkey: Record<string, string[]>
  isInitialLoading: boolean
  isHydrating: boolean
  isRefreshPaused: boolean
  isShowingCache: boolean
  error: unknown
  refetch: () => void
} {
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
    queryKey: ["progressive-product", "network", productId],
    queryFn: () => getProductDetail({ productId, includeMarketHidden: true }),
    staleTime: 20_000,
  })

  const hasNetworkResult = hasAuthoritativeQuerySnapshot({
    hasData: networkQuery.data !== undefined,
    isPlaceholderData: networkQuery.isPlaceholderData,
  })
  const active = selectAuthoritativeQueryFrontier({
    hasAuthoritativeNetworkSnapshot: hasNetworkResult,
    networkData: networkQuery.data,
    cachedData: cachedQuery.data,
  })
  const product = active?.data?.product ?? null
  const family = active?.data?.family ?? null
  const listingSafety = active?.data?.safety ?? null
  const isMarketVisible = listingSafety
    ? isListingMarketVisible(listingSafety)
    : true
  const profileRelayHintsByPubkey =
    product && active?.data?.sourceRelayUrls?.length
      ? { [product.pubkey]: active.data.sourceRelayUrls }
      : {}
  const refetchCachedDetail = cachedQuery.refetch
  const refetchNetworkDetail = networkQuery.refetch
  const refetch = useCallback(() => {
    void refetchCachedDetail()
    void refetchNetworkDetail()
  }, [refetchCachedDetail, refetchNetworkDetail])

  return {
    product,
    family,
    listingSafety,
    isMarketVisible,
    meta: active?.meta ?? null,
    profileRelayHintsByPubkey,
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
