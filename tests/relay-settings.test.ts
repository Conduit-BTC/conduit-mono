import { afterEach, describe, expect, it } from "bun:test"
import {
  assertSafeNip65RelayList,
  applyE2eRelayIsolation,
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_APP_WRITE_RELAYS,
  CANONICAL_COMMERCE_DISCOVERY_RELAYS,
  CANONICAL_COMMERCE_DM_FALLBACK_RELAYS,
  CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
  CANONICAL_DEFAULT_RELAYS,
  CANONICAL_DM_DECLARATION_DISCOVERY_RELAYS,
  CANONICAL_DM_COMPATIBILITY_ORDER_RELAYS,
  CANONICAL_DM_INBOX_DEFAULT_RELAYS,
  CANONICAL_SEARCH_INDEX_RELAYS,
  CANONICAL_ZAP_PUBLIC_RELAYS,
  config,
  createDefaultRelaySettings,
  createRelaySettingsEntryFromScan,
  createRelaySettingsFromPreferences,
  createUnreachableRelaySettingsEntry,
  deriveRelayScanResult,
  getCommerceReadRelayUrls,
  getCommerceWriteRelayUrls,
  getGeneralWriteRelayUrls,
  getInboxCandidateRelayUrls,
  getInboxRelayCandidates,
  getPublishableRelaySettingsEntries,
  getRelayBucketConfigs,
  loadRelaySettings,
  mergeRelayPreferencesIntoSettings,
  normalizeSecureRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizeUntrustedRelayHintsForContext,
  normalizeRelaySettingsState,
  normalizeRelayUrl,
  parseNip65RelayTags,
  resolveE2eRelayIsolation,
  saveRelaySettings,
  scanRelaySettingsEntry,
  secureRelayUrls,
  serializeNip65RelayTags,
  type RelaySettingsEntry,
  type RelaySettingsState,
} from "@conduit/core"

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const originalWindow = globalThis.window
const originalConfig = structuredClone(config)

function installWindowStorage(storage: MemoryStorage): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
  })
}

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig))
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  })
})

function state(entries: RelaySettingsEntry[]): RelaySettingsState {
  return normalizeRelaySettingsState({
    version: 1,
    entries,
    updatedAt: 1,
  })
}

function entry(
  url: string,
  overrides: Partial<RelaySettingsEntry> = {}
): RelaySettingsEntry {
  const baseCapabilities: RelaySettingsEntry["capabilities"] = {
    nip11: true,
    search: false,
    dm: false,
    auth: false,
    commerce: false,
    protectedMessages: false,
    listings: false,
    cleanup: false,
  }
  const commerceCapabilities: RelaySettingsEntry["capabilities"] = {
    ...baseCapabilities,
    dm: true,
    auth: true,
    commerce: true,
    protectedMessages: true,
    listings: true,
    cleanup: true,
  }
  const baseWarnings: RelaySettingsEntry["warnings"] = {
    dmWithoutAuth: false,
    staleRelayInfo: false,
    unreachable: false,
    commercePartialSupport: false,
  }
  const capabilities =
    overrides.capabilities ??
    (overrides.section === "commerce" ? commerceCapabilities : baseCapabilities)
  const warnings = {
    ...baseWarnings,
    ...overrides.warnings,
  }

  return {
    url,
    readEnabled: true,
    writeEnabled: false,
    section: "public",
    capabilities,
    warnings,
    ...overrides,
    capabilities,
    warnings,
  }
}

describe("relay settings protocol helpers", () => {
  it("isolates every configured relay role to one loopback relay in mock mode", () => {
    const relayUrls = resolveE2eRelayIsolation("mock", "ws://127.0.0.1:7777")
    const isolated = applyE2eRelayIsolation(config, relayUrls)

    expect(relayUrls).toEqual(["ws://127.0.0.1:7777"])
    expect(isolated.relayUrl).toBe(relayUrls[0])
    expect(isolated.e2eRelayIsolationEnabled).toBe(true)
    expect(isolated.defaultRelays).toEqual(relayUrls)
    expect(isolated.appWriteRelayUrls).toEqual(relayUrls)
    expect(isolated.commerceRelayUrls).toEqual(relayUrls)
    expect(isolated.publicRelayUrls).toEqual(relayUrls)
    expect(isolated.nip89RelayHint).toBe(relayUrls[0])
    for (const bucket of getRelayBucketConfigs(isolated)) {
      expect(bucket.relayUrls).toEqual(relayUrls)
    }

    expect(() => resolveE2eRelayIsolation("production", relayUrls[0])).toThrow(
      "only allowed in Vite mock mode"
    )
    expect(() =>
      resolveE2eRelayIsolation("mock", "wss://relay.example.com")
    ).toThrow("must use a loopback host")
    expect(() =>
      resolveE2eRelayIsolation("mock", "wss://localhost:7777")
    ).toThrow("must use ws://")
  })

  it("treats E2E isolation as an allowlist instead of retaining public relays", () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))

    expect(
      normalizeSecureOrIsolatedE2eRelayUrls([
        "wss://relay.damus.io",
        isolatedRelayUrl,
        "wss://relay.primal.net",
      ])
    ).toEqual([isolatedRelayUrl])
    expect(
      normalizeSecureOrIsolatedE2eRelayUrls(["wss://relay.damus.io"])
    ).toEqual([])
    expect(
      normalizePublicOrIsolatedE2eRelayHints([
        "wss://relay.damus.io",
        isolatedRelayUrl,
      ])
    ).toEqual([isolatedRelayUrl])
    expect(
      normalizePublicOrIsolatedE2eRelayHints(["wss://relay.damus.io"])
    ).toEqual([])
    expect(
      normalizeUntrustedRelayHintsForContext({
        relayUrls: ["wss://relay.damus.io", isolatedRelayUrl],
        approvedRelayUrls: ["wss://relay.damus.io"],
        allowApprovedPrivate: true,
      })
    ).toEqual(["wss://relay.damus.io"])
  })

  it("keeps relay defaults canonical and excludes legacy default domains", () => {
    expect(CANONICAL_APP_BACKPLANE_RELAYS).toEqual([
      "wss://relay.conduit.market",
    ])
    expect(CANONICAL_APP_WRITE_RELAYS).toEqual(["wss://relay.conduit.market"])
    expect(CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS).toEqual([
      "wss://nos.lol",
      "wss://relay.ditto.pub",
      "wss://relay.primal.net",
    ])
    expect(CANONICAL_COMMERCE_DISCOVERY_RELAYS).toEqual([
      "wss://relay.plebeian.market",
      "wss://relay.ditto.pub",
    ])
    expect(CANONICAL_SEARCH_INDEX_RELAYS).toEqual(["wss://relay.ditto.pub"])
    expect(CANONICAL_DM_DECLARATION_DISCOVERY_RELAYS).toEqual([
      "wss://relay.conduit.market",
      "wss://relay.ditto.pub",
      "wss://nos.lol",
      "wss://relay.primal.net",
    ])
    expect(CANONICAL_COMMERCE_DM_FALLBACK_RELAYS).toEqual([
      "wss://relay.conduit.market",
      "wss://relay.ditto.pub",
      "wss://inbox.azzamo.net",
      "wss://nos.lol",
    ])
    expect(CANONICAL_DM_INBOX_DEFAULT_RELAYS).toEqual([
      "wss://relay.conduit.market",
      "wss://relay.ditto.pub",
    ])
    expect(CANONICAL_ZAP_PUBLIC_RELAYS).toEqual([
      "wss://nos.lol",
      "wss://relay.ditto.pub",
      "wss://relay.primal.net",
      "wss://relay.plebeian.market",
    ])
    expect(CANONICAL_DEFAULT_RELAYS).toEqual([
      "wss://relay.conduit.market",
      "wss://nos.lol",
      "wss://relay.ditto.pub",
      "wss://relay.primal.net",
    ])
    for (const relay of CANONICAL_DEFAULT_RELAYS) {
      expect(config.defaultRelays).toContain(relay)
    }
    expect(config.appBackplaneRelayUrls).toEqual(CANONICAL_APP_BACKPLANE_RELAYS)
    expect(config.appWriteRelayUrls).toEqual(CANONICAL_APP_WRITE_RELAYS)
    expect(config.corePublicFallbackRelayUrls).toEqual(
      CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS
    )
    expect(config.commerceDiscoveryRelayUrls).toEqual(
      CANONICAL_COMMERCE_DISCOVERY_RELAYS
    )
    expect(config.searchIndexRelayUrls).toEqual(CANONICAL_SEARCH_INDEX_RELAYS)
    expect(config.dmDeclarationDiscoveryRelayUrls).toEqual(
      CANONICAL_DM_DECLARATION_DISCOVERY_RELAYS
    )
    expect(config.commerceDmFallbackRelayUrls).toEqual(
      CANONICAL_COMMERCE_DM_FALLBACK_RELAYS
    )
    expect(config.dmInboxDefaultRelayUrls).toEqual(
      CANONICAL_DM_INBOX_DEFAULT_RELAYS
    )
    expect(config.zapRelayUrls).toEqual(CANONICAL_ZAP_PUBLIC_RELAYS)
    expect(config.dmCompatibilityOrderRelayUrls).toEqual(
      CANONICAL_DM_COMPATIBILITY_ORDER_RELAYS
    )
    expect(
      config.dmCompatibilityOrderRelayUrls.every((url) =>
        config.commerceDmFallbackRelayUrls.includes(url)
      )
    ).toBe(true)
    expect(config.dmCompatibilityOrderRoutingEnabled).toBe(false)
    expect(getRelayBucketConfigs().map((bucket) => bucket.id)).toEqual([
      "app_backplane",
      "core_public_fallback",
      "commerce_discovery",
      "search_index",
      "dm_declaration_discovery",
      "commerce_dm_fallback",
      "dm_inbox_default",
      "dm_compatibility_order",
      "zap_public",
    ])
    expect(config.commerceRelayUrls).toContain("wss://relay.conduit.market")
    expect(config.nip89RelayHint).toBe("wss://relay.conduit.market")
    expect(config.defaultRelays).not.toContain("wss://conduitl2.fly.dev")
    expect(config.defaultRelays).not.toContain("wss://relay.plebeian.market")
    expect(config.defaultRelays).not.toContain("wss://nostr.mom")
    const canonicalRelays = getRelayBucketConfigs().flatMap(
      (bucket) => bucket.relayUrls
    )
    expect(canonicalRelays).not.toContain("wss://relay.damus.io")
    expect(canonicalRelays).not.toContain("wss://relay.nostr.band")
    expect(canonicalRelays).not.toContain("wss://relay.nostr.net")
    expect(config.defaultRelays).not.toContain("wss://relay.minibits.cash")

    const settings = createDefaultRelaySettings({
      ...config,
      defaultRelays: ["wss://relay.conduit.market", "wss://nos.lol"],
    })

    expect(settings.entries.map((relay) => relay.url)).toEqual([
      "wss://relay.conduit.market",
      "wss://nos.lol",
    ])
    expect(settings.entries.every((relay) => relay.readEnabled)).toBe(true)
    expect(settings.entries.every((relay) => relay.writeEnabled)).toBe(true)
  })

  it("normalizes relay urls before deduplication", () => {
    expect(normalizeRelayUrl("relay.example.com/")).toBe(
      "wss://relay.example.com"
    )
    expect(normalizeRelayUrl("https://Relay.Example.com/path/")).toBe(
      "wss://relay.example.com/path"
    )
    expect(normalizeRelayUrl("http://127.0.0.1:7777")).toBe(
      "ws://127.0.0.1:7777"
    )
  })

  it("normalizes secure relay urls before stable deduplication", () => {
    const inputs = [
      " Relay.Example.com/path/?ignored=1#fragment ",
      "https://relay.example.com/path/",
      "wss://second.example/",
      "WSS://SECOND.EXAMPLE",
      "ws://insecure.example",
      "http://also-insecure.example",
      "not a relay host",
    ]
    const expected = ["wss://relay.example.com/path", "wss://second.example"]

    expect(normalizeSecureRelayUrls(inputs)).toEqual(expected)
    expect(secureRelayUrls(inputs)).toEqual(expected)
  })

  it("parses and serializes NIP-65 read/write relay tags", () => {
    const parsed = parseNip65RelayTags([
      ["r", "wss://both.example"],
      ["r", "wss://read.example", "read"],
      ["r", "wss://write.example", "write"],
    ])

    expect(parsed).toEqual([
      {
        url: "wss://both.example",
        readEnabled: true,
        writeEnabled: true,
      },
      {
        url: "wss://read.example",
        readEnabled: true,
        writeEnabled: false,
      },
      {
        url: "wss://write.example",
        readEnabled: false,
        writeEnabled: true,
      },
    ])

    expect(
      serializeNip65RelayTags([
        ...parsed,
        {
          url: "wss://disabled.example",
          readEnabled: false,
          writeEnabled: false,
        },
      ])
    ).toEqual([
      ["r", "wss://both.example"],
      ["r", "wss://read.example", "read"],
      ["r", "wss://write.example", "write"],
    ])
  })

  it("derives read-only capabilities and warnings from NIP-11", () => {
    const verified = deriveRelayScanResult(
      "wss://relay.plebeian.market",
      {
        name: "Plebeian Market",
        supported_nips: [9, 42, 50, 59],
      },
      { now: () => 10 }
    )

    expect(verified.capabilities).toEqual({
      nip11: true,
      search: true,
      dm: true,
      auth: true,
      commerce: false,
      protectedMessages: true,
      listings: false,
      cleanup: true,
    })
    expect(verified.observations.protectedMessages).toMatchObject({
      supported: true,
      status: "advertised",
      confidence: "advertised",
      evidence: ["nip11"],
    })
    expect(verified.observations.cleanup).toMatchObject({
      supported: true,
      status: "advertised",
      confidence: "advertised",
      evidence: ["nip11"],
    })
    expect(verified.warnings.dmWithoutAuth).toBe(false)
    expect(verified.warnings.commercePartialSupport).toBe(true)
    expect(verified.scannedAt).toBe(10)

    const dmWithoutAuth = deriveRelayScanResult("wss://relay.example", {
      supported_nips: [59],
    })

    expect(dmWithoutAuth.capabilities.dm).toBe(true)
    expect(dmWithoutAuth.capabilities.protectedMessages).toBe(true)
    expect(dmWithoutAuth.capabilities.auth).toBe(false)
    expect(dmWithoutAuth.warnings.dmWithoutAuth).toBe(true)
    expect(dmWithoutAuth.warnings.commercePartialSupport).toBe(true)
  })

  it("uses the Conduit commerce profile instead of client/event NIPs", () => {
    const scanned = deriveRelayScanResult(
      "wss://commerce.example",
      {
        supported_nips: [9, 42, 50, 59],
      },
      {
        commerceRelayUrls: ["wss://commerce.example"],
      }
    )

    expect(scanned.capabilities.commerce).toBe(true)
    expect(scanned.capabilities.listings).toBe(true)
    expect(scanned.commerceProfileVersion).toBe(1)
    expect(scanned.observations.listings).toMatchObject({
      supported: true,
      status: "known",
      confidence: "known",
      evidence: ["conduit-commerce-profile"],
    })
    expect(scanned.warnings.commercePartialSupport).toBe(false)

    const legacyClientEventNips = deriveRelayScanResult(
      "wss://legacy.example",
      {
        supported_nips: [17, 33, 42, 65, 99],
      }
    )

    expect(legacyClientEventNips.capabilities.commerce).toBe(false)
    expect(legacyClientEventNips.capabilities.dm).toBe(false)
    expect(legacyClientEventNips.warnings.commercePartialSupport).toBe(false)

    const profiledWithoutAuth = deriveRelayScanResult(
      "wss://commerce.example",
      {
        supported_nips: [9, 59],
      },
      {
        commerceRelayUrls: ["wss://commerce.example"],
      }
    )

    expect(profiledWithoutAuth.capabilities.commerce).toBe(false)
    expect(profiledWithoutAuth.capabilities.listings).toBe(true)
    expect(profiledWithoutAuth.warnings.dmWithoutAuth).toBe(true)
    expect(profiledWithoutAuth.warnings.commercePartialSupport).toBe(true)

    const partial = deriveRelayScanResult("wss://partial.example", {
      supported_nips: [33, 65, 99],
    })

    expect(partial.capabilities.commerce).toBe(false)
    expect(partial.warnings.commercePartialSupport).toBe(false)
  })

  it("does not mark configured relays as commerce without NIP-11 evidence", () => {
    const scanned = deriveRelayScanResult("wss://relay.conduit.market", null, {
      commerceRelayUrls: ["wss://relay.conduit.market"],
    })

    expect(scanned.reachable).toBe(false)
    expect(scanned.capabilities.commerce).toBe(false)
    expect(scanned.warnings.commercePartialSupport).toBe(false)
  })

  it("demotes stale persisted commerce placement without current details", () => {
    const settings = normalizeRelaySettingsState({
      version: 1,
      updatedAt: 1,
      entries: [
        {
          url: "wss://old-commerce.example",
          readEnabled: true,
          writeEnabled: true,
          section: "commerce",
          commercePriority: 0,
          capabilities: {
            nip11: true,
            search: true,
            dm: true,
            auth: true,
            commerce: true,
          },
          warnings: {
            dmWithoutAuth: false,
            staleRelayInfo: false,
            unreachable: false,
            commercePartialSupport: false,
          },
        },
      ],
    })

    expect(settings.entries[0]?.section).toBe("public")
    expect(settings.entries[0]?.commercePriority).toBeUndefined()
    expect(settings.entries[0]?.capabilities.commerce).toBe(false)
  })

  it("keeps unreachable relays disabled instead of silently discarding them", () => {
    const relay = createUnreachableRelaySettingsEntry("relay.example")

    expect(relay.url).toBe("wss://relay.example")
    expect(relay.readEnabled).toBe(false)
    expect(relay.writeEnabled).toBe(false)
    expect(relay.warnings.unreachable).toBe(true)
  })

  it("keeps declared and unreachable inbox relays in the typed candidate model", () => {
    const reachable = createRelaySettingsEntryFromScan(
      deriveRelayScanResult(
        "wss://advertised.example",
        { supported_nips: [59] },
        { now: () => 10 }
      )
    )
    const unreachable = createUnreachableRelaySettingsEntry(
      "wss://unreachable.example",
      "manual",
      20,
      {
        ...reachable,
        url: "wss://unreachable.example",
        readEnabled: true,
      }
    )
    const disabled = entry("wss://disabled.example", {
      readEnabled: false,
    })

    const candidates = getInboxRelayCandidates(
      state([reachable, unreachable, disabled]).entries,
      ["wss://declared-only.example", "wss://advertised.example/"]
    )

    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "wss://declared-only.example",
      "wss://advertised.example",
      "wss://unreachable.example",
      "wss://disabled.example",
    ])
    expect(candidates[0]).toEqual({
      url: "wss://declared-only.example",
      configured: false,
      enabled: false,
      declared: true,
      retained: false,
      selectable: true,
      relayInfoProbe: "unknown",
      protectedMessageCapabilityEvidence: "unknown",
      protectedMessageRuntimeEvidence: "unknown",
    })
    expect(candidates[1]).toMatchObject({
      configured: true,
      enabled: true,
      declared: true,
      selectable: true,
      relayInfoProbe: "succeeded",
      protectedMessageCapabilityEvidence: "advertised",
      protectedMessageRuntimeEvidence: "unknown",
    })
    expect(candidates[2]).toMatchObject({
      configured: true,
      enabled: true,
      declared: false,
      selectable: false,
      relayInfoProbe: "failed",
      protectedMessageCapabilityEvidence: "advertised",
      protectedMessageRuntimeEvidence: "unknown",
    })
    expect(candidates[3]).toMatchObject({
      configured: true,
      enabled: false,
      declared: false,
      selectable: false,
      relayInfoProbe: "unknown",
      protectedMessageCapabilityEvidence: "unknown",
      protectedMessageRuntimeEvidence: "unknown",
    })

    // The one-argument projection remains compatible with callers that only
    // need enabled, reachable declaration targets.
    expect(
      getInboxCandidateRelayUrls(
        state([reachable, unreachable, disabled]).entries
      )
    ).toEqual(["wss://advertised.example"])
  })

  it("keeps inbox relay capability evidence classes separate", () => {
    const advertised = createRelaySettingsEntryFromScan(
      deriveRelayScanResult("wss://advertised.example", {
        supported_nips: [59],
      })
    )
    const known = createRelaySettingsEntryFromScan(
      deriveRelayScanResult(
        "wss://known.example",
        { supported_nips: [9, 42] },
        { commerceRelayUrls: ["wss://known.example"] }
      )
    )
    const observedBase = createRelaySettingsEntryFromScan(
      deriveRelayScanResult("wss://observed.example", {
        supported_nips: [],
      })
    )
    const observed: RelaySettingsEntry = {
      ...observedBase,
      observations: {
        ...observedBase.observations,
        protectedMessages: {
          supported: true,
          status: "observed",
          confidence: "observed",
          evidence: ["active-probe"],
          checkedAt: 30,
        },
      },
    }
    const failedProbe: RelaySettingsEntry = {
      ...advertised,
      url: "wss://probe-failed.example",
      observations: {
        ...advertised.observations,
        protectedMessages: {
          supported: true,
          status: "failed",
          confidence: "advertised",
          evidence: ["nip11", "active-probe"],
          checkedAt: 40,
        },
      },
    }
    const relayInfoOnly = createRelaySettingsEntryFromScan(
      deriveRelayScanResult("wss://relay-info-only.example", {
        supported_nips: [],
      })
    )

    const byUrl = new Map(
      getInboxRelayCandidates(
        state([advertised, known, observed, failedProbe, relayInfoOnly])
          .entries,
        []
      ).map((candidate) => [candidate.url, candidate])
    )

    expect(
      byUrl.get("wss://advertised.example")?.protectedMessageCapabilityEvidence
    ).toBe("advertised")
    expect(
      byUrl.get("wss://known.example")?.protectedMessageCapabilityEvidence
    ).toBe("known")
    expect(byUrl.get("wss://observed.example")).toMatchObject({
      protectedMessageCapabilityEvidence: "unknown",
      protectedMessageRuntimeEvidence: "probe_passed",
    })
    expect(byUrl.get("wss://probe-failed.example")).toMatchObject({
      protectedMessageCapabilityEvidence: "advertised",
      protectedMessageRuntimeEvidence: "probe_failed",
    })
    expect(byUrl.get("wss://relay-info-only.example")).toMatchObject({
      relayInfoProbe: "succeeded",
      protectedMessageCapabilityEvidence: "unknown",
      protectedMessageRuntimeEvidence: "unknown",
    })
  })

  it("keeps retained recovery relays distinct from the current declaration", () => {
    expect(
      getInboxRelayCandidates(
        [],
        [],
        ["wss://previous.example", "ws://unsafe.example"]
      )
    ).toEqual([
      {
        url: "wss://previous.example",
        configured: false,
        enabled: false,
        declared: false,
        retained: true,
        selectable: true,
        relayInfoProbe: "unknown",
        protectedMessageCapabilityEvidence: "unknown",
        protectedMessageRuntimeEvidence: "unknown",
      },
    ])
  })

  it("preserves published NIP-65 controls when a capability refresh is unreachable", () => {
    const relay = createUnreachableRelaySettingsEntry(
      "relay.example",
      "published",
      10,
      entry("wss://relay.example", {
        readEnabled: true,
        writeEnabled: true,
        source: "published",
      })
    )

    expect(relay.readEnabled).toBe(true)
    expect(relay.writeEnabled).toBe(true)
    expect(relay.section).toBe("public")
    expect(relay.capabilities.commerce).toBe(false)
    expect(relay.warnings.unreachable).toBe(true)
  })

  it("preserves commerce priority across transient scan failures", () => {
    const unreachable = createUnreachableRelaySettingsEntry(
      "commerce.example",
      "manual",
      10,
      entry("wss://commerce.example", {
        section: "commerce",
        commercePriority: 2,
        readEnabled: true,
        writeEnabled: true,
        source: "manual",
      })
    )
    const normalized = state([unreachable])
    const restoredScan = deriveRelayScanResult(
      "wss://commerce.example",
      {
        supported_nips: [9, 42, 50, 59],
      },
      {
        commerceRelayUrls: ["wss://commerce.example"],
      }
    )
    const restored = createRelaySettingsEntryFromScan(
      restoredScan,
      normalized.entries[0]
    )

    expect(normalized.entries[0]?.section).toBe("public")
    expect(normalized.entries[0]?.commercePriority).toBe(2)
    expect(normalized.entries[0]?.capabilities.commerce).toBe(false)
    expect(normalized.entries[0]?.warnings.unreachable).toBe(true)
    expect(restored.section).toBe("commerce")
    expect(restored.commercePriority).toBe(2)
  })

  it("orders commerce relays by saved commerce priority before public fallback", () => {
    const settings = state([
      entry("wss://public.example"),
      entry("wss://commerce-b.example", {
        section: "commerce",
        commercePriority: 1,
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: true,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
      entry("wss://commerce-a.example", {
        section: "commerce",
        commercePriority: 0,
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: true,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
    ])

    expect(
      getCommerceReadRelayUrls({ settings, fallbackRelayUrls: [] })
    ).toEqual([
      "wss://commerce-a.example",
      "wss://commerce-b.example",
      "wss://public.example",
    ])
    expect(
      getCommerceWriteRelayUrls({ settings, fallbackRelayUrls: [] })
    ).toEqual(["wss://commerce-a.example", "wss://commerce-b.example"])
  })

  it("keeps user-enabled write relays in the plan while carrying trust warnings", () => {
    const settings = state([
      entry("wss://stale-write.example", {
        writeEnabled: true,
        warnings: {
          dmWithoutAuth: false,
          staleRelayInfo: true,
          unreachable: false,
          commercePartialSupport: false,
        },
        capabilities: {
          nip11: false,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://verified-write.example", {
        writeEnabled: true,
      }),
    ])

    expect(
      getGeneralWriteRelayUrls({ settings, fallbackRelayUrls: [] })
    ).toEqual(["wss://stale-write.example", "wss://verified-write.example"])
    expect(
      getGeneralWriteRelayUrls({
        settings: state([
          entry("wss://stale-only.example", {
            writeEnabled: true,
            warnings: {
              dmWithoutAuth: false,
              staleRelayInfo: true,
              unreachable: false,
              commercePartialSupport: false,
            },
          }),
        ]),
        fallbackRelayUrls: ["wss://fallback.example"],
      })
    ).toEqual(["wss://stale-only.example"])
  })

  it("treats invalid NIP-11 responses as unreachable", async () => {
    const existing = entry("wss://relay.example", {
      writeEnabled: true,
      capabilities: {
        nip11: true,
        search: true,
        dm: true,
        auth: true,
        commerce: false,
      },
    })
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(["not", "nip11"]))

    const scanned = await scanRelaySettingsEntry(
      "wss://relay.example",
      { fetchImpl, now: () => 20 },
      existing
    )

    expect(scanned.readEnabled).toBe(true)
    expect(scanned.writeEnabled).toBe(true)
    expect(scanned.warnings.unreachable).toBe(true)
    expect(scanned.warnings.staleRelayInfo).toBe(true)
    expect(
      getGeneralWriteRelayUrls({
        settings: state([scanned]),
        fallbackRelayUrls: [],
      })
    ).toEqual(["wss://relay.example"])
  })

  it("does not drop user-enabled write relays with incomplete NIP-11 data", async () => {
    const existing = entry("wss://relay.example", {
      writeEnabled: true,
    })
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ name: "Relay" }))

    const scanned = await scanRelaySettingsEntry(
      "wss://relay.example",
      { fetchImpl },
      existing
    )

    expect(scanned.capabilities.nip11).toBe(true)
    expect(scanned.warnings.staleRelayInfo).toBe(true)
    expect(
      getGeneralWriteRelayUrls({
        settings: state([scanned]),
        fallbackRelayUrls: [],
      })
    ).toEqual(["wss://relay.example"])
  })

  it("preserves local read and write toggles when importing signer relays", () => {
    const settings = state([
      entry("wss://relay.example", {
        readEnabled: false,
        writeEnabled: true,
        source: "manual",
      }),
    ])

    const next = mergeRelayPreferencesIntoSettings(settings, [
      {
        url: "wss://relay.example",
        readEnabled: true,
        writeEnabled: false,
      },
      {
        url: "wss://new.example",
        readEnabled: true,
        writeEnabled: false,
      },
    ])
    const existing = next.entries.find(
      (item) => item.url === "wss://relay.example"
    )
    const added = next.entries.find((item) => item.url === "wss://new.example")

    expect(existing?.readEnabled).toBe(false)
    expect(existing?.writeEnabled).toBe(true)
    expect(existing?.source).toBe("manual")
    expect(added?.readEnabled).toBe(true)
    expect(added?.writeEnabled).toBe(false)
    expect(added?.source).toBe("signer")
  })

  it("lets a published NIP-65 list replace default relay controls", () => {
    const settings = state([
      entry("wss://relay.example", {
        readEnabled: true,
        writeEnabled: false,
        source: "default",
      }),
    ])

    const next = mergeRelayPreferencesIntoSettings(
      settings,
      [
        {
          url: "wss://relay.example",
          readEnabled: false,
          writeEnabled: true,
        },
      ],
      "published"
    )

    expect(next.entries[0]?.readEnabled).toBe(false)
    expect(next.entries[0]?.writeEnabled).toBe(true)
    expect(next.entries[0]?.source).toBe("published")
  })

  it("keeps Conduit defaults out of saved personal relay settings", () => {
    const settings = saveRelaySettings(
      createRelaySettingsFromPreferences(
        [
          {
            url: "wss://published.example",
            readEnabled: true,
            writeEnabled: true,
          },
        ],
        "published"
      ),
      "test:relays"
    )

    expect(settings.entries.map((relay) => relay.url)).toEqual([
      "wss://published.example",
    ])
    for (const relay of config.defaultRelays) {
      expect(settings.entries.map((entry) => entry.url)).not.toContain(relay)
    }

    expect(
      getPublishableRelaySettingsEntries(settings.entries).map(
        (relay) => relay.url
      )
    ).toEqual(["wss://published.example"])
  })

  it("filters legacy default relays when loading personal relay settings", () => {
    const storage = new MemoryStorage()
    installWindowStorage(storage)
    storage.setItem(
      "conduit:relay-settings:v1:test:legacy",
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        entries: [
          entry("wss://relay.damus.io", {
            readEnabled: true,
            writeEnabled: true,
            source: "default",
          }),
          entry("wss://user.example", {
            readEnabled: true,
            writeEnabled: false,
            source: "manual",
          }),
        ],
      })
    )

    const loaded = loadRelaySettings("test:legacy")

    expect(loaded.entries.map((relay) => relay.url)).toEqual([
      "wss://user.example",
    ])
  })

  it("preserves a user-managed relay even when it matches a default URL", () => {
    const settings = saveRelaySettings(
      state([
        entry("wss://relay.damus.io", {
          readEnabled: true,
          writeEnabled: true,
          source: "manual",
        }),
      ]),
      "test:user-managed-default"
    )

    expect(settings.entries).toHaveLength(1)
    expect(settings.entries[0]).toMatchObject({
      url: "wss://relay.damus.io",
      readEnabled: true,
      writeEnabled: true,
      source: "manual",
    })
    expect(
      getPublishableRelaySettingsEntries(settings.entries).map(
        (relay) => relay.url
      )
    ).toEqual(["wss://relay.damus.io"])
  })

  it("keeps planner fallback relays available when user settings are empty", () => {
    expect(
      getCommerceReadRelayUrls({
        settings: state([]),
        fallbackRelayUrls: ["wss://fallback.example"],
      })
    ).toEqual(["wss://fallback.example"])
  })

  it("blocks unsafe tiny NIP-65 publishes", () => {
    expect(() =>
      assertSafeNip65RelayList(
        createRelaySettingsFromPreferences([
          {
            url: "wss://only.example",
            readEnabled: true,
            writeEnabled: true,
          },
        ]).entries
      )
    ).toThrow("Refusing to publish a tiny NIP-65 relay list")

    expect(() =>
      assertSafeNip65RelayList(
        createRelaySettingsFromPreferences([
          {
            url: "wss://one.example",
            readEnabled: true,
            writeEnabled: true,
          },
          {
            url: "wss://two.example",
            readEnabled: true,
            writeEnabled: false,
          },
        ]).entries
      )
    ).not.toThrow()
  })

  it("blocks NIP-65 publishes without an OUT relay", () => {
    expect(() =>
      assertSafeNip65RelayList(
        createRelaySettingsFromPreferences([
          {
            url: "wss://one.example",
            readEnabled: true,
            writeEnabled: false,
          },
          {
            url: "wss://two.example",
            readEnabled: true,
            writeEnabled: false,
          },
        ]).entries
      )
    ).toThrow("without an OUT relay")
  })

  it("applies safe defaults when creating an entry from a scan", () => {
    const publicScan = deriveRelayScanResult("wss://relay.example", {
      supported_nips: [50],
    })
    const publicEntry = createRelaySettingsEntryFromScan(publicScan)

    expect(publicEntry.section).toBe("public")
    expect(publicEntry.readEnabled).toBe(true)
    expect(publicEntry.writeEnabled).toBe(false)

    const commerceScan = deriveRelayScanResult(
      "wss://commerce.example",
      {
        supported_nips: [9, 42, 50, 59],
      },
      {
        commerceRelayUrls: ["wss://commerce.example"],
      }
    )
    const commerceEntry = createRelaySettingsEntryFromScan(commerceScan)

    expect(commerceEntry.section).toBe("commerce")
    expect(commerceEntry.readEnabled).toBe(true)
    expect(commerceEntry.writeEnabled).toBe(true)
  })
})
