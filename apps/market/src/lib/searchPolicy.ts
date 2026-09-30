export const MARKET_SEARCH_SETTLE_MS = 350
export const MARKET_SEARCH_MIN_NETWORK_QUERY_LENGTH = 2

/** Search reads are user-driven; a rejection must not trigger another burst. */
export const MARKET_SEARCH_QUERY_POLICY = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const

export function isRemoteMarketSearchEligible(query: string): boolean {
  return query.trim().length >= MARKET_SEARCH_MIN_NETWORK_QUERY_LENGTH
}
