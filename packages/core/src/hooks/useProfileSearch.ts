import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import {
  PROFILE_SEARCH_DEFAULT_LIMIT,
  PROFILE_SEARCH_MIN_QUERY_LENGTH,
  mergeProfileSearchResults,
  normalizeProfileSearchText,
  searchCachedProfiles,
  searchNetworkProfiles,
  type ProfileSearchResult,
} from "../protocol/profile-search"

export const PROFILE_SEARCH_SETTLE_MS = 350

export interface UseProfileSearchOptions {
  enabled?: boolean
  limit?: number
  /** Idle time after the last keystroke before the relay query is issued. */
  settleMs?: number
}

export interface UseProfileSearchResult {
  /** The trimmed query being searched; empty when nothing is eligible. */
  activeQuery: string
  /** The query sent to relays; empty while the settle timer is running. */
  settledQuery: string
  /**
   * Cached matches as soon as the local scan answers, then the merged result
   * once relays for the same query answer. Evidence stays `not_queried` until
   * the network phase for `activeQuery` completes.
   */
  data: ProfileSearchResult | undefined
  /** True while any phase for `activeQuery` is still outstanding. */
  isFetching: boolean
  /** True while the input has changed and the settle timer is still running. */
  isSettling: boolean
}

export function getProfileSearchQueryKey(
  query: string,
  limit: number,
  phase: "cached" | "network" = "network"
) {
  return [
    "profile-search",
    phase,
    normalizeProfileSearchText(query),
    limit,
  ] as const
}

export function useProfileSearch(
  query: string,
  options: UseProfileSearchOptions = {}
): UseProfileSearchResult {
  const limit = options.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT
  const settleMs = options.settleMs ?? PROFILE_SEARCH_SETTLE_MS
  const trimmed = query.trim()
  const normalized = normalizeProfileSearchText(trimmed)
  const eligible =
    (options.enabled ?? true) &&
    normalized.length >= PROFILE_SEARCH_MIN_QUERY_LENGTH
  const [settledQuery, setSettledQuery] = useState("")

  useEffect(() => {
    if (!eligible) {
      setSettledQuery("")
      return
    }
    if (settleMs <= 0) {
      setSettledQuery(trimmed)
      return
    }
    const timeoutId = window.setTimeout(() => {
      setSettledQuery(trimmed)
    }, settleMs)
    return () => window.clearTimeout(timeoutId)
  }, [eligible, settleMs, trimmed])

  const cachedQuery = useQuery({
    queryKey: getProfileSearchQueryKey(trimmed, limit, "cached"),
    enabled: eligible,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchCachedProfiles({ query: trimmed, limit, signal }),
  })

  const networkQuery = useQuery({
    queryKey: getProfileSearchQueryKey(settledQuery, limit, "network"),
    enabled: eligible && settledQuery.length > 0,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchNetworkProfiles({ query: settledQuery, limit, signal }),
  })

  const cachedData = cachedQuery.data
  const networkData =
    networkQuery.data &&
    normalizeProfileSearchText(networkQuery.data.query) === normalized
      ? networkQuery.data
      : undefined
  const data = useMemo(() => {
    if (!eligible || (!cachedData && !networkData)) return undefined
    return mergeProfileSearchResults(cachedData, networkData, limit)
  }, [cachedData, eligible, limit, networkData])

  const isSettling = eligible && settledQuery !== trimmed
  const networkDone = networkData !== undefined || networkQuery.isError
  return {
    activeQuery: eligible ? trimmed : "",
    settledQuery: eligible ? settledQuery : "",
    data,
    isFetching:
      eligible && (cachedQuery.isFetching || isSettling || !networkDone),
    isSettling,
  }
}
