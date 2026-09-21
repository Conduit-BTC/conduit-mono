import { useCallback, useMemo } from "react"
import { useNavigate } from "@tanstack/react-router"
import { normalizePubkey } from "@conduit/core"

import {
  ACCOUNT_SUGGESTION_LIMIT,
  limitAccountMatches,
} from "../lib/accountSearch"
import {
  getCategorySuggestionOptions,
  normalizeFacetValues,
} from "../lib/facets"
import {
  buildMarketHeaderSuggestionModel,
  describeMarketHeaderSearchEmptyState,
  describeMarketHeaderSearchEvidence,
  getCategoryBrowseSearch,
} from "../lib/marketHeaderSearch"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"
import { useSellerDirectory } from "./useSellerDirectory"

export function useMarketHeaderSuggestions(input: {
  catalogSource: ProductCatalogSourceMode
  enabled: boolean
  isBrowseRoute: boolean
  listboxId: string
  merchantFilter: unknown
  onSelect: () => void
  query: string
}) {
  const {
    catalogSource,
    enabled,
    isBrowseRoute,
    listboxId,
    merchantFilter,
    onSelect,
    query,
  } = input
  const navigate = useNavigate()
  const sellerDirectory = useSellerDirectory({
    catalogSource,
    enabled,
    query,
  })
  const accountSearch = sellerDirectory.accountSearch
  const accountMatches = useMemo(
    () =>
      accountSearch.data
        ? limitAccountMatches(
            accountSearch.data.matches,
            ACCOUNT_SUGGESTION_LIMIT
          )
        : [],
    [accountSearch.data]
  )
  const routeMerchantFilters = useMemo(() => {
    if (!isBrowseRoute) return undefined
    const merchants = normalizeFacetValues(merchantFilter).map(
      (merchant) => normalizePubkey(merchant) ?? merchant
    )
    return merchants.length > 0 ? merchants : undefined
  }, [isBrowseRoute, merchantFilter])
  const categorySuggestions = useMemo(
    () =>
      getCategorySuggestionOptions(sellerDirectory.catalogProducts, {
        query,
        merchants: routeMerchantFilters,
      }),
    [query, routeMerchantFilters, sellerDirectory.catalogProducts]
  )
  const suggestionModel = useMemo(
    () =>
      buildMarketHeaderSuggestionModel({
        listboxId,
        categories: categorySuggestions,
        accounts: accountMatches,
      }),
    [accountMatches, categorySuggestions, listboxId]
  )
  const evidence = describeMarketHeaderSearchEvidence(
    accountSearch.data,
    sellerDirectory.eligibilityState,
    sellerDirectory.catalogEvidenceIncomplete
  )
  const loading =
    sellerDirectory.eligibilityState === "loading" ||
    sellerDirectory.isFetching ||
    accountSearch.isFetching
  const selectSuggestion = useCallback(
    (selectedId: string | undefined): void => {
      if (!selectedId) return
      const target = suggestionModel.targetById.get(selectedId)
      if (!target) return
      onSelect()
      if (target.kind === "category") {
        void navigate({
          to: "/products",
          search: isBrowseRoute
            ? (previous: Record<string, unknown>) =>
                getCategoryBrowseSearch(previous, target.tag)
            : { tag: [target.tag] },
          replace: isBrowseRoute,
        })
        return
      }
      void navigate(target.target)
    },
    [isBrowseRoute, navigate, onSelect, suggestionModel.targetById]
  )

  return {
    sellerDirectory,
    suggestionModel,
    evidence,
    loading,
    selectSuggestion,
    open:
      enabled && (suggestionModel.items.length > 0 || !!evidence || loading),
    emptyMessage: describeMarketHeaderSearchEmptyState({
      eligibilityState: sellerDirectory.eligibilityState,
      catalogUnavailable: sellerDirectory.isUnavailable,
      loading,
    }),
  }
}
