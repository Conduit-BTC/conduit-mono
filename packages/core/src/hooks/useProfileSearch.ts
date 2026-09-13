import { useEffect, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import {
  PROFILE_SEARCH_DEFAULT_LIMIT,
  PROFILE_SEARCH_MIN_QUERY_LENGTH,
  normalizeProfileSearchText,
  searchProfiles,
  type ProfileSearchResult,
} from "../protocol/profile-search"

export const PROFILE_SEARCH_SETTLE_MS = 350

export interface UseProfileSearchOptions {
  enabled?: boolean
  limit?: number
  /** Idle time after the last keystroke before a query is issued. */
  settleMs?: number
}

export interface UseProfileSearchResult {
  /** The query that produced `data`; empty while nothing has settled. */
  settledQuery: string
  data: ProfileSearchResult | undefined
  isFetching: boolean
  /** True while the input has changed and the settle timer is still running. */
  isSettling: boolean
}

export function getProfileSearchQueryKey(query: string, limit: number) {
  return ["profile-search", normalizeProfileSearchText(query), limit] as const
}

export function useProfileSearch(
  query: string,
  options: UseProfileSearchOptions = {}
): UseProfileSearchResult {
  const limit = options.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT
  const settleMs = options.settleMs ?? PROFILE_SEARCH_SETTLE_MS
  const trimmed = query.trim()
  const eligible =
    (options.enabled ?? true) &&
    normalizeProfileSearchText(trimmed).length >=
      PROFILE_SEARCH_MIN_QUERY_LENGTH
  const [settledQuery, setSettledQuery] = useState("")

  useEffect(() => {
    if (!eligible) {
      setSettledQuery("")
      return
    }
    const timeoutId = window.setTimeout(() => {
      setSettledQuery(trimmed)
    }, settleMs)
    return () => window.clearTimeout(timeoutId)
  }, [eligible, settleMs, trimmed])

  const searchQuery = useQuery({
    queryKey: getProfileSearchQueryKey(settledQuery, limit),
    enabled: eligible && settledQuery.length > 0,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchProfiles({ query: settledQuery, limit, signal }),
  })

  return {
    settledQuery: eligible ? settledQuery : "",
    data: eligible ? searchQuery.data : undefined,
    isFetching: eligible && searchQuery.isFetching,
    isSettling: eligible && settledQuery !== trimmed,
  }
}
