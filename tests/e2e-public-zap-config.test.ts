import { describe, expect, it } from "bun:test"
import {
  applyE2eRelayIsolation,
  CANONICAL_ZAP_PUBLIC_RELAYS,
  config,
  resolveE2ePublicZapReceiptHints,
  resolveE2eRelayIsolation,
} from "../packages/core/src/config"

describe("isolated public-zap receipt hints", () => {
  it("keeps ordinary relay isolation unchanged by default", () => {
    const relays = resolveE2eRelayIsolation("mock", "ws://127.0.0.1:7777")
    expect(resolveE2ePublicZapReceiptHints("mock", relays, "")).toBe(false)
    const isolated = applyE2eRelayIsolation(config, relays)
    expect(isolated.zapRelayUrls).toEqual(relays)
  })

  it("declares canonical public receipt hints without changing operational roles", () => {
    const relays = resolveE2eRelayIsolation("mock", "ws://127.0.0.1:7777")
    const enabled = resolveE2ePublicZapReceiptHints("mock", relays, "true")
    const isolated = applyE2eRelayIsolation(config, relays, enabled)
    expect(isolated.e2eRelayIsolationEnabled).toBe(true)
    expect(isolated.zapRelayUrls).toEqual(CANONICAL_ZAP_PUBLIC_RELAYS)
    for (const key of [
      "defaultRelays",
      "appReadRelayUrls",
      "appCommerceRelayUrls",
      "appBackplaneRelayUrls",
      "appWriteRelayUrls",
      "commerceRelayUrls",
      "publicRelayUrls",
      "corePublicFallbackRelayUrls",
      "commerceDiscoveryRelayUrls",
      "searchIndexRelayUrls",
      "dmDeclarationDiscoveryRelayUrls",
      "commerceDmFallbackRelayUrls",
      "dmInboxDefaultRelayUrls",
      "dmCompatibilityOrderRelayUrls",
    ] as const) {
      expect(isolated[key]).toEqual(relays)
    }
    expect(isolated.nip89RelayHint).toBe(relays[0])
    expect(config.e2eRelayIsolationEnabled).toBe(false)
  })

  it("requires explicit mock mode and a valid isolated relay", () => {
    const relays = resolveE2eRelayIsolation("mock", "ws://127.0.0.1:7777")
    expect(resolveE2ePublicZapReceiptHints("production", [], "false")).toBe(
      false
    )
    expect(() =>
      resolveE2ePublicZapReceiptHints("production", relays, "true")
    ).toThrow("explicit mock relay isolation")
    expect(() => resolveE2ePublicZapReceiptHints("mock", [], "true")).toThrow(
      "explicit mock relay isolation"
    )
    expect(() => applyE2eRelayIsolation(config, [], true)).toThrow(
      "require relay isolation"
    )
  })
})
