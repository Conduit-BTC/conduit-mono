import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  type CommerceProductRecord,
  type CommerceQueryMeta,
  type CommerceReadPolicy,
  type CommerceResult,
  getFollowPubkeys,
  getCachedMarketplaceProducts,
  getCachedMerchantStorefront,
  getCachedProductDetail,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
  getMerchantStorefront,
  getProductDetail,
  normalizePubkey,
  type Product,
} from "@conduit/core"
import {
  getCatalogAuthorPubkeys,
  getProductCatalogQueryKey,
  isPerspectiveMarketplaceRead,
  resolvePerspectiveAuthorPubkeys,
  type ProductCatalogReadInput,
} from "../lib/productCatalogRead"
import { getDefaultMarketPerspectiveFollowPubkeys } from "../lib/defaultMarketPerspective"

const PERSPECTIVE_STREAM_READ_POLICY: CommerceReadPolicy = {
  maxRelays: 32,
  connectTimeoutMs: 1_200,
  fetchTimeoutMs: 2_500,
}
const CATALOG_COMPLETION_READ_POLICY: CommerceReadPolicy = {
  maxRelays: 32,
  connectTimeoutMs: 4_000,
  fetchTimeoutMs: 8_000,
}
const FOLLOW_CACHE_PREFIX = "conduit.market.perspectiveFollows.v1:"

type SortOption = "newest" | "price_asc" | "price_desc"

type ProgressiveListQuery =
  | {
      scope: "marketplace"
      merchantPubkey?: string
      perspectivePubkey?: string | null
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
      textQuery?: string
      tag?: string
      sort?: SortOption
      limit?: number
      enabled?: boolean
    }

export interface ProgressiveProductsResult {
  products: Product[]
  meta: CommerceQueryMeta | null
  profileRelayHintsByPubkey: Record<string, string[]>
  cachedCount: number
  networkCount: number
  firstDegreeAuthorCount: number
  hydrationStage: "cache" | "resolving_follows" | "first_degree"
  isInitialLoading: boolean
  isHydrating: boolean
  isShowingCache: boolean
  error: unknown
}

function toProducts(
  result: CommerceResult<CommerceProductRecord[]> | undefined
): Product[] {
  return result?.data.map((record) => record.product) ?? []
}

function mergeProfileRelayHints(
  ...results: Array<CommerceResult<CommerceProductRecord[]> | undefined>
): Record<string, string[]> {
  const byPubkey = new Map<string, Set<string>>()
  for (const result of results) {
    for (const record of result?.data ?? []) {
      if (!record.sourceRelayUrls?.length) continue
      const current = byPubkey.get(record.product.pubkey) ?? new Set<string>()
      for (const relayUrl of record.sourceRelayUrls) {
        current.add(relayUrl)
      }
      byPubkey.set(record.product.pubkey, current)
    }
  }

  return Object.fromEntries(
    Array.from(byPubkey.entries()).map(([pubkey, relayUrls]) => [
      pubkey,
      Array.from(relayUrls),
    ])
  )
}

function dedupeProducts(products: Product[]): Product[] {
  const byId = new Map<string, Product>()
  for (const product of products) {
    if (!byId.has(product.id)) byId.set(product.id, product)
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt)
}

function mergeProducts(existing: Product[], incoming: Product[]): Product[] {
  return dedupeProducts([...existing, ...incoming])
}

function uniquePubkeys(pubkeys: readonly string[]): string[] {
  return Array.from(
    new Set(pubkeys.map(normalizePubkey).filter(Boolean) as string[])
  )
}

function readCachedPerspectiveFollows(
  pubkey: string | null
): string[] | undefined {
  if (!pubkey || typeof window === "undefined") return undefined

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(`${FOLLOW_CACHE_PREFIX}${pubkey}`) ?? "null"
    ) as unknown
    if (!parsed || typeof parsed !== "object") return undefined
    const pubkeys = (parsed as { pubkeys?: unknown }).pubkeys
    if (!Array.isArray(pubkeys)) return undefined
    const normalized = uniquePubkeys(
      pubkeys.filter((value): value is string => typeof value === "string")
    ).filter((value) => value !== pubkey)
    return normalized.length > 0 ? normalized : undefined
  } catch {
    return undefined
  }
}

function writeCachedPerspectiveFollows(
  pubkey: string | null,
  follows: string[]
): void {
  if (!pubkey || typeof window === "undefined" || follows.length === 0) return

  try {
    window.localStorage.setItem(
      `${FOLLOW_CACHE_PREFIX}${pubkey}`,
      JSON.stringify({ cachedAt: Date.now(), pubkeys: follows })
    )
  } catch {
    // A transient storage failure should not block live relay hydration.
  }
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
      textQuery: readsPerspectiveCatalog ? undefined : input.textQuery,
      tags: readsPerspectiveCatalog ? undefined : input.tags,
      sort: readsPerspectiveCatalog ? "newest" : input.sort,
      limit: input.limit,
      readPolicy,
    })
  }

  return await getMerchantStorefront({
    merchantPubkey: input.merchantPubkey,
    textQuery: input.textQuery,
    tag: input.tag,
    sort: input.sort,
    limit: input.limit,
  })
}

export function useProgressiveProducts(
  input: ProgressiveListQuery
): ProgressiveProductsResult {
  const queryEnabled = input.enabled ?? true
  const perspectiveMarketplaceRead = isPerspectiveMarketplaceRead(input)
  const perspectivePubkey =
    input.scope === "marketplace" && !input.merchantPubkey
      ? normalizePubkey(input.perspectivePubkey)
      : null
  const usesPerspectiveGraph =
    input.scope === "marketplace" && !!perspectivePubkey
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
  const cachedPerspectiveAuthors = useMemo(
    () =>
      !seededAuthors && usesPerspectiveGraph
        ? readCachedPerspectiveFollows(perspectivePubkey)
        : undefined,
    [perspectivePubkey, seededAuthors, usesPerspectiveGraph]
  )
  const firstDegreeQuery = useQuery({
    queryKey: ["market-perspective-follows", perspectivePubkey],
    queryFn: () => getFollowPubkeys({ pubkey: perspectivePubkey! }),
    enabled: queryEnabled && usesPerspectiveGraph,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const data = query.state.data as CommerceResult<string[]> | undefined
      return data && data.data.length === 0 ? 5_000 : false
    },
  })

  const fallbackPerspectiveAuthors = useMemo(
    () =>
      usesPerspectiveGraph && !seededAuthors
        ? getDefaultMarketPerspectiveFollowPubkeys()
        : undefined,
    [seededAuthors, usesPerspectiveGraph]
  )
  const firstDegreeResolution = useMemo(
    () =>
      resolvePerspectiveAuthorPubkeys({
        usesPerspectiveGraph,
        perspectivePubkey,
        refreshedAuthorPubkeys: firstDegreeQuery.data?.data,
        seedAuthorPubkeys: seededAuthors,
        cachedAuthorPubkeys: cachedPerspectiveAuthors,
        fallbackAuthorPubkeys: fallbackPerspectiveAuthors,
        followLookupSettled:
          firstDegreeQuery.isSuccess || firstDegreeQuery.isError,
      }),
    [
      cachedPerspectiveAuthors,
      fallbackPerspectiveAuthors,
      firstDegreeQuery.data?.data,
      firstDegreeQuery.isError,
      firstDegreeQuery.isSuccess,
      perspectivePubkey,
      seededAuthors,
      usesPerspectiveGraph,
    ]
  )
  const firstDegreeAuthors = firstDegreeResolution.authorPubkeys
  const usingFallbackPerspective = firstDegreeResolution.source === "fallback"

  const personalizedAuthorCount = usingFallbackPerspective
    ? 0
    : (firstDegreeAuthors?.length ?? 0)

  const catalogReady =
    !perspectiveMarketplaceRead || firstDegreeAuthors !== undefined
  const catalogAuthorPubkeys = useMemo(
    () =>
      getCatalogAuthorPubkeys(
        {
          scope: input.scope,
          merchantPubkey: input.merchantPubkey,
        },
        firstDegreeAuthors
      ),
    [firstDegreeAuthors, input.merchantPubkey, input.scope]
  )
  const catalogAuthorKey = catalogAuthorPubkeys?.join(",") ?? "no-authors"
  const discoveryKey = useMemo(
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
  const marketplaceTags = input.scope === "marketplace" ? input.tags : undefined
  const inputTagsKey =
    input.scope === "marketplace"
      ? (marketplaceTags ?? []).join(",")
      : (input.tag ?? "")
  const [productAccumulator, setProductAccumulator] = useState<{
    key: string
    products: Product[]
  }>({ key: discoveryKey, products: [] })
  const [progressiveRead, setProgressiveRead] = useState<{
    key: string
    isFetching: boolean
    count: number
    meta: CommerceQueryMeta | null
    error: unknown
    latestResult?: CommerceResult<CommerceProductRecord[]>
  }>({
    key: discoveryKey,
    isFetching: false,
    count: 0,
    meta: null,
    error: null,
  })

  useEffect(() => {
    if (
      !perspectivePubkey ||
      !firstDegreeAuthors ||
      firstDegreeAuthors.length === 0
    ) {
      return
    }
    writeCachedPerspectiveFollows(perspectivePubkey, firstDegreeAuthors)
  }, [firstDegreeAuthors, perspectivePubkey])

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
    placeholderData: (previousData) => previousData,
    enabled: queryEnabled && catalogReady && !streamsNetwork,
    staleTime: 20_000,
  })

  const firstProducts = useMemo(
    () => toProducts(firstNetworkQuery.data),
    [firstNetworkQuery.data]
  )
  const mergedNetworkProducts = useMemo(
    () => dedupeProducts(firstProducts),
    [firstProducts]
  )
  const hasNetworkResult =
    firstNetworkQuery.data !== undefined && !firstNetworkQuery.isFetching
  const cachedProducts = useMemo(
    () => toProducts(cachedQuery.data),
    [cachedQuery.data]
  )
  const accumulatedProducts =
    productAccumulator.key === discoveryKey ? productAccumulator.products : []

  useEffect(() => {
    setProductAccumulator({ key: discoveryKey, products: [] })
    setProgressiveRead({
      key: discoveryKey,
      isFetching: false,
      count: 0,
      meta: null,
      error: null,
      latestResult: undefined,
    })
  }, [discoveryKey])

  useEffect(() => {
    if (cachedProducts.length === 0) return
    setProductAccumulator((current) => ({
      key: discoveryKey,
      products: mergeProducts(
        current.key === discoveryKey ? current.products : [],
        cachedProducts
      ),
    }))
  }, [cachedProducts, discoveryKey])

  useEffect(() => {
    if (mergedNetworkProducts.length === 0) return
    setProductAccumulator((current) => ({
      key: discoveryKey,
      products: mergeProducts(
        current.key === discoveryKey ? current.products : [],
        mergedNetworkProducts
      ),
    }))
  }, [mergedNetworkProducts, discoveryKey])

  useEffect(() => {
    if (!streamsNetwork || !catalogReady || input.scope !== "marketplace") {
      return undefined
    }

    let cancelled = false
    const completionRead = perspectiveMarketplaceRead
    setProgressiveRead((current) => ({
      key: discoveryKey,
      isFetching: true,
      count: current.key === discoveryKey ? current.count : 0,
      meta: current.key === discoveryKey ? current.meta : null,
      error: null,
    }))

    const readCatalog = async (
      readPolicy: CommerceReadPolicy
    ): Promise<CommerceResult<CommerceProductRecord[]>> =>
      await getMarketplaceProductsProgressive(
        {
          merchantPubkey: input.merchantPubkey,
          authorPubkeys: catalogAuthorPubkeys,
          textQuery: perspectiveMarketplaceRead ? undefined : input.textQuery,
          tags: perspectiveMarketplaceRead ? undefined : marketplaceTags,
          sort: perspectiveMarketplaceRead ? "newest" : input.sort,
          limit: input.limit,
          readPolicy,
        },
        (result) => {
          if (cancelled) return
          const incoming = toProducts(result)
          if (incoming.length > 0) {
            setProductAccumulator((current) => ({
              key: discoveryKey,
              products: mergeProducts(
                current.key === discoveryKey ? current.products : [],
                incoming
              ),
            }))
          }
          setProgressiveRead((current) => ({
            key: discoveryKey,
            isFetching: true,
            count: Math.max(
              current.key === discoveryKey ? current.count : 0,
              result.data.length
            ),
            meta: result.meta,
            error: null,
            latestResult: result,
          }))
        }
      )

    ;(async () => {
      const fastResult = await readCatalog(PERSPECTIVE_STREAM_READ_POLICY)
      if (cancelled) return

      setProgressiveRead({
        key: discoveryKey,
        isFetching: completionRead,
        count: fastResult.data.length,
        meta: fastResult.meta,
        error: null,
        latestResult: fastResult,
      })

      if (!completionRead) return

      const completionResult = await readCatalog(CATALOG_COMPLETION_READ_POLICY)
      if (cancelled) return

      setProgressiveRead((current) => ({
        key: discoveryKey,
        isFetching: false,
        count: Math.max(
          current.key === discoveryKey ? current.count : 0,
          completionResult.data.length
        ),
        meta: completionResult.meta,
        error: null,
        latestResult: completionResult,
      }))
    })().catch((error) => {
      if (cancelled) return
      setProgressiveRead((current) => ({
        key: discoveryKey,
        isFetching: false,
        count: current.key === discoveryKey ? current.count : 0,
        meta: current.key === discoveryKey ? current.meta : null,
        error,
        latestResult:
          current.key === discoveryKey ? current.latestResult : undefined,
      }))
    })

    return () => {
      cancelled = true
    }
  }, [
    catalogAuthorKey,
    catalogAuthorPubkeys,
    catalogReady,
    discoveryKey,
    input.limit,
    input.merchantPubkey,
    input.scope,
    input.sort,
    input.textQuery,
    inputTagsKey,
    marketplaceTags,
    perspectiveMarketplaceRead,
    streamsNetwork,
  ])

  const products =
    accumulatedProducts.length > 0
      ? accumulatedProducts
      : mergedNetworkProducts.length > 0
        ? mergedNetworkProducts
        : cachedProducts
  const cachedCount = cachedQuery.data?.data.length ?? 0
  const isResolvingPerspectiveGraph =
    perspectiveMarketplaceRead && !catalogReady
  const liveNetworkCount =
    progressiveRead.key === discoveryKey
      ? Math.max(progressiveRead.count, mergedNetworkProducts.length)
      : mergedNetworkProducts.length
  const networkCount = Math.max(liveNetworkCount, accumulatedProducts.length)
  const activeProgressiveResult =
    progressiveRead.key === discoveryKey
      ? progressiveRead.latestResult
      : undefined
  const profileRelayHintsByPubkey = useMemo(
    () =>
      mergeProfileRelayHints(
        cachedQuery.data,
        firstNetworkQuery.data,
        activeProgressiveResult
      ),
    [activeProgressiveResult, cachedQuery.data, firstNetworkQuery.data]
  )
  const hydrationStage = isResolvingPerspectiveGraph
    ? "resolving_follows"
    : progressiveRead.count > 0 || firstNetworkQuery.data
      ? "first_degree"
      : "cache"

  return {
    products,
    meta:
      (progressiveRead.key === discoveryKey ? progressiveRead.meta : null) ??
      firstNetworkQuery.data?.meta ??
      cachedQuery.data?.meta ??
      null,
    profileRelayHintsByPubkey,
    cachedCount,
    networkCount,
    firstDegreeAuthorCount: personalizedAuthorCount,
    hydrationStage,
    isInitialLoading:
      products.length === 0 &&
      (isResolvingPerspectiveGraph ||
        firstDegreeQuery.isLoading ||
        cachedQuery.isLoading ||
        firstNetworkQuery.isLoading ||
        (progressiveRead.key === discoveryKey && progressiveRead.isFetching)),
    isHydrating:
      isResolvingPerspectiveGraph ||
      firstDegreeQuery.isFetching ||
      firstNetworkQuery.isFetching ||
      (progressiveRead.key === discoveryKey && progressiveRead.isFetching),
    isShowingCache:
      !hasNetworkResult && progressiveRead.count === 0 && cachedCount > 0,
    error:
      firstNetworkQuery.error ??
      (progressiveRead.key === discoveryKey ? progressiveRead.error : null) ??
      firstDegreeQuery.error ??
      cachedQuery.error,
  }
}

export function useProgressiveProductDetail(productId: string): {
  product: Product | null
  meta: CommerceQueryMeta | null
  profileRelayHintsByPubkey: Record<string, string[]>
  isInitialLoading: boolean
  isHydrating: boolean
  isShowingCache: boolean
  error: unknown
} {
  const cachedQuery = useQuery({
    queryKey: ["progressive-product", "cache", productId],
    queryFn: () => getCachedProductDetail({ productId }),
    staleTime: 15_000,
  })

  const networkQuery = useQuery({
    queryKey: ["progressive-product", "network", productId],
    queryFn: () => getProductDetail({ productId }),
    placeholderData: (previousData) => previousData,
    staleTime: 20_000,
  })

  const hasNetworkResult =
    networkQuery.data !== undefined && !networkQuery.isFetching
  const active =
    hasNetworkResult || !cachedQuery.data ? networkQuery.data : cachedQuery.data
  const product = active?.data?.product ?? null
  const profileRelayHintsByPubkey =
    product && active?.data?.sourceRelayUrls?.length
      ? { [product.pubkey]: active.data.sourceRelayUrls }
      : {}

  return {
    product,
    meta: active?.meta ?? null,
    profileRelayHintsByPubkey,
    isInitialLoading:
      !product && cachedQuery.isLoading && networkQuery.isLoading,
    isHydrating: networkQuery.isFetching,
    isShowingCache: active === cachedQuery.data && !!product,
    error: networkQuery.error ?? cachedQuery.error,
  }
}
