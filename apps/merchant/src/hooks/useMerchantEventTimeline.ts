import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  discoverPerspectiveEventMarkets,
  extractFollowPubkeys,
  getFollowPubkeys,
  getMerchantStorefront,
  isCommerceReadIncomplete,
  normalizePubkey,
  peekRetainedOwnFollowListSnapshot,
  readRetainedOwnFollowListSnapshot,
  resolveEventMarketPerspectiveAuthorPubkeys,
  selectLatestFollowListEvent,
  useConduitSession,
  useAuth,
  type EventMarketPerspectiveAuthorSource,
  type EventMarketPerspectiveSnapshot,
  type EventMarketPerspectiveSource,
  type FollowListCoverageState,
  type FollowListResult,
  type PerspectiveEventMarketDiscoveryResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  listOrganizerEventMarkets,
  parseOrganizerEventMarketReference,
  projectMarketList,
  resolveOrganizerEventMarketResolution,
  retainMerchantOrganizerEventMarkets,
  type MerchantOrganizerEventMarketsReadResult,
} from "../lib/event-market"
import {
  findSavedOrganizerEventMarketReference,
  loadSavedDiscoveredEventMarkets,
  loadSavedOrganizerEventMarkets,
  mergeSavedOrganizerEventMarketReferences,
  organizerEventMarketCanSupplySavedTitle,
  rememberDiscoveredEventMarket,
  type SavedOrganizerEventMarketReference,
} from "../lib/event-market-workflow"
import { getMerchantProductEventContext } from "../lib/merchant-product-event-context"
import {
  mergeMerchantEventTimeline,
  qualifyMerchantEventTimelineNetwork,
  type MerchantEventTimelineItem,
} from "../lib/merchant-event-timeline"
import {
  hydrateMerchantEventRelationships,
  prioritizeMerchantEventRelationshipReferences,
  type MerchantEventRelationshipReference,
} from "../lib/merchant-event-relationship-hydration"

// This is the same public perspective used by Market. Merchant reads the
// signed follow list rather than maintaining a separate organizer registry.
export const CONDUIT_MARKET_PERSPECTIVE_PUBKEY =
  "9d92077c5e35af76f7b1cd84738000b7bafb43d20b0a26c18fe29fa838d27146"

export interface MerchantEventTimelineDiscovery {
  network: PerspectiveEventMarketDiscoveryResult | undefined
  items: MerchantEventTimelineItem[]
  savedReferences: SavedOrganizerEventMarketReference[]
  sellingCollectionCoordinates: string[]
  profileRelayHintsByPubkey: Record<string, string[]>
  authorSource: EventMarketPerspectiveAuthorSource
  isInitialLoading: boolean
  isFetching: boolean
  isRefreshStale: boolean
  unresolvedRelationshipCount: number
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

function combinedCoverage(
  left: FollowListCoverageState,
  right: FollowListCoverageState
): FollowListCoverageState {
  if (left === "unavailable" && right === "unavailable") return "unavailable"
  if (left === "complete" && right === "complete") return "complete"
  return "limited"
}

export function useMerchantEventTimeline(input: {
  merchantPubkey: string
  source: EventMarketPerspectiveSource
  currentReference?: string
  storageRevision?: number
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
  const queryClient = useQueryClient()
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
      return data && !data.meta.eventObserved ? 5_000 : false
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
  const followingCoverage =
    followingQuery.data?.meta.coverage ??
    (retainedFollowing
      ? "limited"
      : followingQuery.isError
        ? "unavailable"
        : "limited")
  const conduitCoverage =
    conduitQuery.data?.meta.coverage ??
    (conduitQuery.isError ? "unavailable" : "limited")
  const followingRefreshStale =
    followingEnabled &&
    (isCommerceReadIncomplete(followingQuery.data?.meta) ||
      followingQuery.isRefetchError ||
      followingQuery.isPaused)
  const conduitRefreshStale =
    conduitEnabled &&
    (isCommerceReadIncomplete(conduitQuery.data?.meta) ||
      conduitQuery.isRefetchError ||
      conduitQuery.isPaused)
  const perspectiveRefreshStale =
    input.source === "following"
      ? followingRefreshStale
      : input.source === "conduit"
        ? conduitRefreshStale
        : followingRefreshStale || conduitRefreshStale
  const perspective = useMemo<
    Omit<EventMarketPerspectiveSnapshot, "authorCount">
  >(() => {
    if (input.source === "following") {
      return {
        source: input.source,
        coverage: followingCoverage,
        eventObserved: followingQuery.data?.meta.eventObserved ?? false,
        snapshotState:
          followingQuery.data?.meta.snapshotState ??
          retainedFollowing?.state ??
          (followingQuery.isPending ? "pending" : "none"),
        truncated: followingQuery.data?.meta.capped === true || retainedIsNewer,
      }
    }
    if (input.source === "conduit") {
      return {
        source: input.source,
        coverage: conduitCoverage,
        eventObserved: conduitQuery.data?.meta.eventObserved ?? false,
        snapshotState:
          conduitQuery.data?.meta.eventObserved === true
            ? "curated"
            : conduitQuery.isPending
              ? "pending"
              : "none",
        truncated: conduitQuery.data?.meta.capped === true,
      }
    }
    return {
      source: input.source,
      coverage: combinedCoverage(followingCoverage, conduitCoverage),
      eventObserved:
        (followingQuery.data?.meta.eventObserved ?? false) ||
        (conduitQuery.data?.meta.eventObserved ?? false),
      snapshotState:
        followingQuery.data?.meta.snapshotState ??
        retainedFollowing?.state ??
        (conduitQuery.data?.meta.eventObserved
          ? "curated"
          : followingQuery.isPending || conduitQuery.isPending
            ? "pending"
            : "none"),
      truncated:
        followingQuery.data?.meta.capped === true ||
        conduitQuery.data?.meta.capped === true ||
        retainedIsNewer,
    }
  }, [
    conduitCoverage,
    conduitQuery.data?.meta,
    conduitQuery.isPending,
    followingCoverage,
    followingQuery.data?.meta,
    followingQuery.isPending,
    input.source,
    retainedFollowing?.state,
    retainedIsNewer,
  ])

  const authorKey = authorPubkeys?.join(",") ?? "unresolved"
  const perspectiveQuery = useQuery({
    queryKey: [
      "merchant-event-timeline-perspective",
      ...queryScope,
      merchantPubkey || "none",
      input.source,
      authorKey,
      perspective.coverage,
      perspective.eventObserved,
      perspective.snapshotState,
      perspective.truncated,
    ],
    queryFn: ({ signal }) =>
      discoverPerspectiveEventMarkets({
        organizerPubkeys: authorPubkeys!,
        perspective,
        includeEnded: true,
        authenticatedPubkey,
        signal,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
      }),
    enabled:
      session.relaySettingsReady &&
      !!merchantPubkey &&
      authorPubkeys !== undefined,
    retry: false,
    staleTime: 60_000,
  })

  const ownedQueryKey = [
    "merchant-organizer-event-markets",
    merchantPubkey || "none",
    ...queryScope,
  ] as const
  const ownedQuery = useQuery({
    queryKey: ownedQueryKey,
    queryFn: async ({ signal }) => {
      const result = await listOrganizerEventMarkets(
        merchantPubkey,
        authenticatedPubkey,
        signal,
        () => !signal.aborted && authGenerationRef.current === authGeneration
      )
      const retained =
        queryClient.getQueryData<MerchantOrganizerEventMarketsReadResult>(
          ownedQueryKey
        )?.markets ?? []
      return {
        ...result,
        markets: retainMerchantOrganizerEventMarkets(retained, result),
      }
    },
    enabled: session.relaySettingsReady && !!merchantPubkey,
    retry: false,
    staleTime: 30_000,
  })

  const productsQuery = useQuery({
    queryKey: [
      "merchant-event-timeline-products",
      ...queryScope,
      merchantPubkey || "none",
    ],
    queryFn: ({ signal }) =>
      getMerchantStorefront({
        merchantPubkey,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted && authGenerationRef.current === authGeneration,
        includeMarketHidden: true,
        sort: "updated_at_desc",
      }),
    enabled: session.relaySettingsReady && !!merchantPubkey,
    retry: false,
    staleTime: 60_000,
  })
  const sellingCollectionCoordinates = useMemo(
    () =>
      Array.from(
        new Set(
          (productsQuery.data?.data ?? []).flatMap((record) => {
            const context = getMerchantProductEventContext(record.product)
            return context ? [context.collectionCoordinate] : []
          })
        )
      ).sort(),
    [productsQuery.data?.data]
  )

  const storageRevision = input.storageRevision
  const savedReferences = useMemo(() => {
    // The revision is an invalidation token for local-storage-backed reads.
    void storageRevision
    return mergeSavedOrganizerEventMarketReferences([
      ...loadSavedDiscoveredEventMarkets(merchantPubkey),
      ...loadSavedOrganizerEventMarkets(merchantPubkey),
    ])
  }, [merchantPubkey, storageRevision])
  const exactReferences = useMemo(() => {
    let current: MerchantEventRelationshipReference | undefined
    if (input.currentReference) {
      try {
        current = projectReference(input.currentReference)
      } catch {
        // Route validation owns invalid-link feedback.
      }
    }
    const products = sellingCollectionCoordinates.flatMap((coordinate) => {
      try {
        return [projectReference(coordinate)]
      } catch {
        return []
      }
    })
    const saved = savedReferences.flatMap((reference) => {
      try {
        return [projectReference(reference.reference)]
      } catch {
        // Invalid local rows are ignored by the storage loader as well.
        return []
      }
    })
    return prioritizeMerchantEventRelationshipReferences({
      current,
      products,
      saved,
    })
  }, [input.currentReference, savedReferences, sellingCollectionCoordinates])
  const exactReferenceKey = exactReferences.join("\u0000")
  const exactQuery = useQuery({
    queryKey: [
      "merchant-event-timeline-relationships",
      ...queryScope,
      merchantPubkey || "none",
      exactReferenceKey,
    ],
    queryFn: async ({ signal }) => {
      const shouldContinue = () =>
        !signal.aborted && authGenerationRef.current === authGeneration
      const hydration = await hydrateMerchantEventRelationships({
        references: exactReferences,
        signal,
        shouldContinue,
        resolve: (reference, hydrationSignal) =>
          resolveOrganizerEventMarketResolution(
            reference,
            undefined,
            authenticatedPubkey,
            hydrationSignal,
            () => !hydrationSignal.aborted && shouldContinue()
          ),
      })
      const resolutions = hydration.values
      return {
        resolutions,
        markets: projectMarketList(resolutions),
        failedCount:
          hydration.failedCount +
          resolutions.filter(
            (resolution) =>
              resolution.state === "unavailable" ||
              resolution.state === "missing"
          ).length,
      }
    },
    enabled:
      session.relaySettingsReady &&
      !!merchantPubkey &&
      exactReferences.length > 0,
    retry: false,
    staleTime: 30_000,
  })

  useEffect(() => {
    for (const market of exactQuery.data?.markets ?? []) {
      const saved = findSavedOrganizerEventMarketReference(
        savedReferences,
        market.collectionCoordinate
      )
      if (
        !saved ||
        saved.title === market.title ||
        !organizerEventMarketCanSupplySavedTitle(market, saved)
      ) {
        continue
      }
      rememberDiscoveredEventMarket(merchantPubkey, {
        ...saved,
        title: market.title,
      })
    }
  }, [exactQuery.data?.markets, merchantPubkey, savedReferences])

  const perspectiveMarkets = useMemo(
    () => projectMarketList(perspectiveQuery.data?.markets ?? []),
    [perspectiveQuery.data?.markets]
  )
  const items = useMemo(
    () =>
      mergeMerchantEventTimeline({
        merchantPubkey,
        perspectiveMarkets,
        ownedMarkets: ownedQuery.data?.markets ?? [],
        exactRelationshipMarkets: exactQuery.data?.markets ?? [],
        savedReferences,
        sellingCollectionCoordinates,
        resolutionObservations: [
          ...(perspectiveQuery.data?.markets ?? []).map((resolution) => ({
            readScope: "perspective" as const,
            resolution,
          })),
          ...(ownedQuery.data?.resolutions ?? []).map((resolution) => ({
            readScope: "owned" as const,
            resolution,
          })),
          ...(exactQuery.data?.resolutions ?? []).map((resolution) => ({
            readScope: "exact" as const,
            resolution,
          })),
        ],
      }),
    [
      exactQuery.data,
      merchantPubkey,
      ownedQuery.data,
      perspectiveQuery.data,
      perspectiveMarkets,
      savedReferences,
      sellingCollectionCoordinates,
    ]
  )
  const profileRelayHintsByPubkey = useMemo(() => {
    const hints = new Map<string, Set<string>>()
    for (const item of items) {
      const relayUrls = [
        ...(item.market.source.collection?.sourceRelayUrls ?? []),
        ...(item.market.source.calendar?.sourceRelayUrls ?? []),
      ]
      const current =
        hints.get(item.market.organizerPubkey) ?? new Set<string>()
      for (const relayUrl of relayUrls) current.add(relayUrl)
      hints.set(item.market.organizerPubkey, current)
    }
    return Object.fromEntries(
      Array.from(hints, ([pubkey, relayUrls]) => [
        pubkey,
        Array.from(relayUrls),
      ])
    )
  }, [items])

  const refreshPerspective = perspectiveQuery.refetch
  const refreshFollowing = followingQuery.refetch
  const refreshConduit = conduitQuery.refetch
  const refreshOwned = ownedQuery.refetch
  const refreshProducts = productsQuery.refetch
  const refreshExact = exactQuery.refetch
  const refetch = useCallback(() => {
    if (followingEnabled) void refreshFollowing()
    if (conduitEnabled) void refreshConduit()
    if (authorPubkeys !== undefined) void refreshPerspective()
    void refreshOwned()
    void refreshProducts()
    if (exactReferences.length > 0) void refreshExact()
  }, [
    authorPubkeys,
    conduitEnabled,
    exactReferences.length,
    followingEnabled,
    refreshConduit,
    refreshExact,
    refreshFollowing,
    refreshOwned,
    refreshPerspective,
    refreshProducts,
  ])

  const visibleCoordinates = new Set(
    items.map((item) => item.market.collectionCoordinate)
  )
  const relationshipCoordinates = new Set([
    ...sellingCollectionCoordinates,
    ...savedReferences.flatMap((reference) => {
      try {
        return [projectReference(reference.reference).coordinate]
      } catch {
        return []
      }
    }),
  ])
  const unresolvedRelationshipCount = Array.from(
    relationshipCoordinates
  ).filter((coordinate) => !visibleCoordinates.has(coordinate)).length
  const productReadIncomplete = isCommerceReadIncomplete(
    productsQuery.data?.meta
  )
  const network = qualifyMerchantEventTimelineNetwork(
    perspectiveQuery.data,
    perspectiveRefreshStale
  )

  return {
    network,
    items,
    savedReferences,
    sellingCollectionCoordinates,
    profileRelayHintsByPubkey,
    authorSource: authorResolution.source,
    isInitialLoading:
      authorPubkeys === undefined ||
      (items.length === 0 &&
        (perspectiveQuery.isPending ||
          ownedQuery.isPending ||
          (exactReferences.length > 0 && exactQuery.isPending))),
    isFetching:
      followingQuery.isFetching ||
      conduitQuery.isFetching ||
      perspectiveQuery.isFetching ||
      ownedQuery.isFetching ||
      productsQuery.isFetching ||
      exactQuery.isFetching,
    isRefreshStale:
      perspectiveQuery.isError ||
      ownedQuery.isError ||
      exactQuery.isError ||
      perspectiveRefreshStale ||
      productReadIncomplete ||
      (exactQuery.data?.failedCount ?? 0) > 0,
    unresolvedRelationshipCount,
    error:
      perspectiveQuery.error ??
      ownedQuery.error ??
      productsQuery.error ??
      exactQuery.error,
    refetch,
  }
}

function projectReference(reference: string): {
  coordinate: string
  reference: string
} {
  const parsed = parseOrganizerEventMarketReference(reference)
  return { coordinate: parsed.coordinate, reference: parsed.naddr }
}
