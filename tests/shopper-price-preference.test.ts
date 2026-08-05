import { describe, expect, it } from "bun:test"
import {
  getShopperPricePreferenceStorageKey,
  loadShopperPricePreference,
  persistShopperPricePreference,
} from "../apps/market/src/hooks/useShopperPricePreference"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  }
}

describe("shopper price preference storage", () => {
  it("persists preferences independently for each connected identity", () => {
    const storage = memoryStorage()

    persistShopperPricePreference(
      "buyer-a",
      { currency: "EUR", bitcoinUnit: "bitcoin" },
      storage
    )
    persistShopperPricePreference(
      "buyer-b",
      { currency: "BITCOIN", bitcoinUnit: "sats" },
      storage
    )

    expect(loadShopperPricePreference("buyer-a", storage)).toEqual({
      currency: "EUR",
      bitcoinUnit: "bitcoin",
    })
    expect(loadShopperPricePreference("buyer-b", storage)).toEqual({
      currency: "BITCOIN",
      bitcoinUnit: "sats",
    })
    expect(getShopperPricePreferenceStorageKey("buyer-a")).not.toBe(
      getShopperPricePreferenceStorageKey("buyer-b")
    )
  })

  it("falls back to the Bitcoin base-unit default for invalid storage", () => {
    const storage = memoryStorage()
    storage.values.set(
      getShopperPricePreferenceStorageKey("buyer"),
      JSON.stringify({ currency: "DOGE", bitcoinUnit: "bits" })
    )

    expect(loadShopperPricePreference("buyer", storage)).toEqual({
      currency: "BITCOIN",
      bitcoinUnit: "bitcoin",
    })
  })
})
