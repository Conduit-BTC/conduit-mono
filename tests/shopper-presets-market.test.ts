import { describe, expect, it } from "bun:test"
import {
  SHOPPER_PRESET_PASSWORD_MAX_BYTES,
  getShopperPresetPasswordError,
  type ShopperPresetsReadResult,
  type ShopperShippingPreset,
} from "@conduit/core"
import { fetchShopperPresetsForSession } from "../apps/market/src/hooks/useShopperPresets"
import {
  createSerialOperationQueue,
  isCurrentShopperPresetsRevision,
  isCurrentShopperPresetsRelayLifecycle,
  shopperPresetsQueryKey,
  shouldApplyShopperPresetsReadResult,
  shouldRefetchShopperPresetsAfterRelayActivation,
} from "../apps/market/src/lib/shopper-presets-relay-lifecycle"
import { getShopperPreferencesSaveBlockers } from "../apps/market/src/lib/shopper-preferences-validation"
import { isClearedRemoteShopperPreset } from "../apps/market/src/lib/shopper-presets-ui"
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
  initializeCheckoutShippingSession,
  readCheckoutShippingCapabilityInitialization,
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

  it("identifies only an unlocked remote preset without shipping as cleared", () => {
    const clearedPreset = {
      preferredRail: "automatic" as const,
      display: {
        currency: "BITCOIN" as const,
        bitcoinUnit: "bitcoin" as const,
      },
    }

    expect(
      isClearedRemoteShopperPreset({
        hasRemotePreset: true,
        unlockState: "unlocked",
        preset: clearedPreset,
      })
    ).toBe(true)
    expect(
      isClearedRemoteShopperPreset({
        hasRemotePreset: false,
        unlockState: "unlocked",
        preset: clearedPreset,
      })
    ).toBe(false)
    expect(
      isClearedRemoteShopperPreset({
        hasRemotePreset: true,
        unlockState: "locked",
        preset: clearedPreset,
      })
    ).toBe(false)
    expect(
      isClearedRemoteShopperPreset({
        hasRemotePreset: true,
        unlockState: "unlocked",
        preset: { ...clearedPreset, shipping: preset },
      })
    ).toBe(false)
  })

  it("shows the cleared-record notice and scopes the replacement save failure", async () => {
    const preferences = await Bun.file(
      "apps/market/src/routes/preferences.tsx"
    ).text()
    const saveStart = preferences.indexOf("async function save")
    const clearStart = preferences.indexOf("async function clear")
    const save = preferences.slice(saveStart, clearStart)

    expect(preferences).toContain('label: "Preset cleared"')
    expect(preferences).toContain(
      "No checkout preset is currently saved. Enter new defaults to\n              replace the cleared record."
    )
    expect(save).toContain(
      "No new preset was confirmed. Refresh may still find an older encrypted record."
    )
    expect(save).not.toContain(
      "The preset could not be saved. Check relay access and try again."
    )
    expect(preferences.slice(clearStart)).toContain(
      '"The preset could not be cleared."'
    )
  })

  it("accepts protocol-valid passwords through the 1024-byte boundary", () => {
    const asciiMaximum = `${"a".repeat(SHOPPER_PRESET_PASSWORD_MAX_BYTES - 1)}7`
    const multibyteMaximum = `${"é".repeat(511)}a7`

    expect(new TextEncoder().encode(asciiMaximum)).toHaveLength(
      SHOPPER_PRESET_PASSWORD_MAX_BYTES
    )
    expect(new TextEncoder().encode(multibyteMaximum)).toHaveLength(
      SHOPPER_PRESET_PASSWORD_MAX_BYTES
    )
    expect(getShopperPresetPasswordError(asciiMaximum)).toBeNull()
    expect(getShopperPresetPasswordError(multibyteMaximum)).toBeNull()
    expect(getShopperPresetPasswordError(`${multibyteMaximum}a`)).toBe(
      "Password is too long."
    )
    expect(
      getShopperPreferencesSaveBlockers({
        shipping: preset,
        password: asciiMaximum,
        confirmPassword: asciiMaximum,
        identityConnected: true,
        relayState: "ready",
      })
    ).toEqual([])
  })

  it("uses the shared password ceiling on every preferences password field", async () => {
    const preferences = await Bun.file(
      "apps/market/src/routes/preferences.tsx"
    ).text()

    expect(preferences).not.toContain("maxLength={256}")
    expect(
      preferences.match(/maxLength=\{SHOPPER_PRESET_PASSWORD_MAX_BYTES\}/gu)
    ).toHaveLength(3)
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

  it("retains unlocked preset state across same-identity relay scope changes", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()
    const lifecycleEffectStart = source.indexOf(
      "useEffect(() => {",
      source.indexOf("stateOwnerPubkeyRef")
    )
    const lifecycleEffect = source.slice(
      lifecycleEffectStart,
      source.indexOf("const result = remote.data", lifecycleEffectStart)
    )

    const sameIdentityBranch = lifecycleEffect.indexOf(
      "if (stateOwnerPubkeyRef.current === identityPubkey)"
    )
    const sameIdentityReturn = lifecycleEffect.indexOf(
      "return",
      sameIdentityBranch
    )
    const newIdentityAssignment = lifecycleEffect.indexOf(
      "stateOwnerPubkeyRef.current = identityPubkey",
      sameIdentityReturn
    )
    const clearDecryptedPreset = lifecycleEffect.indexOf(
      "setDecryptedPreset(null)",
      newIdentityAssignment
    )

    expect(sameIdentityBranch).toBeGreaterThan(-1)
    expect(lifecycleEffect).toContain('setSyncState("syncing")')
    expect(sameIdentityReturn).toBeGreaterThan(sameIdentityBranch)
    expect(newIdentityAssignment).toBeGreaterThan(sameIdentityReturn)
    expect(clearDecryptedPreset).toBeGreaterThan(newIdentityAssignment)
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

  it("keeps accepted preset revisions monotonic across stale relay reads", () => {
    const acceptedRevision = { eventId: "b", createdAt: 200 }

    expect(
      shouldApplyShopperPresetsReadResult(
        { state: "not_found" },
        acceptedRevision
      )
    ).toBe(false)
    expect(
      shouldApplyShopperPresetsReadResult(
        { state: "unavailable", reason: "relay_read" },
        acceptedRevision
      )
    ).toBe(false)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "unavailable",
          reason: "invalid_envelope",
          revision: { eventId: "a", createdAt: 199 },
        },
        acceptedRevision
      )
    ).toBe(false)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "unavailable",
          reason: "invalid_envelope",
          revision: { eventId: "a", createdAt: 201 },
        },
        acceptedRevision
      )
    ).toBe(true)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "found",
          envelope: {} as never,
          revision: { eventId: "a", createdAt: 199 },
        },
        acceptedRevision
      )
    ).toBe(false)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "found",
          envelope: {} as never,
          revision: acceptedRevision,
        },
        acceptedRevision
      )
    ).toBe(false)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "found",
          envelope: {} as never,
          revision: { eventId: "c", createdAt: 200 },
        },
        acceptedRevision
      )
    ).toBe(false)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "found",
          envelope: {} as never,
          revision: { eventId: "a", createdAt: 200 },
        },
        acceptedRevision
      )
    ).toBe(true)
    expect(
      shouldApplyShopperPresetsReadResult(
        {
          state: "found",
          envelope: {} as never,
          revision: { eventId: "c", createdAt: 201 },
        },
        acceptedRevision
      )
    ).toBe(true)
    expect(
      isCurrentShopperPresetsRevision(acceptedRevision, acceptedRevision)
    ).toBe(true)
    expect(
      isCurrentShopperPresetsRevision(
        { eventId: "a", createdAt: 200 },
        acceptedRevision
      )
    ).toBe(false)
  })

  it("gates remote preset state before applying stale query results", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()
    const effectStart = source.indexOf("const result = remote.data")
    const gate = source.indexOf(
      "shouldApplyShopperPresetsReadResult(",
      effectStart
    )
    const notFound = source.indexOf(
      'if (result.state === "not_found")',
      effectStart
    )

    expect(effectStart).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(effectStart)
    expect(gate).toBeLessThan(notFound)
    expect(source).not.toContain("handledRemoteRef")
    expect(source).not.toContain("acceptedRevisionRef")
    expect(source).not.toContain("acceptedRemoteRef")
    expect(
      source.match(/acceptedReadRef\.current = (?:result|next)/gu)
    ).toHaveLength(3)
    const decryptStart = source.indexOf("const decryptRemote = useCallback")
    const remoteEffect = source.indexOf("const result = remote.data")
    expect(
      source.indexOf("isCurrentShopperPresetsRevision(", decryptStart)
    ).toBeLessThan(remoteEffect)
    expect(source).toMatch(
      /isCurrentShopperPresetsRevision\(\s*acceptedReadRef\.current\?\.revision \?\? null,\s*result\.revision\s*\)/u
    )
    expect(source).toMatch(
      /result\.reason === "invalid_envelope"[\s\S]*acceptedReadRef\.current = result[\s\S]*setRemotePreset\(null\)[\s\S]*setDecryptedPreset\(null\)/u
    )
    expect(source).toMatch(
      /setUnlockState\(\(current\) =>[\s\S]*current === "unlocked" \? "unlocked" : "error"/u
    )
    expect(source).toMatch(
      /const preserveUnlocked =[\s\S]*decryptedPreset\?\.ownerPubkey === identityPubkey[\s\S]*unlockState === "unlocked"/u
    )
    expect(source).toMatch(
      /if \(!preserveUnlocked\) setUnlockState\("unlocking"\)[\s\S]*setDecryptedPreset\(null\)[\s\S]*setUnlockState\("error"\)/u
    )
  })

  it("settles no-op refreshes while retaining the accepted preset", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()
    const refreshStart = source.indexOf("const refresh = useCallback")
    const refreshEnd = source.indexOf("const presetOwnerPubkey", refreshStart)
    const refresh = source.slice(refreshStart, refreshEnd)
    const monotonicGate = refresh.indexOf(
      "!shouldApplyShopperPresetsReadResult("
    )
    const restoreAccepted = refresh.indexOf(
      "shopperPresetsQueryKey(identity, lifecycle.relayScope),\n            acceptedRead",
      monotonicGate
    )
    const settle = refresh.indexOf("setSyncState(", restoreAccepted)
    const earlyReturn = refresh.indexOf("return", settle)

    expect(refreshStart).toBeGreaterThan(-1)
    expect(monotonicGate).toBeGreaterThan(-1)
    expect(restoreAccepted).toBeGreaterThan(monotonicGate)
    expect(settle).toBeGreaterThan(restoreAccepted)
    expect(earlyReturn).toBeGreaterThan(settle)
    expect(refresh).toContain(
      'acceptedRead?.state === "found" ? "synced" : "unavailable"'
    )
    expect(refresh).toContain('result.state === "not_found"')
    expect(refresh).toContain('? "ready"')
    expect(refresh).toContain(': "unavailable"')
  })

  it("keeps capability drafts and clear policy bound to connected auth state", async () => {
    const [capability, preferences, presets] = await Promise.all([
      Bun.file("apps/market/src/hooks/useMerchantCheckoutCapability.ts").text(),
      Bun.file("apps/market/src/routes/preferences.tsx").text(),
      Bun.file("apps/market/src/hooks/useShopperPresets.tsx").text(),
    ])

    expect(capability).toContain(
      'const identityPubkey = authStatus === "connected" ? pubkey : null'
    )
    expect(capability).toMatch(
      /readCheckoutShippingCapabilityInitialization\([\s\S]*identityPubkey\s*\)\.value/u
    )
    expect(preferences).toContain("presets.clear(password, policy)")
    expect(preferences).toContain("const policyEditedRef = useRef(false)")
    expect(preferences).toMatch(
      /draftIdentityRef\.current !== presets\.identityPubkey[\s\S]*policyEditedRef\.current = false[\s\S]*setPolicy\(presets\.unlockPolicy\)[\s\S]*clearPlaintextDraft\(\)/u
    )
    expect(preferences).toMatch(
      /if \(plaintextBecameUnavailable\)[\s\S]*policyEditedRef\.current = false[\s\S]*setPolicy\(presets\.unlockPolicy\)[\s\S]*clearPlaintextDraft\(\)/u
    )
    expect(presets).toContain(
      "password: string,\n      policy: ShopperPresetsUnlockPolicy"
    )
    expect(presets).toContain("rememberPassword(password, policy)")
    expect(presets).toContain(
      "unlockPolicyState.ownerPubkey === identityPubkey"
    )
  })

  it("stores an unlock password only after an explicit policy choice", () => {
    const local = memoryStorage()
    const session = memoryStorage()
    persistShopperPresetsUnlock(
      "buyer",
      "password one",
      "device",
      local,
      session
    )
    expect(
      readRememberedShopperPresetsPassword("buyer", local, session)
    ).toEqual({ password: "password one", policy: "device" })

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
    expect(readShopperPresetsUnlockPolicy("buyer", local)).toBe("always")

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
    const setPolicyIndex = source.indexOf(
      "setUnlockPolicyState({ ownerPubkey: identityPubkey, policy })"
    )
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
    const writeIndex = source.indexOf("const write = useCallback")
    const saveIndex = source.indexOf("const save = useCallback")
    const clearIndex = source.indexOf("const clear = useCallback")
    const lockIndex = source.indexOf("const lock = useCallback")

    expect(
      source.indexOf("rememberPassword(password, policy)", unlockIndex)
    ).toBeGreaterThan(unlockIndex)
    expect(
      source.indexOf("rememberPassword(password, policy)", writeIndex)
    ).toBeGreaterThan(writeIndex)
    expect(
      source.indexOf("clearShopperPresetsUnlock(", lockIndex)
    ).toBeGreaterThan(lockIndex)
  })

  it("passes the accepted found revision when saving or clearing presets", async () => {
    const source = await Bun.file(
      "apps/market/src/hooks/useShopperPresets.tsx"
    ).text()
    const writeStart = source.indexOf("const write = useCallback")
    const saveStart = source.indexOf("const save = useCallback")
    const clearStart = source.indexOf("const clear = useCallback")
    const lockStart = source.indexOf("const lock = useCallback")
    const write = source.slice(writeStart, saveStart)
    const save = source.slice(saveStart, clearStart)
    const clear = source.slice(clearStart, lockStart)

    expect(source).toContain("const writeQueueRef = useRef")
    expect(source).toContain("createSerialOperationQueue()")

    const queueIndex = write.indexOf("writeQueueRef.current!.enqueue")
    const acceptedRevisionIndex = write.indexOf("const acceptedRevision")
    expect(write).toContain('acceptedReadRef.current?.state === "found"')
    expect(write).toContain("acceptedRevision,")
    expect(queueIndex).toBeGreaterThan(-1)
    expect(acceptedRevisionIndex).toBeGreaterThan(queueIndex)
    expect(save).toContain("if (!value.shipping) return false")
    expect(save).toContain("write(value, password, policy)")
    expect(clear).toContain("write(null, password, policy)")
  })

  it("serializes operations after a successful predecessor", async () => {
    const queue = createSerialOperationQueue()
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = queue.enqueue(
      () =>
        new Promise<void>((resolve) => {
          order.push("first:start")
          releaseFirst = () => {
            order.push("first:end")
            resolve()
          }
        })
    )
    const second = queue.enqueue(async () => {
      order.push("second:start")
      return "second"
    })

    await Promise.resolve()
    expect(order).toEqual(["first:start"])
    releaseFirst!()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBe("second")
    expect(order).toEqual(["first:start", "first:end", "second:start"])
  })

  it("serializes operations after a rejected predecessor", async () => {
    const queue = createSerialOperationQueue()
    const order: string[] = []
    const first = queue.enqueue(async () => {
      order.push("first:start")
      throw new Error("first failed")
    })
    const second = queue.enqueue(async () => {
      order.push("second:start")
      return "second"
    })

    await expect(first).rejects.toThrow("first failed")
    await expect(second).resolves.toBe("second")
    expect(order).toEqual(["first:start", "second:start"])
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

  it("keeps capability readiness aligned while checkout claims a guest draft", () => {
    const storage = memoryStorage()
    const guestDraft = { ...DEFAULT_CHECKOUT_SHIPPING, street: "Guest draft" }
    writeCheckoutShippingSession(guestDraft, storage, 1_000, null)

    expect(
      readCheckoutShippingCapabilityInitialization(
        null,
        "buyer-a",
        storage,
        1_001
      )
    ).toEqual({ value: guestDraft, hasActiveDraft: true })
    expect(
      initializeCheckoutShippingSession(null, "buyer-a", storage, 1_002)
    ).toEqual({ value: guestDraft, hasActiveDraft: true })
    expect(
      readCheckoutShippingInitialization(null, storage, 1_003, "buyer-a")
    ).toEqual({ value: guestDraft, hasActiveDraft: true })

    const foreignStorage = memoryStorage()
    writeCheckoutShippingSession(guestDraft, foreignStorage, 1_000, "buyer-a")
    expect(
      readCheckoutShippingCapabilityInitialization(
        null,
        "buyer-b",
        foreignStorage,
        1_001
      )
    ).toEqual({ value: DEFAULT_CHECKOUT_SHIPPING, hasActiveDraft: false })
    expect(foreignStorage.length).toBe(1)
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

  it("keeps unlocked preset shipping in memory until the shopper edits it", async () => {
    const checkout = await Bun.file(
      "apps/market/src/routes/checkout.tsx"
    ).text()
    const presetEffectStart = checkout.indexOf(
      "const preset = getIdentityBoundShippingPreset("
    )
    const updateShippingStart = checkout.indexOf(
      "function updateShipping<K extends keyof ShippingFormState>("
    )

    expect(checkout).toContain("const presetSeededShippingRef = useRef(false)")
    expect(checkout).toContain("if (presetSeededShippingRef.current) {")
    expect(checkout).toContain("setShipping(DEFAULT_CHECKOUT_SHIPPING)")
    expect(presetEffectStart).toBeGreaterThan(-1)
    expect(updateShippingStart).toBeGreaterThan(presetEffectStart)
    expect(
      checkout.slice(presetEffectStart, updateShippingStart)
    ).not.toContain("writeCheckoutShippingSession(")
    expect(checkout.slice(updateShippingStart)).toContain(
      "writeCheckoutShippingSession(next, undefined, undefined, draftOwnerIdentity)"
    )
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
      shippingOptionId: "30406:merchant:restricted-shipping-standard",
      shippingOptionDTag: "restricted-shipping-standard",
      shippingCountries: ["US"],
      shippingCountryRules: [
        { code: "US", name: "US", restrictTo: ["94**"], exclude: [] },
      ],
      canonicalShippingResolved: true,
    })
    expect(
      getCartShippingDestinationEligibility(
        { country: "US", postalCode: "94559" },
        [restricted]
      )
    ).toEqual({ eligible: true })
    expect(
      getCartShippingDestinationEligibility(
        { country: "US", postalCode: "10001" },
        [restricted]
      )
    ).toEqual({ eligible: false, reason: "postal_restricted" })
  })

  it("uses the saved rail preference for checkout without narrowing Zap Out capability", async () => {
    const [checkout, capability] = await Promise.all([
      Bun.file("apps/market/src/routes/checkout.tsx").text(),
      Bun.file("apps/market/src/hooks/useMerchantCheckoutCapability.ts").text(),
    ])

    expect(checkout).toContain(
      "preferredRail: shopperPresets.preset.preferredRail"
    )
    expect(checkout).toContain("readyWalletIds,")
    expect(capability).toContain(
      'import { useShopperPresets } from "./useShopperPresets"'
    )
    expect(capability).toContain("const shopperPresets = useShopperPresets()")
    expect(capability).not.toContain(
      "preferredRail: shopperPresets.preset.preferredRail"
    )
    expect(capability).toContain("resolveCheckoutPaymentTarget({")
    expect(capability).toContain("selection: null")
    expect(capability).toContain("readyWalletIds,")
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
    expect(capability).toContain(
      "readCheckoutShippingCapabilityInitialization("
    )
  })
})
