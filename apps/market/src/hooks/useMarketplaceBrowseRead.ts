import { useEffect, useMemo, useSyncExternalStore } from "react"
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  getMarketplaceBrowsePage,
  getMarketplaceCatalogMetadata,
  getLocalProductDeletionSnapshot,
  reconcileProductRecordsWithDeletions,
  subscribeLocalProductDeletionChanges,
  subscribeToProductCacheChanges,
  useConduitSession,
  type CommerceProductRecord,
  type MarketplaceBrowseCursor,
} from "@conduit/core"
import type { MarketBrowseSearch } from "../lib/marketBrowseModel"
import { MARKET_SEARCH_QUERY_POLICY } from "../lib/searchPolicy"
import type { ProgressiveProductsResult } from "./useProgressiveProducts"

export function useMarketplaceBrowseRead(input: {
  scope: ProgressiveProductsResult
  search: MarketBrowseSearch
  accountPubkey: string | null
  authGeneration: number
  shouldContinue: () => boolean
  visibleCount: number
}) {
  const session = useConduitSession()
  const client = useQueryClient()
  const { scope, search, accountPubkey, authGeneration, shouldContinue } = input
  const authors = scope.catalogAuthorPubkeys
  const authorSet = useMemo(() => new Set(authors), [authors])
  const scoped =
    !!search.q?.trim() || !!search.tag?.length || !!search.merchant?.length
  const mode = scoped ? "all" : (search.view ?? "discover")
  const metadataKey = useMemo(
    () => ["market-catalog-metadata", authors, accountPubkey, authGeneration],
    [authors, accountPubkey, authGeneration]
  )
  const metadata = useQuery({
    ...MARKET_SEARCH_QUERY_POLICY,
    queryKey: metadataKey,
    queryFn: () => getMarketplaceCatalogMetadata(authors ?? []),
    enabled: authors !== undefined,
    staleTime: 30_000,
  })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => void client.invalidateQueries({ queryKey: metadataKey }),
        200
      )
    }
    const unsubscribe = subscribeToProductCacheChanges({
      onChange: update,
      onError: update,
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [client, metadataKey])
  const pages = useInfiniteQuery({
    ...MARKET_SEARCH_QUERY_POLICY,
    structuralSharing: false,
    queryKey: [
      "market-browse-pages",
      authors,
      accountPubkey,
      authGeneration,
      session.relayScope,
      mode,
      !!search.q?.trim(),
      search.tag,
      search.merchant,
      scoped ? false : search.older,
    ],
    initialPageParam: undefined as MarketplaceBrowseCursor | undefined,
    queryFn: ({ pageParam, signal }) =>
      getMarketplaceBrowsePage({
        mode,
        merchantScope: !!search.merchant?.length,
        includeOlder: !scoped && search.older,
        authorPubkeys: search.merchant?.length
          ? search.merchant.filter((author) => authorSet.has(author))
          : authors,
        tags: search.tag,
        pageCursor: pageParam,
        signal,
        accountPubkey,
        authenticatedPubkey: accountPubkey,
        shouldContinue: () => !signal.aborted && shouldContinue(),
      }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: authors !== undefined && !search.q?.trim(),
    staleTime: 60_000,
  })
  const deletionSnapshot = useSyncExternalStore(
    subscribeLocalProductDeletionChanges,
    getLocalProductDeletionSnapshot
  )
  const records = useMemo(() => {
    const candidates = reconcileProductRecordsWithDeletions(
      pages.data?.pages.flatMap((page) => page.data) ?? [],
      deletionSnapshot.evidence
    )
    const byAddress = new Map<string, CommerceProductRecord>()
    for (const row of candidates) {
      const prior = byAddress.get(row.addressId)
      if (
        !prior ||
        row.eventCreatedAt > prior.eventCreatedAt ||
        (row.eventCreatedAt === prior.eventCreatedAt &&
          row.eventId < prior.eventId)
      )
        byAddress.set(row.addressId, row)
    }
    return [...byAddress.values()]
  }, [pages.data, deletionSnapshot])
  // One next display page is prepared. Never sweep the entire catalog in idle.
  const { hasNextPage, isFetching, fetchNextPage, error } = pages
  const readPageCount = pages.data?.pages.length ?? 0
  useEffect(() => {
    if (
      !search.q?.trim() &&
      hasNextPage &&
      !isFetching &&
      records.length < input.visibleCount + 24 &&
      readPageCount < Math.ceil(input.visibleCount / 24) + 1 &&
      !error
    )
      void fetchNextPage()
  }, [
    input.visibleCount,
    hasNextPage,
    isFetching,
    fetchNextPage,
    error,
    records.length,
    readPageCount,
    search.q,
  ])
  return { metadata, pages, records, scoped, mode }
}
