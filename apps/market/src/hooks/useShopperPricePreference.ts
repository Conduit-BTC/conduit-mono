import { useCallback, useSyncExternalStore } from "react"
import {
  DEFAULT_SHOPPER_PRICE_PREFERENCE,
  isSupportedShopperDisplayCurrency,
  normalizeShopperPricePreference,
  useAuth,
  type ShopperDisplayCurrency,
  type ShopperPricePreference,
} from "@conduit/core"
import { useShopperPresets } from "./useShopperPresets"

type Listener = () => void
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

const cachedPreferences = new Map<string, ShopperPricePreference | null>()
const listenersByPubkey = new Map<string, Set<Listener>>()
const SHOPPER_PRICE_PREFERENCE_STORAGE_KEY_PREFIX =
  "conduit:market-price-preference:v1"
let storageListenerCount = 0

export function getShopperPricePreferenceStorageKey(pubkey: string): string {
  return `${SHOPPER_PRICE_PREFERENCE_STORAGE_KEY_PREFIX}:${pubkey}`
}

export function loadShopperPricePreference(
  pubkey: string,
  storage: Pick<PreferenceStorage, "getItem">
): ShopperPricePreference {
  return (
    readStoredShopperPricePreference(pubkey, storage) ??
    DEFAULT_SHOPPER_PRICE_PREFERENCE
  )
}

export function readStoredShopperPricePreference(
  pubkey: string,
  storage: Pick<PreferenceStorage, "getItem">
): ShopperPricePreference | null {
  try {
    const raw = storage.getItem(getShopperPricePreferenceStorageKey(pubkey))
    if (!raw) return null
    const candidate = JSON.parse(raw) as {
      currency?: unknown
      bitcoinUnit?: unknown
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.currency !== "string" ||
      !isSupportedShopperDisplayCurrency(candidate.currency) ||
      (candidate.bitcoinUnit !== "bitcoin" && candidate.bitcoinUnit !== "sats")
    ) {
      return null
    }
    return normalizeShopperPricePreference(candidate)
  } catch {
    return null
  }
}

export function persistShopperPricePreference(
  pubkey: string,
  preference: ShopperPricePreference,
  storage: Pick<PreferenceStorage, "setItem">
): ShopperPricePreference {
  const normalized = normalizeShopperPricePreference(preference)
  storage.setItem(
    getShopperPricePreferenceStorageKey(pubkey),
    JSON.stringify(normalized)
  )
  return normalized
}

/**
 * Updates a deliberately stored device override after its matching encrypted
 * preset has been saved. A clean device remains governed by the remote preset.
 */
export function updateExistingDevicePriceOverrideAfterPresetSaveInStorage(
  pubkey: string,
  preference: ShopperPricePreference,
  storage: PreferenceStorage
): ShopperPricePreference | null {
  if (!readStoredShopperPricePreference(pubkey, storage)) return null
  return persistShopperPricePreference(pubkey, preference, storage)
}

function readStoredPreference(
  pubkey: string | null
): ShopperPricePreference | null {
  if (!pubkey || typeof window === "undefined") return null

  if (cachedPreferences.has(pubkey)) {
    return cachedPreferences.get(pubkey) ?? null
  }

  const preference = readStoredShopperPricePreference(
    pubkey,
    window.localStorage
  )
  cachedPreferences.set(pubkey, preference)
  return preference
}

export function resolveShopperPricePreference(
  localPreference: ShopperPricePreference | null,
  unlockedPresetDisplay: ShopperPricePreference | null
): ShopperPricePreference {
  return (
    localPreference ?? unlockedPresetDisplay ?? DEFAULT_SHOPPER_PRICE_PREFERENCE
  )
}

function notify(pubkey: string): void {
  listenersByPubkey.get(pubkey)?.forEach((listener) => listener())
}

function writePreference(
  pubkey: string,
  preference: ShopperPricePreference
): void {
  const normalized = normalizeShopperPricePreference(preference)
  cachedPreferences.set(pubkey, normalized)
  try {
    persistShopperPricePreference(pubkey, normalized, window.localStorage)
  } catch {
    // Keep the active preference usable when browser storage is unavailable.
  }
  notify(pubkey)
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== window.localStorage || !event.key) return
  if (
    !event.key.startsWith(`${SHOPPER_PRICE_PREFERENCE_STORAGE_KEY_PREFIX}:`)
  ) {
    return
  }

  const pubkey = event.key.slice(
    SHOPPER_PRICE_PREFERENCE_STORAGE_KEY_PREFIX.length + 1
  )
  if (!pubkey) return
  cachedPreferences.delete(pubkey)
  notify(pubkey)
}

function subscribe(pubkey: string | null, listener: Listener): () => void {
  if (!pubkey || typeof window === "undefined") return () => undefined

  const listeners = listenersByPubkey.get(pubkey) ?? new Set<Listener>()
  listeners.add(listener)
  listenersByPubkey.set(pubkey, listeners)

  if (storageListenerCount === 0) window.addEventListener("storage", onStorage)
  storageListenerCount++

  return () => {
    const current = listenersByPubkey.get(pubkey)
    current?.delete(listener)
    if (current?.size === 0) listenersByPubkey.delete(pubkey)
    storageListenerCount = Math.max(0, storageListenerCount - 1)
    if (storageListenerCount === 0) {
      window.removeEventListener("storage", onStorage)
    }
  }
}

export function __resetShopperPricePreferenceForTests(): void {
  cachedPreferences.clear()
  listenersByPubkey.clear()
  storageListenerCount = 0
}

export function useShopperPricePreference() {
  const { pubkey, status } = useAuth()
  const { preset, unlockState } = useShopperPresets()
  const identityPubkey = status === "connected" ? pubkey : null
  const subscribeToIdentity = useCallback(
    (listener: Listener) => subscribe(identityPubkey, listener),
    [identityPubkey]
  )
  const getSnapshot = useCallback(
    () => readStoredPreference(identityPubkey),
    [identityPubkey]
  )
  const localPreference = useSyncExternalStore(
    subscribeToIdentity,
    getSnapshot,
    () => null
  )
  const preference = resolveShopperPricePreference(
    localPreference,
    identityPubkey && unlockState === "unlocked" ? preset.display : null
  )
  const setCurrency = useCallback(
    (currency: ShopperDisplayCurrency) => {
      if (!identityPubkey) return
      writePreference(identityPubkey, {
        ...resolveShopperPricePreference(
          readStoredPreference(identityPubkey),
          unlockState === "unlocked" ? preset.display : null
        ),
        currency,
      })
    },
    [identityPubkey, preset.display, unlockState]
  )
  const setSatsStandard = useCallback(
    (enabled: boolean) => {
      if (!identityPubkey) return
      writePreference(identityPubkey, {
        ...resolveShopperPricePreference(
          readStoredPreference(identityPubkey),
          unlockState === "unlocked" ? preset.display : null
        ),
        bitcoinUnit: enabled ? "sats" : "bitcoin",
      })
    },
    [identityPubkey, preset.display, unlockState]
  )
  const updateExistingDevicePriceOverrideAfterPresetSave = useCallback(
    (display: ShopperPricePreference): boolean => {
      if (!identityPubkey || typeof window === "undefined") return false
      try {
        const updated =
          updateExistingDevicePriceOverrideAfterPresetSaveInStorage(
            identityPubkey,
            display,
            window.localStorage
          )
        if (!updated) return false
        cachedPreferences.set(identityPubkey, updated)
        notify(identityPubkey)
        return true
      } catch {
        return false
      }
    },
    [identityPubkey]
  )

  return {
    preference,
    setCurrency,
    setSatsStandard,
    updateExistingDevicePriceOverrideAfterPresetSave,
  }
}
