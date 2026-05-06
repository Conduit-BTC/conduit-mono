import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useAuth, useProfile, useRelaySettings } from "@conduit/core"
import {
  getNwcUriStorageKey,
  getMerchantSetupReadiness,
  hasNwcConfigured,
  MERCHANT_READINESS_STORAGE_EVENT,
  parseShippingConfig,
  SHIPPING_STORAGE_KEY,
} from "../lib/readiness"

const EMPTY_STORAGE_SNAPSHOT = JSON.stringify([null, null])

function getMerchantReadinessStorageSnapshot(
  nwcStorageKey: string | null
): string {
  if (typeof window === "undefined") return EMPTY_STORAGE_SNAPSHOT

  try {
    return JSON.stringify([
      window.localStorage.getItem(SHIPPING_STORAGE_KEY),
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
    if (
      event.key &&
      event.key !== SHIPPING_STORAGE_KEY &&
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
  const { data: profile } = useProfile(pubkey)
  const { settings } = useRelaySettings(
    pubkey ? `merchant:${pubkey}` : "merchant"
  )
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
  const [rawShippingConfig, rawNwcUri] = useMemo(
    () => parseMerchantReadinessStorageSnapshot(storageSnapshot),
    [storageSnapshot]
  )
  const shippingConfig = useMemo(
    () => parseShippingConfig(rawShippingConfig),
    [rawShippingConfig]
  )
  const hasNwc = useMemo(() => hasNwcConfigured(rawNwcUri), [rawNwcUri])

  return getMerchantSetupReadiness({
    profile,
    shippingConfig,
    relaySettings: settings,
    hasNwc,
  })
}
