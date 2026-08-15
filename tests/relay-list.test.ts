import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  getRelayList,
  getRelayLists,
  getRelayListsDetailed,
  ingestRelayListEvent,
  parseRelayListEvent,
  pickLatestRelayListEvent,
  RELAY_LIST_CACHE_TTL_MS,
  type RelayList,
} from "@conduit/core"
import type { CachedRelayList } from "@conduit/core"
import type { NDKEvent } from "@nostr-dev-kit/ndk"

interface FakeEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

function makeRelayListEvent(
  overrides: Partial<FakeEvent> & { pubkey: string; tags?: string[][] }
): FakeEvent {
  return {
    id: overrides.id ?? `evt-${Math.random()}`,
    kind: 10002,
    created_at: overrides.created_at ?? 1_700_000_000,
    content: overrides.content ?? "",
    tags: overrides.tags ?? [
      ["r", "wss://relay.example.com"],
      ["r", "wss://read.example.com", "read"],
      ["r", "wss://write.example.com", "write"],
    ],
    pubkey: overrides.pubkey,
  }
}

describe("parseRelayListEvent", () => {
  it("splits read/write/both markers per NIP-65", () => {
    const list = parseRelayListEvent(makeRelayListEvent({ pubkey: "alice" }), {
      cachedAt: 1,
    })
    expect(list.pubkey).toBe("alice")
    expect(list.eventId).toBeDefined()
    expect(list.readRelayUrls).toContain("wss://relay.example.com")
    expect(list.readRelayUrls).toContain("wss://read.example.com")
    expect(list.readRelayUrls).not.toContain("wss://write.example.com")
    expect(list.writeRelayUrls).toContain("wss://relay.example.com")
    expect(list.writeRelayUrls).toContain("wss://write.example.com")
    expect(list.writeRelayUrls).not.toContain("wss://read.example.com")
  })

  it("ignores malformed r tags and unknown markers", () => {
    const list = parseRelayListEvent(
      makeRelayListEvent({
        pubkey: "alice",
        tags: [
          ["r"],
          ["r", "not a url"],
          ["r", "wss://ok.example.com", "weird-marker"],
          ["p", "wss://wrong-tag.example.com"],
        ],
      }),
      { cachedAt: 1 }
    )
    expect(list.readRelayUrls).toEqual(["wss://ok.example.com"])
    expect(list.writeRelayUrls).toEqual(["wss://ok.example.com"])
  })

  it("normalizes urls and dedupes", () => {
    const list = parseRelayListEvent(
      makeRelayListEvent({
        pubkey: "alice",
        tags: [
          ["r", "wss://Relay.Example.com/"],
          ["r", "wss://relay.example.com"],
          ["r", "wss://relay.example.com", "write"],
        ],
      })
    )
    expect(list.readRelayUrls).toEqual(["wss://relay.example.com"])
    expect(list.writeRelayUrls).toEqual(["wss://relay.example.com"])
  })

  it("preserves insecure relay urls while parsing NIP-65 tags", () => {
    const list = parseRelayListEvent(
      makeRelayListEvent({
        pubkey: "alice",
        tags: [
          ["r", "ws://Artshop:4848/"],
          ["r", "wss://relay.example.com"],
        ],
      })
    )
    expect(list.readRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://relay.example.com",
    ])
    expect(list.writeRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://relay.example.com",
    ])
  })

  it("captures source relay urls when provided", () => {
    const list = parseRelayListEvent(makeRelayListEvent({ pubkey: "alice" }), {
      sourceRelayUrls: ["wss://Origin.example.com"],
    })
    expect(list.sourceRelayUrls).toEqual(["wss://origin.example.com"])
  })
})

describe("pickLatestRelayListEvent", () => {
  it("returns the highest created_at for the requested pubkey", () => {
    const a = makeRelayListEvent({
      pubkey: "alice",
      id: "old",
      created_at: 1,
    })
    const b = makeRelayListEvent({
      pubkey: "alice",
      id: "new",
      created_at: 2,
    })
    const c = makeRelayListEvent({
      pubkey: "bob",
      id: "bob-new",
      created_at: 99,
    })
    const latest = pickLatestRelayListEvent([a, b, c], "alice")
    expect(latest?.id).toBe("new")
  })

  it("returns the lowest event id when created_at values are equal", () => {
    const higherId = makeRelayListEvent({
      pubkey: "alice",
      id: "ff",
      created_at: 2,
    })
    const lowerId = makeRelayListEvent({
      pubkey: "alice",
      id: "00",
      created_at: 2,
    })

    expect(pickLatestRelayListEvent([higherId, lowerId], "alice")?.id).toBe(
      "00"
    )
    expect(pickLatestRelayListEvent([lowerId, higherId], "alice")?.id).toBe(
      "00"
    )
  })

  it("returns undefined when no events match the pubkey", () => {
    expect(pickLatestRelayListEvent([], "alice")).toBeUndefined()
  })
})

describe("getRelayList / getRelayLists cache behavior", () => {
  let cache: Map<string, CachedRelayList>
  let fetchCalls: Array<{ authors: string[] }>
  const FIXED_NOW = 1_700_000_000_000

  beforeEach(() => {
    cache = new Map()
    fetchCalls = []
    __setRelayListTestOverrides({
      now: () => FIXED_NOW,
      loadCached: async (pubkey) => cache.get(pubkey),
      putCached: async (entry) => {
        cache.set(entry.pubkey, entry)
      },
      fetchEventsFanout: async (filter) => {
        fetchCalls.push({ authors: (filter.authors as string[]) ?? [] })
        const authors = (filter.authors as string[]) ?? []
        return authors.map((pubkey) =>
          makeRelayListEvent({
            pubkey,
            created_at: 100 + pubkey.length,
            tags: [["r", `wss://relay-${pubkey}.example.com`]],
          })
        ) as unknown as NDKEvent[]
      },
    })
  })

  afterEach(() => {
    __resetRelayListTestOverrides()
  })

  it("returns cached entries when fresh and skips network", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://cached.example.com"],
      writeRelayUrls: ["wss://cached.example.com"],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - 1_000,
    })
    const list = await getRelayList("alice")
    expect(list?.readRelayUrls).toEqual(["wss://cached.example.com"])
    expect(fetchCalls.length).toBe(0)
  })

  it("refreshes when cached entry is older than TTL", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://stale.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    const list = await getRelayList("alice")
    expect(fetchCalls.length).toBe(1)
    expect(list?.readRelayUrls).toEqual(["wss://relay-alice.example.com"])
  })

  it("does not regress a newer cached replaceable event on a narrower refresh", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://newer-cached.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () =>
        [
          makeRelayListEvent({
            pubkey: "alice",
            id: "11",
            created_at: 100,
            tags: [["r", "wss://older-network.example.com"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList("alice")

    expect(list?.readRelayUrls).toEqual(["wss://newer-cached.example.com"])
    expect(cache.get("alice")?.eventCreatedAt).toBe(200)
  })

  it("converges equal-timestamp observations on the lower event id across reads", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://higher-id.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "ff",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () =>
        [
          makeRelayListEvent({
            pubkey: "alice",
            id: "00",
            created_at: 200,
            tags: [["r", "wss://lower-id.example.com"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList("alice")

    expect(list?.readRelayUrls).toEqual(["wss://lower-id.example.com"])
    expect(cache.get("alice")?.eventId).toBe("00")
  })

  it("retains the lower cached id when an equal-timestamp higher id arrives", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://lower-id.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () =>
        [
          makeRelayListEvent({
            pubkey: "alice",
            id: "ff",
            created_at: 200,
            tags: [["r", "wss://higher-id.example.com"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList("alice")

    expect(list?.readRelayUrls).toEqual(["wss://lower-id.example.com"])
    expect(cache.get("alice")?.eventId).toBe("00")
  })

  it("forces a single refresh without letting skipCache regress the retained winner", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://retained.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () =>
        [
          makeRelayListEvent({
            pubkey: "alice",
            id: "ff",
            created_at: 100,
            tags: [["r", "wss://regressed.example.com"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList("alice", { skipCache: true })

    expect(list?.readRelayUrls).toEqual(["wss://retained.example.com"])
    expect(cache.get("alice")?.eventCreatedAt).toBe(200)
  })

  it("retains stale evidence when a forced single refresh finds no event", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://retained.example.com"],
      writeRelayUrls: ["wss://retained.example.com"],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () => [],
    })

    const list = await getRelayList("alice", { skipCache: true })

    expect(list?.lookupState).toBe("stale-cache")
    expect(list?.writeRelayUrls).toEqual(["wss://retained.example.com"])
  })

  it("retains stale evidence when a forced single refresh fails", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://retained.example.com"],
      writeRelayUrls: ["wss://retained.example.com"],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () => {
        throw new Error("lookup unavailable")
      },
    })

    const list = await getRelayList("alice", { skipCache: true })

    expect(list?.lookupState).toBe("stale-cache")
    expect(list?.writeRelayUrls).toEqual(["wss://retained.example.com"])
  })

  it("atomically retains a newer single-refresh winner across concurrent tabs", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://initial.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 100,
      eventId: "initial",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    let fetchCall = 0
    let resolveNewerCommit!: () => void
    const newerCommitted = new Promise<void>((resolve) => {
      resolveNewerCommit = resolve
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () => {
        fetchCall += 1
        if (fetchCall === 1) {
          return [
            makeRelayListEvent({
              pubkey: "alice",
              id: "newer",
              created_at: 200,
              tags: [["r", "wss://newer.example.com"]],
            }),
          ] as unknown as NDKEvent[]
        }
        await newerCommitted
        return [
          makeRelayListEvent({
            pubkey: "alice",
            id: "older",
            created_at: 150,
            tags: [["r", "wss://older.example.com"]],
          }),
        ] as unknown as NDKEvent[]
      },
      putCached: async (entry) => {
        cache.set(entry.pubkey, entry)
        if (entry.eventCreatedAt === 200) resolveNewerCommit()
      },
    })

    const [newerResult, olderResult] = await Promise.all([
      getRelayList("alice", { skipCache: true }),
      getRelayList("alice", { skipCache: true }),
    ])

    expect(newerResult?.lookupState).toBe("network")
    expect(olderResult?.lookupState).toBe("stale-cache")
    expect(olderResult?.readRelayUrls).toEqual(["wss://newer.example.com"])
    expect(cache.get("alice")?.eventCreatedAt).toBe(200)
  })

  it("forces batched refreshes without regressing retained winners", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://retained.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () =>
        [
          makeRelayListEvent({
            pubkey: "alice",
            id: "ff",
            created_at: 100,
            tags: [["r", "wss://regressed.example.com"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const lists = await getRelayLists(["alice"], { skipCache: true })

    expect(lists.get("alice")?.readRelayUrls).toEqual([
      "wss://retained.example.com",
    ])
    expect(cache.get("alice")?.eventCreatedAt).toBe(200)
  })

  it("returns the durable lower-id winner from concurrent detailed refreshes", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://initial.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 100,
      eventId: "initial",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    const relayUrls = ["wss://discovery.example.com"]
    let fetchCall = 0
    let resolveLowerIdCommit!: () => void
    const lowerIdCommitted = new Promise<void>((resolve) => {
      resolveLowerIdCommit = resolve
    })
    __setRelayListTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => {
        fetchCall += 1
        if (fetchCall !== 1) await lowerIdCommitted
        const event = makeRelayListEvent({
          pubkey: "alice",
          id: fetchCall === 1 ? "00" : "ff",
          created_at: 200,
          tags: [
            [
              "r",
              fetchCall === 1
                ? "wss://lower-id.example.com"
                : "wss://higher-id.example.com",
            ],
          ],
        })
        return {
          events: [event] as unknown as NDKEvent[],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
          eventsVerified: true,
        }
      },
      putCached: async (entry) => {
        cache.set(entry.pubkey, entry)
        if (entry.eventId === "00") resolveLowerIdCommit()
      },
    })

    const [lowerIdResult, higherIdResult] = await Promise.all([
      getRelayListsDetailed(["alice"], { relayUrls, skipCache: true }),
      getRelayListsDetailed(["alice"], { relayUrls, skipCache: true }),
    ])

    expect(lowerIdResult.resolutionStates.get("alice")).toBe("network")
    expect(higherIdResult.resolutionStates.get("alice")).toBe("stale-cache")
    expect(higherIdResult.relayLists.get("alice")?.readRelayUrls).toEqual([
      "wss://lower-id.example.com",
    ])
    expect(cache.get("alice")?.eventId).toBe("00")
  })

  it("returns existing cached entry when network fetch fails", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://stale.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchEventsFanout: async () => {
        throw new Error("boom")
      },
    })
    const list = await getRelayList("alice")
    expect(list?.readRelayUrls).toEqual(["wss://stale.example.com"])
  })

  it("getRelayLists batches missing pubkeys into a single fetch", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://cached.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - 1_000,
    })
    const result = await getRelayLists(["alice", "bob", "carol"])
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]?.authors.sort()).toEqual(["bob", "carol"])
    expect(result.get("alice")?.readRelayUrls).toEqual([
      "wss://cached.example.com",
    ])
    expect(result.get("bob")?.readRelayUrls).toEqual([
      "wss://relay-bob.example.com",
    ])
    expect(result.get("carol")?.readRelayUrls).toEqual([
      "wss://relay-carol.example.com",
    ])
  })

  it("does not treat an uncached cache-only lookup as authoritative absence", async () => {
    const result = await getRelayListsDetailed(["alice"], {
      cacheOnly: true,
    })

    expect(result.relayLists.has("alice")).toBe(false)
    expect(result.resolutionStates.get("alice")).toBe("lookup-unavailable")
    expect(fetchCalls).toHaveLength(0)
  })

  it("distinguishes completed absence from unavailable relay-list discovery", async () => {
    const relayUrls = ["wss://one.example/", "wss://two.example/"]
    __setRelayListTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "failed" as const,
          eventCount: 0,
        })),
        eventsVerified: true,
      }),
    })

    const unavailable = await getRelayListsDetailed(["alice"], {
      relayUrls,
      skipCache: true,
    })
    expect(unavailable.resolutionStates.get("alice")).toBe("lookup-unavailable")

    __setRelayListTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        })),
        eventsVerified: true,
      }),
    })
    const absent = await getRelayListsDetailed(["alice"], {
      relayUrls,
      skipCache: true,
    })
    expect(absent.resolutionStates.get("alice")).toBe("missing")
  })

  it("does not call discovery complete when an intended relay was omitted", async () => {
    const relayUrls = ["wss://healthy.example/", "wss://parked.example/"]
    __setRelayListTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => {
        expect(options.skipHealthFilter).toBe(true)
        expect(options.relayUrls).toEqual(relayUrls)
        return {
          events: [],
          relays: [
            {
              relayUrl: relayUrls[0]!,
              status: "success" as const,
              eventCount: 0,
            },
          ],
          eventsVerified: true,
        }
      },
    })

    const result = await getRelayListsDetailed(["alice"], {
      relayUrls,
      skipCache: true,
    })

    expect(result.resolutionStates.get("alice")).toBe("partial-network")
  })

  it("retains prior relay evidence when a forced lookup returns no event", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://previous.example/"],
      writeRelayUrls: ["wss://previous.example/"],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        })),
        eventsVerified: true,
      }),
    })

    const result = await getRelayListsDetailed(["alice"], {
      relayUrls: ["wss://discovery.example/"],
      skipCache: true,
    })

    expect(result.resolutionStates.get("alice")).toBe("stale-cache")
    expect(result.relayLists.get("alice")?.writeRelayUrls).toEqual([
      "wss://previous.example",
    ])
  })

  it("dedupes pubkeys and ignores empty entries", async () => {
    await getRelayLists(["alice", "alice", "  ", ""])
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]?.authors).toEqual(["alice"])
  })

  it("filters insecure relays from third-party lookup results without mutating the raw cache", async () => {
    __setRelayListTestOverrides({
      fetchEventsFanout: async (filter) => {
        fetchCalls.push({ authors: (filter.authors as string[]) ?? [] })
        return [
          makeRelayListEvent({
            pubkey: "alice",
            tags: [
              ["r", "ws://artshop:4848"],
              ["r", "wss://127.0.0.1:4848"],
              ["r", "wss://192.168.1.10:4848"],
              ["r", "wss://relay-alice.example.com"],
            ],
          }),
        ] as unknown as NDKEvent[]
      },
    })

    const list = await getRelayList("alice")
    expect(list?.readRelayUrls).toEqual(["wss://relay-alice.example.com"])
    expect(cache.get("alice")?.readRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://127.0.0.1:4848",
      "wss://192.168.1.10:4848",
      "wss://relay-alice.example.com",
    ])
  })

  it("preserves insecure relays when the lookup matches the authenticated pubkey", async () => {
    __setRelayListTestOverrides({
      fetchEventsFanout: async (filter) => {
        fetchCalls.push({ authors: (filter.authors as string[]) ?? [] })
        return [
          makeRelayListEvent({
            pubkey: "alice",
            tags: [
              ["r", "ws://artshop:4848"],
              ["r", "wss://127.0.0.1:4848"],
              ["r", "wss://relay-alice.example.com"],
            ],
          }),
        ] as unknown as NDKEvent[]
      },
    })

    const list = await getRelayList("alice", {
      allowInsecureRelayUrlsForPubkey: "alice",
    })
    expect(list?.readRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://127.0.0.1:4848",
      "wss://relay-alice.example.com",
    ])
  })

  it("filters insecure relays only for non-authenticated pubkeys in batched lookups", async () => {
    __setRelayListTestOverrides({
      fetchEventsFanout: async (filter) => {
        const authors = (filter.authors as string[]) ?? []
        fetchCalls.push({ authors })
        return authors.map((pubkey) =>
          makeRelayListEvent({
            pubkey,
            tags: [
              ["r", `ws://local-${pubkey}:4848`],
              ["r", `wss://relay-${pubkey}.example.com`],
            ],
          })
        ) as unknown as NDKEvent[]
      },
    })

    const result = await getRelayLists(["alice", "bob"], {
      allowInsecureRelayUrlsForPubkey: "alice",
    })
    expect(result.get("alice")?.readRelayUrls).toEqual([
      "ws://local-alice:4848",
      "wss://relay-alice.example.com",
    ])
    expect(result.get("bob")?.readRelayUrls).toEqual([
      "wss://relay-bob.example.com",
    ])
  })

  it("ingestRelayListEvent warms the cache without a network call", async () => {
    const list: RelayList = await ingestRelayListEvent(
      makeRelayListEvent({
        pubkey: "alice",
        tags: [["r", "wss://ingested.example.com"]],
      }),
      ["wss://source.example.com"]
    )
    expect(list.readRelayUrls).toEqual(["wss://ingested.example.com"])
    expect(cache.get("alice")?.readRelayUrls).toEqual([
      "wss://ingested.example.com",
    ])
    expect(fetchCalls.length).toBe(0)
  })

  it("does not let a concurrent older ingest overwrite a newer winner", async () => {
    cache.set("alice", {
      pubkey: "alice",
      readRelayUrls: ["wss://initial.example.com"],
      writeRelayUrls: [],
      eventCreatedAt: 100,
      eventId: "initial",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    const olderEvent = makeRelayListEvent({
      pubkey: "alice",
      id: "older",
      created_at: 150,
      tags: [["r", "wss://older.example.com"]],
    })
    let olderIngest: Promise<RelayList> | undefined
    let injected = false
    __setRelayListTestOverrides({
      putCached: async (entry) => {
        if (!injected && entry.eventCreatedAt === 200) {
          injected = true
          olderIngest = ingestRelayListEvent(olderEvent)
        }
        cache.set(entry.pubkey, entry)
      },
    })

    const newerResult = await ingestRelayListEvent(
      makeRelayListEvent({
        pubkey: "alice",
        id: "newer",
        created_at: 200,
        tags: [["r", "wss://newer.example.com"]],
      })
    )
    expect(olderIngest).toBeDefined()
    const olderResult = await olderIngest!

    expect(newerResult.lookupState).toBe("network")
    expect(olderResult.lookupState).toBe("stale-cache")
    expect(olderResult.readRelayUrls).toEqual(["wss://newer.example.com"])
    expect(cache.get("alice")?.eventCreatedAt).toBe(200)
  })
})
