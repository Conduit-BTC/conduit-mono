import { beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  kinds,
} from "nostr-tools"
import {
  __resetMediaServerPreferencesForTests,
  addMediaServerPreference,
  BLOSSOM_SERVER_LIST_KIND,
  moveMediaServerPreference,
  normalizeBlossomServerRoot,
  normalizeMediaServerPreferenceOwner,
  parseBlossomServerListTags,
  readMediaServerPreferences,
  removeMediaServerPreference,
  selectLatestValidBlossomServerListEvent,
  serializeBlossomServerListTags,
  type MediaServerPreferencesStorage,
} from "../packages/core/src/protocol/media-server-preferences"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"

const OWNER_KEY = generateSecretKey()
const OTHER_KEY = generateSecretKey()
const OWNER = getPublicKey(OWNER_KEY)
const OTHER_OWNER = getPublicKey(OTHER_KEY)

class MemoryStorage implements MediaServerPreferencesStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function event(
  tags: string[][],
  options: {
    createdAt?: number
    secretKey?: Uint8Array
    kind?: number
  } = {}
): SignedPublicNostrEvent {
  const secretKey = options.secretKey ?? OWNER_KEY
  return finalizeEvent(
    {
      kind: options.kind ?? BLOSSOM_SERVER_LIST_KIND,
      created_at: options.createdAt ?? 100,
      tags,
      content: "",
    },
    secretKey
  )
}

function relayRead(
  events: SignedPublicNostrEvent[],
  relays: Array<{
    relayUrl: string
    status: "success" | "partial" | "failed"
    rejectedEventCount?: number
  }>,
  sources: Record<string, string[]> = {}
) {
  return {
    events,
    eventSourceRelayUrls: sources,
    relays: relays.map((relay) => ({
      ...relay,
      eventCount: events.length,
    })),
    eventsVerified: true,
  }
}

beforeEach(() => {
  __resetMediaServerPreferencesForTests()
})

describe("BUD-03 media server preference parsing", () => {
  it("uses the installed nostr-tools kind constant", () => {
    expect(BLOSSOM_SERVER_LIST_KIND).toBe(kinds.BlossomServerList)
    expect(BLOSSOM_SERVER_LIST_KIND).toBe(10063)
  })

  it("canonicalizes only public HTTPS origins", () => {
    const credentialUrl = new URL("https://media.conduit.market")
    credentialUrl.username = ["us", "er"].join("")
    credentialUrl.password = ["sec", "ret"].join("")
    expect(normalizeBlossomServerRoot("https://CONDUIT.MARKET:443/")).toBe(
      "https://conduit.market"
    )
    expect(
      normalizeBlossomServerRoot("https://media.conduit.market:8443")
    ).toBe("https://media.conduit.market:8443")

    for (const unsafe of [
      "http://media.conduit.market",
      credentialUrl.toString(),
      "https://media.conduit.market/path",
      "https://media.conduit.market/?token=secret",
      "https://media.conduit.market/#fragment",
      "https://localhost",
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://169.254.1.1",
      "https://media.local",
      "not a URL",
    ]) {
      expect(normalizeBlossomServerRoot(unsafe)).toBeNull()
    }
    expect(() => normalizeMediaServerPreferenceOwner("not-a-pubkey")).toThrow(
      "valid connected account"
    )
  })

  it("preserves signed order and serializes the displayed list exactly", () => {
    const tags = [
      ["client", "another-app"],
      ["server", "https://two.conduit.market"],
      ["server", "https://one.conduit.market/"],
    ]
    expect(parseBlossomServerListTags(tags)).toEqual({
      state: "valid",
      serverUrls: ["https://two.conduit.market", "https://one.conduit.market"],
      serverTagCount: 2,
      malformedTagCount: 0,
      duplicateTagCount: 0,
    })
    expect(
      serializeBlossomServerListTags([
        "https://two.conduit.market",
        "https://one.conduit.market",
      ])
    ).toEqual([
      ["server", "https://two.conduit.market"],
      ["server", "https://one.conduit.market"],
    ])
    expect(
      serializeBlossomServerListTags(
        Array.from(
          { length: 13 },
          (_, index) => `https://server-${index}.conduit.market`
        )
      )
    ).toHaveLength(13)
  })

  it("rejects unsafe tags and deduplicates valid tags in signed order", () => {
    expect(parseBlossomServerListTags([]).state).toBe("empty")
    expect(
      parseBlossomServerListTags([
        ["server", "https://safe.conduit.market"],
        ["server", "http://unsafe.conduit.market"],
      ])
    ).toMatchObject({
      state: "malformed",
      serverUrls: ["https://safe.conduit.market"],
      malformedTagCount: 1,
    })
    expect(
      parseBlossomServerListTags([
        ["server", "https://same.conduit.market", "client-extension"],
        ["server", "https://same.conduit.market/"],
      ])
    ).toMatchObject({
      state: "valid",
      serverUrls: ["https://same.conduit.market"],
      duplicateTagCount: 1,
    })
    expect(() =>
      serializeBlossomServerListTags([
        "https://same.conduit.market",
        "https://same.conduit.market/",
      ])
    ).toThrow("already in the ordered list")
  })

  it("supports add, remove, and order-sensitive movement without publishing", () => {
    const added = addMediaServerPreference(
      ["https://one.conduit.market"],
      "https://two.conduit.market/"
    )
    expect(added).toEqual([
      "https://one.conduit.market",
      "https://two.conduit.market",
    ])
    expect(moveMediaServerPreference(added, 1, 0)).toEqual([
      "https://two.conduit.market",
      "https://one.conduit.market",
    ])
    expect(
      removeMediaServerPreference(added, "https://one.conduit.market")
    ).toEqual(["https://two.conduit.market"])
    expect(() =>
      addMediaServerPreference(added, "https://two.conduit.market")
    ).toThrow("already in the ordered list")
  })
})

describe("kind 10063 replacement selection and evidence", () => {
  it("selects the latest valid owner event with the NIP-01 lowest-id tie break", () => {
    const older = event([["server", "https://older.conduit.market"]], {
      createdAt: 10,
    })
    const tiedA = event([["server", "https://a.conduit.market"]], {
      createdAt: 11,
    })
    const tiedB = event([["server", "https://b.conduit.market"]], {
      createdAt: 11,
    })
    const malformedNewer = event([["server", "http://unsafe.conduit.market"]], {
      createdAt: 12,
    })
    const otherOwner = event([["server", "https://other.conduit.market"]], {
      createdAt: 99,
      secretKey: OTHER_KEY,
    })
    const wrongKind = event([["server", "https://wrong-kind.conduit.market"]], {
      createdAt: 100,
      kind: 10002,
    })
    const expectedTie = [tiedA, tiedB].sort((left, right) =>
      left.id.localeCompare(right.id)
    )[0]!

    const selected = selectLatestValidBlossomServerListEvent(
      [older, tiedA, tiedB, malformedNewer, otherOwner, wrongKind],
      OWNER
    )
    expect(selected?.event.id).toBe(expectedTie.id)
    expect(selected?.parsed.serverUrls).toEqual(
      parseBlossomServerListTags(expectedTie.tags).serverUrls
    )
    expect(selected?.event.pubkey).not.toBe(OTHER_OWNER)
  })

  it("projects complete source and freshness evidence", async () => {
    const storage = new MemoryStorage()
    const signed = event([
      ["server", "https://first.conduit.market"],
      ["server", "https://second.conduit.market"],
    ])
    const now = 1_700_000_000_000
    const result = await readMediaServerPreferences(OWNER, {
      storage,
      now: () => now,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents: async () =>
        relayRead(
          [signed],
          [
            { relayUrl: "wss://one.conduit.market", status: "success" },
            { relayUrl: "wss://two.conduit.market", status: "success" },
          ],
          {
            [signed.id]: [
              "wss://one.conduit.market",
              "wss://two.conduit.market",
            ],
          }
        ),
    })

    expect(result).toMatchObject({
      status: "published",
      coverage: "complete",
      publishedServerUrls: [
        "https://first.conduit.market",
        "https://second.conduit.market",
      ],
      stale: false,
      retained: false,
      completeObservedAt: now,
    })
    expect(result.publishedRevision).toEqual({
      eventId: signed.id,
      createdAt: signed.created_at,
    })
    expect(result.sourceRelayUrls).toEqual([
      "wss://one.conduit.market",
      "wss://two.conduit.market",
    ])
  })

  it("retains stronger published evidence when a later lookup is partial", async () => {
    const storage = new MemoryStorage()
    const signed = event([["server", "https://retained.conduit.market"]])
    let complete = true
    const fetchEvents = async () =>
      complete
        ? relayRead(
            [signed],
            [
              { relayUrl: "wss://one.conduit.market", status: "success" },
              { relayUrl: "wss://two.conduit.market", status: "success" },
            ],
            { [signed.id]: ["wss://one.conduit.market"] }
          )
        : relayRead(
            [],
            [
              { relayUrl: "wss://one.conduit.market", status: "success" },
              { relayUrl: "wss://two.conduit.market", status: "failed" },
            ]
          )
    await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents,
    })
    complete = false
    const degraded = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents,
    })

    expect(degraded).toMatchObject({
      status: "lookup_partial",
      coverage: "partial",
      publishedServerUrls: ["https://retained.conduit.market"],
      stale: true,
      retained: true,
    })
  })

  it("preserves the last valid list while exposing a newer malformed frontier", async () => {
    const storage = new MemoryStorage()
    const valid = event([["server", "https://valid.conduit.market"]], {
      createdAt: 100,
    })
    const malformed = event([["server", "http://unsafe.conduit.market"]], {
      createdAt: 101,
    })
    const result = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market"],
      fetchEvents: async () =>
        relayRead(
          [valid, malformed],
          [{ relayUrl: "wss://one.conduit.market", status: "success" }],
          {
            [valid.id]: ["wss://one.conduit.market"],
            [malformed.id]: ["wss://one.conduit.market"],
          }
        ),
    })

    expect(result).toMatchObject({
      status: "malformed",
      coverage: "complete",
      publishedServerUrls: ["https://valid.conduit.market"],
      stale: true,
      frontier: {
        eventId: malformed.id,
        createdAt: malformed.created_at,
        state: "malformed",
      },
    })
  })

  it("does not collapse rejected signatures or unavailable reads into absence", async () => {
    const storage = new MemoryStorage()
    const rejected = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market"],
      fetchEvents: async () =>
        relayRead(
          [],
          [
            {
              relayUrl: "wss://one.conduit.market",
              status: "success",
              rejectedEventCount: 1,
            },
          ]
        ),
    })
    expect(rejected.status).toBe("lookup_partial")
    expect(rejected.lookup.rejectedEventCount).toBe(1)

    const unavailable = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market"],
      fetchEvents: async () => {
        throw new Error("offline")
      },
    })
    expect(unavailable.status).toBe("lookup_unavailable")
    expect(unavailable.coverage).toBe("unavailable")
  })
})
