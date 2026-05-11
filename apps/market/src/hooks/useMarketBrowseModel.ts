import { useMemo } from "react"
import { useAuth, type PricingRateInput } from "@conduit/core"
import {
  filterProductsByFacets,
  getCategoryFacetOptions,
  getStoreFacetOptions,
} from "../lib/facets"
import {
  getBrowseSearchKey,
  getStoreTriggerLabel,
  hasUnavailablePriceForBrowseSort,
  sortBrowseProducts,
  sortStoreFacetOptionsByRecentPublisher,
  type MarketBrowseSearch,
  type MarketProductCardView,
} from "../lib/marketBrowseModel"
import { useGuestMarketDiscovery } from "./useGuestMarketDiscovery"
import { useMerchantIdentities } from "./useMerchantIdentities"
import { useProgressiveProducts } from "./useProgressiveProducts"

interface UseMarketBrowseModelInput {
  btcUsdRate: PricingRateInput
  search: MarketBrowseSearch
  storeMenuOpen: boolean
  visibleCount: number
}

export function useMarketBrowseModel({
  btcUsdRate,
  search,
  storeMenuOpen,
  visibleCount,
}: UseMarketBrowseModelInput) {
  const { pubkey, status } = useAuth()
  const selectedMerchants = useMemo(
    () => search.merchant ?? [],
    [search.merchant]
  )
  const selectedMerchantSet = useMemo(
    () => new Set(selectedMerchants),
    [selectedMerchants]
  )
  const selectedTags = useMemo(() => search.tag ?? [], [search.tag])
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags])
  const usesAnonymousPerspective = status !== "connected"
  const guestMarket = useGuestMarketDiscovery({
    enabled: usesAnonymousPerspective,
  })
  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    perspectivePubkey:
      status === "connected" && pubkey ? pubkey : guestMarket.perspectivePubkey,
    seedAuthorPubkeys: guestMarket.seedAuthorPubkeys,
    sort: "newest",
  })
  const productData = productsQuery.products
  const allMerchantPubkeys = useMemo(() => {
    if (productData.length === 0) return []
    const set = new Set<string>()
    for (const product of productData) set.add(product.pubkey)
    return Array.from(set).sort()
  }, [productData])
  const filteredProducts = useMemo(
    () =>
      filterProductsByFacets(productData, {
        q: search.q,
        merchants: selectedMerchants,
        tags: selectedTags,
      }),
    [productData, search.q, selectedMerchants, selectedTags]
  )
  const hasUnavailablePriceForSort = useMemo(
    () =>
      hasUnavailablePriceForBrowseSort(
        filteredProducts,
        search.sort,
        btcUsdRate
      ),
    [btcUsdRate, filteredProducts, search.sort]
  )
  const filtered = useMemo(
    () => sortBrowseProducts(filteredProducts, search.sort, btcUsdRate),
    [btcUsdRate, filteredProducts, search.sort]
  )
  const visibleProducts = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  )
  const visibleMerchantPubkeys = useMemo(
    () => Array.from(new Set(visibleProducts.map((product) => product.pubkey))),
    [visibleProducts]
  )
  const merchantIdentities = useMerchantIdentities({
    allMerchantPubkeys,
    visibleMerchantPubkeys,
    relayHintsByPubkey: productsQuery.profileRelayHintsByPubkey,
  })
  const getMerchantIdentity = merchantIdentities.getIdentity
  const categoryFacetOptions = useMemo(
    () =>
      getCategoryFacetOptions(productData, {
        q: search.q,
        merchants: selectedMerchants,
        tags: selectedTags,
      }),
    [productData, search.q, selectedMerchants, selectedTags]
  )
  const storeFacetOptions = useMemo(
    () =>
      getStoreFacetOptions(
        productData,
        {
          q: search.q,
          merchants: selectedMerchants,
          tags: selectedTags,
        },
        (merchantPubkey) => getMerchantIdentity(merchantPubkey).displayName
      ),
    [
      getMerchantIdentity,
      productData,
      search.q,
      selectedMerchants,
      selectedTags,
    ]
  )
  const storeFacetSortProducts = useMemo(
    () =>
      filterProductsByFacets(productData, {
        q: search.q,
        tags: selectedTags,
      }),
    [productData, search.q, selectedTags]
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
        merchant: getMerchantIdentity(product.pubkey),
      })),
    [getMerchantIdentity, visibleProducts]
  )
  const searchKey = useMemo(
    () =>
      getBrowseSearchKey({
        q: search.q,
        selectedMerchants,
        selectedTags,
        sort: search.sort,
      }),
    [search.q, search.sort, selectedMerchants, selectedTags]
  )

  return {
    auth: { pubkey, status },
    categoryFacetOptions,
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
    isUpdatingListings:
      !productsQuery.isInitialLoading && productsQuery.isHydrating,
    productCards,
    productData,
    productsQuery,
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
