import { describe, expect, it } from "bun:test"
import {
  assertSafeNip65RelayList,
  CANONICAL_APP_WRITE_RELAYS,
  CANONICAL_DEFAULT_RELAYS,
  config,
  createDefaultRelaySettings,
  createRelaySettingsEntryFromScan,
  createRelaySettingsFromPreferences,
  createUnreachableRelaySettingsEntry,
  deriveRelayScanResult,
  getCommerceReadRelayUrls,
  getGeneralWriteRelayUrls,
  getPublishableRelaySettingsEntries,
  includeDefaultRelaySettingsEntries,
  mergeRelayPreferencesIntoSettings,
  normalizeRelaySettingsState,
  normalizeRelayUrl,
  parseNip65RelayTags,
  saveRelaySettings,
  scanRelaySettingsEntry,
  serializeNip65RelayTags,
  type RelaySettingsEntry,
  type RelaySettingsState,
} from "@conduit/core"

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
  it("keeps relay defaults canonical and excludes retired relay domains", () => {
    expect(CANONICAL_DEFAULT_RELAYS).toEqual([
      "wss://conduitl2.fly.dev",
      "wss://relay.plebeian.market",
      "wss://relay.primal.net",
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://nostr.mom",
      "wss://relay.nostr.net",
      "wss://relay.minibits.cash",
    ])
    for (const relay of CANONICAL_DEFAULT_RELAYS) {
      expect(config.defaultRelays).toContain(relay)
    }
    expect(CANONICAL_APP_WRITE_RELAYS).toEqual(["wss://conduitl2.fly.dev"])
    expect(config.appWriteRelayUrls).toEqual(CANONICAL_APP_WRITE_RELAYS)
    expect(config.commerceRelayUrls).toContain("wss://conduitl2.fly.dev")
    expect(config.nip89RelayHint).toBe("wss://conduitl2.fly.dev")
    expect(config.defaultRelays).not.toContain("wss://relay.conduit.market")

    const settings = createDefaultRelaySettings({
      ...config,
      defaultRelays: ["wss://relay.conduit.market", "wss://relay.primal.net"],
    })

    expect(settings.entries.map((relay) => relay.url)).toEqual([
      "wss://relay.primal.net",
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
    const scanned = deriveRelayScanResult("wss://conduitl2.fly.dev", null, {
      commerceRelayUrls: ["wss://conduitl2.fly.dev"],
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

  it("orders commerce reads before public fallback without manual priority", () => {
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
      "wss://commerce-b.example",
      "wss://commerce-a.example",
      "wss://public.example",
    ])
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

  it("upgrades persisted default relays to IN and OUT controls", () => {
    const settings = normalizeRelaySettingsState({
      version: 1,
      updatedAt: 1,
      entries: [
        entry("wss://relay.example", {
          readEnabled: true,
          writeEnabled: false,
          source: "default",
        }),
      ],
    })

    expect(settings.entries[0]?.readEnabled).toBe(true)
    expect(settings.entries[0]?.writeEnabled).toBe(true)
  })

  it("keeps Conduit defaults visible but out of NIP-65 publishes until included", () => {
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

    expect(settings.entries.map((relay) => relay.url)).toContain(
      "wss://published.example"
    )
    for (const relay of config.defaultRelays) {
      expect(settings.entries.map((entry) => entry.url)).toContain(relay)
    }

    expect(
      getPublishableRelaySettingsEntries(settings.entries).map(
        (relay) => relay.url
      )
    ).toEqual(["wss://published.example"])

    const included = includeDefaultRelaySettingsEntries(settings)
    expect(
      getPublishableRelaySettingsEntries(included.entries).map(
        (relay) => relay.url
      )
    ).toEqual(["wss://published.example", ...config.defaultRelays])
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
