import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getMarketplaceProducts,
  normalizePubkey,
  useAuth,
  type PricingRateInput,
} from "@conduit/core"
import {
  filterProductsByFacets,
  getCategoryFacetOptions,
  getStoreFacetOptions,
} from "../lib/facets"
import {
  getBrowseSearchKey,
  getGlobalProductSearchQueryKey,
  getStoreTriggerLabel,
  hasUnavailablePriceForBrowseSort,
  isMarketBrowseRefreshStale,
  mergeProductSearchResults,
  refreshMarketBrowseData,
  sortBrowseProducts,
  sortStoreFacetOptionsByRecentPublisher,
  type MarketBrowseSearch,
  type MarketProductCardView,
} from "../lib/marketBrowseModel"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"
import {
  isRemoteMarketSearchEligible,
  MARKET_SEARCH_QUERY_POLICY,
} from "../lib/searchPolicy"
import {
  filterSellersByName,
  groupDiscoveredSellers,
} from "../lib/sellerDirectory"
import { useGuestMarketDiscovery } from "./useGuestMarketDiscovery"
import { useShopperPresets } from "./useShopperPresets"
import { useMerchantIdentities } from "./useMerchantIdentities"
import { useProgressiveProducts } from "./useProgressiveProducts"

interface UseMarketBrowseModelInput {
  btcUsdRate: PricingRateInput
  catalogSource: ProductCatalogSourceMode
  search: MarketBrowseSearch
  storeMenuOpen: boolean
  visibleCount: number
}

export function useMarketBrowseModel({
  btcUsdRate,
  catalogSource,
  search,
  storeMenuOpen,
  visibleCount,
}: UseMarketBrowseModelInput) {
  const { pubkey, status, authGeneration } = useAuth()
  const queryClient = useQueryClient()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const shouldContinueAccountRead = () =>
    authGenerationRef.current === authGeneration
  const shopperPresets = useShopperPresets()
  const selectedMerchants = useMemo(
    () =>
      (search.merchant ?? []).map((merchant) => {
        return normalizePubkey(merchant) ?? merchant
      }),
    [search.merchant]
  )
  const selectedMerchantSet = useMemo(
    () => new Set(selectedMerchants),
    [selectedMerchants]
  )
  const selectedTags = useMemo(() => search.tag ?? [], [search.tag])
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags])
  const usesAnonymousPerspective = status !== "connected"
  const effectiveCatalogSource =
    status === "connected" ? catalogSource : "conduit"
  const guestMarket = useGuestMarketDiscovery({
    enabled: usesAnonymousPerspective,
  })
  const normalizedSearchQuery = search.q?.trim() ?? ""
  const isSearching = normalizedSearchQuery.length > 0
  const isRemoteSearchEligible = isRemoteMarketSearchEligible(
    normalizedSearchQuery
  )
  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    catalogSource: effectiveCatalogSource,
    perspectivePubkey:
      status === "connected" && pubkey ? pubkey : guestMarket.perspectivePubkey,
    authenticatedPubkey: status === "connected" ? pubkey : null,
    seedAuthorPubkeys: guestMarket.seedAuthorPubkeys,
    sort: "newest",
    networkEnabled: !isSearching,
  })
  const catalogAuthorPubkeys = productsQuery.catalogAuthorPubkeys
  const globalSearchEnabled =
    isRemoteSearchEligible && catalogAuthorPubkeys !== undefined
  // Merchant and category facets filter this response locally, preserving rank
  // without repeating the same relay search when a selection changes.
  const globalSearchKey = getGlobalProductSearchQueryKey({
    query: normalizedSearchQuery,
    pubkey,
    catalogSource: effectiveCatalogSource,
    anonymous: usesAnonymousPerspective,
    authorPubkeys: catalogAuthorPubkeys,
  })
  const globalSearchQuery = useQuery({
    ...MARKET_SEARCH_QUERY_POLICY,
    queryKey: globalSearchKey,
    queryFn: ({ signal }) =>
      getMarketplaceProducts({
        authenticatedPubkey: status === "connected" ? pubkey : null,
        shouldContinue: () => !signal.aborted && shouldContinueAccountRead(),
        signal,
        textQuery: normalizedSearchQuery,
        searchIndex: true,
        authorPubkeys: catalogAuthorPubkeys,
        onProgress: (snapshot) => {
          if (!signal.aborted && shouldContinueAccountRead())
            queryClient.setQueryData(globalSearchKey, snapshot)
        },
        readPolicy: {
          maxRelays: 12,
          connectTimeoutMs: 4_000,
          fetchTimeoutMs: 8_000,
        },
      }),
    enabled: globalSearchEnabled,
    staleTime: 20_000,
  })
  const globalSearchProducts = useMemo(
    () => globalSearchQuery.data?.data.map((record) => record.product) ?? [],
    [globalSearchQuery.data]
  )
  const cachedSearchProducts = useMemo(
    () =>
      filterProductsByFacets(productsQuery.products, {
        q: normalizedSearchQuery,
        merchants: selectedMerchants,
        tags: selectedTags,
      }),
    [
      productsQuery.products,
      normalizedSearchQuery,
      selectedMerchants,
      selectedTags,
    ]
  )
  const isShowingCachedSearch =
    isSearching && !globalSearchQuery.data && cachedSearchProducts.length > 0
  const familiesByProductId = useMemo(() => {
    const families = { ...productsQuery.familiesByProductId }
    for (const record of globalSearchQuery.data?.data ?? []) {
      if (record.family) families[record.product.id] = record.family
    }
    return families
  }, [globalSearchQuery.data, productsQuery.familiesByProductId])
  const productData = useMemo(
    () =>
      isSearching
        ? isShowingCachedSearch
          ? cachedSearchProducts
          : globalSearchProducts
        : productsQuery.products,
    [
      isSearching,
      isShowingCachedSearch,
      cachedSearchProducts,
      globalSearchProducts,
      productsQuery.products,
    ]
  )
  const merchantCandidateProducts = useMemo(
    () =>
      globalSearchEnabled
        ? mergeProductSearchResults(
            productsQuery.products,
            globalSearchProducts
          )
        : productsQuery.products,
    [globalSearchEnabled, globalSearchProducts, productsQuery.products]
  )
  const refreshCatalog = productsQuery.refetch
  const refreshGuestDiscovery = guestMarket.refetch
  const refreshGlobalSearch = globalSearchQuery.refetch
  const refetch = useCallback(async () => {
    if (isSearching && !isRemoteSearchEligible) return
    await refreshMarketBrowseData({
      globalSearchEnabled,
      refreshDiscovery: usesAnonymousPerspective
        ? refreshGuestDiscovery
        : undefined,
      refreshCatalog,
      refreshGlobalSearch,
    })
  }, [
    globalSearchEnabled,
    isSearching,
    isRemoteSearchEligible,
    refreshCatalog,
    refreshGlobalSearch,
    refreshGuestDiscovery,
    usesAnonymousPerspective,
  ])
  const preparedProductsQuery = {
    ...productsQuery,
    isInitialLoading:
      isSearching && isRemoteSearchEligible
        ? !isShowingCachedSearch &&
          (!globalSearchEnabled ||
            (productData.length === 0 && globalSearchQuery.isPending))
        : productsQuery.isInitialLoading,
    isHydrating: isSearching
      ? globalSearchEnabled && globalSearchQuery.isFetching
      : productsQuery.isHydrating ||
        (usesAnonymousPerspective && guestMarket.isRefreshing),
    error: isSearching ? globalSearchQuery.error : productsQuery.error,
    isRefreshStale: isSearching
      ? isRemoteSearchEligible &&
        (isShowingCachedSearch ||
          productsQuery.discoveryStale ||
          (usesAnonymousPerspective && guestMarket.stale) ||
          !!globalSearchQuery.error ||
          globalSearchQuery.isPaused ||
          !!globalSearchQuery.data?.meta.degraded ||
          !!globalSearchQuery.data?.meta.capped)
      : isMarketBrowseRefreshStale({
          catalogMeta: productsQuery.meta,
          catalogError: productsQuery.error,
          catalogPaused: productsQuery.isRefreshPaused,
          discoveryStale:
            productsQuery.discoveryStale ||
            (usesAnonymousPerspective && guestMarket.stale),
          globalSearchEnabled: false,
          globalSearchMeta: undefined,
          globalSearchError: null,
          globalSearchPaused: false,
        }),
    refetch,
  }
  const allMerchantPubkeys = useMemo(() => {
    if (merchantCandidateProducts.length === 0) return []
    const set = new Set<string>()
    for (const product of merchantCandidateProducts) set.add(product.pubkey)
    return Array.from(set).sort()
  }, [merchantCandidateProducts])
  const filteredProducts = useMemo(
    () =>
      filterProductsByFacets(productData, {
        q: isSearching ? undefined : search.q,
        merchants: selectedMerchants,
        tags: selectedTags,
      }),
    [isSearching, productData, search.q, selectedMerchants, selectedTags]
  )
  const hasUnavailablePriceForSort = useMemo(
    () =>
      !isSearching &&
      hasUnavailablePriceForBrowseSort(
        filteredProducts,
        search.sort,
        btcUsdRate,
        familiesByProductId
      ),
    [
      btcUsdRate,
      familiesByProductId,
      filteredProducts,
      isSearching,
      search.sort,
    ]
  )
  const filtered = useMemo(
    () =>
      isSearching
        ? filteredProducts
        : sortBrowseProducts(
            filteredProducts,
            search.sort,
            btcUsdRate,
            familiesByProductId,
            shopperPresets.discoveryDestination
          ),
    [
      btcUsdRate,
      familiesByProductId,
      filteredProducts,
      isSearching,
      search.sort,
      shopperPresets.discoveryDestination,
    ]
  )
  const visibleProducts = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  )
  const visibleMerchantPubkeys = useMemo(
    () => Array.from(new Set(visibleProducts.map((product) => product.pubkey))),
    [visibleProducts]
  )
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const merchantIdentities = useMerchantIdentities({
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    allMerchantPubkeys,
    // Hydrate off-screen merchants (the rest of the store dropdown) in parallel
    // with product streaming instead of waiting for hydration to settle, so the
    // store list shows names/avatars rather than bare npubs when first opened.
    deferBackgroundHydration: false,
    visibleMerchantPubkeys,
    relayHintsByPubkey: productsQuery.profileRelayHintsByPubkey,
  })
  const getMerchantIdentity = merchantIdentities.getIdentity
  const categoryFacetProducts = useMemo(
    () =>
      filterProductsByFacets(productData, {
        q: isSearching ? undefined : search.q,
        merchants: selectedMerchants,
      }),
    [isSearching, productData, search.q, selectedMerchants]
  )
  const categoryFacetOptions = useMemo(
    () =>
      getCategoryFacetOptions(productData, {
        q: isSearching ? undefined : search.q,
        merchants: selectedMerchants,
        tags: selectedTags,
      }),
    [isSearching, productData, search.q, selectedMerchants, selectedTags]
  )
  const storeFacetOptions = useMemo(
    () =>
      getStoreFacetOptions(
        productData,
        {
          q: isSearching ? undefined : search.q,
          merchants: selectedMerchants,
          tags: selectedTags,
        },
        (merchantPubkey) => getMerchantIdentity(merchantPubkey).displayName
      ),
    [
      getMerchantIdentity,
      isSearching,
      productData,
      search.q,
      selectedMerchants,
      selectedTags,
    ]
  )
  /**
   * Storefronts whose own name matches the text query, taken from the same
   * discovered catalog. Product filtering stays product-only; this list is a
   * separate answer to "did you mean this store?".
   */
  const matchingSellers = useMemo(() => {
    const query = search.q?.trim() ?? ""
    if (!query) return []
    return filterSellersByName(
      groupDiscoveredSellers(merchantCandidateProducts),
      getMerchantIdentity,
      query
    )
  }, [getMerchantIdentity, merchantCandidateProducts, search.q])
  const storeFacetSortProducts = useMemo(
    () =>
      filterProductsByFacets(productData, {
        q: isSearching ? undefined : search.q,
        tags: selectedTags,
      }),
    [isSearching, productData, search.q, selectedTags]
  )
  const visibleStoreFacetOptions = useMemo(
    () =>
      storeMenuOpen
        ? sortStoreFacetOptionsByRecentPublisher(
            storeFacetOptions,
            storeFacetSortProducts
          )
        : storeFacetOptions,
    [storeFacetOptions, storeFacetSortProducts, storeMenuOpen]
  )
  const storeFacetTotal = storeFacetSortProducts.length
  const productCards: MarketProductCardView[] = useMemo(
    () =>
      visibleProducts.map((product) => ({
        product,
        family: familiesByProductId[product.id],
        merchant: getMerchantIdentity(product.pubkey),
      })),
    [familiesByProductId, getMerchantIdentity, visibleProducts]
  )
  const searchKey = useMemo(
    () =>
      getBrowseSearchKey({
        q: search.q,
        source: effectiveCatalogSource,
        selectedMerchants,
        selectedTags,
        sort: search.sort,
      }),
    [
      effectiveCatalogSource,
      search.q,
      search.sort,
      selectedMerchants,
      selectedTags,
    ]
  )

  return {
    auth: { pubkey, status },
    isSearching,
    isRemoteSearchEligible,
    isShowingCachedSearch,
    searchTagScopeVerified:
      selectedTags.length > 0
        ? false
        : globalSearchQuery.data?.meta.productSearch?.tagScopeVerified,
    catalogSource: effectiveCatalogSource,
    categoryFacetOptions,
    categoryFacetTotal: categoryFacetProducts.length,
    filtered,
    filteredProducts,
    hasActiveFilters: !!(
      search.q ||
      selectedTags.length > 0 ||
      search.sort ||
      selectedMerchants.length > 0
    ),
    hasMore: visibleCount < filtered.length,
    hasUnavailablePriceForSort,
    matchingSellers,
    isUpdatingListings: preparedProductsQuery.isHydrating,
    productCards,
    productData,
    productsQuery: preparedProductsQuery,
    searchKey,
    selectedMerchants,
    selectedMerchantSet,
    selectedTags,
    selectedTagSet,
    shouldShowCategories:
      categoryFacetOptions.length > 0 ||
      (productsQuery.isInitialLoading && categoryFacetOptions.length === 0),
    showCategorySkeleton:
      productsQuery.isInitialLoading && categoryFacetOptions.length === 0,
    storeFacetOptions: visibleStoreFacetOptions,
    storeFacetTotal,
    storeTriggerLabel: getStoreTriggerLabel(selectedMerchants),
    visibleProducts,
    getMerchantIdentity,
  }
}
