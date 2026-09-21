import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useAuth, useProfileSearch } from "@conduit/core"
import {
  ACCOUNT_SEARCH_CANDIDATE_LIMIT,
  ACCOUNT_SUGGESTION_LIMIT,
  limitAccountMatches,
} from "../lib/accountSearch"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"
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
  query: string
  accountSearchSettleMs?: number
}) {
  const { pubkey, status, authGeneration } = useAuth()
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
    perspectivePubkey: connected ? pubkey : guestMarket.perspectivePubkey,
    authenticatedPubkey: connected ? pubkey : null,
    seedAuthorPubkeys: guestMarket.seedAuthorPubkeys,
    sort: "newest",
  })
  const sellers = useMemo(
    () => groupDiscoveredSellers(productsQuery.products),
    [productsQuery.products]
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
    relayHintsByPubkey: productsQuery.profileRelayHintsByPubkey,
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
  const isFetching = productsQuery.isInitialLoading || productsQuery.isHydrating
  const isUnavailable = isSellerDirectoryUnavailable({
    hasSellers: sellers.length > 0,
    isFetching,
    error: productsQuery.error,
    meta: productsQuery.meta,
    isRefreshPaused: productsQuery.isRefreshPaused,
    discoveryStale: productsQuery.discoveryStale,
  })
  const catalogEvidenceIncomplete = isSellerCatalogEvidenceIncomplete({
    error: productsQuery.error,
    meta: productsQuery.meta,
    isRefreshPaused: productsQuery.isRefreshPaused,
    discoveryStale: productsQuery.discoveryStale,
  })
  const refreshCatalog = productsQuery.refetch
  const refreshGuestDiscovery = guestMarket.refetch
  const refreshAccountSearch = accountSearch.refetch
  const retry = useCallback(() => {
    if (!connected) void refreshGuestDiscovery()
    refreshCatalog()
    refreshAccountSearch()
  }, [connected, refreshAccountSearch, refreshCatalog, refreshGuestDiscovery])

  return {
    connected,
    effectiveSource,
    eligibilityState,
    catalogProducts: productsQuery.products,
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
