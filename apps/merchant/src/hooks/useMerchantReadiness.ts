import { useMemo, useSyncExternalStore } from "react"
import { useAuth, useProfile, useRelaySettings } from "@conduit/core"
import {
  getMerchantSetupReadiness,
  hasNwcConfigured,
  MERCHANT_READINESS_STORAGE_EVENT,
  NWC_URI_STORAGE_KEY,
  parseShippingConfig,
  SHIPPING_STORAGE_KEY,
} from "../lib/readiness"

const EMPTY_STORAGE_SNAPSHOT = JSON.stringify([null, null])

function getMerchantReadinessStorageSnapshot(): string {
  if (typeof window === "undefined") return EMPTY_STORAGE_SNAPSHOT

  try {
    return JSON.stringify([
      window.localStorage.getItem(SHIPPING_STORAGE_KEY),
      window.localStorage.getItem(NWC_URI_STORAGE_KEY),
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

function subscribeToMerchantReadinessStorage(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {}

  function handleStorageChange(event: StorageEvent): void {
    if (
      event.key &&
      event.key !== SHIPPING_STORAGE_KEY &&
      event.key !== NWC_URI_STORAGE_KEY
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
  const storageSnapshot = useSyncExternalStore(
    subscribeToMerchantReadinessStorage,
    getMerchantReadinessStorageSnapshot,
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
