import {
  createDefaultRelaySettings,
  type Profile,
  type RelaySettingsState,
} from "@conduit/core"
import {
  getNwcUriStorageKey,
  getShippingStorageKey,
  getMerchantSetupReadiness,
  hasNwcConfigured,
  loadShippingConfig,
  parseShippingConfig,
  parseStoredNwcConnection,
  serializeShippingConfig,
  shippingOptionToConfig,
} from "./readiness"

declare function describe(name: string, fn: () => void): void
declare function test(name: string, fn: () => void): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}

const completeProfile = {
  displayName: "Merchant",
  about: "A merchant profile",
  picture: "https://example.com/avatar.png",
  lud16: "merchant@example.com",
} as Profile

const shippingConfig = {
  countries: [
    {
      code: "US",
      name: "United States",
      restrictTo: [],
      exclude: [],
    },
  ],
}

const emptyRelaySettings: RelaySettingsState = {
  version: 1,
  updatedAt: 1,
  entries: [],
}

function withMockLocalStorage(run: (storage: Storage) => void): void {
  const hadLocalStorage = "localStorage" in globalThis
  const originalLocalStorage = globalThis.localStorage
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } as Storage

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  })

  try {
    run(storage)
  } finally {
    if (hadLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      })
    } else {
      Reflect.deleteProperty(globalThis, "localStorage")
    }
  }
}

test("validates stored NWC URIs with the shared NIP-47 parser", () => {
  const validUri =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Frelay.example.com&secret=" +
    "b".repeat(64)

  expect(parseStoredNwcConnection(validUri)?.walletPubkey).toBe("a".repeat(64))
  expect(hasNwcConfigured(validUri)).toBe(true)
  expect(hasNwcConfigured("nostr+walletconnect://wallet?relay=x")).toBe(false)
})

test("scopes stored NWC URIs to the active merchant pubkey", () => {
  expect(getNwcUriStorageKey("merchant-pubkey")).toBe(
    "conduit:merchant:nwc_uri:merchant-pubkey"
  )
  expect(getNwcUriStorageKey("")).toBe(null)
  expect(hasNwcConfigured()).toBe(false)
})

test("scopes stored shipping configs to the active merchant pubkey", () => {
  expect(getShippingStorageKey("merchant-pubkey")).toBe(
    "conduit:merchant:shipping_config:merchant-pubkey"
  )
  expect(getShippingStorageKey("")).toBe("conduit:merchant:shipping_config")
})

test("keeps legacy shipping config out of signed-in merchant readiness", () => {
  withMockLocalStorage((storage) => {
    storage.setItem(
      "conduit:merchant:shipping_config",
      JSON.stringify(shippingConfig)
    )

    expect(loadShippingConfig("other-merchant")).toEqual({ countries: [] })
    expect(loadShippingConfig()).toEqual(shippingConfig)
  })
})

test("parses stored shipping config defensively", () => {
  expect(parseShippingConfig(JSON.stringify(shippingConfig))).toEqual(
    shippingConfig
  )
  expect(parseShippingConfig("not-json")).toEqual({ countries: [] })
  expect(
    parseShippingConfig(
      JSON.stringify({ countries: [{ code: " us ", restrictTo: [123] }] })
    )
  ).toEqual({
    countries: [
      {
        code: "US",
        name: "United States",
        restrictTo: [],
        exclude: [],
      },
    ],
  })
  expect(serializeShippingConfig(shippingConfig)).toBe(
    JSON.stringify(shippingConfig)
  )
})

test("maps published shipping options back into readiness config", () => {
  expect(
    shippingOptionToConfig({
      id: "30406:merchant:conduit-default",
      pubkey: "merchant",
      dTag: "conduit-default",
      title: "Standard Shipping",
      currency: "USD",
      price: 0,
      countries: ["US"],
      countryRules: [
        {
          code: "US",
          name: "US",
          restrictTo: ["787**"],
          exclude: ["78799"],
        },
      ],
      service: "standard",
      createdAt: 1,
    })
  ).toEqual({
    countries: [
      {
        code: "US",
        name: "United States",
        restrictTo: ["787**"],
        exclude: ["78799"],
      },
    ],
  })
})

describe("merchant setup readiness", () => {
  test("marks fully configured merchants direct-payment ready", () => {
    const readiness = getMerchantSetupReadiness({
      profile: completeProfile,
      shippingConfig,
      relaySettings: createDefaultRelaySettings(),
      hasNwc: false,
    })

    expect(readiness.setupComplete).toBe(true)
    expect(readiness.paymentCapability).toBe("direct_payment")
    expect(readiness.missingAreas).toEqual([])
  })

  test("does not mark malformed Lightning Addresses payment-ready", () => {
    const readiness = getMerchantSetupReadiness({
      profile: { ...completeProfile, lud16: "not-a-lightning-address" },
      shippingConfig,
      relaySettings: createDefaultRelaySettings(),
      hasNwc: false,
    })

    expect(readiness.paymentsComplete).toBe(false)
    expect(readiness.paymentCapability).toBe("invoice_only")
    expect(readiness.missingAreas).toEqual(["payments"])
  })

  test("separates invoice/manual flow from direct payment readiness", () => {
    const readiness = getMerchantSetupReadiness({
      profile: { ...completeProfile, lud16: undefined },
      shippingConfig,
      relaySettings: createDefaultRelaySettings(),
      hasNwc: true,
    })

    expect(readiness.operationalReady).toBe(true)
    expect(readiness.setupComplete).toBe(false)
    expect(readiness.paymentCapability).toBe("invoice_only")
    expect(readiness.hasNwc).toBe(true)
    expect(readiness.missingAreas).toEqual(["payments"])
  })

  test("requires usable relay settings before marking setup operational", () => {
    const readiness = getMerchantSetupReadiness({
      profile: completeProfile,
      shippingConfig,
      relaySettings: emptyRelaySettings,
      hasNwc: false,
    })

    expect(readiness.operationalReady).toBe(false)
    expect(readiness.paymentCapability).toBe("not_ready")
    expect(readiness.missingAreas).toEqual(["network"])
  })

  test("defers profile-derived missing areas while profile hydration is pending", () => {
    const readiness = getMerchantSetupReadiness({
      profile: null,
      shippingConfig,
      relaySettings: createDefaultRelaySettings(),
      profileCheckPending: true,
      paymentsCheckPending: true,
    })

    expect(readiness.profileComplete).toBe(false)
    expect(readiness.profileCheckPending).toBe(true)
    expect(readiness.paymentsComplete).toBe(false)
    expect(readiness.paymentsCheckPending).toBe(true)
    expect(readiness.setupCheckPending).toBe(true)
    expect(readiness.setupComplete).toBe(false)
    expect(readiness.missingAreas).toEqual([])
  })

  test("defers shipping missing area while published settings are loading", () => {
    const readiness = getMerchantSetupReadiness({
      profile: completeProfile,
      shippingConfig: { countries: [] },
      relaySettings: createDefaultRelaySettings(),
      shippingCheckPending: true,
    })

    expect(readiness.shippingComplete).toBe(false)
    expect(readiness.shippingCheckPending).toBe(true)
    expect(readiness.setupCheckPending).toBe(true)
    expect(readiness.missingAreas).toEqual([])
  })
})
