import { describe, expect, it } from "bun:test"
import type {
  ShopperPresetsReadResult,
  ShopperShippingPreset,
} from "@conduit/core"
import { fetchShopperPresetsForSession } from "../apps/market/src/hooks/useShopperPresets"
import {
  isCurrentShopperPresetsRelayLifecycle,
  shopperPresetsQueryKey,
  shouldRefetchShopperPresetsAfterRelayActivation,
} from "../apps/market/src/lib/shopper-presets-relay-lifecycle"
import { getShopperPreferencesSaveBlockers } from "../apps/market/src/lib/shopper-preferences-validation"
import { getCartShippingDestinationEligibility } from "../apps/market/src/lib/cart-shipping-options"
import {
  buildShippingAddressFromForm,
  validateShippingFields,
} from "../apps/market/src/lib/checkout-validation"
import {
  DEFAULT_CHECKOUT_SHIPPING,
  clearCheckoutShippingSession,
  getIdentityBoundShippingPreset,
  getShippingFormFromPreset,
  readCheckoutShippingInitialization,
  writeCheckoutShippingSession,
} from "../apps/market/src/lib/checkout-session"
import {
  clearShopperPresetsUnlock,
  getLegacyShopperPresetsStorageKey,
  getShopperPresetsPolicyStorageKey,
  getShopperPresetsUnlockStorageKey,
  persistShopperPresetsUnlock,
  readRememberedShopperPresetsPassword,
  readShopperPresetsUnlockPolicy,
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

function throwingStorage(operations: Array<"get" | "set" | "remove">): Storage {
  const fails = new Set(operations)
  return {
    get length() {
      return 0
    },
    clear: () => undefined,
    getItem: () => {
      if (fails.has("get")) throw new Error("storage read failed")
      return null
    },
    key: () => null,
    removeItem: () => {
      if (fails.has("remove")) throw new Error("storage remove failed")
    },
    setItem: () => {
      if (fails.has("set")) throw new Error("storage write failed")
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

  it("waits for the signed-in relay scope before the initial preset read", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()

    expect(source).toContain(
      "const { identityReady, relayScope, relaySettingsReady } = useConduitSession()"
    )
    expect(source).toContain(
      "enabled: !!identityPubkey && identityReady && relaySettingsReady"
    )
  })

  it("does not explicitly refetch the initial ready session with no cache", () => {
    expect(
      shouldRefetchShopperPresetsAfterRelayActivation(
        null,
        {
          identityPubkey: "buyer",
          relayScope: "market:buyer",
          relaySettingsReady: true,
        },
        false
      )
    ).toBe(false)
  })

  it("refetches a cached session once when relay settings reactivate", () => {
    const lifecycle = {
      identityPubkey: "buyer",
      relayScope: "market:buyer",
    }

    expect(
      shouldRefetchShopperPresetsAfterRelayActivation(
        { ...lifecycle, relaySettingsReady: false },
        { ...lifecycle, relaySettingsReady: true },
        true
      )
    ).toBe(true)
  })

  it("uses a distinct query key for each relay scope", () => {
    expect(shopperPresetsQueryKey("buyer", "market:buyer:primary")).not.toEqual(
      shopperPresetsQueryKey("buyer", "market:buyer:secondary")
    )
  })

  it("does not refetch repeatedly while relay settings remain ready", () => {
    const lifecycle = {
      identityPubkey: "buyer",
      relayScope: "market:buyer",
      relaySettingsReady: true,
    }

    expect(
      shouldRefetchShopperPresetsAfterRelayActivation(
        lifecycle,
        lifecycle,
        true
      )
    ).toBe(false)
  })

  it("fences preset commits after an identity or relay scope change", () => {
    const previous = {
      identityPubkey: "buyer-a",
      relayScope: "market:buyer-a",
      relaySettingsReady: false,
    }
    const current = {
      identityPubkey: "buyer-b",
      relayScope: "market:buyer-b",
      relaySettingsReady: true,
    }

    expect(
      shouldRefetchShopperPresetsAfterRelayActivation(previous, current, true)
    ).toBe(false)
    expect(isCurrentShopperPresetsRelayLifecycle(current, previous)).toBe(false)
    expect(
      isCurrentShopperPresetsRelayLifecycle(
        { ...previous, relayScope: "market:buyer-a:next" },
        previous
      )
    ).toBe(false)
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

  it("treats storage read failures as absent unlock state", () => {
    const storage = throwingStorage(["get"])

    expect(readShopperPresetsUnlockPolicy("buyer", storage)).toBe("always")
    expect(
      readRememberedShopperPresetsPassword("buyer", storage, storage)
    ).toBeNull()
  })

  it("keeps unlock persistence and cleanup best-effort when storage writes fail", () => {
    const storage = throwingStorage(["set", "remove"])

    expect(() =>
      persistShopperPresetsUnlock(
        "buyer",
        "password one",
        "always",
        storage,
        storage
      )
    ).not.toThrow()
    expect(() =>
      clearShopperPresetsUnlock("buyer", storage, storage)
    ).not.toThrow()
    expect(() =>
      removeLegacyPlaintextShopperPresets("buyer", storage)
    ).not.toThrow()
  })

  it("continues session password cleanup after a local storage removal failure", () => {
    const local = throwingStorage(["remove"])
    const session = memoryStorage()
    const key = getShopperPresetsUnlockStorageKey("buyer")
    session.setItem(key, JSON.stringify({ version: 1, password: "password" }))

    clearShopperPresetsUnlock("buyer", local, session)

    expect(session.getItem(key)).toBeNull()
  })

  it("keeps the selected policy in memory when local storage is unavailable", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()
    const setPolicyIndex = source.indexOf("setUnlockPolicy(policy)")
    const persistIndex = source.indexOf(
      "persistShopperPresetsUnlock(",
      setPolicyIndex
    )

    expect(setPolicyIndex).toBeGreaterThan(-1)
    expect(persistIndex).toBeGreaterThan(setPolicyIndex)
    expect(source).toContain("clearShopperPresetsUnlock(")
    expect(source).toContain("removeLegacyPlaintextShopperPresets(")
    expect(source).toContain("readRememberedShopperPresetsPassword(")
  })

  it("keeps save, unlock, clear, and lock protocol outcomes separate from storage", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()
    const unlockIndex = source.indexOf("const decryptRemote = useCallback")
    const saveIndex = source.indexOf("const save = useCallback")
    const clearIndex = source.indexOf("const clear = useCallback")
    const lockIndex = source.indexOf("const lock = useCallback")

    expect(
      source.indexOf("rememberPassword(password, policy)", unlockIndex)
    ).toBeGreaterThan(unlockIndex)
    expect(
      source.indexOf("rememberPassword(password, policy)", saveIndex)
    ).toBeGreaterThan(saveIndex)
    expect(
      source.indexOf("rememberPassword(password, unlockPolicy)", clearIndex)
    ).toBeGreaterThan(clearIndex)
    expect(
      source.indexOf("clearShopperPresetsUnlock(", lockIndex)
    ).toBeGreaterThan(lockIndex)
  })

  it("does not require password persistence for the always policy", () => {
    const local = memoryStorage()
    const session = throwingStorage(["set", "remove"])

    expect(() =>
      persistShopperPresetsUnlock(
        "buyer",
        "password one",
        "always",
        local,
        session
      )
    ).not.toThrow()
    expect(local.getItem(getShopperPresetsUnlockStorageKey("buyer"))).toBeNull()
    expect(local.getItem(getShopperPresetsPolicyStorageKey("buyer"))).toBe(
      "always"
    )
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

  it("hydrates single-name and organization recipients without changing their order names", () => {
    const cases = [
      {
        recipientName: "Madonna",
        firstName: "Madonna",
        lastName: "",
      },
      {
        recipientName: "Acme Trading Company",
        firstName: "Acme Trading",
        lastName: "Company",
      },
    ]

    for (const expected of cases) {
      const shipping = getShippingFormFromPreset({
        ...preset,
        recipientName: expected.recipientName,
      })

      expect(shipping.firstName).toBe(expected.firstName)
      expect(shipping.lastName).toBe(expected.lastName)
      expect(validateShippingFields(shipping)).toEqual([])
      expect(buildShippingAddressFromForm(shipping).name).toBe(
        expected.recipientName
      )
    }
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

  it("does not expose identity-scoped drafts to another identity before transition cleanup", () => {
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
    expect(buyerSwitchStorage.length).toBe(1)
    clearCheckoutShippingSession(buyerSwitchStorage)
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
    expect(logoutStorage.length).toBe(1)
    clearCheckoutShippingSession(logoutStorage)
    expect(logoutStorage.length).toBe(0)
  })

  it("recovers a guest draft on reload and defers restore-pending drafts", async () => {
    const guestStorage = memoryStorage()
    const guestDraft = { ...DEFAULT_CHECKOUT_SHIPPING, street: "Guest draft" }
    writeCheckoutShippingSession(guestDraft, guestStorage, 1_000, null)
    expect(
      readCheckoutShippingInitialization(null, guestStorage, 1_001, null)
    ).toEqual({ value: guestDraft, hasActiveDraft: true })

    // A pending signed-in session restore defers all draft storage reads until
    // the owner is known, so an identity-bound draft cannot render in between.
    const source = await Bun.file("apps/market/src/routes/checkout.tsx").text()
    expect(source).toContain("restorePendingPubkey")
    expect(source).toContain(
      'authSignerReadiness === "pending" || restorePendingPubkey !== null'
    )
    expect(source).not.toContain('authStatus === "restoring"')
    expect(source).toContain("if (authPending) return")
    expect(source).toContain("initializeCheckoutShippingSession(")
    expect(source).not.toContain("readCheckoutShippingInitialization(")
    expect(source).not.toContain("readAuthSession")
    expect(source).not.toContain("AUTH_STORAGE_KEY")
    expect(source).not.toContain("authStorageRevision")
  })

  it("delegates ownership decisions to checkout session initialization before preset seeding", async () => {
    const [checkout, session] = await Promise.all([
      Bun.file("apps/market/src/routes/checkout.tsx").text(),
      Bun.file("apps/market/src/lib/checkout-session.ts").text(),
    ])
    const initializationIndex = checkout.indexOf(
      "initializeCheckoutShippingSession("
    )
    const presetSeedIndex = checkout.indexOf(
      "if (!presetMaySeedShippingRef.current) return"
    )

    expect(initializationIndex).toBeGreaterThan(-1)
    expect(presetSeedIndex).toBeGreaterThan(initializationIndex)
    expect(session).toContain("getCheckoutShippingDraftOwnershipAction")
    expect(session).toContain("inspectCheckoutShippingDraftOwnership")
  })

  it("uses the connected auth identity for checkout draft ownership independently of signer readiness", async () => {
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()

    expect(checkout).toContain(
      'const draftOwnerIdentity = authStatus === "connected" ? pubkey : null'
    )
    expect(checkout).toContain(
      "getIdentityBoundShippingPreset(\n      draftOwnerIdentity,"
    )
    expect(checkout).toContain(
      "initializeCheckoutShippingSession(\n        preset,\n        draftOwnerIdentity"
    )
    expect(checkout).toContain(
      "if (previousIdentity === draftOwnerIdentity) return"
    )
    expect(checkout).toContain(
      "writeCheckoutShippingSession(next, undefined, undefined, draftOwnerIdentity)"
    )
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
