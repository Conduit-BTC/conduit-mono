import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getMarketplaceProducts,
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
  getProductSourceRelayHintsByPubkey,
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
import { useGuestMarketDiscovery } from "./useGuestMarketDiscovery"
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
  const guestMarket = useGuestMarketDiscovery({
    enabled: enabled && !connected,
  })
  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    catalogSource: effectiveSource,
    enabled,
    networkEnabled: input.networkEnabled,
    perspectivePubkey: connected ? pubkey : guestMarket.perspectivePubkey,
    authenticatedPubkey: connected ? pubkey : null,
    seedAuthorPubkeys: guestMarket.seedAuthorPubkeys,
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
  const fallbackReady =
    input.fallbackNetworkAllowed !== false &&
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
      productsQuery.products.length === 0,
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
      productsQuery.products.length > 0
        ? productsQuery.products
        : (fallbackQuery.data?.data.map((record) => record.product) ??
          productsQuery.products),
    [fallbackQuery.data, productsQuery.products]
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
    visibleMerchantPubkeys: sellerPubkeys,
    relayHintsByPubkey: profileRelayHintsByPubkey,
  })
  const query = input.query.trim()
  const filteredSellers = useMemo(
    () => filterSellersByName(sellers, identities.getIdentity, query),
    [identities.getIdentity, query, sellers]
  )
  const eligibleAuthorPubkeys = productsQuery.catalogAuthorPubkeys
  const eligibilityState = getSellerEligibilityState({
    authorPubkeys: eligibleAuthorPubkeys,
    source: effectiveSource,
    followLookupStatus: productsQuery.followLookupStatus,
    discoveryStale:
      productsQuery.discoveryStale || (!connected && guestMarket.stale),
  })
  const accountSearch = useProfileSearch(query, {
    enabled: enabled && eligibleAuthorPubkeys !== undefined,
    limit: ACCOUNT_SEARCH_CANDIDATE_LIMIT,
    settleMs: input.accountSearchSettleMs,
    accountPubkey: connected ? pubkey : null,
    authorPubkeys: eligibleAuthorPubkeys,
  })
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
  const catalogMeta =
    productsQuery.products.length > 0
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
  const refreshGuestDiscovery = guestMarket.refetch
  const refreshAccountSearch = accountSearch.refetch
  const retry = useCallback(() => {
    const remoteSearchEligible = isRemoteMarketSearchEligible(query)
    if (input.networkEnabled === false && !remoteSearchEligible) return
    if (!connected) void refreshGuestDiscovery()
    if (input.fallbackNetworkEnabled && fallbackReady) void refreshFallback()
    else refreshCatalog()
    if (remoteSearchEligible) refreshAccountSearch()
  }, [
    connected,
    fallbackReady,
    input.networkEnabled,
    input.fallbackNetworkEnabled,
    query,
    refreshAccountSearch,
    refreshCatalog,
    refreshFallback,
    refreshGuestDiscovery,
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
    getIdentity: identities.getIdentity,
    query,
    accountSearch,
    networkAccounts,
  }
}
