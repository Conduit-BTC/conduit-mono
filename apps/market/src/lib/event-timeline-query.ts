import { queryOptions, type QueryClient } from "@tanstack/react-query"
import {
  discoverPerspectiveEventMarkets,
  type DiscoverPerspectiveEventMarketsInput,
  type PerspectiveEventMarketDiscoveryResult,
} from "@conduit/core"

export function eventTimelineQueryOptions(
  client: QueryClient,
  queryKey: readonly unknown[],
  input: Omit<
    DiscoverPerspectiveEventMarketsInput,
    "signal" | "shouldContinue" | "onProgress"
  >,
  isScopeCurrent: (signal: AbortSignal) => boolean,
  discover: typeof discoverPerspectiveEventMarkets = discoverPerspectiveEventMarkets
) {
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }) => {
      let settled = false
      const active = () => !signal.aborted && isScopeCurrent(signal)
      const assertActive = () => {
        if (!active())
          throw new DOMException("Event timeline read cancelled", "AbortError")
      }
      try {
        assertActive()
        const result = await discover({
          ...input,
          signal,
          shouldContinue: active,
          onProgress: (snapshot: PerspectiveEventMarketDiscoveryResult) => {
            if (settled || !active()) return
            // Core supplies a cumulative frontier, including retractions. A
            // preview cannot certify completion or an empty perspective.
            client.setQueryData(
              queryKey,
              { ...snapshot, state: "partial" },
              { updatedAt: 0 }
            )
          },
        })
        assertActive()
        return result
      } finally {
        settled = true
      }
    },
    retry: false,
    staleTime: 60_000,
  })
}

export function getEventTimelineQueryDisplayState(query: {
  data?: Pick<PerspectiveEventMarketDiscoveryResult, "markets">
  isPending: boolean
  isFetching: boolean
  isError: boolean
  isPaused: boolean
}) {
  return {
    isInitialLoading:
      (query.data?.markets.length ?? 0) === 0 &&
      (query.isPending || query.isFetching),
    isRefreshStale: query.isError || query.isPaused,
  }
}
