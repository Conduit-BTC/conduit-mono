import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useQuery } from "@tanstack/react-query"
import {
  getMerchantShippingPolicyCoordinate,
  getShippingOptionAddress,
  getShippingOptionsByCoordinates,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
  useProfile,
} from "@conduit/core"
import {
  getNwcUriStorageKey,
  getMerchantSetupReadiness,
  hasNwcConfigured,
  MERCHANT_READINESS_STORAGE_EVENT,
  selectConduitShippingOption,
  shippingOptionToConfig,
  isPaymentsComplete,
  isNetworkComplete,
  isProfileComplete,
} from "../lib/readiness"

const EMPTY_STORAGE_SNAPSHOT = JSON.stringify([null, null])
const PROFILE_READINESS_POLL_MS = 2_500
const PROFILE_READINESS_GRACE_MS = 10_000

function getMerchantReadinessStorageSnapshot(
  nwcStorageKey: string | null
): string {
  if (typeof window === "undefined") return EMPTY_STORAGE_SNAPSHOT

  try {
    return JSON.stringify([
      null,
      nwcStorageKey ? window.localStorage.getItem(nwcStorageKey) : null,
    ])
  } catch {
    return EMPTY_STORAGE_SNAPSHOT
  }
}

function parseMerchantReadinessStorageSnapshot(
  snapshot: string
): readonly [string | null, string | null] {
  try {
    const parsed = JSON.parse(snapshot) as unknown
    if (!Array.isArray(parsed)) return [null, null]

    const [shippingConfig, nwcUri] = parsed
    return [
      typeof shippingConfig === "string" ? shippingConfig : null,
      typeof nwcUri === "string" ? nwcUri : null,
    ]
  } catch {
    return [null, null]
  }
}

function subscribeToMerchantReadinessStorage(
  onStoreChange: () => void,
  nwcStorageKey: string | null
) {
  if (typeof window === "undefined") return () => {}

  function handleStorageChange(event: StorageEvent): void {
    if (event.key && event.key !== nwcStorageKey) {
      return
    }

    onStoreChange()
  }

  window.addEventListener("storage", handleStorageChange)
  window.addEventListener(MERCHANT_READINESS_STORAGE_EVENT, onStoreChange)

  return () => {
    window.removeEventListener("storage", handleStorageChange)
    window.removeEventListener(MERCHANT_READINESS_STORAGE_EVENT, onStoreChange)
  }
}

export function useMerchantReadiness() {
  const { pubkey, status: authStatus, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const session = useConduitSession()
  const authenticatedPubkey = authStatus === "connected" ? pubkey : null
  const profileQuery = useProfile(pubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    skipCache: true,
    staleTime: PROFILE_READINESS_POLL_MS,
    refetchUnresolvedMs: PROFILE_READINESS_POLL_MS,
    readPolicy: {
      maxRelays: 16,
      connectTimeoutMs: 2_000,
      fetchTimeoutMs: 8_000,
    },
  })
  const profile = profileQuery.data
  const refetchProfile = profileQuery.refetch
  const privateInboxCheckEnabled = !!pubkey && session.relaySettingsReady
  const privateInbox = useInboxDeclaration(pubkey, {
    enabled: privateInboxCheckEnabled,
    relayScope: session.relayScope,
  })
  const [profileCheckExpired, setProfileCheckExpired] = useState(false)
  const nwcStorageKey = useMemo(() => getNwcUriStorageKey(pubkey), [pubkey])
  const subscribeToStorage = useCallback(
    (onStoreChange: () => void) =>
      subscribeToMerchantReadinessStorage(onStoreChange, nwcStorageKey),
    [nwcStorageKey]
  )
  const getStorageSnapshot = useCallback(
    () => getMerchantReadinessStorageSnapshot(nwcStorageKey),
    [nwcStorageKey]
  )
  const storageSnapshot = useSyncExternalStore(
    subscribeToStorage,
    getStorageSnapshot,
    () => EMPTY_STORAGE_SNAPSHOT
  )
  const [, rawNwcUri] = useMemo(
    () => parseMerchantReadinessStorageSnapshot(storageSnapshot),
    [storageSnapshot]
  )
  const remoteShippingQuery = useQuery({
    queryKey: ["merchant-shipping-options", pubkey ?? "none", authStatus],
    enabled: !!pubkey && authStatus === "connected",
    queryFn: ({ signal }) =>
      getShippingOptionsByCoordinates(
        [
          getShippingOptionAddress(pubkey!),
          getMerchantShippingPolicyCoordinate(pubkey!),
        ],
        {
          accountPubkey: pubkey,
          authenticatedPubkey: authStatus === "connected" ? pubkey : null,
          signal,
          shouldContinue: () =>
            !signal.aborted && authGenerationRef.current === authGeneration,
        }
      ),
    staleTime: 30_000,
  })
  const shippingPolicyReady =
    authStatus === "connected" &&
    !!remoteShippingQuery.data?.some(
      (option) =>
        option.id === getMerchantShippingPolicyCoordinate(pubkey!) &&
        !!option.shippingPolicy
    )
  const remoteShippingConfig = useMemo(() => {
    const latest = selectConduitShippingOption(remoteShippingQuery.data)
    return latest ? shippingOptionToConfig(latest) : null
  }, [remoteShippingQuery.data])
  const effectiveShippingConfig = remoteShippingConfig ?? { countries: [] }
  const hasNwc = useMemo(() => hasNwcConfigured(rawNwcUri), [rawNwcUri])
  const profileComplete = isProfileComplete(profile)
  const paymentsComplete = isPaymentsComplete(
    profileQuery.profileContext?.profile
  )
  const shippingCheckPending =
    !!pubkey && !shippingPolicyReady && remoteShippingQuery.isFetching
  const networkComplete = isNetworkComplete(
    session.accountNetworkPreferences.reconciliation?.projection.rows ?? []
  )

  useEffect(() => {
    setProfileCheckExpired(false)
  }, [pubkey])

  useEffect(() => {
    if (profileComplete) {
      setProfileCheckExpired(false)
      return
    }
    if (!pubkey || profileCheckExpired) return

    const timeoutId = window.setTimeout(
      () => setProfileCheckExpired(true),
      PROFILE_READINESS_GRACE_MS
    )
    const intervalId = window.setInterval(() => {
      void refetchProfile()
    }, PROFILE_READINESS_POLL_MS)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [profileCheckExpired, profileComplete, pubkey, refetchProfile])

  const profileCheckPending =
    !!pubkey && !profileComplete && !profileCheckExpired
  const paymentsCheckPending =
    !!pubkey && !paymentsComplete && !profileComplete && !profileCheckExpired

  return getMerchantSetupReadiness({
    profile,
    shippingConfig: effectiveShippingConfig,
    shippingPolicyReady,
    networkComplete,
    hasNwc,
    profileCheckPending,
    paymentsCheckPending,
    shippingCheckPending,
    privateInboxStatus: privateInbox.status,
    privateInboxStale: privateInbox.stale,
    privateInboxCheckEnabled,
  })
}
