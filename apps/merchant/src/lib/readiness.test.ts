import {
  createDefaultRelaySettings,
  type Profile,
  type RelaySettingsState,
} from "@conduit/core"
import {
  getNwcUriStorageKey,
  getMerchantSetupReadiness,
  hasNwcConfigured,
  parseShippingConfig,
  parseStoredNwcConnection,
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

test("parses stored shipping config defensively", () => {
  expect(parseShippingConfig(JSON.stringify(shippingConfig))).toEqual(
    shippingConfig
  )
  expect(parseShippingConfig("not-json")).toEqual({ countries: [] })
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
})
