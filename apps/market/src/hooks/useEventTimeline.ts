import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  useProgressiveEventMarketDiscovery,
  extractFollowPubkeys,
  getFollowPubkeys,
  normalizePubkey,
  peekRetainedOwnFollowListSnapshot,
  readRetainedOwnFollowListSnapshot,
  useAuth,
  useConduitSession,
  type FollowListResult,
  type EventMarketRosterReadResult,
} from "@conduit/core"
import {
  isProductDiscoveryReadIncomplete,
  retainedFollowSnapshotSupersedesLive,
  resolvePerspectiveAuthorPubkeys,
  type PerspectiveAuthorSource,
  type ProductCatalogSourceMode,
} from "../lib/productCatalogRead"
import { MARKET_MERCHANT_PUBKEYS } from "../lib/marketMerchants"

export const MARKET_EVENT_TIMELINE_REFRESH_INTERVAL_MS = 60_000

export interface EventTimelineDiscoveryResult {
  data:
    | { state: "complete" | "complete_empty" | "partial" | "unavailable" }
    | undefined
  futureMarkets: EventMarketRosterReadResult[]
  organizerPubkeys: string[] | undefined
  profileRelayHintsByPubkey: Record<string, string[]>
  authorSource: PerspectiveAuthorSource
  effectiveSource: ProductCatalogSourceMode
  isInitialLoading: boolean
  isFetching: boolean
  isRefreshStale: boolean
  error: unknown
  refetch: () => void
}

function uniquePubkeys(pubkeys: readonly string[] | undefined): string[] {
  return Array.from(
    new Set(pubkeys?.map(normalizePubkey).filter(Boolean) as string[])
  ).sort()
}

export function useEventTimeline(
  requestedSource: ProductCatalogSourceMode
): EventTimelineDiscoveryResult {
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const session = useConduitSession()
  const connected = status === "connected" && !!pubkey
  const effectiveSource = connected ? requestedSource : "conduit"
  const authenticatedPubkey = connected ? pubkey : null
  const perspectivePubkey = connected ? pubkey : null
  const normalizedPerspectivePubkey = normalizePubkey(perspectivePubkey)
  const firstDegreeDiscoveryEnabled =
    session.relaySettingsReady &&
    connected &&
    effectiveSource !== "conduit" &&
    !!normalizedPerspectivePubkey
  const firstDegreeQuery = useQuery({
    queryKey: [
      "market-perspective-follows",
      normalizedPerspectivePubkey,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      getFollowPubkeys({
        pubkey: normalizedPerspectivePubkey!,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled: firstDegreeDiscoveryEnabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const data = query.state.data as FollowListResult | undefined
      return data && !data.meta.eventObserved
        ? 5_000
        : MARKET_EVENT_TIMELINE_REFRESH_INTERVAL_MS
    },
  })
  const retainedFirstDegreeQuery = useQuery({
    queryKey: [
      "market-perspective-follows",
      "retained",
      normalizedPerspectivePubkey,
      authenticatedPubkey,
    ],
    queryFn: ({ signal }) =>
      readRetainedOwnFollowListSnapshot(normalizedPerspectivePubkey!, {
        signal,
      }),
    enabled: firstDegreeDiscoveryEnabled,
    initialData: () =>
      firstDegreeDiscoveryEnabled
        ? peekRetainedOwnFollowListSnapshot(normalizedPerspectivePubkey!)
        : undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  const retainedFirstDegreeSnapshot = useMemo(
    () =>
      (firstDegreeDiscoveryEnabled
        ? peekRetainedOwnFollowListSnapshot(normalizedPerspectivePubkey!)
        : undefined) ?? retainedFirstDegreeQuery.data,
    [
      firstDegreeDiscoveryEnabled,
      normalizedPerspectivePubkey,
      retainedFirstDegreeQuery.data,
    ]
  )
  const retainedFirstDegreeAuthors = useMemo(
    () =>
      retainedFirstDegreeSnapshot
        ? extractFollowPubkeys(retainedFirstDegreeSnapshot.event.tags)
        : undefined,
    [retainedFirstDegreeSnapshot]
  )
  const conduitAuthors = useMemo(
    () => uniquePubkeys(MARKET_MERCHANT_PUBKEYS),
    []
  )
  const retainedSupersedesLive = retainedFollowSnapshotSupersedesLive(
    firstDegreeQuery.data?.meta.eventObserved
      ? firstDegreeQuery.data.event
      : undefined,
    retainedFirstDegreeSnapshot?.event
  )
  const followLookupSettled =
    firstDegreeQuery.isSuccess ||
    firstDegreeQuery.isError ||
    retainedFirstDegreeSnapshot !== undefined
  const authorResolution = useMemo(
    () =>
      resolvePerspectiveAuthorPubkeys({
        usesPerspectiveGraph: !!normalizedPerspectivePubkey,
        sourceMode: effectiveSource,
        perspectivePubkey: normalizedPerspectivePubkey,
        refreshedAuthorPubkeys:
          firstDegreeQuery.data?.meta.eventObserved && !retainedSupersedesLive
            ? firstDegreeQuery.data.data
            : undefined,
        seedAuthorPubkeys:
          effectiveSource === "conduit" ? conduitAuthors : undefined,
        cachedAuthorPubkeys: retainedFirstDegreeAuthors,
        fallbackAuthorPubkeys:
          effectiveSource === "combined" ? conduitAuthors : undefined,
        followLookupSettled,
      }),
    [
      conduitAuthors,
      effectiveSource,
      firstDegreeQuery.data,
      followLookupSettled,
      normalizedPerspectivePubkey,
      retainedFirstDegreeAuthors,
      retainedSupersedesLive,
    ]
  )
  const resolvedOrganizerPubkeys = authorResolution.authorPubkeys
  const followCoverage =
    firstDegreeQuery.data?.meta.coverage ??
    (retainedFirstDegreeSnapshot
      ? "limited"
      : firstDegreeQuery.isError
        ? "unavailable"
        : "limited")
  const followReadIncomplete =
    firstDegreeDiscoveryEnabled &&
    isProductDiscoveryReadIncomplete(firstDegreeQuery.data?.meta)
  const followRefreshStale =
    firstDegreeDiscoveryEnabled &&
    (followReadIncomplete ||
      firstDegreeQuery.isRefetchError ||
      firstDegreeQuery.isPaused)
  const perspective = useMemo(() => {
    if (effectiveSource === "conduit") {
      return {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      }
    }
    return {
      source: effectiveSource,
      coverage:
        effectiveSource === "combined" && followCoverage === "unavailable"
          ? "limited"
          : followCoverage,
      eventObserved: firstDegreeQuery.data?.meta.eventObserved ?? false,
      snapshotState:
        firstDegreeQuery.data?.meta.snapshotState ??
        retainedFirstDegreeSnapshot?.state ??
        (effectiveSource === "combined" && conduitAuthors.length > 0
          ? "curated"
          : firstDegreeQuery.isPending
            ? "pending"
            : "none"),
      truncated:
        firstDegreeQuery.data?.meta.capped === true || retainedSupersedesLive,
    }
  }, [
    conduitAuthors.length,
    effectiveSource,
    firstDegreeQuery.data?.meta,
    firstDegreeQuery.isPending,
    followCoverage,
    retainedFirstDegreeSnapshot?.state,
    retainedSupersedesLive,
  ])
  const organizerPubkeys = resolvedOrganizerPubkeys
  const organizerKey = organizerPubkeys?.join(",") ?? "unresolved"
  const discoveryQueryKey = [
    "market-event-timeline",
    session.relayScope ?? "no-relay-scope",
    authenticatedPubkey,
    authGeneration,
    effectiveSource,
    normalizedPerspectivePubkey,
    organizerKey,
    perspective.coverage,
    perspective.eventObserved,
    perspective.snapshotState,
    perspective.truncated,
  ] as const
  const futureQuery = useProgressiveEventMarketDiscovery({
    queryKey: ["future-market-event-timeline", ...discoveryQueryKey],
    discoveryInput: {
      organizerPubkeys: organizerPubkeys ?? [],
      authenticatedPubkey,
      shouldContinue: () => authGenerationRef.current === authGeneration,
    },
    enabled: session.relaySettingsReady && organizerPubkeys !== undefined,
    refetchInterval: MARKET_EVENT_TIMELINE_REFRESH_INTERVAL_MS,
  })
  const profileRelayHintsByPubkey = useMemo(
    () =>
      Object.fromEntries(
        (futureQuery.data?.markets ?? []).flatMap((read) =>
          read.resolution.state === "current"
            ? [[read.resolution.market.organizerPubkey, read.observedRelayUrls]]
            : []
        )
      ),
    [futureQuery.data?.markets]
  )
  const refreshFollows = firstDegreeQuery.refetch
  const refreshFuture = futureQuery.refetch
  const refetch = useCallback(() => {
    if (firstDegreeDiscoveryEnabled) void refreshFollows()
    void refreshFuture()
  }, [firstDegreeDiscoveryEnabled, refreshFuture, refreshFollows])
  return {
    data: futureQuery.data
      ? {
          state:
            futureQuery.data.coverage === "complete"
              ? futureQuery.data.markets.length
                ? "complete"
                : "complete_empty"
              : futureQuery.data.coverage === "unavailable"
                ? "unavailable"
                : "partial",
        }
      : undefined,
    futureMarkets: futureQuery.data?.markets ?? [],
    organizerPubkeys,
    profileRelayHintsByPubkey,
    authorSource: authorResolution.source,
    effectiveSource,
    isInitialLoading: organizerPubkeys === undefined || futureQuery.isPending,
    isFetching: futureQuery.isFetching || firstDegreeQuery.isFetching,
    isRefreshStale:
      futureQuery.isError ||
      futureQuery.data?.coverage !== "complete" ||
      followRefreshStale,
    error: futureQuery.error,
    refetch,
  }
}
