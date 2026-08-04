import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import {
  DEFAULT_SHOPPER_PRICE_PREFERENCE,
  normalizeShopperPricePreference,
  useAuth,
  type ShopperDisplayCurrency,
  type ShopperPricePreference,
} from "@conduit/core"
import {
  LEGACY_PRICE_PREFERENCE_STORAGE_KEY_PREFIX,
  getLegacyPricePreferenceStorageKey,
} from "../lib/shopper-presets-store"
import { useShopperPresets } from "./useShopperPresets"

type Listener = () => void
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

const cachedPreferences = new Map<string, ShopperPricePreference>()
const listenersByPubkey = new Map<string, Set<Listener>>()
let storageListenerCount = 0

export function getShopperPricePreferenceStorageKey(pubkey: string): string {
  return getLegacyPricePreferenceStorageKey(pubkey)
}

export function loadShopperPricePreference(
  pubkey: string,
  storage: Pick<PreferenceStorage, "getItem">
): ShopperPricePreference {
  try {
    const raw = storage.getItem(getShopperPricePreferenceStorageKey(pubkey))
    return raw
      ? normalizeShopperPricePreference(JSON.parse(raw))
      : DEFAULT_SHOPPER_PRICE_PREFERENCE
  } catch {
    return DEFAULT_SHOPPER_PRICE_PREFERENCE
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

function readPreference(pubkey: string | null): ShopperPricePreference {
  if (!pubkey || typeof window === "undefined") {
    return DEFAULT_SHOPPER_PRICE_PREFERENCE
  }

  const cached = cachedPreferences.get(pubkey)
  if (cached) return cached

  const preference = loadShopperPricePreference(pubkey, window.localStorage)
  cachedPreferences.set(pubkey, preference)
  return preference
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
  if (!event.key.startsWith(`${LEGACY_PRICE_PREFERENCE_STORAGE_KEY_PREFIX}:`)) {
    return
  }

  const pubkey = event.key.slice(
    LEGACY_PRICE_PREFERENCE_STORAGE_KEY_PREFIX.length + 1
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
  const { preset, unlockState, updateLocal } = useShopperPresets()
  const identityPubkey = status === "connected" ? pubkey : null
  const subscribeToIdentity = useCallback(
    (listener: Listener) => subscribe(identityPubkey, listener),
    [identityPubkey]
  )
  const getSnapshot = useCallback(
    () => readPreference(identityPubkey),
    [identityPubkey]
  )
  const localPreference = useSyncExternalStore(
    subscribeToIdentity,
    getSnapshot,
    () => DEFAULT_SHOPPER_PRICE_PREFERENCE
  )
  const preference =
    identityPubkey && unlockState === "unlocked"
      ? preset.display
      : localPreference

  useEffect(() => {
    if (!identityPubkey || unlockState !== "unlocked") return
    if (
      localPreference.currency === preset.display.currency &&
      localPreference.bitcoinUnit === preset.display.bitcoinUnit
    ) {
      return
    }
    writePreference(identityPubkey, preset.display)
  }, [identityPubkey, localPreference, preset.display, unlockState])

  const applyPreference = useCallback(
    (next: ShopperPricePreference) => {
      if (!identityPubkey) return
      const normalized = normalizeShopperPricePreference(next)
      writePreference(identityPubkey, normalized)
      updateLocal({ ...preset, display: normalized })
    },
    [identityPubkey, preset, updateLocal]
  )

  const setPreference = useCallback(
    (next: ShopperPricePreference) => {
      applyPreference(next)
    },
    [applyPreference]
  )
  const setCurrency = useCallback(
    (currency: ShopperDisplayCurrency) => {
      applyPreference({ ...preference, currency })
    },
    [applyPreference, preference]
  )
  const setSatsStandard = useCallback(
    (enabled: boolean) => {
      applyPreference({
        ...preference,
        bitcoinUnit: enabled ? "sats" : "bitcoin",
      })
    },
    [applyPreference, preference]
  )

  return useMemo(
    () => ({
      preference,
      canCustomize: !!identityPubkey,
      setPreference,
      setCurrency,
      setSatsStandard,
    }),
    [identityPubkey, preference, setCurrency, setPreference, setSatsStandard]
  )
}
