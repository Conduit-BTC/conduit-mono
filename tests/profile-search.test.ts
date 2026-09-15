import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  normalizeProfileSearchText,
  rankProfileSearchMatches,
  resolveProfileSearchEvidence,
  mergeProfileSearchResults,
  scoreProfileSearchMatch,
  searchCachedProfiles,
  searchNetworkProfiles,
  planProfileSearchRelayUrls,
  searchProfiles,
  applyProfileSearchSellerFlags,
  summarizeProfileSearchRelays,
  PROFILE_SEARCH_MAX_RELAYS,
  type ProfileSearchDependencies,
  type ProfileSearchMatch,
  type ProfileSearchResult,
} from "../packages/core/src/protocol/profile-search"

const ALICE = "a".repeat(64)
const ALICIA = "b".repeat(64)
const CAROL = "c".repeat(64)
const MALICE = "d".repeat(64)
const ERIN = "e".repeat(64)
const FRANK = "f".repeat(64)
const GRACE = "9".repeat(64)

function profileEvent(
  pubkey: string,
  content: Record<string, string>,
  createdAt = 100
): NDKEvent {
  return {
    kind: 0,
    pubkey,
    id: `${pubkey.slice(0, 8)}-${createdAt}`,
    created_at: createdAt,
    content: JSON.stringify(content),
    tags: [],
  } as unknown as NDKEvent
}

function match(
  overrides: Partial<ProfileSearchMatch> & Pick<ProfileSearchMatch, "pubkey">
): ProfileSearchMatch {
  return {
    profile: { pubkey: overrides.pubkey },
    isSeller: false,
    source: "network",
    score: 1,
    frontier: {},
    ...overrides,
  }
}

function result(
  overrides: Partial<ProfileSearchResult> & Pick<ProfileSearchResult, "query">
): ProfileSearchResult {
  return {
    matches: [],
    evidence: "not_queried",
    relaysPlanned: 0,
    relaysCompleted: 0,
    relaysDegraded: 0,
    verified: true,
    device: {
      profileCache: "not_read",
      sellerFlags: "not_read",
      cachedFrontiers: "not_read",
    },
    superseded: [],
    ...overrides,
  }
}

function deps(
  overrides: Partial<ProfileSearchDependencies> = {}
): Partial<ProfileSearchDependencies> {
  return {
    loadCachedProfiles: async () => [],
    loadCachedProfileRows: async () => new Map(),
    loadSellerPubkeys: async () => new Set(),
    planSearchRelayUrls: () => ["wss://search.example"],
    fetchEvents: async () => ({
      events: [],
      relays: [
        { relayUrl: "wss://search.example", status: "success", eventCount: 0 },
      ],
      eventsVerified: true,
    }),
    ...overrides,
  }
}

describe("profile search text matching", () => {
  it("normalizes case, whitespace, and diacritics", () => {
    expect(normalizeProfileSearchText("  Ålice   Smíth ")).toBe("alice smith")
  })

  it("scores exact, prefix, word, and substring matches in order", () => {
    const query = "ali"
    expect(scoreProfileSearchMatch({ pubkey: ALICE, name: "ali" }, query)).toBe(
      0
    )
    expect(
      scoreProfileSearchMatch({ pubkey: ALICE, displayName: "Alice" }, query)
    ).toBe(1)
    expect(
      scoreProfileSearchMatch({ pubkey: ALICE, name: "Real Alice" }, query)
    ).toBe(2)
    expect(
      scoreProfileSearchMatch({ pubkey: ALICE, name: "Malice" }, query)
    ).toBe(3)
    expect(
      scoreProfileSearchMatch({ pubkey: ALICE, about: "alice" }, query)
    ).toBe(Number.POSITIVE_INFINITY)
  })

  it("ranks sellers first, then by score and name, and caps the list", () => {
    const ranked = rankProfileSearchMatches(
      [
        match({
          pubkey: MALICE,
          profile: { pubkey: MALICE, name: "Malice" },
          isSeller: true,
          score: 3,
        }),
        match({ pubkey: CAROL, profile: { pubkey: CAROL, name: "Alice C" } }),
        match({
          pubkey: ALICIA,
          profile: { pubkey: ALICIA, name: "Alice B" },
          isSeller: true,
        }),
        match({
          pubkey: ALICE,
          profile: { pubkey: ALICE, name: "alice" },
          score: 0,
        }),
      ],
      3
    )
    expect(ranked.map((match) => match.pubkey)).toEqual([ALICIA, MALICE, ALICE])
  })
})

describe("profile search evidence", () => {
  const complete = {
    relaysPlanned: 2,
    relaysCompleted: 2,
    relaysDegraded: 0,
    verified: true,
  }

  it("does not collapse partial or unavailable reads into absence", () => {
    expect(
      resolveProfileSearchEvidence({
        ...complete,
        relaysPlanned: 0,
        relaysCompleted: 0,
        matchCount: 0,
      })
    ).toBe("lookup_unavailable")
    expect(
      resolveProfileSearchEvidence({
        ...complete,
        relaysCompleted: 0,
        matchCount: 0,
      })
    ).toBe("lookup_unavailable")
    expect(
      resolveProfileSearchEvidence({
        ...complete,
        relaysCompleted: 1,
        matchCount: 0,
      })
    ).toBe("lookup_partial")
    expect(resolveProfileSearchEvidence({ ...complete, matchCount: 0 })).toBe(
      "absent_within_scope"
    )
    expect(resolveProfileSearchEvidence({ ...complete, matchCount: 1 })).toBe(
      "present_current"
    )
  })

  it("keeps degraded relay observations partial with or without matches", () => {
    for (const matchCount of [0, 1]) {
      expect(
        resolveProfileSearchEvidence({
          ...complete,
          relaysCompleted: 1,
          relaysDegraded: 1,
          matchCount,
        })
      ).toBe("lookup_partial")
      expect(
        resolveProfileSearchEvidence({
          ...complete,
          relaysCompleted: 0,
          relaysDegraded: 2,
          matchCount,
        })
      ).toBe("lookup_partial")
      expect(
        resolveProfileSearchEvidence({
          ...complete,
          verified: false,
          matchCount,
        })
      ).toBe("lookup_partial")
    }
  })

  it("classifies partial, capped, rejected, and invalid-only relays as degraded", () => {
    expect(
      summarizeProfileSearchRelays(
        {
          relays: [
            { relayUrl: "wss://a.example", status: "success", eventCount: 3 },
            { relayUrl: "wss://b.example", status: "partial", eventCount: 3 },
            { relayUrl: "wss://c.example", status: "success", eventCount: 24 },
            {
              relayUrl: "wss://d.example",
              status: "success",
              eventCount: 2,
              rejectedEventCount: 1,
            },
            {
              relayUrl: "wss://e.example",
              status: "success",
              eventCount: 0,
              rejectedEventCount: 2,
            },
            { relayUrl: "wss://f.example", status: "failed", eventCount: 0 },
          ],
          eventsVerified: false,
        },
        24
      )
    ).toEqual({ relaysCompleted: 1, relaysDegraded: 4, verified: false })
  })
})

describe("profile search relay plan", () => {
  it("keeps configured indexes first, deduplicates, and caps the fanout", () => {
    const advertised = Array.from(
      { length: 30 },
      (_, index) => `wss://advertised-${index}.example/`
    )
    const planned = planProfileSearchRelayUrls(
      ["wss://index.example", "wss://index.example/"],
      ["WSS://INDEX.EXAMPLE", "ws://insecure.example", "  ", ...advertised]
    )

    expect(planned).toHaveLength(PROFILE_SEARCH_MAX_RELAYS)
    expect(planned[0]).toBe("wss://index.example")
    expect(new Set(planned).size).toBe(planned.length)
    expect(planned.every((url) => url.startsWith("wss://"))).toBe(true)
  })

  it("reports the capped plan as the relays it actually attempted", async () => {
    const attempted: string[][] = []
    const result = await searchNetworkProfiles(
      { query: "alice" },
      deps({
        planSearchRelayUrls: () =>
          planProfileSearchRelayUrls(
            [],
            Array.from(
              { length: 12 },
              (_, index) => `wss://relay-${index}.example`
            )
          ),
        fetchEvents: async (_filter, options) => {
          attempted.push(options.relayUrls)
          return {
            events: [],
            relays: options.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 0,
            })),
            eventsVerified: true,
          }
        },
      })
    )

    expect(attempted).toHaveLength(1)
    expect(attempted[0]).toHaveLength(PROFILE_SEARCH_MAX_RELAYS)
    expect(result.relaysPlanned).toBe(PROFILE_SEARCH_MAX_RELAYS)
    expect(result.evidence).toBe("absent_within_scope")
  })
})

describe("account-scoped search plan", () => {
  it("plans with the active account and keeps a guest plan separate", async () => {
    const scopes: (string | null)[] = []
    const attempted: string[][] = []
    const scopedDeps = (accountRelay: string) =>
      deps({
        planSearchRelayUrls: (authenticatedPubkey) => {
          scopes.push(authenticatedPubkey)
          return authenticatedPubkey ? [accountRelay] : ["wss://search.example"]
        },
        fetchEvents: async (_filter, options) => {
          attempted.push(options.relayUrls)
          return {
            events: [],
            relays: options.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 0,
            })),
            eventsVerified: true,
          }
        },
      })

    await searchNetworkProfiles(
      { query: "alice", authenticatedPubkey: ALICE },
      scopedDeps("wss://account.example")
    )
    await searchNetworkProfiles(
      { query: "alice" },
      scopedDeps("wss://other.example")
    )

    expect(scopes).toEqual([ALICE, null])
    expect(attempted).toEqual([
      ["wss://account.example"],
      ["wss://search.example"],
    ])
  })

  it("binds the account relay snapshot instead of the guest adapter", async () => {
    const source = await readFile(
      "packages/core/src/protocol/profile-search.ts",
      "utf8"
    )
    expect(source).toContain(
      "await readDurableAccountRelaySettingsPlanningSnapshot(authenticatedPubkey)"
    )
    expect(source).toMatch(
      /authenticatedPubkey\s*\?[\s\S]{0,120}: loadRelaySettingsPlanningSnapshot\(\)/
    )
  })
})

describe("searchProfiles", () => {
  it("skips relay traffic for queries below the minimum length", async () => {
    let fetched = 0
    const result = await searchProfiles(
      { query: "a" },
      deps({
        fetchEvents: async () => {
          fetched += 1
          return { events: [], relays: [], eventsVerified: true }
        },
      })
    )
    expect(fetched).toBe(0)
    expect(result.evidence).toBe("not_queried")
    expect(result.matches).toEqual([])
  })

  it("merges local cache and network hits, keeps the newest kind-0 per pubkey, and flags sellers", async () => {
    const filters: unknown[] = []
    const result = await searchProfiles(
      { query: "Alice", limit: 5 },
      deps({
        loadCachedProfiles: async () => [
          { pubkey: ALICE, name: "alice", cachedAt: 1 },
          { pubkey: CAROL, name: "Carol", cachedAt: 1 },
        ],
        loadSellerPubkeys: async (pubkeys) =>
          new Set(pubkeys.filter((pubkey) => pubkey === ALICIA)),
        fetchEvents: async (filter) => {
          filters.push(filter)
          return {
            events: [
              profileEvent(ALICIA, { name: "Alicia", display_name: "Old" }, 50),
              profileEvent(
                ALICIA,
                { name: "Alicia", display_name: "Alice B" },
                90
              ),
              profileEvent(ALICE, { name: "alice", about: "newer" }, 200),
              profileEvent(MALICE, { about: "alice fan" }, 10),
            ],
            relays: [
              {
                relayUrl: "wss://search.example",
                status: "success",
                eventCount: 4,
              },
            ],
            eventsVerified: true,
          }
        },
      })
    )

    expect(filters).toEqual([{ kinds: [0], search: "Alice", limit: 24 }])
    expect(result.evidence).toBe("present_current")
    expect(result.matches.map((match) => match.pubkey)).toEqual([ALICIA, ALICE])
    expect(result.matches[0]?.profile.displayName).toBe("Alice B")
    expect(result.matches[0]?.isSeller).toBe(true)
    expect(result.matches[1]?.source).toBe("both")
    expect(result.matches[1]?.profile.about).toBe("newer")
  })

  it("keeps local matches and reports unavailability when every relay fails", async () => {
    const result = await searchProfiles(
      { query: "alice" },
      deps({
        loadCachedProfiles: async () => [
          { pubkey: ALICE, displayName: "Alice", cachedAt: 1 },
        ],
        fetchEvents: async () => {
          throw new Error("offline")
        },
      })
    )
    expect(result.matches.map((match) => match.pubkey)).toEqual([ALICE])
    expect(result.evidence).toBe("lookup_unavailable")
    expect(result.relaysCompleted).toBe(0)
  })

  it("keeps a capped or partially answered relay read partial even with matches", async () => {
    const capped = await searchProfiles(
      { query: "alice" },
      deps({
        fetchEvents: async () => ({
          events: [profileEvent(ALICE, { name: "alice" })],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "success",
              eventCount: 24,
            },
          ],
          eventsVerified: true,
        }),
      })
    )
    expect(capped.matches.map((entry) => entry.pubkey)).toEqual([ALICE])
    expect(capped.evidence).toBe("lookup_partial")
    expect(capped.relaysDegraded).toBe(1)

    const partial = await searchProfiles(
      { query: "alice" },
      deps({
        fetchEvents: async () => ({
          events: [],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "partial",
              eventCount: 0,
            },
          ],
          eventsVerified: true,
        }),
      })
    )
    expect(partial.evidence).toBe("lookup_partial")
    expect(partial.relaysCompleted).toBe(0)
  })

  it("picks the lowest event id when two kind-0 events share a timestamp", async () => {
    const lower = {
      ...profileEvent(ALICE, { name: "alice low" }, 100),
      id: "0a",
    }
    const higher = {
      ...profileEvent(ALICE, { name: "alice high" }, 100),
      id: "0b",
    }
    const result = await searchNetworkProfiles(
      { query: "alice" },
      deps({
        fetchEvents: async () => ({
          events: [higher as NDKEvent, lower as NDKEvent],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "success",
              eventCount: 2,
            },
          ],
          eventsVerified: true,
        }),
      })
    )
    expect(result.matches[0]?.profile.name).toBe("alice low")
    expect(result.matches[0]?.frontier).toEqual({
      createdAt: 100,
      eventId: "0a",
    })
  })

  it("reports a partial lookup when only some relays answer", async () => {
    const result = await searchProfiles(
      { query: "alice" },
      deps({
        planSearchRelayUrls: () => ["wss://one.example", "wss://two.example"],
        fetchEvents: async () => ({
          events: [],
          relays: [
            { relayUrl: "wss://one.example", status: "success", eventCount: 0 },
            { relayUrl: "wss://two.example", status: "failed", eventCount: 0 },
          ],
          eventsVerified: true,
        }),
      })
    )
    expect(result.evidence).toBe("lookup_partial")
    expect(result.relaysPlanned).toBe(2)
    expect(result.relaysCompleted).toBe(1)
  })

  it("drops a relay name this device already replaced and keeps a newer one", async () => {
    const relayDeps = (createdAt: number) =>
      deps({
        loadCachedProfileRows: async () =>
          new Map([
            [
              ALICE,
              {
                pubkey: ALICE,
                name: "Bob",
                eventCreatedAt: 300,
                eventId: "cached",
                cachedAt: 1,
              },
            ],
          ]),
        fetchEvents: async () => ({
          events: [profileEvent(ALICE, { name: "Alice" }, createdAt)],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "success" as const,
              eventCount: 1,
            },
          ],
          eventsVerified: true,
        }),
      })

    const stale = await searchNetworkProfiles(
      { query: "alice" },
      relayDeps(200)
    )
    expect(stale.matches).toEqual([])
    expect(stale.evidence).toBe("absent_within_scope")

    const current = await searchNetworkProfiles(
      { query: "alice" },
      relayDeps(400)
    )
    expect(current.matches.map((entry) => entry.pubkey)).toEqual([ALICE])
    expect(current.matches[0]?.profile.name).toBe("Alice")
  })

  it("drops a merged row whose winning profile no longer matches", () => {
    const merged = mergeProfileSearchResults(
      result({
        query: "alice",
        matches: [
          match({
            pubkey: ALICE,
            profile: { pubkey: ALICE, name: "Alice" },
            source: "local_cache",
            score: 0,
            frontier: { createdAt: 100, eventId: "old" },
          }),
        ],
      }),
      result({
        query: "alice",
        matches: [
          match({
            pubkey: ALICE,
            profile: { pubkey: ALICE, name: "Bob" },
            score: 3,
            frontier: { createdAt: 300, eventId: "new" },
          }),
        ],
        evidence: "present_current",
        relaysPlanned: 1,
        relaysCompleted: 1,
      }),
      5
    )
    expect(merged.matches).toEqual([])
  })

  it("rethrows an abort so a superseded query does not report stale evidence", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      searchProfiles(
        { query: "alice", signal: controller.signal },
        deps({
          fetchEvents: async () => {
            throw new DOMException("aborted", "AbortError")
          },
        })
      )
    ).rejects.toBeInstanceOf(DOMException)
  })
})

describe("phased profile search", () => {
  it("answers from the local cache without relay traffic and stays not_queried", async () => {
    let fetched = 0
    const result = await searchCachedProfiles(
      { query: "ali", limit: 5 },
      deps({
        loadCachedProfiles: async () => [
          { pubkey: ALICE, name: "alice", cachedAt: 1 },
          { pubkey: CAROL, name: "Carol", cachedAt: 1 },
        ],
        loadSellerPubkeys: async (pubkeys) =>
          new Set(pubkeys.filter((pubkey) => pubkey === ALICE)),
        fetchEvents: async () => {
          fetched += 1
          return { events: [], relays: [], eventsVerified: true }
        },
      })
    )

    expect(fetched).toBe(0)
    expect(result.evidence).toBe("not_queried")
    expect(result.relaysPlanned).toBe(0)
    expect(result.matches.map((match) => match.pubkey)).toEqual([ALICE])
    expect(result.matches[0]?.source).toBe("local_cache")
    expect(result.matches[0]?.isSeller).toBe(true)
  })

  it("reads relays only in the network phase and reports its own evidence", async () => {
    let cacheReads = 0
    const result = await searchNetworkProfiles(
      { query: "ali", limit: 5 },
      deps({
        loadCachedProfiles: async () => {
          cacheReads += 1
          return [{ pubkey: ALICE, name: "alice", cachedAt: 1 }]
        },
        fetchEvents: async () => ({
          events: [profileEvent(ALICIA, { name: "Alicia" })],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "success",
              eventCount: 1,
            },
          ],
          eventsVerified: true,
        }),
      })
    )

    expect(cacheReads).toBe(0)
    expect(result.evidence).toBe("present_current")
    expect(result.matches.map((match) => match.pubkey)).toEqual([ALICIA])
    expect(result.matches[0]?.source).toBe("network")
  })

  it("merges phases: cached rows show first, the NIP-01 winner supplies the profile, evidence follows the network", () => {
    const cached = result({
      query: "ali",
      matches: [
        match({
          pubkey: ALICE,
          profile: { pubkey: ALICE, name: "alice" },
          isSeller: true,
          source: "local_cache",
          frontier: { createdAt: 100, eventId: "cached" },
        }),
      ],
    })
    const network = result({
      query: "ali",
      matches: [
        match({
          pubkey: ALICE,
          profile: { pubkey: ALICE, name: "alice", about: "newer" },
          frontier: { createdAt: 200, eventId: "relay" },
        }),
        match({ pubkey: ALICIA, profile: { pubkey: ALICIA, name: "Alicia" } }),
      ],
      evidence: "lookup_partial",
      relaysPlanned: 2,
      relaysCompleted: 1,
    })

    const cachedOnly = mergeProfileSearchResults(cached, undefined, 5)
    expect(cachedOnly.evidence).toBe("not_queried")
    expect(cachedOnly.matches.map((entry) => entry.pubkey)).toEqual([ALICE])

    const merged = mergeProfileSearchResults(cached, network, 5)
    expect(merged.evidence).toBe("lookup_partial")
    expect(merged.relaysPlanned).toBe(2)
    expect(merged.matches.map((entry) => entry.pubkey)).toEqual([ALICE, ALICIA])
    expect(merged.matches[0]?.source).toBe("both")
    expect(merged.matches[0]?.isSeller).toBe(true)
    expect(merged.matches[0]?.profile.about).toBe("newer")
    expect(merged.matches[0]?.frontier.eventId).toBe("relay")
  })

  it("keeps a newer cached frontier over a stale relay copy and breaks ties by lowest id", () => {
    const cached = result({
      query: "ali",
      matches: [
        match({
          pubkey: ALICE,
          profile: { pubkey: ALICE, name: "alice renamed" },
          source: "local_cache",
          frontier: { createdAt: 300, eventId: "cached-new" },
        }),
        match({
          pubkey: ALICIA,
          profile: { pubkey: ALICIA, name: "alicia cached" },
          source: "local_cache",
          frontier: { createdAt: 100, eventId: "0a" },
        }),
      ],
    })
    const network = result({
      query: "ali",
      matches: [
        match({
          pubkey: ALICE,
          profile: { pubkey: ALICE, name: "alice stale" },
          frontier: { createdAt: 200, eventId: "relay-old" },
        }),
        match({
          pubkey: ALICIA,
          profile: { pubkey: ALICIA, name: "alicia relay" },
          frontier: { createdAt: 100, eventId: "0b" },
        }),
      ],
      evidence: "present_current",
      relaysPlanned: 1,
      relaysCompleted: 1,
    })

    const merged = mergeProfileSearchResults(cached, network, 5)
    const byPubkey = new Map(
      merged.matches.map((entry) => [entry.pubkey, entry])
    )
    expect(byPubkey.get(ALICE)?.profile.name).toBe("alice renamed")
    expect(byPubkey.get(ALICE)?.frontier.eventId).toBe("cached-new")
    expect(byPubkey.get(ALICIA)?.profile.name).toBe("alicia cached")
    expect(byPubkey.get(ALICIA)?.frontier.eventId).toBe("0a")
    expect(merged.matches.every((entry) => entry.source === "both")).toBe(true)
  })

  it("ranks the displayed profile, not a replaced name", () => {
    const merged = mergeProfileSearchResults(
      result({
        query: "alice",
        matches: [
          match({
            pubkey: ALICE,
            profile: { pubkey: ALICE, name: "alice" },
            source: "local_cache",
            score: 0,
            frontier: { createdAt: 100, eventId: "old" },
          }),
        ],
      }),
      result({
        query: "alice",
        matches: [
          match({
            pubkey: ALICE,
            profile: { pubkey: ALICE, name: "Malice Corp" },
            score: 3,
            frontier: { createdAt: 200, eventId: "new" },
          }),
          match({
            pubkey: ALICIA,
            profile: { pubkey: ALICIA, name: "alice" },
            score: 0,
            frontier: { createdAt: 150, eventId: "exact" },
          }),
        ],
        evidence: "present_current",
        relaysPlanned: 1,
        relaysCompleted: 1,
      }),
      5
    )

    expect(merged.matches.map((entry) => entry.pubkey)).toEqual([ALICIA, ALICE])
    expect(merged.matches[1]?.profile.name).toBe("Malice Corp")
    expect(merged.matches[1]?.score).toBe(3)
  })

  it("does not let cached rows upgrade an absent relay observation", () => {
    const merged = mergeProfileSearchResults(
      result({
        query: "ali",
        matches: [
          match({
            pubkey: ALICE,
            profile: { pubkey: ALICE, name: "alice" },
            source: "local_cache",
          }),
        ],
      }),
      result({
        query: "ali",
        evidence: "absent_within_scope",
        relaysPlanned: 1,
        relaysCompleted: 1,
      }),
      5
    )
    expect(merged.matches.map((entry) => entry.pubkey)).toEqual([ALICE])
    expect(merged.evidence).toBe("absent_within_scope")
  })

  it("answers within the seller lookup budget and keeps flags it already knows", async () => {
    let release: (value: Set<string>) => void = () => {}
    const blocked = new Promise<Set<string>>((resolve) => {
      release = resolve
    })
    const slowDeps = deps({
      loadCachedProfiles: async () => [
        { pubkey: ERIN, name: "erin", cachedAt: 1 },
      ],
      loadSellerPubkeys: () => blocked,
    })

    const started = Date.now()
    const first = await searchCachedProfiles(
      { query: "eri", sellerLookupBudgetMs: 20 },
      slowDeps
    )
    expect(Date.now() - started).toBeLessThan(500)
    expect(first.matches[0]?.isSeller).toBe(false)

    release(new Set([ERIN]))
    await blocked
    const second = await searchCachedProfiles(
      { query: "eri", sellerLookupBudgetMs: 20 },
      deps({
        loadCachedProfiles: async () => [
          { pubkey: ERIN, name: "erin", cachedAt: 1 },
        ],
        loadSellerPubkeys: () => new Promise(() => {}),
      })
    )
    expect(second.matches[0]?.isSeller).toBe(true)
  })
})

describe("profile search device reads and retirement", () => {
  it("reports an unreadable profile cache instead of an empty directory", async () => {
    const outcome = await searchCachedProfiles(
      { query: "ali" },
      deps({
        loadCachedProfiles: async () => {
          throw new Error("indexeddb unavailable")
        },
      })
    )

    expect(outcome.matches).toEqual([])
    expect(outcome.device.profileCache).toBe("unavailable")
    expect(outcome.evidence).toBe("not_queried")
  })

  it("reports an unavailable seller lookup and still shows the account", async () => {
    const outcome = await searchCachedProfiles(
      { query: "fra", sellerLookupBudgetMs: Infinity },
      deps({
        loadCachedProfiles: async () => [
          {
            pubkey: FRANK,
            name: "frank",
            eventCreatedAt: 100,
            eventId: "cached",
            cachedAt: 1,
          },
        ],
        loadSellerPubkeys: async () => {
          throw new Error("products store unavailable")
        },
      })
    )

    expect(outcome.matches.map((entry) => entry.pubkey)).toEqual([FRANK])
    expect(outcome.matches[0]?.isSeller).toBe(false)
    expect(outcome.device.sellerFlags).toBe("unavailable")
  })

  it("reports when relay answers could not be checked against saved profiles", async () => {
    const outcome = await searchNetworkProfiles(
      { query: "ali" },
      deps({
        loadCachedProfileRows: async () => {
          throw new Error("indexeddb unavailable")
        },
        fetchEvents: async () => ({
          events: [profileEvent(ALICE, { name: "Alice" }, 200)],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "success",
              eventCount: 1,
            },
          ],
          eventsVerified: true,
        }),
      })
    )

    expect(outcome.matches.map((entry) => entry.pubkey)).toEqual([ALICE])
    expect(outcome.device.cachedFrontiers).toBe("unavailable")
  })

  it("answers a one-character query from the device and leaves relays alone", async () => {
    let planned = 0
    let fetched = 0
    const shortQueryDeps = deps({
      loadCachedProfiles: async () => [
        {
          pubkey: ALICE,
          name: "alice",
          eventCreatedAt: 100,
          eventId: "cached",
          cachedAt: 1,
        },
      ],
      planSearchRelayUrls: () => {
        planned += 1
        return ["wss://search.example"]
      },
      fetchEvents: async () => {
        fetched += 1
        return { events: [], relays: [], eventsVerified: true }
      },
    })

    const cached = await searchCachedProfiles({ query: "a" }, shortQueryDeps)
    const network = await searchNetworkProfiles({ query: "a" }, shortQueryDeps)

    expect(cached.matches.map((entry) => entry.pubkey)).toEqual([ALICE])
    expect(network.matches).toEqual([])
    expect(network.evidence).toBe("not_queried")
    expect(network.relaysPlanned).toBe(0)
    expect(planned).toBe(0)
    expect(fetched).toBe(0)
  })

  it("retires a cached suggestion the relay has already replaced", async () => {
    const cachedRow = {
      pubkey: ALICE,
      name: "alice",
      eventCreatedAt: 100,
      eventId: "cached",
      cachedAt: 1,
    }
    const replacedDeps = deps({
      loadCachedProfiles: async () => [cachedRow],
      loadCachedProfileRows: async () => new Map([[ALICE, cachedRow]]),
      fetchEvents: async () => ({
        events: [profileEvent(ALICE, { name: "Bob" }, 200)],
        relays: [
          {
            relayUrl: "wss://search.example",
            status: "success",
            eventCount: 1,
          },
        ],
        eventsVerified: true,
      }),
    })

    const network = await searchNetworkProfiles({ query: "ali" }, replacedDeps)
    expect(network.superseded.map((entry) => entry.pubkey)).toEqual([ALICE])

    const merged = await searchProfiles({ query: "ali" }, replacedDeps)
    expect(merged.matches).toEqual([])
  })

  it("keeps the cached suggestion when the relay copy is older", async () => {
    const cachedRow = {
      pubkey: ALICE,
      name: "alice",
      eventCreatedAt: 300,
      eventId: "cached",
      cachedAt: 1,
    }
    const merged = await searchProfiles(
      { query: "ali" },
      deps({
        loadCachedProfiles: async () => [cachedRow],
        loadCachedProfileRows: async () => new Map([[ALICE, cachedRow]]),
        fetchEvents: async () => ({
          events: [profileEvent(ALICE, { name: "Bob" }, 200)],
          relays: [
            {
              relayUrl: "wss://search.example",
              status: "success",
              eventCount: 1,
            },
          ],
          eventsVerified: true,
        }),
      })
    )

    expect(merged.matches.map((entry) => entry.pubkey)).toEqual([ALICE])
    expect(merged.matches[0]?.profile.name).toBe("alice")
    expect(merged.superseded).toEqual([])
  })
})

describe("late seller lookups", () => {
  it("publishes a seller lookup that answered after its budget", async () => {
    let release: (value: Set<string>) => void = () => {}
    const blocked = new Promise<Set<string>>((resolve) => {
      release = resolve
    })
    const settled: Set<string>[] = []

    const outcome = await searchCachedProfiles(
      {
        query: "gra",
        sellerLookupBudgetMs: 20,
        onSellerFlagsSettled: (sellerPubkeys) => settled.push(sellerPubkeys),
      },
      deps({
        loadCachedProfiles: async () => [
          {
            pubkey: GRACE,
            name: "grace",
            eventCreatedAt: 100,
            eventId: "cached",
            cachedAt: 1,
          },
        ],
        loadSellerPubkeys: () => blocked,
      })
    )

    expect(outcome.matches[0]?.isSeller).toBe(false)
    expect(outcome.device.sellerFlags).toBe("partial")
    expect(settled).toEqual([])

    release(new Set([GRACE]))
    await blocked
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toEqual([new Set([GRACE])])

    const corrected = applyProfileSearchSellerFlags(outcome, settled[0]!, 5)
    expect(corrected.matches[0]?.isSeller).toBe(true)
    expect(corrected.device.sellerFlags).toBe("read")
  })

  it("keeps seller-first order when the flags arrive late", () => {
    const base = result({
      query: "ali",
      matches: [
        match({
          pubkey: ALICIA,
          profile: { pubkey: ALICIA, name: "Alicia" },
          score: 1,
        }),
        match({
          pubkey: MALICE,
          profile: { pubkey: MALICE, name: "Malice" },
          score: 3,
        }),
      ],
    })

    const corrected = applyProfileSearchSellerFlags(base, new Set([MALICE]), 5)
    expect(corrected.matches.map((entry) => entry.pubkey)).toEqual([
      MALICE,
      ALICIA,
    ])
  })
})
