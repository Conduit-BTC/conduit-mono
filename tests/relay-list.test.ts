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
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { admitPublicEvent } from "@conduit/core/protocol/verified-public-event"
import { config } from "@conduit/core/config"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayTarget,
} from "@conduit/core/protocol/relay-authority"

const ALICE_SECRET = generateSecretKey()
const BOB_SECRET = generateSecretKey()
const CAROL_SECRET = generateSecretKey()
const ALICE = getPublicKey(ALICE_SECRET)
const BOB = getPublicKey(BOB_SECRET)
const CAROL = getPublicKey(CAROL_SECRET)

interface FakeEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function makeRelayListEvent(
  overrides: Partial<FakeEvent> & { pubkey: string; tags?: string[][] }
): FakeEvent {
  const secret =
    overrides.pubkey === ALICE
      ? ALICE_SECRET
      : overrides.pubkey === BOB
        ? BOB_SECRET
        : overrides.pubkey === CAROL
          ? CAROL_SECRET
          : null
  if (!secret) throw new Error("Relay-list fixture requires a signing key")
  return finalizeEvent(
    {
      kind: 10002,
      created_at: overrides.created_at ?? 1_700_000_000,
      content: overrides.content ?? "",
      tags: overrides.tags ?? [
        ["r", "wss://relay.example.com"],
        ["r", "wss://read.example.com", "read"],
        ["r", "wss://write.example.com", "write"],
      ],
    },
    secret
  )
}

async function admittedRelayListEvent(event: FakeEvent) {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error("Invalid relay-list fixture")
  return result.event
}

describe("parseRelayListEvent", () => {
  it("splits read/write/both markers per NIP-65", async () => {
    const list = parseRelayListEvent(
      await admittedRelayListEvent(makeRelayListEvent({ pubkey: ALICE })),
      {
        cachedAt: 1,
      }
    )
    expect(list.pubkey).toBe(ALICE)
    expect(list.eventId).toBeDefined()
    expect(list.readRelayUrls).toContain("wss://relay.example.com")
    expect(list.readRelayUrls).toContain("wss://read.example.com")
    expect(list.readRelayUrls).not.toContain("wss://write.example.com")
    expect(list.writeRelayUrls).toContain("wss://relay.example.com")
    expect(list.writeRelayUrls).toContain("wss://write.example.com")
    expect(list.writeRelayUrls).not.toContain("wss://read.example.com")
  })

  it("ignores malformed r tags and unknown markers", async () => {
    const list = parseRelayListEvent(
      await admittedRelayListEvent(
        makeRelayListEvent({
          pubkey: ALICE,
          tags: [
            ["r"],
            ["r", "not a url"],
            ["r", "wss://ok.example.com", "weird-marker"],
            ["p", "wss://wrong-tag.example.com"],
          ],
        })
      ),
      { cachedAt: 1 }
    )
    expect(list.readRelayUrls).toEqual(["wss://ok.example.com"])
    expect(list.writeRelayUrls).toEqual(["wss://ok.example.com"])
  })

  it("normalizes urls and dedupes", async () => {
    const list = parseRelayListEvent(
      await admittedRelayListEvent(
        makeRelayListEvent({
          pubkey: ALICE,
          tags: [
            ["r", "wss://Relay.Example.com/"],
            ["r", "wss://relay.example.com"],
            ["r", "wss://relay.example.com", "write"],
          ],
        })
      )
    )
    expect(list.readRelayUrls).toEqual(["wss://relay.example.com"])
    expect(list.writeRelayUrls).toEqual(["wss://relay.example.com"])
  })

  it("preserves insecure relay urls while parsing NIP-65 tags", async () => {
    const list = parseRelayListEvent(
      await admittedRelayListEvent(
        makeRelayListEvent({
          pubkey: ALICE,
          tags: [
            ["r", "ws://Artshop:4848/"],
            ["r", "wss://relay.example.com"],
          ],
        })
      )
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

  it("captures source relay urls when provided", async () => {
    const list = parseRelayListEvent(
      await admittedRelayListEvent(makeRelayListEvent({ pubkey: ALICE })),
      {
        sourceRelayUrls: ["wss://Origin.example.com"],
      }
    )
    expect(list.sourceRelayUrls).toEqual(["wss://origin.example.com"])
  })
})

describe("pickLatestRelayListEvent", () => {
  it("returns the highest created_at for the requested pubkey", () => {
    const a = makeRelayListEvent({
      pubkey: ALICE,
      id: "old",
      created_at: 1,
    })
    const b = makeRelayListEvent({
      pubkey: ALICE,
      id: "new",
      created_at: 2,
    })
    const c = makeRelayListEvent({
      pubkey: BOB,
      id: "bob-new",
      created_at: 99,
    })
    const latest = pickLatestRelayListEvent([a, b, c], ALICE)
    expect(latest?.id).toBe(b.id)
  })

  it("returns the lowest event id when created_at values are equal", () => {
    const first = makeRelayListEvent({
      pubkey: ALICE,
      created_at: 2,
      tags: [["r", "wss://first.example"]],
    })
    const second = makeRelayListEvent({
      pubkey: ALICE,
      created_at: 2,
      tags: [["r", "wss://second.example"]],
    })
    const [lowerId, higherId] = [first, second].sort((left, right) =>
      left.id.localeCompare(right.id)
    )

    expect(pickLatestRelayListEvent([higherId, lowerId], ALICE)?.id).toBe(
      lowerId.id
    )
    expect(pickLatestRelayListEvent([lowerId, higherId], ALICE)?.id).toBe(
      lowerId.id
    )
  })

  it("returns undefined when no events match the pubkey", () => {
    expect(pickLatestRelayListEvent([], ALICE)).toBeUndefined()
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
      fetchPublicEvents: async (filter) => {
        fetchCalls.push({ authors: (filter.authors as string[]) ?? [] })
        const authors = (filter.authors as string[]) ?? []
        return authors.map((pubkey) =>
          makeRelayListEvent({
            pubkey,
            created_at: 100 + pubkey.length,
            tags: [
              [
                "r",
                `wss://relay-${pubkey === ALICE ? "alice" : pubkey === BOB ? "bob" : "carol"}.conduit.market`,
              ],
            ],
          })
        ) as unknown as NDKEvent[]
      },
    })
  })

  afterEach(() => {
    __resetRelayListTestOverrides()
  })

  it("returns cached entries when fresh and skips network", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://cached.conduit.market"],
      writeRelayUrls: ["wss://cached.conduit.market"],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - 1_000,
    })
    const list = await getRelayList(ALICE)
    expect(list?.readRelayUrls).toEqual(["wss://cached.conduit.market"])
    expect(fetchCalls.length).toBe(0)
  })

  it("refreshes when cached entry is older than TTL", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://stale.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    const list = await getRelayList(ALICE)
    expect(fetchCalls.length).toBe(1)
    expect(list?.readRelayUrls).toEqual(["wss://relay-alice.conduit.market"])
  })

  it("carries explicit relay grants to relay-list discovery I/O", async () => {
    const relayUrls = [config.appReadRelayUrls[0]!, "wss://public-hint.example"]
    const relayTargets = mergeRelayTargets(
      relayTargetsFromUrls([relayUrls[0]!], {
        kind: "app",
        operation: "read",
        bucket: "general_read",
      }),
      relayTargetsFromUrls([relayUrls[1]!], {
        kind: "public_hint",
        operation: "read",
      })
    )
    let capturedOptions:
      | {
          relayTargets?: readonly RelayTarget[]
        }
      | undefined
    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => {
        capturedOptions = options
        return {
          events: [],
          relays: relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
        }
      },
    })

    await getRelayListsDetailed([ALICE], {
      relayUrls,
      relayTargets,
      skipCache: true,
    })

    expect(capturedOptions?.relayTargets).toEqual(relayTargets)
  })

  it("does not regress a newer cached replaceable event on a narrower refresh", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://newer-cached.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () =>
        [
          makeRelayListEvent({
            pubkey: ALICE,
            id: "11",
            created_at: 100,
            tags: [["r", "wss://older-network.conduit.market"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList(ALICE)

    expect(list?.readRelayUrls).toEqual(["wss://newer-cached.conduit.market"])
    expect(cache.get(ALICE)?.eventCreatedAt).toBe(200)
  })

  it("converges equal-timestamp observations on the lower event id across reads", async () => {
    const networkEvent = makeRelayListEvent({
      pubkey: ALICE,
      created_at: 200,
      tags: [["r", "wss://lower-id.conduit.market"]],
    })
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://higher-id.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "ff",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () => [networkEvent] as unknown as NDKEvent[],
    })

    const list = await getRelayList(ALICE)

    expect(list?.readRelayUrls).toEqual(["wss://lower-id.conduit.market"])
    expect(cache.get(ALICE)?.eventId).toBe(networkEvent.id)
  })

  it("retains the lower cached id when an equal-timestamp higher id arrives", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://lower-id.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () =>
        [
          makeRelayListEvent({
            pubkey: ALICE,
            id: "ff",
            created_at: 200,
            tags: [["r", "wss://higher-id.conduit.market"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList(ALICE)

    expect(list?.readRelayUrls).toEqual(["wss://lower-id.conduit.market"])
    expect(cache.get(ALICE)?.eventId).toBe("00")
  })

  it("forces a single refresh without letting skipCache regress the retained winner", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://retained.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () =>
        [
          makeRelayListEvent({
            pubkey: ALICE,
            id: "ff",
            created_at: 100,
            tags: [["r", "wss://regressed.conduit.market"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList(ALICE, { skipCache: true })

    expect(list?.readRelayUrls).toEqual(["wss://retained.conduit.market"])
    expect(cache.get(ALICE)?.eventCreatedAt).toBe(200)
  })

  it("retains stale evidence when a forced single refresh finds no event", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://retained.conduit.market"],
      writeRelayUrls: ["wss://retained.conduit.market"],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () => [],
    })

    const list = await getRelayList(ALICE, { skipCache: true })

    expect(list?.lookupState).toBe("stale-cache")
    expect(list?.writeRelayUrls).toEqual(["wss://retained.conduit.market"])
  })

  it("retains stale evidence when a forced single refresh fails", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://retained.conduit.market"],
      writeRelayUrls: ["wss://retained.conduit.market"],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () => {
        throw new Error("lookup unavailable")
      },
    })

    const list = await getRelayList(ALICE, { skipCache: true })

    expect(list?.lookupState).toBe("stale-cache")
    expect(list?.writeRelayUrls).toEqual(["wss://retained.conduit.market"])
  })

  it("atomically retains a newer single-refresh winner across concurrent tabs", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://initial.conduit.market"],
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
      fetchPublicEvents: async () => {
        fetchCall += 1
        if (fetchCall === 1) {
          return [
            makeRelayListEvent({
              pubkey: ALICE,
              id: "newer",
              created_at: 200,
              tags: [["r", "wss://newer.conduit.market"]],
            }),
          ] as unknown as NDKEvent[]
        }
        await newerCommitted
        return [
          makeRelayListEvent({
            pubkey: ALICE,
            id: "older",
            created_at: 150,
            tags: [["r", "wss://older.conduit.market"]],
          }),
        ] as unknown as NDKEvent[]
      },
      putCached: async (entry) => {
        cache.set(entry.pubkey, entry)
        if (entry.eventCreatedAt === 200) resolveNewerCommit()
      },
    })

    const [newerResult, olderResult] = await Promise.all([
      getRelayList(ALICE, { skipCache: true }),
      getRelayList(ALICE, { skipCache: true }),
    ])

    expect(newerResult?.lookupState).toBe("network")
    expect(olderResult?.lookupState).toBe("stale-cache")
    expect(olderResult?.readRelayUrls).toEqual(["wss://newer.conduit.market"])
    expect(cache.get(ALICE)?.eventCreatedAt).toBe(200)
  })

  it("forces batched refreshes without regressing retained winners", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://retained.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () =>
        [
          makeRelayListEvent({
            pubkey: ALICE,
            id: "ff",
            created_at: 100,
            tags: [["r", "wss://regressed.conduit.market"]],
          }),
        ] as unknown as NDKEvent[],
    })

    const lists = await getRelayLists([ALICE], { skipCache: true })

    expect(lists.get(ALICE)?.readRelayUrls).toEqual([
      "wss://retained.conduit.market",
    ])
    expect(cache.get(ALICE)?.eventCreatedAt).toBe(200)
  })

  it("returns the durable lower-id winner from concurrent detailed refreshes", async () => {
    const candidates = [
      makeRelayListEvent({
        pubkey: ALICE,
        created_at: 200,
        tags: [["r", "wss://candidate-a.conduit.market"]],
      }),
      makeRelayListEvent({
        pubkey: ALICE,
        created_at: 200,
        tags: [["r", "wss://candidate-b.conduit.market"]],
      }),
    ].sort((a, b) => a.id.localeCompare(b.id))
    const [lowerEvent, higherEvent] = candidates as [FakeEvent, FakeEvent]
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://initial.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 100,
      eventId: "initial",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    const relayUrls = ["wss://discovery.conduit.market"]
    let fetchCall = 0
    let resolveLowerIdCommit!: () => void
    const lowerIdCommitted = new Promise<void>((resolve) => {
      resolveLowerIdCommit = resolve
    })
    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => {
        fetchCall += 1
        if (fetchCall !== 1) await lowerIdCommitted
        const event = fetchCall === 1 ? lowerEvent : higherEvent
        return {
          events: [event] as unknown as NDKEvent[],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
        }
      },
      putCached: async (entry) => {
        cache.set(entry.pubkey, entry)
        if (entry.eventId === lowerEvent.id) resolveLowerIdCommit()
      },
    })

    const [lowerIdResult, higherIdResult] = await Promise.all([
      getRelayListsDetailed([ALICE], { relayUrls, skipCache: true }),
      getRelayListsDetailed([ALICE], { relayUrls, skipCache: true }),
    ])

    expect(lowerIdResult.resolutionStates.get(ALICE)).toBe("network")
    expect(higherIdResult.resolutionStates.get(ALICE)).toBe("stale-cache")
    expect(higherIdResult.relayLists.get(ALICE)?.readRelayUrls).toEqual([
      lowerEvent.tags[0]![1],
    ])
    expect(cache.get(ALICE)?.eventId).toBe(lowerEvent.id)
  })

  it("returns existing cached entry when network fetch fails", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://stale.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    __setRelayListTestOverrides({
      fetchPublicEvents: async () => {
        throw new Error("boom")
      },
    })
    const list = await getRelayList(ALICE)
    expect(list?.readRelayUrls).toEqual(["wss://stale.conduit.market"])
  })

  it("getRelayLists batches missing pubkeys into a single fetch", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://cached.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 1,
      cachedAt: FIXED_NOW - 1_000,
    })
    const result = await getRelayLists([ALICE, BOB, CAROL])
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]?.authors.sort()).toEqual([BOB, CAROL].sort())
    expect(result.get(ALICE)?.readRelayUrls).toEqual([
      "wss://cached.conduit.market",
    ])
    expect(result.get(BOB)?.readRelayUrls).toEqual([
      "wss://relay-bob.conduit.market",
    ])
    expect(result.get(CAROL)?.readRelayUrls).toEqual([
      "wss://relay-carol.conduit.market",
    ])
  })

  it("does not treat an uncached cache-only lookup as authoritative absence", async () => {
    const result = await getRelayListsDetailed([ALICE], {
      cacheOnly: true,
    })

    expect(result.relayLists.has(ALICE)).toBe(false)
    expect(result.resolutionStates.get(ALICE)).toBe("lookup-unavailable")
    expect(fetchCalls).toHaveLength(0)
  })

  it("distinguishes completed absence from unavailable relay-list discovery", async () => {
    const relayUrls = ["wss://one.example/", "wss://two.example/"]
    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "failed" as const,
          eventCount: 0,
        })),
      }),
    })

    const unavailable = await getRelayListsDetailed([ALICE], {
      relayUrls,
      skipCache: true,
    })
    expect(unavailable.resolutionStates.get(ALICE)).toBe("lookup-unavailable")

    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        })),
      }),
    })
    const absent = await getRelayListsDetailed([ALICE], {
      relayUrls,
      skipCache: true,
    })
    expect(absent.resolutionStates.get(ALICE)).toBe("missing")
  })

  it("does not call discovery complete when an intended relay was omitted", async () => {
    const relayUrls = [
      "wss://healthy.conduit.market/",
      "wss://parked.conduit.market/",
    ]
    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => {
        expect(options.skipHealthFilter).toBe(true)
        expect(options.relayUrls).toEqual(relayUrls)
        return {
          events: [],
          admittedRelayUrls: relayUrls,
          relays: [
            {
              relayUrl: relayUrls[0]!,
              status: "success" as const,
              eventCount: 0,
            },
          ],
        }
      },
    })

    const result = await getRelayListsDetailed([ALICE], {
      relayUrls,
      skipCache: true,
    })

    expect(result.resolutionStates.get(ALICE)).toBe("partial-network")
  })

  it("uses the admitted bounded plan for completed relay-list absence", async () => {
    const suppressedPersonalRelay = "wss://personal-disabled.example/"
    const admittedAppRelay = "wss://app-admitted.example/"
    const cappedAppRelay = "wss://app-beyond-cap.example/"
    const relayUrls = [
      suppressedPersonalRelay,
      admittedAppRelay,
      cappedAppRelay,
    ]
    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => {
        expect(options.relayUrls).toEqual(relayUrls)
        expect(options.maxRelayAttempts).toBe(1)
        return {
          events: [],
          admittedRelayUrls: [admittedAppRelay],
          relays: [
            {
              relayUrl: admittedAppRelay,
              status: "success" as const,
              eventCount: 0,
            },
          ],
        }
      },
    })

    const result = await getRelayListsDetailed([ALICE], {
      relayUrls,
      maxRelayAttempts: 1,
      skipCache: true,
    })

    expect(result.resolutionStates.get(ALICE)).toBe("missing")
  })

  it("retains prior relay evidence when a forced lookup returns no event", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://previous.conduit.market/"],
      writeRelayUrls: ["wss://previous.conduit.market/"],
      eventCreatedAt: 200,
      eventId: "00",
      cachedAt: FIXED_NOW - 1_000,
    })
    __setRelayListTestOverrides({
      fetchSignedEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        })),
      }),
    })

    const result = await getRelayListsDetailed([ALICE], {
      relayUrls: ["wss://discovery.example/"],
      skipCache: true,
    })

    expect(result.resolutionStates.get(ALICE)).toBe("stale-cache")
    expect(result.relayLists.get(ALICE)?.writeRelayUrls).toEqual([
      "wss://previous.conduit.market",
    ])
  })

  it("dedupes pubkeys and ignores empty entries", async () => {
    await getRelayLists([ALICE, ALICE, "  ", ""])
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]?.authors).toEqual([ALICE])
  })

  it("filters insecure relays from third-party lookup results without mutating the raw cache", async () => {
    __setRelayListTestOverrides({
      fetchPublicEvents: async (filter) => {
        fetchCalls.push({ authors: (filter.authors as string[]) ?? [] })
        return [
          makeRelayListEvent({
            pubkey: ALICE,
            tags: [
              ["r", "ws://artshop:4848"],
              ["r", "wss://127.0.0.1:4848"],
              ["r", "wss://192.168.1.10:4848"],
              ["r", "wss://relay-alice.conduit.market"],
              ["r", "https://relay-two.conduit.market/path?ignored=true"],
              ["r", "wss://relay-two.conduit.market/path"],
              ["r", "wss://service.test"],
            ],
          }),
        ] as unknown as NDKEvent[]
      },
    })

    const list = await getRelayList(ALICE)
    expect(list?.readRelayUrls).toEqual([
      "wss://relay-alice.conduit.market",
      "wss://relay-two.conduit.market/path",
    ])
    expect(cache.get(ALICE)?.readRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://127.0.0.1:4848",
      "wss://192.168.1.10:4848",
      "wss://relay-alice.conduit.market",
      "wss://relay-two.conduit.market/path",
      "wss://service.test",
    ])
  })

  it("preserves insecure relays when the lookup matches the authenticated pubkey", async () => {
    __setRelayListTestOverrides({
      fetchPublicEvents: async (filter) => {
        fetchCalls.push({ authors: (filter.authors as string[]) ?? [] })
        return [
          makeRelayListEvent({
            pubkey: ALICE,
            tags: [
              ["r", "ws://artshop:4848"],
              ["r", "wss://127.0.0.1:4848"],
              ["r", "wss://relay-alice.conduit.market"],
            ],
          }),
        ] as unknown as NDKEvent[]
      },
    })

    const list = await getRelayList(ALICE, {
      allowInsecureRelayUrlsForPubkey: ALICE,
      authenticatedPubkey: ALICE,
    })
    expect(list?.readRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://127.0.0.1:4848",
      "wss://relay-alice.conduit.market",
    ])
  })

  it("does not treat an insecure-result allowlist as authentication", async () => {
    __setRelayListTestOverrides({
      fetchPublicEvents: async () =>
        [
          makeRelayListEvent({
            pubkey: ALICE,
            tags: [
              ["r", "ws://artshop:4848"],
              ["r", "wss://relay-alice.conduit.market"],
            ],
          }),
        ] as unknown as NDKEvent[],
    })

    const list = await getRelayList(ALICE, {
      allowInsecureRelayUrlsForPubkey: ALICE,
    })
    expect(list?.readRelayUrls).toEqual(["wss://relay-alice.conduit.market"])
  })

  it("filters insecure relays only for non-authenticated pubkeys in batched lookups", async () => {
    __setRelayListTestOverrides({
      fetchPublicEvents: async (filter) => {
        const authors = (filter.authors as string[]) ?? []
        fetchCalls.push({ authors })
        return authors.map((pubkey) =>
          makeRelayListEvent({
            pubkey,
            tags: [
              ["r", `ws://local-${pubkey}:4848`],
              ["r", `wss://relay-${pubkey.slice(0, 8)}.conduit.market`],
            ],
          })
        ) as unknown as NDKEvent[]
      },
    })

    const result = await getRelayLists([ALICE, BOB], {
      allowInsecureRelayUrlsForPubkey: ALICE,
      authenticatedPubkey: ALICE,
    })
    expect(result.get(ALICE)?.readRelayUrls).toEqual([
      `ws://local-${ALICE}:4848`,
      `wss://relay-${ALICE.slice(0, 8)}.conduit.market`,
    ])
    expect(result.get(BOB)?.readRelayUrls).toEqual([
      `wss://relay-${BOB.slice(0, 8)}.conduit.market`,
    ])
  })

  it("ingestRelayListEvent warms the cache without a network call", async () => {
    const list: RelayList = await ingestRelayListEvent(
      makeRelayListEvent({
        pubkey: ALICE,
        tags: [["r", "wss://ingested.example.com"]],
      }),
      ["wss://source.example.com"]
    )
    expect(list.readRelayUrls).toEqual([])
    expect(cache.get(ALICE)?.readRelayUrls).toEqual([
      "wss://ingested.example.com",
    ])
    expect(cache.get(ALICE)?.sourceRelayUrls).toEqual([
      "wss://source.example.com",
    ])
    expect(fetchCalls.length).toBe(0)
  })

  it("does not let a concurrent older ingest overwrite a newer winner", async () => {
    cache.set(ALICE, {
      pubkey: ALICE,
      readRelayUrls: ["wss://initial.conduit.market"],
      writeRelayUrls: [],
      eventCreatedAt: 100,
      eventId: "initial",
      cachedAt: FIXED_NOW - RELAY_LIST_CACHE_TTL_MS - 1,
    })
    const olderEvent = makeRelayListEvent({
      pubkey: ALICE,
      id: "older",
      created_at: 150,
      tags: [["r", "wss://older.conduit.market"]],
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
        pubkey: ALICE,
        id: "newer",
        created_at: 200,
        tags: [["r", "wss://newer.conduit.market"]],
      })
    )
    expect(olderIngest).toBeDefined()
    const olderResult = await olderIngest!

    expect(newerResult.lookupState).toBe("network")
    expect(olderResult.lookupState).toBe("stale-cache")
    expect(olderResult.readRelayUrls).toEqual(["wss://newer.conduit.market"])
    expect(cache.get(ALICE)?.eventCreatedAt).toBe(200)
  })
})
