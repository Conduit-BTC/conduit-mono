import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  PROFILE_SEARCH_DEFAULT_LIMIT,
  PROFILE_SEARCH_MIN_NETWORK_QUERY_LENGTH,
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
  /**
   * Active account whose signed relay list supplies the NIP-50 read relays.
   * It is part of the query key, so a guest never reuses an account plan.
   */
  accountPubkey?: string | null
}

export interface UseProfileSearchResult {
  /** The trimmed query being searched; empty when nothing is eligible. */
  activeQuery: string
  /** The query sent to relays; empty while the settle timer is running. */
  settledQuery: string
  /**
   * Cached matches as soon as the local scan answers, then the merged result
   * once relays for the same query answer. Evidence stays `not_queried` until
   * the network phase for `activeQuery` completes, and for queries too short
   * to send to a relay it stays `not_queried` for good.
   */
  data: ProfileSearchResult | undefined
  /** True while the device-cache phase for `activeQuery` is outstanding. */
  isDeviceFetching: boolean
  /** True only while relay work for `activeQuery` is outstanding. */
  isNetworkFetching: boolean
  /** True while any phase for `activeQuery` is still outstanding. */
  isFetching: boolean
  /** True while the input has changed and the settle timer is still running. */
  isSettling: boolean
}

export function getProfileSearchQueryKey(
  query: string,
  limit: number,
  phase: "cached" | "network" = "network",
  accountPubkey: string | null = null
) {
  return [
    "profile-search",
    phase,
    normalizeProfileSearchText(query),
    limit,
    accountPubkey ?? "guest",
  ] as const
}

/** Stable identity for one cached-phase query, used to scope repair reads. */
export function getProfileSearchRepairKey(
  queryKey: readonly (string | number)[]
): string {
  return queryKey.join("\u0000")
}

/**
 * True when this exact query already ran its one repair read. Scoping by key
 * keeps a late lookup for an abandoned query from silencing the current one.
 */
export function isRepairedProfileSearchQuery(
  repairedKey: string | null,
  queryKey: string
): boolean {
  return repairedKey === queryKey
}

/**
 * Accepts a phase result only when it answers the query currently typed.
 * Query keys change per keystroke, so a result for the previous query must
 * never render or become selectable while the current read is pending.
 */
export function selectProfileSearchPhaseResult(
  result: ProfileSearchResult | undefined,
  normalizedQuery: string
): ProfileSearchResult | undefined {
  if (!result) return undefined
  return normalizeProfileSearchText(result.query) === normalizedQuery
    ? result
    : undefined
}

export function useProfileSearch(
  query: string,
  options: UseProfileSearchOptions = {}
): UseProfileSearchResult {
  const limit = options.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT
  const settleMs = options.settleMs ?? PROFILE_SEARCH_SETTLE_MS
  const accountPubkey = options.accountPubkey?.trim().toLowerCase() || null
  const trimmed = query.trim()
  const normalized = normalizeProfileSearchText(trimmed)
  const eligible =
    (options.enabled ?? true) &&
    normalized.length >= PROFILE_SEARCH_MIN_QUERY_LENGTH
  // A one-character query still answers from the device cache, but relays
  // only index enough text to answer from two characters up.
  const networkEligible =
    eligible && normalized.length >= PROFILE_SEARCH_MIN_NETWORK_QUERY_LENGTH
  const [settledQuery, setSettledQuery] = useState("")
  const queryClient = useQueryClient()
  /**
   * Identifies the query whose seller lookup already triggered a repair read.
   * It is keyed, not a plain flag, so a late lookup for a query the shopper
   * has already left cannot consume the repair the current query needs.
   */
  const repairedQueryRef = useRef<string | null>(null)

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

  const cachedKey = getProfileSearchQueryKey(
    trimmed,
    limit,
    "cached",
    accountPubkey
  )
  const cachedKeyId = getProfileSearchRepairKey(cachedKey)
  const cachedQuery = useQuery({
    queryKey: cachedKey,
    enabled: eligible,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      searchCachedProfiles({
        query: trimmed,
        limit,
        signal,
        sellerLookupBudgetMs: isRepairedProfileSearchQuery(
          repairedQueryRef.current,
          cachedKeyId
        )
          ? Infinity
          : undefined,
        onSellerLookupSettled: () => {
          if (
            isRepairedProfileSearchQuery(repairedQueryRef.current, cachedKeyId)
          ) {
            return
          }
          repairedQueryRef.current = cachedKeyId
          void queryClient.refetchQueries({
            queryKey: cachedKey,
            exact: true,
          })
        },
      }),
  })

  const networkQuery = useQuery({
    queryKey: getProfileSearchQueryKey(
      settledQuery,
      limit,
      "network",
      accountPubkey
    ),
    enabled: networkEligible && settledQuery.length > 0,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      searchNetworkProfiles({
        query: settledQuery,
        limit,
        signal,
        authenticatedPubkey: accountPubkey,
      }),
  })

  const cachedData = selectProfileSearchPhaseResult(
    cachedQuery.data,
    normalized
  )
  const networkData = selectProfileSearchPhaseResult(
    networkQuery.data,
    normalized
  )
  const data = useMemo(() => {
    if (!eligible || (!cachedData && !networkData)) return undefined
    return mergeProfileSearchResults(cachedData, networkData, limit)
  }, [cachedData, eligible, limit, networkData])

  const isSettling = networkEligible && settledQuery !== trimmed
  const networkDone =
    !networkEligible || networkData !== undefined || networkQuery.isError
  const isDeviceFetching = eligible && cachedQuery.isFetching
  const isNetworkFetching = networkEligible && (isSettling || !networkDone)
  return {
    activeQuery: eligible ? trimmed : "",
    settledQuery: eligible ? settledQuery : "",
    data,
    isDeviceFetching,
    isNetworkFetching,
    isFetching: isDeviceFetching || isNetworkFetching,
    isSettling,
  }
}
