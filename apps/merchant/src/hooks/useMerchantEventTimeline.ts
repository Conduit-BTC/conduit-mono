import { useCallback, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  extractFollowPubkeys,
  getFollowPubkeys,
  normalizePubkey,
  peekRetainedOwnFollowListSnapshot,
  readRetainedOwnFollowListSnapshot,
  resolveEventMarketPerspectiveAuthorPubkeys,
  selectLatestFollowListEvent,
  useConduitSession,
  useAuth,
  type EventMarketPerspectiveSource,
  type FollowListResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
// This is the same public perspective used by Market. Merchant reads the
// signed follow list rather than maintaining a separate organizer registry.
export const CONDUIT_MARKET_PERSPECTIVE_PUBKEY =
  "9d92077c5e35af76f7b1cd84738000b7bafb43d20b0a26c18fe29fa838d27146"

export const MERCHANT_EVENT_TIMELINE_REFRESH_INTERVAL_MS = 60_000

export interface MerchantEventTimelineDiscovery {
  organizerPubkeys: string[] | undefined
  isInitialLoading: boolean
  isFetching: boolean
  isRefreshStale: boolean
  error: unknown
  refetch: () => void
}

function retainedSupersedesLive(
  live: SignedPublicNostrEvent | null | undefined,
  retained: SignedPublicNostrEvent | null | undefined
): boolean {
  if (!retained) return false
  if (!live) return true
  if (live.id === retained.id) return false
  return selectLatestFollowListEvent([live, retained])?.id === retained.id
}

export function useMerchantEventTimeline(input: {
  merchantPubkey: string
  source: EventMarketPerspectiveSource
}): MerchantEventTimelineDiscovery {
  const session = useConduitSession()
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const queryScope = [
    session.relayScope ?? "no-relay-scope",
    authenticatedPubkey,
    authGeneration,
  ] as const
  const merchantPubkey = normalizePubkey(input.merchantPubkey) ?? ""
  const followingEnabled =
    session.relaySettingsReady && input.source !== "conduit" && !!merchantPubkey
  const conduitEnabled =
    session.relaySettingsReady &&
    input.source !== "following" &&
    !!merchantPubkey

  const followingQuery = useQuery({
    queryKey: [
      "merchant-event-perspective-follows",
      ...queryScope,
      merchantPubkey || "none",
    ],
    queryFn: ({ signal }) =>
      getFollowPubkeys({
        pubkey: merchantPubkey,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled: followingEnabled,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as FollowListResult | undefined
      return data && !data.meta.eventObserved
        ? 5_000
        : MERCHANT_EVENT_TIMELINE_REFRESH_INTERVAL_MS
    },
  })
  const retainedFollowingQuery = useQuery({
    queryKey: [
      "merchant-event-perspective-follows",
      ...queryScope,
      "retained",
      merchantPubkey,
    ],
    queryFn: ({ signal }) =>
      readRetainedOwnFollowListSnapshot(merchantPubkey, { signal }),
    enabled: followingEnabled,
    initialData: () =>
      followingEnabled
        ? peekRetainedOwnFollowListSnapshot(merchantPubkey)
        : undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  const retainedFollowing = useMemo(
    () =>
      (followingEnabled
        ? peekRetainedOwnFollowListSnapshot(merchantPubkey)
        : undefined) ??
      retainedFollowingQuery.data ??
      undefined,
    [followingEnabled, merchantPubkey, retainedFollowingQuery.data]
  )
  const retainedFollowingAuthors = useMemo(
    () =>
      retainedFollowing
        ? extractFollowPubkeys(retainedFollowing.event.tags)
        : undefined,
    [retainedFollowing]
  )
  const retainedIsNewer = retainedSupersedesLive(
    followingQuery.data?.meta.eventObserved
      ? followingQuery.data.event
      : undefined,
    retainedFollowing?.event
  )

  const conduitQuery = useQuery({
    queryKey: [
      "merchant-event-perspective-follows",
      ...queryScope,
      "conduit",
      CONDUIT_MARKET_PERSPECTIVE_PUBKEY,
      merchantPubkey || "none",
    ],
    queryFn: ({ signal }) =>
      getFollowPubkeys({
        pubkey: CONDUIT_MARKET_PERSPECTIVE_PUBKEY,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled: conduitEnabled,
    staleTime: 60_000,
    retry: false,
    refetchInterval: MERCHANT_EVENT_TIMELINE_REFRESH_INTERVAL_MS,
  })
  const conduitAuthors = conduitQuery.data?.meta.eventObserved
    ? conduitQuery.data.data
    : undefined
  const followingLookupSettled =
    !followingEnabled ||
    followingQuery.isSuccess ||
    followingQuery.isError ||
    retainedFollowing !== undefined
  const conduitLookupSettled =
    !conduitEnabled || conduitQuery.isSuccess || conduitQuery.isError
  const authorResolution = useMemo(
    () =>
      resolveEventMarketPerspectiveAuthorPubkeys({
        usesPerspectiveGraph: true,
        sourceMode: input.source,
        perspectivePubkey: merchantPubkey,
        refreshedAuthorPubkeys:
          followingQuery.data?.meta.eventObserved && !retainedIsNewer
            ? followingQuery.data.data
            : undefined,
        seedAuthorPubkeys:
          input.source === "conduit" ? conduitAuthors : undefined,
        cachedAuthorPubkeys: retainedFollowingAuthors,
        fallbackAuthorPubkeys:
          input.source === "combined" ? conduitAuthors : undefined,
        followLookupSettled:
          input.source === "conduit"
            ? conduitLookupSettled
            : followingLookupSettled &&
              (input.source !== "combined" || conduitLookupSettled),
      }),
    [
      conduitAuthors,
      conduitLookupSettled,
      followingLookupSettled,
      followingQuery.data,
      input.source,
      merchantPubkey,
      retainedFollowingAuthors,
      retainedIsNewer,
    ]
  )
  const authorPubkeys = useMemo(
    () =>
      authorResolution.authorPubkeys ??
      (followingLookupSettled && conduitLookupSettled ? [] : undefined),
    [
      authorResolution.authorPubkeys,
      conduitLookupSettled,
      followingLookupSettled,
    ]
  )
  const refreshFollowing = followingQuery.refetch
  const refreshConduit = conduitQuery.refetch
  const refetch = useCallback(() => {
    if (followingEnabled) void refreshFollowing()
    if (conduitEnabled) void refreshConduit()
  }, [followingEnabled, conduitEnabled, refreshFollowing, refreshConduit])
  return {
    organizerPubkeys: authorPubkeys,
    isInitialLoading: authorPubkeys === undefined,
    isFetching: followingQuery.isFetching || conduitQuery.isFetching,
    isRefreshStale: followingQuery.isError || conduitQuery.isError,
    error: followingQuery.error ?? conduitQuery.error,
    refetch,
  }
}
