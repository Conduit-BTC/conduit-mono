import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getMarketplaceProducts,
  normalizePubkey,
  useAuth,
  useConduitSession,
  useProfileSearch,
  type PricingRateInput,
} from "@conduit/core"
import { filterProductsByFacets, getCategoryFacetOptions } from "../lib/facets"
import {
  getBrowseSearchKey,
  getGlobalProductSearchQueryKey,
  getStoreTriggerLabel,
  getMerchantIdentityView,
  hasUnavailablePriceForBrowseSort,
  isMarketBrowseRefreshStale,
  mergeProductSearchResults,
  sortBrowseProducts,
  type MarketBrowseSearch,
  type MarketProductCardView,
} from "../lib/marketBrowseModel"
import { ACCOUNT_SEARCH_CANDIDATE_LIMIT } from "../lib/accountSearch"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"
import {
  getBrowseBackgroundHydrationPubkeys,
  getPagedMerchantPubkeys,
  MERCHANT_SEARCH_PREVIEW_SIZE,
} from "../lib/clientHydration"
import {
  isRemoteMarketSearchEligible,
  MARKET_SEARCH_QUERY_POLICY,
} from "../lib/searchPolicy"
import {
  filterSellersByName,
  getMerchantNameSearchFeedback,
} from "../lib/sellerDirectory"
import { useShopperPresets } from "./useShopperPresets"
import { useMerchantIdentities } from "./useMerchantIdentities"
import { useProgressiveProducts } from "./useProgressiveProducts"
import { useMarketplaceBrowseRead } from "./useMarketplaceBrowseRead"

interface UseMarketBrowseModelInput {
  btcUsdRate: PricingRateInput
  catalogSource: ProductCatalogSourceMode
  search: MarketBrowseSearch
  storeMenuOpen: boolean
  merchantQuery: string
  visibleMerchantCount: number
  visibleCount: number
}

export function useMarketBrowseModel({
  btcUsdRate,
  catalogSource,
  search,
  storeMenuOpen,
  merchantQuery,
  visibleMerchantCount,
  visibleCount,
}: UseMarketBrowseModelInput) {
  const { pubkey, status, authGeneration } = useAuth()
  const queryClient = useQueryClient()
  const session = useConduitSession()
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
  const normalizedSearchQuery = search.q?.trim() ?? ""
  const isSearching = normalizedSearchQuery.length > 0
  const isRemoteSearchEligible = isRemoteMarketSearchEligible(
    normalizedSearchQuery
  )
  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    catalogSource: effectiveCatalogSource,
    perspectivePubkey: status === "connected" && pubkey ? pubkey : null,
    authenticatedPubkey: status === "connected" ? pubkey : null,
    sort: "newest",
    networkEnabled: false,
    cacheEnabled: isSearching,
  })
  const browseRead = useMarketplaceBrowseRead({
    scope: productsQuery,
    search: { ...search, merchant: selectedMerchants },
    accountPubkey: status === "connected" ? pubkey : null,
    authGeneration,
    shouldContinue: shouldContinueAccountRead,
    visibleCount,
  })
  const browseProducts = useMemo(
    () => browseRead.records.map((row) => row.product),
    [browseRead.records]
  )
  const catalogAuthorPubkeys = productsQuery.catalogAuthorPubkeys
  const globalSearchEnabled =
    isRemoteSearchEligible && catalogAuthorPubkeys !== undefined
  // Each explicit scope gets its own ranked read across the eligible catalog.
  const catalogAuthorSet = useMemo(
    () => new Set(catalogAuthorPubkeys),
    [catalogAuthorPubkeys]
  )
  const globalSearchKey = getGlobalProductSearchQueryKey({
    query: normalizedSearchQuery,
    pubkey,
    catalogSource: effectiveCatalogSource,
    anonymous: usesAnonymousPerspective,
    authorPubkeys: catalogAuthorPubkeys,
  })
  const globalSearchQuery = useQuery({
    ...MARKET_SEARCH_QUERY_POLICY,
    queryKey: [
      ...globalSearchKey,
      selectedMerchants,
      selectedTags,
      authGeneration,
      session.relayScope,
    ],
    queryFn: ({ signal }) =>
      getMarketplaceProducts({
        authenticatedPubkey: status === "connected" ? pubkey : null,
        shouldContinue: () => !signal.aborted && shouldContinueAccountRead(),
        signal,
        textQuery: normalizedSearchQuery,
        searchIndex: true,
        authorPubkeys: selectedMerchants.length
          ? selectedMerchants.filter((author) => catalogAuthorSet.has(author))
          : catalogAuthorPubkeys,
        tags: selectedTags,
        onProgress: (snapshot) => {
          if (!signal.aborted && shouldContinueAccountRead())
            queryClient.setQueryData(
              [
                ...globalSearchKey,
                selectedMerchants,
                selectedTags,
                authGeneration,
                session.relayScope,
              ],
              snapshot
            )
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
    for (const record of [
      ...browseRead.records,
      ...(globalSearchQuery.data?.data ?? []),
    ]) {
      if (record.family) families[record.product.id] = record.family
    }
    return families
  }, [
    globalSearchQuery.data,
    productsQuery.familiesByProductId,
    browseRead.records,
  ])
  const productData = useMemo(
    () =>
      isSearching
        ? isShowingCachedSearch
          ? cachedSearchProducts
          : globalSearchProducts
        : browseProducts,
    [
      browseProducts,
      isSearching,
      isShowingCachedSearch,
      cachedSearchProducts,
      globalSearchProducts,
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
  const refreshScope = productsQuery.refetch
  const refreshCatalog = browseRead.pages.refetch
  const refreshGlobalSearch = globalSearchQuery.refetch
  const refetch = useCallback(async () => {
    await Promise.all([
      refreshScope(),
      !isSearching ? refreshCatalog() : undefined,
      globalSearchEnabled ? refreshGlobalSearch() : undefined,
    ])
  }, [
    globalSearchEnabled,
    isSearching,
    refreshScope,
    refreshCatalog,
    refreshGlobalSearch,
  ])
  const preparedProductsQuery = {
    ...productsQuery,
    isInitialLoading:
      isSearching && isRemoteSearchEligible
        ? !isShowingCachedSearch &&
          (!globalSearchEnabled ||
            (productData.length === 0 && globalSearchQuery.isPending))
        : isSearching
          ? productsQuery.isInitialLoading
          : catalogAuthorPubkeys === undefined ||
            (browseRead.pages.isPending && !productData.length),
    isHydrating:
      isSearching && isRemoteSearchEligible
        ? globalSearchEnabled && globalSearchQuery.isFetching
        : isSearching
          ? productsQuery.isHydrating
          : browseRead.pages.isFetching,
    error:
      isSearching && isRemoteSearchEligible
        ? globalSearchQuery.error
        : isSearching
          ? productsQuery.error
          : browseRead.pages.error,
    isRefreshStale:
      isSearching && isRemoteSearchEligible
        ? isShowingCachedSearch ||
          productsQuery.discoveryStale ||
          !!globalSearchQuery.error ||
          globalSearchQuery.isPaused ||
          !!globalSearchQuery.data?.meta.degraded ||
          !!globalSearchQuery.data?.meta.capped
        : isMarketBrowseRefreshStale({
            catalogMeta: isSearching
              ? productsQuery.meta
              : browseRead.pages.data?.pages.length
                ? {
                    ...browseRead.pages.data.pages[0].meta,
                    capped: browseRead.pages.data.pages.some(
                      (page) => page.meta.capped
                    ),
                    degraded: browseRead.pages.data.pages.some(
                      (page) => page.meta.degraded
                    ),
                  }
                : null,
            catalogError: isSearching
              ? productsQuery.error
              : browseRead.pages.error,
            catalogPaused: productsQuery.isRefreshPaused,
            discoveryStale: productsQuery.discoveryStale,
            globalSearchEnabled: false,
            globalSearchMeta: undefined,
            globalSearchError: null,
            globalSearchPaused: false,
          }),
    refetch,
  }
  const allMerchantPubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...(catalogAuthorPubkeys ?? []),
          ...merchantCandidateProducts.map((product) => product.pubkey),
        ])
      ),
    [catalogAuthorPubkeys, merchantCandidateProducts]
  )
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
      browseRead.scoped &&
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
      browseRead.scoped,
      search.sort,
    ]
  )
  const filtered = useMemo(
    () =>
      sortBrowseProducts(
        filteredProducts,
        browseRead.scoped
          ? (search.sort ?? (isSearching ? "relevance" : "newest"))
          : "newest",
        btcUsdRate,
        familiesByProductId,
        browseRead.mode === "discover"
          ? shopperPresets.discoveryDestination
          : undefined
      ).sort((a, b) =>
        (!browseRead.scoped && browseRead.mode !== "discover") ||
        (browseRead.scoped &&
          ((!isSearching && !search.sort) || search.sort === "newest"))
          ? b.updatedAt - a.updatedAt
          : 0
      ),
    [
      btcUsdRate,
      familiesByProductId,
      filteredProducts,
      isSearching,
      search.sort,
      shopperPresets.discoveryDestination,
      browseRead.scoped,
      browseRead.mode,
    ]
  )
  const visibleProducts = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  )
  const visibleMerchantPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          filtered.slice(0, visibleCount + 24).map((product) => product.pubkey)
        )
      ),
    [filtered, visibleCount]
  )
  const orderedStoreFacets = useMemo(
    () =>
      allMerchantPubkeys.map((pubkey) => ({
        value: pubkey,
        label: pubkey,
        count: browseRead.metadata.data?.merchants[pubkey] ?? 0,
        selected: selectedMerchantSet.has(pubkey),
      })),
    [allMerchantPubkeys, browseRead.metadata.data, selectedMerchantSet]
  )
  const menuMerchantPubkeys = allMerchantPubkeys
  const merchantProfileSearch = useProfileSearch(
    storeMenuOpen ? merchantQuery : normalizedSearchQuery,
    {
      enabled: storeMenuOpen || isSearching,
      authorPubkeys: menuMerchantPubkeys,
      accountPubkey: status === "connected" ? pubkey : null,
      limit: ACCOUNT_SEARCH_CANDIDATE_LIMIT,
    }
  )
  const searchedProfiles = useMemo(
    () =>
      Object.fromEntries(
        (merchantProfileSearch.data?.matches ?? []).map((match) => [
          match.pubkey,
          match.profile,
        ])
      ),
    [merchantProfileSearch.data]
  )
  const backgroundHydrationPubkeys = useMemo(() => {
    return getBrowseBackgroundHydrationPubkeys({
      menuMerchantPubkeys: merchantQuery.trim()
        ? []
        : getPagedMerchantPubkeys(menuMerchantPubkeys, visibleMerchantCount),
      selectedMerchantPubkeys: selectedMerchants,
      searchMerchantPubkeys: getPagedMerchantPubkeys(
        allMerchantPubkeys,
        MERCHANT_SEARCH_PREVIEW_SIZE,
        MERCHANT_SEARCH_PREVIEW_SIZE
      ),
      isSearching,
      storeMenuOpen,
    })
  }, [
    allMerchantPubkeys,
    isSearching,
    menuMerchantPubkeys,
    merchantQuery,
    selectedMerchants,
    storeMenuOpen,
    visibleMerchantCount,
  ])
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const merchantIdentities = useMerchantIdentities({
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    allMerchantPubkeys,
    // Prepare identities for displayed cards and one next page. The menu and
    // seller-name results request additional identities only while in use.
    deferBackgroundHydration: !storeMenuOpen && !isSearching,
    backgroundHydrationPubkeys,
    visibleMerchantPubkeys,
    relayHintsByPubkey: productsQuery.profileRelayHintsByPubkey,
  })
  const getBaseMerchantIdentity = merchantIdentities.getIdentity
  const getMerchantIdentity = useCallback(
    (merchantPubkey: string) => {
      const profile = searchedProfiles[merchantPubkey]
      return profile
        ? getMerchantIdentityView(
            merchantPubkey,
            profile,
            productsQuery.profileRelayHintsByPubkey[merchantPubkey]
          )
        : getBaseMerchantIdentity(merchantPubkey)
    },
    [
      getBaseMerchantIdentity,
      productsQuery.profileRelayHintsByPubkey,
      searchedProfiles,
    ]
  )
  const categoryFacetProducts = useMemo(
    () =>
      filterProductsByFacets(productData, {
        q: isSearching ? undefined : search.q,
        merchants: selectedMerchants,
      }),
    [isSearching, productData, search.q, selectedMerchants]
  )
  const categoryFacetOptions = useMemo(() => {
    const counts = new Map(
      Object.entries(browseRead.metadata.data?.categories ?? {})
    )
    for (const option of getCategoryFacetOptions(productData, {}))
      if (!counts.has(option.value)) counts.set(option.value, option.count)
    for (const tag of [
      "art",
      "books",
      "clothing",
      "food",
      "home",
      "electronics",
      ...selectedTags,
    ])
      if (!counts.has(tag)) counts.set(tag, 0)
    return [...counts]
      .map(([tag, count]) => ({
        value: tag,
        label: tag,
        count,
        selected: selectedTagSet.has(tag),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }, [browseRead.metadata.data, productData, selectedTags, selectedTagSet])
  const storeFacetOptions = useMemo(() => {
    const matching = merchantQuery.trim()
      ? new Set(
          filterSellersByName(
            allMerchantPubkeys.map((pubkey) => ({
              pubkey,
              listingCount: browseRead.metadata.data?.merchants[pubkey] ?? 0,
              latestListingAt: 0,
            })),
            getMerchantIdentity,
            merchantQuery
          ).map((seller) => seller.pubkey)
        )
      : null
    return orderedStoreFacets.filter(
      (option) => !matching || matching.has(option.value)
    )
  }, [
    getMerchantIdentity,
    merchantQuery,
    orderedStoreFacets,
    allMerchantPubkeys,
    browseRead.metadata.data,
  ])
  /**
   * Storefronts whose own name matches the text query, taken from the same
   * discovered catalog. Product filtering stays product-only; this list is a
   * separate answer to "did you mean this store?".
   */
  const matchingSellers = useMemo(() => {
    const query = search.q?.trim() ?? ""
    if (!query) return []
    return filterSellersByName(
      allMerchantPubkeys.map((pubkey) => ({
        pubkey,
        listingCount: browseRead.metadata.data?.merchants[pubkey] ?? 0,
        latestListingAt: 0,
      })),
      getMerchantIdentity,
      query
    )
  }, [
    getMerchantIdentity,
    allMerchantPubkeys,
    browseRead.metadata.data,
    search.q,
  ])
  const visibleStoreFacetOptions = storeFacetOptions
    .slice(0, visibleMerchantCount)
    .map((option) => ({
      ...option,
      label: getMerchantIdentity(option.value).displayName,
    }))
  const merchantSearchStatus = !merchantQuery.trim()
    ? undefined
    : getMerchantNameSearchFeedback({
        evidence: merchantProfileSearch.data?.evidence,
        isFetching: merchantProfileSearch.isFetching,
        matchCount: storeFacetOptions.length,
      }).message
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
        view: search.view,
        older: search.older,
      }),
    [
      effectiveCatalogSource,
      search.q,
      search.sort,
      search.view,
      search.older,
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
    hasMore:
      visibleCount < filtered.length ||
      (!isSearching && !!browseRead.pages.hasNextPage),
    scoped: browseRead.scoped,
    browseMode: browseRead.mode,
    boundaryBlocked:
      browseRead.pages.data?.pages.some((page) => page.boundaryBlocked) ??
      false,
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
    showCategorySkeleton: false,
    storeFacetOptions: visibleStoreFacetOptions,
    hasMoreStoreFacets: storeFacetOptions.length > visibleMerchantCount,
    merchantSearchStatus,
    storeTriggerLabel: getStoreTriggerLabel(selectedMerchants),
    visibleProducts,
    getMerchantIdentity,
  }
}
