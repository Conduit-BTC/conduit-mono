import { useCallback, useMemo } from "react"
import {
  DEFAULT_SHOPPER_PRICE_PREFERENCE,
  normalizeShopperPricePreference,
  useAuth,
  type ShopperDisplayCurrency,
  type ShopperPricePreference,
} from "@conduit/core"
import {
  __resetShopperPresetsStoreForTests,
  getLegacyPricePreferenceStorageKey,
} from "../lib/shopper-presets-store"
import { useShopperPresets } from "./useShopperPresets"

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

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

export function __resetShopperPricePreferenceForTests(): void {
  __resetShopperPresetsStoreForTests()
}

export function useShopperPricePreference() {
  const { pubkey, status } = useAuth()
  const { preset, updateLocal } = useShopperPresets()
  const identityPubkey = status === "connected" ? pubkey : null
  const preference = identityPubkey
    ? preset.display
    : DEFAULT_SHOPPER_PRICE_PREFERENCE

  const setPreference = useCallback(
    (next: ShopperPricePreference) => {
      if (!identityPubkey) return
      updateLocal({ ...preset, display: next })
    },
    [identityPubkey, preset, updateLocal]
  )
  const setCurrency = useCallback(
    (currency: ShopperDisplayCurrency) => {
      if (!identityPubkey) return
      updateLocal({
        ...preset,
        display: { ...preset.display, currency },
      })
    },
    [identityPubkey, preset, updateLocal]
  )
  const setSatsStandard = useCallback(
    (enabled: boolean) => {
      if (!identityPubkey) return
      updateLocal({
        ...preset,
        display: {
          ...preset.display,
          bitcoinUnit: enabled ? "sats" : "bitcoin",
        },
      })
    },
    [identityPubkey, preset, updateLocal]
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
