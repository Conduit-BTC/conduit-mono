import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  discoverPerspectiveEventMarkets,
  extractFollowPubkeys,
  getFollowPubkeys,
  normalizePubkey,
  peekRetainedOwnFollowListSnapshot,
  readRetainedOwnFollowListSnapshot,
  useAuth,
  useConduitSession,
  type EventMarketPerspectiveSnapshot,
  type FollowListResult,
  type PerspectiveEventMarketDiscoveryResult,
} from "@conduit/core"
import {
  isProductDiscoveryReadIncomplete,
  retainedFollowSnapshotSupersedesLive,
  resolvePerspectiveAuthorPubkeys,
  type PerspectiveAuthorSource,
  type ProductCatalogSourceMode,
} from "../lib/productCatalogRead"
import { getDefaultMarketPerspectiveFollowPubkeys } from "../lib/defaultMarketPerspective"
import { useGuestMarketDiscovery } from "./useGuestMarketDiscovery"

export interface EventTimelineDiscoveryResult {
  data: PerspectiveEventMarketDiscoveryResult | undefined
  markets: PerspectiveEventMarketDiscoveryResult["markets"]
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
  const guestMarket = useGuestMarketDiscovery({
    enabled: effectiveSource !== "following",
  })
  const perspectivePubkey = connected ? pubkey : guestMarket.perspectivePubkey
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
      return data && !data.meta.eventObserved ? 5_000 : false
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
    () =>
      uniquePubkeys(
        guestMarket.seedAuthorPubkeys ??
          getDefaultMarketPerspectiveFollowPubkeys()
      ),
    [guestMarket.seedAuthorPubkeys]
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
  const resolvedOrganizerPubkeys =
    authorResolution.authorPubkeys ??
    (effectiveSource === "conduit" &&
    guestMarket.seedAuthorPubkeys !== undefined &&
    !guestMarket.isRefreshing
      ? []
      : undefined)
  const followCoverage =
    firstDegreeQuery.data?.meta.coverage ??
    (retainedFirstDegreeSnapshot
      ? "limited"
      : firstDegreeQuery.isError
        ? "unavailable"
        : "limited")
  const perspective = useMemo<
    Omit<EventMarketPerspectiveSnapshot, "authorCount">
  >(() => {
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
  const discoveryQuery = useQuery({
    queryKey: [
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
    ],
    queryFn: ({ signal }) =>
      discoverPerspectiveEventMarkets({
        organizerPubkeys: organizerPubkeys!,
        perspective,
        includeEnded: true,
        authenticatedPubkey,
        signal,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled: session.relaySettingsReady && organizerPubkeys !== undefined,
    retry: false,
    staleTime: 60_000,
  })
  const markets = useMemo(
    () => discoveryQuery.data?.markets ?? [],
    [discoveryQuery.data?.markets]
  )
  const profileRelayHintsByPubkey = useMemo(() => {
    const hints = new Map<string, Set<string>>()
    for (const market of markets) {
      if (!market.organizerPubkey) continue
      const relayUrls = [
        ...(market.collection?.sourceRelayUrls ?? []),
        ...(market.calendar?.sourceRelayUrls ?? []),
      ]
      const current = hints.get(market.organizerPubkey) ?? new Set<string>()
      for (const relayUrl of relayUrls) current.add(relayUrl)
      hints.set(market.organizerPubkey, current)
    }
    return Object.fromEntries(
      Array.from(hints, ([organizerPubkey, relayUrls]) => [
        organizerPubkey,
        Array.from(relayUrls),
      ])
    )
  }, [markets])
  const refreshGuestPerspective = guestMarket.refetch
  const refreshFollows = firstDegreeQuery.refetch
  const refreshDiscovery = discoveryQuery.refetch
  const refetch = useCallback(() => {
    if (effectiveSource !== "following") void refreshGuestPerspective()
    if (firstDegreeDiscoveryEnabled) void refreshFollows()
    void refreshDiscovery()
  }, [
    effectiveSource,
    firstDegreeDiscoveryEnabled,
    refreshDiscovery,
    refreshFollows,
    refreshGuestPerspective,
  ])
  const followReadIncomplete =
    firstDegreeDiscoveryEnabled &&
    isProductDiscoveryReadIncomplete(firstDegreeQuery.data?.meta)

  return {
    data: discoveryQuery.data,
    markets,
    profileRelayHintsByPubkey,
    authorSource: authorResolution.source,
    effectiveSource,
    isInitialLoading:
      organizerPubkeys === undefined ||
      (markets.length === 0 && discoveryQuery.isPending),
    isFetching:
      discoveryQuery.isFetching ||
      firstDegreeQuery.isFetching ||
      guestMarket.isRefreshing,
    isRefreshStale:
      discoveryQuery.isError ||
      followReadIncomplete ||
      (effectiveSource !== "following" && guestMarket.stale),
    error: discoveryQuery.error,
    refetch,
  }
}
