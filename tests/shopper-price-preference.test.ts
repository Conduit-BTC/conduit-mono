import { describe, expect, it } from "bun:test"
import {
  getShopperPricePreferenceStorageKey,
  loadShopperPricePreference,
  persistShopperPricePreference,
  readStoredShopperPricePreference,
  resolveShopperPricePreference,
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

  it("treats malformed local records as absent so an unlocked preset can remain the fallback", () => {
    const storage = memoryStorage()
    storage.values.set(
      getShopperPricePreferenceStorageKey("buyer"),
      JSON.stringify({ currency: "DOGE", bitcoinUnit: "sats" })
    )

    expect(readStoredShopperPricePreference("buyer", storage)).toBeNull()
    expect(
      resolveShopperPricePreference(
        readStoredShopperPricePreference("buyer", storage),
        { currency: "EUR", bitcoinUnit: "sats" }
      )
    ).toEqual({ currency: "EUR", bitcoinUnit: "sats" })
  })

  it("prefers an explicit local preference over an unlocked encrypted preset", () => {
    expect(
      resolveShopperPricePreference(
        { currency: "USD", bitcoinUnit: "bitcoin" },
        { currency: "EUR", bitcoinUnit: "sats" }
      )
    ).toEqual({ currency: "USD", bitcoinUnit: "bitcoin" })
    expect(
      resolveShopperPricePreference(null, {
        currency: "EUR",
        bitcoinUnit: "sats",
      })
    ).toEqual({ currency: "EUR", bitcoinUnit: "sats" })
  })

  it("keeps wallet setters device-local without creating overrides on preset saves", async () => {
    const [pricePreference, pricing, wallet, preferences, presets] =
      await Promise.all([
        Bun.file("apps/market/src/hooks/useShopperPricePreference.ts").text(),
        Bun.file("apps/market/src/hooks/useShopperPricing.ts").text(),
        Bun.file("apps/market/src/routes/wallet.tsx").text(),
        Bun.file("apps/market/src/routes/preferences.tsx").text(),
        Bun.file("apps/market/src/hooks/useShopperPresets.tsx").text(),
      ])

    expect(pricePreference).toContain(
      "return { preference, setCurrency, setSatsStandard }"
    )
    expect(pricePreference).toContain("function writePreference")
    expect(pricePreference).not.toContain("updateLocal")
    expect(pricePreference).not.toContain("publishShopperPresets")
    expect(pricing).toContain(
      "const { preference, setCurrency, setSatsStandard } ="
    )
    expect(wallet).toContain("PriceDisplaySettings")
    expect(wallet).toContain("shopperPricing.setCurrency")
    expect(wallet).toContain("shopperPricing.setSatsStandard")
    expect(preferences).toContain('id="preset-display-currency"')
    expect(preferences).toContain("presets.save(value, password, policy)")
    expect(preferences).not.toContain("useShopperPricePreference")
    expect(preferences).not.toContain("setCurrency(")
    expect(preferences).not.toContain("setSatsStandard(")
    expect(presets).toContain(
      "setDecryptedPreset({ ownerPubkey: identity, value })"
    )
  })
})
