import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { useQuery } from "@tanstack/react-query"
import { getFollowPubkeys, type FollowListResult } from "@conduit/core"
import {
  DEFAULT_MARKET_PERSPECTIVE_NPUB,
  DEFAULT_MARKET_PERSPECTIVE_PUBKEY,
  getDefaultMarketPerspectiveCatalogAuthorKey,
  getDefaultMarketPerspectiveFollowReconciliation,
  getDefaultMarketPerspectiveFollowSnapshot,
  getDefaultMarketPerspectiveFollowStorageSnapshot,
  resolveSafeDefaultMarketPerspectiveFollowRefresh,
  selectDefaultMarketPerspectiveFollowSnapshot,
  storeDefaultMarketPerspectiveFollowSnapshot,
  subscribeDefaultMarketPerspectiveFollowStorage,
} from "../lib/defaultMarketPerspective"
import {
  isProductDiscoveryReadIncomplete,
  isSameFollowListSnapshot,
  parseFollowListSnapshot,
  type FollowListSnapshot,
} from "../lib/productCatalogRead"

export interface GuestMarketDiscovery {
  usesGuestMarket: boolean
  perspectivePubkey: string | null
  seedAuthorPubkeys?: string[]
  isRefreshing: boolean
  stale: boolean
  refetch: () => Promise<boolean>
}

function getSafeGuestFollowCandidate(
  result: FollowListResult | undefined,
  previousPubkeys: readonly string[]
): FollowListSnapshot | null {
  if (
    !result?.meta.eventObserved ||
    isProductDiscoveryReadIncomplete(result.meta)
  )
    return null
  const safePubkeys = resolveSafeDefaultMarketPerspectiveFollowRefresh(
    result.data,
    previousPubkeys
  )
  if (!safePubkeys) return null
  return (
    parseFollowListSnapshot(
      {
        pubkeys: safePubkeys,
        eventCreatedAt: result.meta.eventCreatedAt,
        eventId: result.meta.eventId,
      },
      {
        requireEventId: true,
        sortPubkeys: true,
        evidence: "verified",
        signedEvent: result.event,
      }
    ) ?? null
  )
}

export function useGuestMarketDiscovery(input: {
  enabled: boolean
}): GuestMarketDiscovery {
  const [guestFollowSnapshot, setGuestFollowSnapshot] = useState(
    getDefaultMarketPerspectiveFollowSnapshot
  )

  const followRefreshQuery = useQuery({
    queryKey: ["default-market-perspective-follow-refresh"],
    queryFn: () =>
      getFollowPubkeys({ pubkey: DEFAULT_MARKET_PERSPECTIVE_PUBKEY }),
    enabled: input.enabled,
    staleTime: 6 * 60 * 60_000,
    refetchOnWindowFocus: false,
  })

  const followRefreshIncomplete =
    input.enabled &&
    isProductDiscoveryReadIncomplete(followRefreshQuery.data?.meta)
  const subscribeToPersistedGuestFollows = useCallback(
    (listener: () => void) =>
      input.enabled
        ? subscribeDefaultMarketPerspectiveFollowStorage(listener)
        : () => undefined,
    [input.enabled]
  )
  const getPersistedGuestFollowStorageSnapshot = useCallback(
    () =>
      input.enabled ? getDefaultMarketPerspectiveFollowStorageSnapshot() : null,
    [input.enabled]
  )
  const persistedGuestFollowStorageSnapshot = useSyncExternalStore(
    subscribeToPersistedGuestFollows,
    getPersistedGuestFollowStorageSnapshot,
    () => null
  )
  // Re-read synchronously whenever a manual/automatic query pass changes
  // state or another tab writes, so the stronger snapshot participates before
  // the catalog selection for that render.
  const persistenceReadRevision = `${input.enabled}:${followRefreshQuery.fetchStatus}:${followRefreshQuery.dataUpdatedAt}`
  const persistedGuestFollowRead = useMemo(
    () => ({
      revision: persistenceReadRevision,
      storageSnapshot: persistedGuestFollowStorageSnapshot,
      snapshot: getDefaultMarketPerspectiveFollowSnapshot(),
    }),
    [persistenceReadRevision, persistedGuestFollowStorageSnapshot]
  )
  const persistedGuestFollowSnapshot = persistedGuestFollowRead.snapshot
  const retainedGuestFollowSnapshot = useMemo(
    () =>
      selectDefaultMarketPerspectiveFollowSnapshot(
        guestFollowSnapshot,
        persistedGuestFollowSnapshot
      ),
    [guestFollowSnapshot, persistedGuestFollowSnapshot]
  )
  const acceptedGuestFollowSnapshot = useMemo(
    () =>
      input.enabled
        ? getSafeGuestFollowCandidate(
            followRefreshQuery.data,
            retainedGuestFollowSnapshot.pubkeys
          )
        : null,
    [
      followRefreshQuery.data,
      input.enabled,
      retainedGuestFollowSnapshot.pubkeys,
    ]
  )
  const selectedGuestFollowSnapshot = useMemo(
    () =>
      selectDefaultMarketPerspectiveFollowSnapshot(
        retainedGuestFollowSnapshot,
        undefined,
        acceptedGuestFollowSnapshot ?? undefined
      ),
    [acceptedGuestFollowSnapshot, retainedGuestFollowSnapshot]
  )
  const { needsStateUpdate, needsStorageRepair } =
    getDefaultMarketPerspectiveFollowReconciliation({
      enabled: input.enabled,
      inMemory: guestFollowSnapshot,
      persisted: persistedGuestFollowSnapshot,
      selected: selectedGuestFollowSnapshot,
    })

  useEffect(() => {
    if (!needsStateUpdate && !needsStorageRepair) return
    const storedSnapshot = storeDefaultMarketPerspectiveFollowSnapshot(
      selectedGuestFollowSnapshot,
      { previousSnapshot: guestFollowSnapshot }
    )
    // Storage may have advanced in another tab after this hook rendered. If
    // that stronger snapshot makes this candidate unsafe, reconcile to the
    // stored winner so the pending state cannot remain stuck indefinitely.
    const nextSnapshot =
      storedSnapshot ?? getDefaultMarketPerspectiveFollowSnapshot()
    if (!isSameFollowListSnapshot(guestFollowSnapshot, nextSnapshot)) {
      setGuestFollowSnapshot(nextSnapshot)
    }
  }, [
    guestFollowSnapshot,
    needsStateUpdate,
    needsStorageRepair,
    selectedGuestFollowSnapshot,
  ])

  const refreshGuestFollows = followRefreshQuery.refetch
  const refetch = useCallback(async () => {
    if (!input.enabled) return false
    const previousCatalogKey = getDefaultMarketPerspectiveCatalogAuthorKey(
      selectedGuestFollowSnapshot.pubkeys
    )
    const readRetainedSnapshot = () => {
      const retained = selectDefaultMarketPerspectiveFollowSnapshot(
        selectedGuestFollowSnapshot,
        getDefaultMarketPerspectiveFollowSnapshot()
      )
      return {
        retained,
        catalogWillRekey:
          previousCatalogKey !==
          getDefaultMarketPerspectiveCatalogAuthorKey(retained.pubkeys),
      }
    }
    try {
      const result = await refreshGuestFollows()
      const reconciled = readRetainedSnapshot()
      if (result.isError || !result.data) {
        setGuestFollowSnapshot(reconciled.retained)
        return reconciled.catalogWillRekey
      }
      const latestRetainedSnapshot = reconciled.retained
      const candidate = getSafeGuestFollowCandidate(
        result.data,
        latestRetainedSnapshot.pubkeys
      )
      const selected = candidate
        ? selectDefaultMarketPerspectiveFollowSnapshot(
            latestRetainedSnapshot,
            undefined,
            candidate
          )
        : latestRetainedSnapshot
      const storedSnapshot = candidate
        ? (storeDefaultMarketPerspectiveFollowSnapshot(selected, {
            previousSnapshot: latestRetainedSnapshot,
          }) ?? latestRetainedSnapshot)
        : latestRetainedSnapshot
      setGuestFollowSnapshot(storedSnapshot)
      return (
        previousCatalogKey !==
        getDefaultMarketPerspectiveCatalogAuthorKey(storedSnapshot.pubkeys)
      )
    } catch {
      const reconciled = readRetainedSnapshot()
      setGuestFollowSnapshot(reconciled.retained)
      return reconciled.catalogWillRekey
    }
  }, [input.enabled, refreshGuestFollows, selectedGuestFollowSnapshot])

  const rejectedRefresh =
    input.enabled &&
    followRefreshQuery.isSuccess &&
    (acceptedGuestFollowSnapshot === null ||
      !isSameFollowListSnapshot(
        acceptedGuestFollowSnapshot,
        selectedGuestFollowSnapshot
      ))

  return {
    usesGuestMarket: input.enabled,
    perspectivePubkey: input.enabled ? DEFAULT_MARKET_PERSPECTIVE_NPUB : null,
    seedAuthorPubkeys: input.enabled
      ? selectedGuestFollowSnapshot.pubkeys
      : undefined,
    isRefreshing:
      input.enabled && (followRefreshQuery.isFetching || needsStateUpdate),
    stale:
      input.enabled &&
      (followRefreshQuery.isError ||
        followRefreshIncomplete ||
        selectedGuestFollowSnapshot.evidence !== "verified" ||
        rejectedRefresh),
    refetch,
  }
}
