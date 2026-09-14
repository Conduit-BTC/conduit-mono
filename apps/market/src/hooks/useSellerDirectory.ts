import { useLayoutEffect, useMemo, useRef } from "react"
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
  groupDiscoveredSellers,
} from "../lib/sellerDirectory"
import { useGuestMarketDiscovery } from "./useGuestMarketDiscovery"
import { useMerchantIdentities } from "./useMerchantIdentities"
import { useProgressiveProducts } from "./useProgressiveProducts"

export function useSellerDirectory(input: {
  catalogSource: ProductCatalogSourceMode
  query: string
}) {
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const connected = status === "connected" && !!pubkey
  const effectiveSource: ProductCatalogSourceMode = connected
    ? input.catalogSource
    : "conduit"
  const guestMarket = useGuestMarketDiscovery({ enabled: !connected })
  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    catalogSource: effectiveSource,
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
  const accountSearch = useProfileSearch(query, {
    limit: ACCOUNT_SEARCH_CANDIDATE_LIMIT,
    settleMs: 0,
    accountPubkey: connected ? pubkey : null,
  })
  const networkAccounts = useMemo(
    () =>
      limitAccountMatches(
        excludeDiscoveredSellers(accountSearch.data?.matches ?? [], sellers),
        ACCOUNT_SUGGESTION_LIMIT
      ),
    [accountSearch.data, sellers]
  )

  return {
    connected,
    effectiveSource,
    isFetching: productsQuery.isInitialLoading || productsQuery.isHydrating,
    sellers,
    filteredSellers,
    getIdentity: identities.getIdentity,
    query,
    accountSearch,
    networkAccounts,
  }
}
