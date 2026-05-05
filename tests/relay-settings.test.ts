import { describe, expect, it } from "bun:test"
import {
  assertSafeNip65RelayList,
  createRelaySettingsEntryFromScan,
  createRelaySettingsFromPreferences,
  createUnreachableRelaySettingsEntry,
  deriveRelayScanResult,
  getCommerceReadRelayUrls,
  getGeneralWriteRelayUrls,
  mergeRelayPreferencesIntoSettings,
  normalizeRelaySettingsState,
  normalizeRelayUrl,
  parseNip65RelayTags,
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
  return {
    url,
    readEnabled: true,
    writeEnabled: false,
    section: "public",
    capabilities: {
      nip11: true,
      search: false,
      dm: false,
      auth: false,
      commerce: false,
    },
    warnings: {
      dmWithoutAuth: false,
      staleRelayInfo: false,
      unreachable: false,
      commercePartialSupport: false,
    },
    ...overrides,
  }
}

describe("relay settings protocol helpers", () => {
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
        supported_nips: [17, 42, 50],
      },
      { now: () => 10 }
    )

    expect(verified.capabilities).toEqual({
      nip11: true,
      search: true,
      dm: true,
      auth: true,
      commerce: false,
    })
    expect(verified.warnings.dmWithoutAuth).toBe(false)
    expect(verified.warnings.commercePartialSupport).toBe(true)
    expect(verified.scannedAt).toBe(10)

    const dmWithoutAuth = deriveRelayScanResult("wss://relay.example", {
      supported_nips: [17],
    })

    expect(dmWithoutAuth.capabilities.dm).toBe(true)
    expect(dmWithoutAuth.capabilities.auth).toBe(false)
    expect(dmWithoutAuth.warnings.dmWithoutAuth).toBe(true)
    expect(dmWithoutAuth.warnings.commercePartialSupport).toBe(true)
  })

  it("requires the full commerce NIP profile before marking a relay commerce", () => {
    const scanned = deriveRelayScanResult("wss://relay.example", {
      supported_nips: [17, 33, 42, 65, 99],
    })

    expect(scanned.capabilities.commerce).toBe(true)
    expect(scanned.warnings.commercePartialSupport).toBe(false)

    const partial = deriveRelayScanResult("wss://partial.example", {
      supported_nips: [33, 65, 99],
    })

    expect(partial.capabilities.commerce).toBe(false)
    expect(partial.warnings.commercePartialSupport).toBe(true)
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
    expect(relay.warnings.unreachable).toBe(true)
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

  it("applies safe defaults when creating an entry from a scan", () => {
    const publicScan = deriveRelayScanResult("wss://relay.example", {
      supported_nips: [50],
    })
    const publicEntry = createRelaySettingsEntryFromScan(publicScan)

    expect(publicEntry.section).toBe("public")
    expect(publicEntry.readEnabled).toBe(true)
    expect(publicEntry.writeEnabled).toBe(false)

    const commerceScan = deriveRelayScanResult("wss://commerce.example", {
      supported_nips: [17, 33, 42, 65, 99],
    })
    const commerceEntry = createRelaySettingsEntryFromScan(commerceScan)

    expect(commerceEntry.section).toBe("commerce")
    expect(commerceEntry.readEnabled).toBe(true)
    expect(commerceEntry.writeEnabled).toBe(true)
  })
})
