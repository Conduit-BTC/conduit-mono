import { describe, expect, it } from "bun:test"
import type {
  ShopperPresetsReadResult,
  ShopperShippingPreset,
} from "@conduit/core"
import { fetchShopperPresetsForSession } from "../apps/market/src/hooks/useShopperPresets"
import { getShopperPreferencesSaveBlockers } from "../apps/market/src/lib/shopper-preferences-validation"
import { getCartShippingDestinationEligibility } from "../apps/market/src/lib/cart-shipping-options"
import {
  DEFAULT_CHECKOUT_SHIPPING,
  getIdentityBoundShippingPreset,
  readCheckoutShippingInitialization,
  writeCheckoutShippingSession,
} from "../apps/market/src/lib/checkout-session"
import {
  clearShopperPresetsUnlock,
  getLegacyShopperPresetsStorageKey,
  getShopperPresetsUnlockStorageKey,
  persistShopperPresetsUnlock,
  readRememberedShopperPresetsPassword,
  removeLegacyPlaintextShopperPresets,
} from "../apps/market/src/lib/shopper-presets-store"
import type { CartItem } from "../apps/market/src/lib/cart-model"

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

const preset: ShopperShippingPreset = {
  recipientName: "Ada Lovelace",
  addressLine1: "12 St James Square",
  addressLine2: "Flat 3",
  city: "London",
  stateOrRegion: "Greater London",
  postalCode: "SW1Y 4LB",
  country: "GB",
  email: "ada@example.test",
  phone: "+44 20 0000 0000",
}

function cartItem(productId: string, input: Partial<CartItem> = {}): CartItem {
  return {
    productId,
    merchantPubkey: "merchant",
    title: productId,
    price: 100,
    currency: "SATS",
    quantity: 1,
    ...input,
  }
}

describe("Market shopper preset integration", () => {
  it("lists every requirement that blocks saving preferences", () => {
    const blockers = getShopperPreferencesSaveBlockers({
      shipping: {
        recipientName: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        stateOrRegion: "",
        postalCode: "",
        country: "US",
        email: "",
        phone: "",
      },
      password: "short",
      confirmPassword: "",
      identityConnected: true,
      relayState: "unavailable",
    })

    expect(blockers.map(({ id }) => id)).toEqual([
      "recipient-name",
      "address-line-1",
      "city",
      "postal-code",
      "password-length",
      "password-confirmation",
      "relay-access",
    ])
  })

  it("allows saving when required fields, passwords, and relays are ready", () => {
    expect(
      getShopperPreferencesSaveBlockers({
        shipping: preset,
        password: "secure password 7",
        confirmPassword: "secure password 7",
        identityConnected: true,
        relayState: "ready",
      })
    ).toEqual([])
  })

  it("requires at least one number in an otherwise long password", () => {
    expect(
      getShopperPreferencesSaveBlockers({
        shipping: preset,
        password: "long password without digits",
        confirmPassword: "long password without digits",
        identityConnected: true,
        relayState: "ready",
      })
    ).toContainEqual({
      id: "password-number",
      message: "Password must contain at least one number.",
    })
  })

  it("retries one transient relay-read failure during cold start", async () => {
    const results: ShopperPresetsReadResult[] = [
      { state: "unavailable", reason: "relay_read" },
      { state: "not_found" },
    ]
    let fetchCount = 0
    let waitCount = 0

    const result = await fetchShopperPresetsForSession(
      "buyer",
      async () => results[fetchCount++]!,
      async () => {
        waitCount += 1
      }
    )

    expect(result).toEqual({ state: "not_found" })
    expect(fetchCount).toBe(2)
    expect(waitCount).toBe(1)
  })

  it("stores an unlock password only after an explicit policy choice", () => {
    const local = memoryStorage()
    const session = memoryStorage()
    persistShopperPresetsUnlock(
      "buyer",
      "password one",
      "always",
      local,
      session
    )
    expect(
      readRememberedShopperPresetsPassword("buyer", local, session)
    ).toBeNull()

    persistShopperPresetsUnlock(
      "buyer",
      "password two",
      "session",
      local,
      session
    )
    expect(
      readRememberedShopperPresetsPassword("buyer", local, session)
    ).toEqual({
      password: "password two",
      policy: "session",
    })
    expect(local.getItem(getShopperPresetsUnlockStorageKey("buyer"))).toBeNull()

    clearShopperPresetsUnlock("buyer", local, session)
    expect(
      readRememberedShopperPresetsPassword("buyer", local, session)
    ).toBeNull()
  })

  it("removes the previous plaintext preset storage", () => {
    const storage = memoryStorage()
    const key = getLegacyShopperPresetsStorageKey("buyer")
    storage.setItem(key, JSON.stringify({ value: preset }))
    removeLegacyPlaintextShopperPresets("buyer", storage)
    expect(storage.getItem(key)).toBeNull()
  })

  it("prefills the complete checkout form without replacing an active draft", () => {
    const empty = memoryStorage()
    expect(readCheckoutShippingInitialization(preset, empty, 1_001)).toEqual({
      value: {
        firstName: "Ada",
        lastName: "Lovelace",
        name: "Ada Lovelace",
        street: "12 St James Square",
        line2: "Flat 3",
        city: "London",
        state: "Greater London",
        postalCode: "SW1Y 4LB",
        country: "GB",
        email: "ada@example.test",
        phone: "+44 20 0000 0000",
      },
      hasActiveDraft: false,
    })

    const storage = memoryStorage()
    const draft = { ...DEFAULT_CHECKOUT_SHIPPING, street: "Active draft" }
    writeCheckoutShippingSession(draft, storage, 1_000)
    expect(readCheckoutShippingInitialization(preset, storage, 1_001)).toEqual({
      value: draft,
      hasActiveDraft: true,
    })
  })

  it("does not expose one identity's preset after an identity transition", () => {
    expect(
      getIdentityBoundShippingPreset("buyer-b", "buyer-a", preset)
    ).toBeNull()
    expect(getIdentityBoundShippingPreset(null, "buyer-a", preset)).toBeNull()
    expect(getIdentityBoundShippingPreset("buyer-a", "buyer-a", preset)).toBe(
      preset
    )
  })

  it("drops identity-scoped checkout data after account switch or logout", () => {
    const buyerSwitchStorage = memoryStorage()
    writeCheckoutShippingSession(
      readCheckoutShippingInitialization(preset).value,
      buyerSwitchStorage,
      1_000,
      "buyer-a"
    )
    expect(
      readCheckoutShippingInitialization(
        null,
        buyerSwitchStorage,
        1_001,
        "buyer-b"
      )
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })
    expect(buyerSwitchStorage.length).toBe(0)

    const logoutStorage = memoryStorage()
    writeCheckoutShippingSession(
      readCheckoutShippingInitialization(preset).value,
      logoutStorage,
      1_000,
      "buyer-a"
    )
    expect(
      readCheckoutShippingInitialization(null, logoutStorage, 1_001, null)
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })
    expect(logoutStorage.length).toBe(0)
  })

  it("recovers a guest draft on reload and defers restore-pending drafts", async () => {
    const guestStorage = memoryStorage()
    const guestDraft = { ...DEFAULT_CHECKOUT_SHIPPING, street: "Guest draft" }
    writeCheckoutShippingSession(guestDraft, guestStorage, 1_000, null)
    expect(
      readCheckoutShippingInitialization(null, guestStorage, 1_001, null)
    ).toEqual({ value: guestDraft, hasActiveDraft: true })

    // Checkout must initialize a real guest from the stored guest draft.
    // Only a pending signed-in session restore may defer that read, because
    // a null-owner read deletes an owner-bound draft before recovery runs.
    const source = await Bun.file("apps/market/src/routes/checkout.tsx").text()
    expect(source).toContain("restorePendingPubkey")
    expect(source).toContain("const pendingDraftOwner = restorePendingPubkey")
    expect(source).toContain(
      "const authPending = restorePendingPubkey !== null"
    )
    expect(source).not.toContain('authStatus === "restoring"')
    expect(source).toContain(
      ": pendingDraftOwner\n" +
        "        ? { value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false }\n" +
        "        : readCheckoutShippingInitialization(null, undefined, undefined, null)"
    )
    expect(source).not.toContain("readAuthSession")
    expect(source).not.toContain("AUTH_STORAGE_KEY")
    expect(source).not.toContain("authStorageRevision")
  })

  it("uses country and postal code for local shipping compatibility", () => {
    const restricted = cartItem("restricted", {
      shippingCountries: ["US"],
      shippingCountryRules: [
        { code: "US", name: "US", restrictTo: ["94**"], exclude: [] },
      ],
    })
    expect(
      getCartShippingDestinationEligibility(
        { country: "US", postalCode: "94559" },
        [restricted],
        []
      )
    ).toEqual({ eligible: true })
    expect(
      getCartShippingDestinationEligibility(
        { country: "US", postalCode: "10001" },
        [restricted],
        []
      )
    ).toEqual({ eligible: false, reason: "postal_restricted" })
  })

  it("uses the saved rail preference for initial checkout and Zap Out routing", async () => {
    const [checkout, capability] = await Promise.all([
      Bun.file("apps/market/src/routes/checkout.tsx").text(),
      Bun.file("apps/market/src/hooks/useMerchantCheckoutCapability.ts").text(),
    ])

    expect(checkout).toContain(
      "preferredRail: shopperPresets.preset.preferredRail"
    )
    expect(capability).toContain(
      'import { useShopperPresets } from "./useShopperPresets"'
    )
    expect(capability).toContain("const shopperPresets = useShopperPresets()")
    expect(capability).toContain(
      "preferredRail: shopperPresets.preset.preferredRail"
    )
  })

  it("uses only an unlocked identity-owned preset for Zap Out shipping readiness", async () => {
    const capability = await Bun.file(
      "apps/market/src/hooks/useMerchantCheckoutCapability.ts"
    ).text()

    expect(capability).toContain(
      'const identityPubkey = authStatus === "connected" ? pubkey : null'
    )
    expect(capability).toContain("restorePendingPubkey")
    expect(capability).toContain("DEFAULT_CHECKOUT_SHIPPING")
    expect(capability).toContain("const shippingPreset = restorePendingPubkey")
    expect(capability).toContain('shopperPresets.unlockState === "unlocked"')
    expect(capability).toContain("getIdentityBoundShippingPreset(")
    expect(capability).toContain("shopperPresets.presetOwnerPubkey")
    expect(capability).toContain("shopperPresets.preset.shipping")
    expect(capability).toContain("readCheckoutShippingInitialization(")
  })
})
