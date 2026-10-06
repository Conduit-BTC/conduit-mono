import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getMarketplaceProducts,
  getLocalProductDeletionSnapshot,
  reconcileProductRecordsWithDeletions,
  subscribeLocalProductDeletionChanges,
  useAuth,
  useProfileSearch,
} from "@conduit/core"
import {
  ACCOUNT_SEARCH_CANDIDATE_LIMIT,
  ACCOUNT_SUGGESTION_LIMIT,
  limitAccountMatches,
} from "../lib/accountSearch"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"
import {
  getMerchantIdentityView,
  mergeProductSearchResults,
} from "../lib/marketBrowseModel"
import {
  getProductSourceRelayHintsByPubkey,
  getPagedMerchantPubkeys,
  mergeRelayHintsByPubkey,
} from "../lib/clientHydration"
import {
  isRemoteMarketSearchEligible,
  MARKET_SEARCH_QUERY_POLICY,
} from "../lib/searchPolicy"
import {
  excludeDiscoveredSellers,
  filterSellersByName,
  getSellerEligibilityState,
  groupDiscoveredSellers,
  isSellerCatalogEvidenceIncomplete,
  isSellerDirectoryUnavailable,
} from "../lib/sellerDirectory"
import { useMerchantIdentities } from "./useMerchantIdentities"
import { useProgressiveProducts } from "./useProgressiveProducts"

export function useSellerDirectory(input: {
  catalogSource: ProductCatalogSourceMode
  enabled?: boolean
  /** Header suggestions reuse the local catalog instead of opening a stream. */
  networkEnabled?: boolean
  /** One bounded discovery pass when no page owns catalog discovery. */
  fallbackNetworkEnabled?: boolean
  fallbackNetworkAllowed?: boolean
  query: string
  accountSearchSettleMs?: number
  /** Header suggestions use scoped account search, not every seller profile. */
  hydrateSellerProfiles?: boolean
  visibleSellerCount?: number
}) {
  const { pubkey, status, authGeneration } = useAuth()
  const queryClient = useQueryClient()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const connected = status === "connected" && !!pubkey
  const enabled = input.enabled ?? true
  const effectiveSource: ProductCatalogSourceMode = connected
    ? input.catalogSource
    : "conduit"
  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    catalogSource: effectiveSource,
    enabled,
    networkEnabled: input.networkEnabled,
    perspectivePubkey: connected ? pubkey : null,
    authenticatedPubkey: connected ? pubkey : null,
    sort: "newest",
  })
  // Text only filters these products locally; typing must not repeat discovery.
  const fallbackQueryKey = useMemo(
    () => [
      "header-catalog-fallback",
      connected ? pubkey : null,
      authGeneration,
      effectiveSource,
      productsQuery.catalogAuthorPubkeys,
    ],
    [
      authGeneration,
      connected,
      effectiveSource,
      productsQuery.catalogAuthorPubkeys,
      pubkey,
    ]
  )
  const cacheOnly = input.networkEnabled === false
  const fallbackAllowed = cacheOnly && input.fallbackNetworkAllowed !== false
  const observeCatalogDeletions = useCallback(
    (onChange: () => void) =>
      enabled && cacheOnly
        ? subscribeLocalProductDeletionChanges(onChange)
        : () => {},
    [enabled, cacheOnly]
  )
  const localDeletions = useSyncExternalStore(
    observeCatalogDeletions,
    getLocalProductDeletionSnapshot
  )
  const fallbackReady =
    fallbackAllowed &&
    productsQuery.catalogAuthorPubkeys !== undefined &&
    !productsQuery.isInitialLoading
  const fallbackQuery = useQuery({
    ...MARKET_SEARCH_QUERY_POLICY,
    queryKey: fallbackQueryKey,
    queryFn: ({ signal }) =>
      getMarketplaceProducts({
        authorPubkeys: productsQuery.catalogAuthorPubkeys ?? [],
        accountPubkey: connected ? pubkey : null,
        authenticatedPubkey: connected ? pubkey : null,
        signal,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
        limit: 100,
        readPolicy: {
          maxRelays: 8,
          connectTimeoutMs: 1_200,
          fetchTimeoutMs: 2_500,
        },
      }),
    enabled:
      enabled &&
      fallbackReady &&
      input.fallbackNetworkEnabled === true &&
      isSellerCatalogEvidenceIncomplete({
        error: productsQuery.error,
        meta: productsQuery.meta,
        isRefreshPaused: productsQuery.isRefreshPaused,
        discoveryStale: productsQuery.discoveryStale,
      }),
    staleTime: 60_000,
  })
  useEffect(() => {
    // Stop discovery when suggestions close or a page takes over the catalog.
    // A text edit alone keeps this bounded pass alive for the next local filter.
    if (
      input.networkEnabled === false &&
      (!enabled || input.fallbackNetworkAllowed === false)
    )
      void queryClient.cancelQueries({
        queryKey: fallbackQueryKey,
        exact: true,
      })
  }, [
    enabled,
    fallbackQueryKey,
    input.fallbackNetworkAllowed,
    input.networkEnabled,
    queryClient,
  ])
  const catalogProducts = useMemo(
    () =>
      !cacheOnly
        ? productsQuery.products
        : mergeProductSearchResults(
            reconcileProductRecordsWithDeletions(
              fallbackAllowed ? (fallbackQuery.data?.data ?? []) : [],
              localDeletions.evidence
            ).map((record) => record.product),
            reconcileProductRecordsWithDeletions(
              productsQuery.cachedProductRecords,
              localDeletions.evidence
            ).map((record) => record.product)
          ),
    [
      cacheOnly,
      fallbackAllowed,
      fallbackQuery.data,
      localDeletions.evidence,
      productsQuery.cachedProductRecords,
      productsQuery.products,
    ]
  )
  const profileRelayHintsByPubkey = useMemo(
    () =>
      mergeRelayHintsByPubkey(
        productsQuery.profileRelayHintsByPubkey,
        getProductSourceRelayHintsByPubkey(fallbackQuery.data)
      ),
    [fallbackQuery.data, productsQuery.profileRelayHintsByPubkey]
  )
  const sellers = useMemo(
    () => groupDiscoveredSellers(catalogProducts),
    [catalogProducts]
  )
  const sellerPubkeys = useMemo(
    () => sellers.map((seller) => seller.pubkey),
    [sellers]
  )
  const identities = useMerchantIdentities({
    accountPubkey: connected ? pubkey : null,
    authenticatedPubkey: connected ? pubkey : null,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    allMerchantPubkeys: sellerPubkeys,
    visibleMerchantPubkeys:
      input.hydrateSellerProfiles === false
        ? []
        : getPagedMerchantPubkeys(
            sellerPubkeys,
            input.visibleSellerCount ?? 12
          ),
    deferBackgroundHydration: input.hydrateSellerProfiles === false,
    backgroundHydrationPubkeys: [],
    relayHintsByPubkey: profileRelayHintsByPubkey,
  })
  const query = input.query.trim()
  const eligibleAuthorPubkeys = productsQuery.catalogAuthorPubkeys
  const eligibilityState = getSellerEligibilityState({
    authorPubkeys: eligibleAuthorPubkeys,
    source: effectiveSource,
    followLookupStatus: productsQuery.followLookupStatus,
    discoveryStale: productsQuery.discoveryStale,
  })
  const accountSearch = useProfileSearch(query, {
    enabled: enabled && eligibleAuthorPubkeys !== undefined,
    limit: ACCOUNT_SEARCH_CANDIDATE_LIMIT,
    settleMs: input.accountSearchSettleMs,
    accountPubkey: connected ? pubkey : null,
    authorPubkeys: eligibleAuthorPubkeys,
  })
  const accountSellerProfiles = useMemo(() => {
    const known = new Set(sellerPubkeys)
    return Object.fromEntries(
      (accountSearch.data?.matches ?? [])
        .filter((match) => known.has(match.pubkey))
        .map((match) => [match.pubkey, match.profile])
    )
  }, [accountSearch.data, sellerPubkeys])
  const getBaseIdentity = identities.getIdentity
  const getIdentity = useCallback(
    (sellerPubkey: string) => {
      const profile = accountSellerProfiles[sellerPubkey]
      return profile
        ? getMerchantIdentityView(
            sellerPubkey,
            profile,
            profileRelayHintsByPubkey[sellerPubkey]
          )
        : getBaseIdentity(sellerPubkey)
    },
    [accountSellerProfiles, getBaseIdentity, profileRelayHintsByPubkey]
  )
  const filteredSellers = useMemo(
    () => filterSellersByName(sellers, getIdentity, query),
    [getIdentity, query, sellers]
  )
  const networkAccounts = useMemo(
    () =>
      limitAccountMatches(
        excludeDiscoveredSellers(accountSearch.data?.matches ?? [], sellers),
        ACCOUNT_SUGGESTION_LIMIT
      ),
    [accountSearch.data, sellers]
  )
  const isFetching =
    productsQuery.isInitialLoading ||
    productsQuery.isHydrating ||
    fallbackQuery.isFetching
  const catalogError = productsQuery.error ?? fallbackQuery.error
  const catalogMeta = !fallbackAllowed
    ? productsQuery.meta
    : (fallbackQuery.data?.meta ?? productsQuery.meta)
  const isUnavailable = isSellerDirectoryUnavailable({
    hasSellers: sellers.length > 0,
    isFetching,
    error: catalogError,
    meta: catalogMeta,
    isRefreshPaused: productsQuery.isRefreshPaused,
    discoveryStale: productsQuery.discoveryStale,
  })
  const catalogEvidenceIncomplete = isSellerCatalogEvidenceIncomplete({
    error: catalogError,
    meta: catalogMeta,
    isRefreshPaused: productsQuery.isRefreshPaused,
    discoveryStale: productsQuery.discoveryStale,
  })
  const refreshCatalog = productsQuery.refetch
  const refreshFallback = fallbackQuery.refetch
  const refreshAccountSearch = accountSearch.refetch
  const retry = useCallback(() => {
    const remoteSearchEligible = isRemoteMarketSearchEligible(query)
    if (input.fallbackNetworkEnabled && fallbackReady) void refreshFallback()
    else refreshCatalog()
    if (remoteSearchEligible) refreshAccountSearch()
  }, [
    fallbackReady,
    input.fallbackNetworkEnabled,
    query,
    refreshAccountSearch,
    refreshCatalog,
    refreshFallback,
  ])

  return {
    connected,
    effectiveSource,
    eligibilityState,
    catalogProducts,
    catalogEvidenceIncomplete,
    isFetching,
    isUnavailable,
    retry,
    sellers,
    filteredSellers,
    getIdentity,
    query,
    accountSearch,
    networkAccounts,
  }
}
