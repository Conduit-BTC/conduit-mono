import { queryOptions, type QueryClient } from "@tanstack/react-query"
import {
  discoverPerspectiveEventMarkets,
  encodeEventMarketNaddr,
  type DiscoverPerspectiveEventMarketsInput,
  type PerspectiveEventMarketDiscoveryResult,
} from "@conduit/core"
import {
  parseOrganizerEventMarketReference,
  resolveOrganizerEventMarketRead,
  type MerchantOrganizerEventMarketRead,
} from "./event-market"

export type MerchantEventMarketQueryScope = {
  relayScope: string | null | undefined
  authenticatedPubkey: string | null
  authGeneration: number
}

export type MerchantEventMarketQueryData = {
  /** Browsing projection. Consequential actions must also require complete. */
  read: MerchantOrganizerEventMarketRead
  /** True only after the current bounded exact read settles successfully. */
  complete: boolean
}

/**
 * Returns only the current query's settled exact read. This is a freshness
 * precondition, not a replacement for the existing publish/action gates.
 */
export function getSettledMerchantEventMarketRead(query: {
  data?: MerchantEventMarketQueryData
  isFetching: boolean
}): MerchantOrganizerEventMarketRead | null {
  return query.data?.complete && !query.isFetching ? query.data.read : null
}

export type MerchantEventMarketQueryLoaderOptions = {
  organizerPubkey: string
  authenticatedPubkey: string | null
  signal: AbortSignal
  shouldContinue: () => boolean
  onProgress: (market: MerchantOrganizerEventMarketRead) => void
}

export type MerchantEventMarketQueryLoader = (
  reference: string,
  options: MerchantEventMarketQueryLoaderOptions
) => Promise<MerchantOrganizerEventMarketRead>

async function loadMerchantEventMarket(
  reference: string,
  options: MerchantEventMarketQueryLoaderOptions
) {
  return resolveOrganizerEventMarketRead(
    reference,
    options.organizerPubkey,
    options.authenticatedPubkey,
    options.signal,
    options.shouldContinue,
    options.onProgress
  )
}

function hasUnavailableRelayCoverage(
  data: MerchantEventMarketQueryData | undefined
) {
  if (!data || "terminal" in data.read) return false
  const coverage = data.read.source.coverage
  return (
    coverage.attemptedRelayCount > 0 &&
    coverage.completeRelayCount === 0 &&
    coverage.partialRelayCount === 0
  )
}

export function merchantEventMarketQueryIdentity(
  reference: string,
  scope: MerchantEventMarketQueryScope
) {
  const parsed = parseOrganizerEventMarketReference(reference)
  const hints = [...new Set(parsed.relayHints)].sort()
  const organizerPubkey = parsed.coordinate.split(":")[1]!

  return {
    organizerPubkey,
    reference: encodeEventMarketNaddr(parsed.coordinate, hints),
    queryKey: [
      "merchant-event-market",
      scope.relayScope ?? "no-relay-scope",
      scope.authenticatedPubkey,
      scope.authGeneration,
      parsed.coordinate,
      hints,
    ] as const,
  }
}

export function merchantEventMarketQueryOptions(
  client: QueryClient,
  reference: string,
  scope: MerchantEventMarketQueryScope,
  shouldContinue: () => boolean,
  loader: MerchantEventMarketQueryLoader = loadMerchantEventMarket
) {
  const identity = merchantEventMarketQueryIdentity(reference, scope)
  return queryOptions({
    queryKey: identity.queryKey,
    queryFn: async ({ signal }) => {
      let settled = false
      const active = () => !signal.aborted && shouldContinue()
      const assertActive = () => {
        if (!active())
          throw new DOMException("Merchant event read cancelled", "AbortError")
      }

      try {
        assertActive()
        // A retained final read remains useful for display, but it cannot
        // authorize work while a newer exact read is in flight.
        const retained = client.getQueryData<MerchantEventMarketQueryData>(
          identity.queryKey
        )
        if (retained?.complete) {
          client.setQueryData<MerchantEventMarketQueryData>(
            identity.queryKey,
            { ...retained, complete: false },
            { updatedAt: 0 }
          )
        }

        const read = await loader(identity.reference, {
          organizerPubkey: identity.organizerPubkey,
          authenticatedPubkey: scope.authenticatedPubkey,
          signal,
          shouldContinue: active,
          onProgress: (progress) => {
            if (settled || !active()) return
            client.setQueryData<MerchantEventMarketQueryData>(
              identity.queryKey,
              { read: progress, complete: false },
              { updatedAt: 0 }
            )
          },
        })
        assertActive()
        return { read, complete: true }
      } finally {
        settled = true
      }
    },
    // A completed exact read can be shared across list/detail mounts. Cached
    // progress and all-relay-unavailable reads stay stale and recover on focus.
    staleTime: (query) =>
      query.state.data?.complete &&
      !hasUnavailableRelayCoverage(query.state.data)
        ? 60_000
        : 0,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: (query) =>
      query.state.status === "error"
        ? "always"
        : !query.state.data?.complete ||
          hasUnavailableRelayCoverage(query.state.data),
    retry: false,
  })
}

export function merchantEventTimelineQueryOptions(
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
          throw new DOMException(
            "Merchant timeline read cancelled",
            "AbortError"
          )
      }

      try {
        assertActive()
        const result = await discover({
          ...input,
          signal,
          shouldContinue: active,
          onProgress: (snapshot: PerspectiveEventMarketDiscoveryResult) => {
            if (settled || !active()) return
            // Core progress is cumulative and may include retractions. It is
            // display evidence only until the bounded discovery settles.
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
