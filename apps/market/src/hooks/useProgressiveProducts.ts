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

export const MARKETPLACE_NETWORK_LIMIT = 1_200
export const STOREFRONT_NETWORK_LIMIT = 1_000
const PERSPECTIVE_STREAM_READ_POLICY: CommerceReadPolicy = {
  connectTimeoutMs: 1_200,
  fetchTimeoutMs: 2_500,
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

function getListQueryKey(
  input: ProgressiveListQuery,
  source: "cache" | "network"
) {
  return [
    "progressive-products",
    source,
    input.scope,
    input.scope === "marketplace"
      ? (input.merchantPubkey ?? "all")
      : input.merchantPubkey,
    input.scope === "marketplace"
      ? (input.perspectivePubkey ?? "global")
      : "storefront",
    input.scope === "marketplace"
      ? (input.seedAuthorPubkeys?.join(",") ?? "no-seed")
      : "storefront",
    input.textQuery ?? "",
    input.scope === "marketplace"
      ? (input.tags ?? []).join(",")
      : (input.tag ?? ""),
    input.sort ?? "newest",
    input.limit ?? "default",
  ] as const
}

async function fetchCachedList(
  input: ProgressiveListQuery,
  authorPubkeys?: string[]
) {
  if (input.scope === "marketplace") {
    return await getCachedMarketplaceProducts({
      merchantPubkey: input.merchantPubkey,
      authorPubkeys,
      textQuery: input.textQuery,
      tags: input.tags,
      sort: input.sort,
      limit:
        input.limit ??
        (input.merchantPubkey || authorPubkeys
          ? undefined
          : MARKETPLACE_NETWORK_LIMIT),
    })
  }

  return await getCachedMerchantStorefront({
    merchantPubkey: input.merchantPubkey,
    textQuery: input.textQuery,
    tag: input.tag,
    sort: input.sort,
    limit: input.limit ?? STOREFRONT_NETWORK_LIMIT,
  })
}

async function fetchNetworkList(
  input: ProgressiveListQuery,
  authorPubkeys?: string[],
  readPolicy?: CommerceReadPolicy
) {
  if (input.scope === "marketplace") {
    return await getMarketplaceProducts({
      merchantPubkey: input.merchantPubkey,
      authorPubkeys,
      textQuery: input.textQuery,
      tags: input.tags,
      sort: input.sort,
      limit:
        input.limit ??
        (input.merchantPubkey || authorPubkeys
          ? undefined
          : MARKETPLACE_NETWORK_LIMIT),
      readPolicy,
    })
  }

  return await getMerchantStorefront({
    merchantPubkey: input.merchantPubkey,
    textQuery: input.textQuery,
    tag: input.tag,
    sort: input.sort,
    limit: input.limit ?? STOREFRONT_NETWORK_LIMIT,
  })
}

export function useProgressiveProducts(
  input: ProgressiveListQuery
): ProgressiveProductsResult {
  const queryEnabled = input.enabled ?? true
  const perspectivePubkey =
    input.scope === "marketplace" && !input.merchantPubkey
      ? normalizePubkey(input.perspectivePubkey)
      : null
  const usesPerspectiveGraph =
    input.scope === "marketplace" && !!perspectivePubkey
  const streamsNetwork =
    queryEnabled &&
    input.scope === "marketplace" &&
    (usesPerspectiveGraph || !!input.merchantPubkey)
  const seedAuthorKey =
    input.scope === "marketplace"
      ? (input.seedAuthorPubkeys?.join(",") ?? "")
      : ""
  const seededAuthors = useMemo(
    () =>
      input.scope === "marketplace" && input.seedAuthorPubkeys?.length
        ? uniquePubkeys(input.seedAuthorPubkeys)
        : undefined,
    [input.scope, seedAuthorKey]
  )
  const cachedPerspectiveAuthors = useMemo(
    () =>
      !seededAuthors && usesPerspectiveGraph
        ? readCachedPerspectiveFollows(perspectivePubkey)
        : undefined,
    [perspectivePubkey, seededAuthors, usesPerspectiveGraph]
  )
  const discoveryKey = useMemo(
    () => JSON.stringify(getListQueryKey(input, "network")),
    [input]
  )
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
  }>({
    key: discoveryKey,
    isFetching: false,
    count: 0,
    meta: null,
    error: null,
  })

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

  const firstDegreeAuthors = useMemo(() => {
    const refreshed = uniquePubkeys(firstDegreeQuery.data?.data ?? []).filter(
      (pubkey) => pubkey !== perspectivePubkey
    )
    if (refreshed.length > 0) return refreshed
    if (seededAuthors) return seededAuthors
    if (cachedPerspectiveAuthors) return cachedPerspectiveAuthors
    if (!usesPerspectiveGraph) return undefined
    return undefined
  }, [
    cachedPerspectiveAuthors,
    firstDegreeQuery.data?.data,
    perspectivePubkey,
    seededAuthors,
    usesPerspectiveGraph,
  ])

  const graphReady = !usesPerspectiveGraph || firstDegreeAuthors !== undefined

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

  const cachedQuery = useQuery({
    queryKey: [
      ...getListQueryKey(input, "cache"),
      firstDegreeAuthors?.join(",") ?? "no-graph",
    ],
    queryFn: () => fetchCachedList(input, firstDegreeAuthors),
    enabled: queryEnabled && graphReady,
    staleTime: 15_000,
  })

  const firstNetworkQuery = useQuery({
    queryKey: [
      ...getListQueryKey(input, "network"),
      "first-degree",
      firstDegreeAuthors?.join(",") ?? "global",
    ],
    queryFn: () => fetchNetworkList(input, firstDegreeAuthors),
    placeholderData: (previousData) => previousData,
    enabled: queryEnabled && graphReady && !streamsNetwork,
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
    if (!streamsNetwork || !graphReady || input.scope !== "marketplace") {
      return undefined
    }
    if (!input.merchantPubkey && !firstDegreeAuthors) return undefined

    let cancelled = false
    setProgressiveRead((current) => ({
      key: discoveryKey,
      isFetching: true,
      count: current.key === discoveryKey ? current.count : 0,
      meta: current.key === discoveryKey ? current.meta : null,
      error: null,
    }))

    getMarketplaceProductsProgressive(
      {
        merchantPubkey: input.merchantPubkey,
        authorPubkeys: firstDegreeAuthors,
        textQuery: input.textQuery,
        tags: input.tags,
        sort: input.sort,
        limit: input.limit,
        readPolicy: PERSPECTIVE_STREAM_READ_POLICY,
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
        setProgressiveRead({
          key: discoveryKey,
          isFetching: true,
          count: result.data.length,
          meta: result.meta,
          error: null,
        })
      }
    )
      .then((result) => {
        if (cancelled) return
        setProgressiveRead({
          key: discoveryKey,
          isFetching: false,
          count: result.data.length,
          meta: result.meta,
          error: null,
        })
      })
      .catch((error) => {
        if (cancelled) return
        setProgressiveRead((current) => ({
          key: discoveryKey,
          isFetching: false,
          count: current.key === discoveryKey ? current.count : 0,
          meta: current.key === discoveryKey ? current.meta : null,
          error,
        }))
      })

    return () => {
      cancelled = true
    }
  }, [discoveryKey, firstDegreeAuthors, graphReady, streamsNetwork])

  const products =
    accumulatedProducts.length > 0
      ? accumulatedProducts
      : mergedNetworkProducts.length > 0
        ? mergedNetworkProducts
        : cachedProducts
  const cachedCount = cachedQuery.data?.data.length ?? 0
  const isResolvingPerspectiveGraph = usesPerspectiveGraph && !graphReady
  const liveNetworkCount =
    progressiveRead.key === discoveryKey
      ? Math.max(progressiveRead.count, mergedNetworkProducts.length)
      : mergedNetworkProducts.length
  const networkCount = Math.max(liveNetworkCount, accumulatedProducts.length)
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
    cachedCount,
    networkCount,
    firstDegreeAuthorCount: firstDegreeAuthors?.length ?? 0,
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

  return {
    product,
    meta: active?.meta ?? null,
    isInitialLoading:
      !product && cachedQuery.isLoading && networkQuery.isLoading,
    isHydrating: networkQuery.isFetching,
    isShowingCache: active === cachedQuery.data && !!product,
    error: networkQuery.error ?? cachedQuery.error,
  }
}
