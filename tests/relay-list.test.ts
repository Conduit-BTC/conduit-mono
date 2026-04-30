import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  getRelayList,
  getRelayLists,
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

  it("dedupes pubkeys and ignores empty entries", async () => {
    await getRelayLists(["alice", "alice", "  ", ""])
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]?.authors).toEqual(["alice"])
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
})
