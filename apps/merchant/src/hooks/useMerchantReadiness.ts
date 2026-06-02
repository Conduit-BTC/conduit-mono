import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { useQuery } from "@tanstack/react-query"
import {
  getShippingOptions,
  useAuth,
  useConduitSession,
  useProfile,
  useRelaySettings,
} from "@conduit/core"
import {
  getNwcUriStorageKey,
  getShippingStorageKey,
  getMerchantSetupReadiness,
  hasNwcConfigured,
  MERCHANT_READINESS_STORAGE_EVENT,
  parseShippingConfig,
  saveShippingConfig,
  shippingOptionToConfig,
  isPaymentsComplete,
  isProfileComplete,
  isShippingComplete,
  serializeShippingConfig,
} from "../lib/readiness"

const EMPTY_STORAGE_SNAPSHOT = JSON.stringify([null, null])
const PROFILE_READINESS_POLL_MS = 2_500
const PROFILE_READINESS_GRACE_MS = 10_000

function getMerchantReadinessStorageSnapshot(
  nwcStorageKey: string | null,
  shippingStorageKey: string
): string {
  if (typeof window === "undefined") return EMPTY_STORAGE_SNAPSHOT

  try {
    return JSON.stringify([
      window.localStorage.getItem(shippingStorageKey),
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
  nwcStorageKey: string | null,
  shippingStorageKey: string
) {
  if (typeof window === "undefined") return () => {}

  function handleStorageChange(event: StorageEvent): void {
    if (
      event.key &&
      event.key !== shippingStorageKey &&
      event.key !== nwcStorageKey
    ) {
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
  const { pubkey } = useAuth()
  const session = useConduitSession()
  const profileQuery = useProfile(pubkey, {
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
  const { settings } = useRelaySettings(session.relayScope, {
    pubkey,
    bootstrapRelayList: false,
  })
  const [profileCheckExpired, setProfileCheckExpired] = useState(false)
  const nwcStorageKey = useMemo(() => getNwcUriStorageKey(pubkey), [pubkey])
  const shippingStorageKey = useMemo(
    () => getShippingStorageKey(pubkey),
    [pubkey]
  )
  const subscribeToStorage = useCallback(
    (onStoreChange: () => void) =>
      subscribeToMerchantReadinessStorage(
        onStoreChange,
        nwcStorageKey,
        shippingStorageKey
      ),
    [nwcStorageKey, shippingStorageKey]
  )
  const getStorageSnapshot = useCallback(
    () =>
      getMerchantReadinessStorageSnapshot(nwcStorageKey, shippingStorageKey),
    [nwcStorageKey, shippingStorageKey]
  )
  const storageSnapshot = useSyncExternalStore(
    subscribeToStorage,
    getStorageSnapshot,
    () => EMPTY_STORAGE_SNAPSHOT
  )
  const [rawShippingConfig, rawNwcUri] = useMemo(
    () => parseMerchantReadinessStorageSnapshot(storageSnapshot),
    [storageSnapshot]
  )
  const shippingConfig = useMemo(
    () => parseShippingConfig(rawShippingConfig),
    [rawShippingConfig]
  )
  const localShippingComplete = isShippingComplete(shippingConfig)
  const remoteShippingQuery = useQuery({
    queryKey: ["merchant-shipping-options", pubkey ?? "none"],
    enabled: !!pubkey && !localShippingComplete,
    queryFn: () => getShippingOptions(pubkey!),
    staleTime: 60_000,
  })
  const remoteShippingConfig = useMemo(() => {
    const latest = remoteShippingQuery.data?.[0]
    return latest ? shippingOptionToConfig(latest) : null
  }, [remoteShippingQuery.data])
  const remoteShippingComplete = remoteShippingConfig
    ? isShippingComplete(remoteShippingConfig)
    : false
  const effectiveShippingConfig =
    !localShippingComplete && remoteShippingComplete && remoteShippingConfig
      ? remoteShippingConfig
      : shippingConfig
  const hasNwc = useMemo(() => hasNwcConfigured(rawNwcUri), [rawNwcUri])
  const profileComplete = isProfileComplete(profile)
  const paymentsComplete = isPaymentsComplete(profile)
  const shippingCheckPending =
    !!pubkey && !localShippingComplete && remoteShippingQuery.isFetching

  useEffect(() => {
    if (!pubkey || localShippingComplete || !remoteShippingConfig) return
    if (!isShippingComplete(remoteShippingConfig)) return
    if (
      serializeShippingConfig(remoteShippingConfig) ===
      serializeShippingConfig(shippingConfig)
    ) {
      return
    }

    saveShippingConfig(remoteShippingConfig, pubkey)
  }, [localShippingComplete, pubkey, remoteShippingConfig, shippingConfig])

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
    relaySettings: settings,
    hasNwc,
    profileCheckPending,
    paymentsCheckPending,
    shippingCheckPending,
  })
}
