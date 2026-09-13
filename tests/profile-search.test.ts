import { describe, expect, it } from "bun:test"
import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  normalizeProfileSearchText,
  rankProfileSearchMatches,
  resolveProfileSearchEvidence,
  scoreProfileSearchMatch,
  searchProfiles,
  type ProfileSearchDependencies,
} from "../packages/core/src/protocol/profile-search"

const ALICE = "a".repeat(64)
const ALICIA = "b".repeat(64)
const CAROL = "c".repeat(64)
const MALICE = "d".repeat(64)

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

function deps(
  overrides: Partial<ProfileSearchDependencies> = {}
): Partial<ProfileSearchDependencies> {
  return {
    loadCachedProfiles: async () => [],
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
        {
          pubkey: MALICE,
          profile: { pubkey: MALICE, name: "Malice" },
          isSeller: true,
          source: "network",
          score: 3,
        },
        {
          pubkey: CAROL,
          profile: { pubkey: CAROL, name: "Alice C" },
          isSeller: false,
          source: "network",
          score: 1,
        },
        {
          pubkey: ALICIA,
          profile: { pubkey: ALICIA, name: "Alice B" },
          isSeller: true,
          source: "network",
          score: 1,
        },
        {
          pubkey: ALICE,
          profile: { pubkey: ALICE, name: "alice" },
          isSeller: false,
          source: "network",
          score: 0,
        },
      ],
      3
    )
    expect(ranked.map((match) => match.pubkey)).toEqual([ALICIA, MALICE, ALICE])
  })
})

describe("profile search evidence", () => {
  it("does not collapse partial or unavailable reads into absence", () => {
    expect(
      resolveProfileSearchEvidence({
        relaysPlanned: 0,
        relaysCompleted: 0,
        matchCount: 0,
      })
    ).toBe("lookup_unavailable")
    expect(
      resolveProfileSearchEvidence({
        relaysPlanned: 2,
        relaysCompleted: 0,
        matchCount: 0,
      })
    ).toBe("lookup_unavailable")
    expect(
      resolveProfileSearchEvidence({
        relaysPlanned: 2,
        relaysCompleted: 1,
        matchCount: 0,
      })
    ).toBe("lookup_partial")
    expect(
      resolveProfileSearchEvidence({
        relaysPlanned: 2,
        relaysCompleted: 2,
        matchCount: 0,
      })
    ).toBe("absent_within_scope")
    expect(
      resolveProfileSearchEvidence({
        relaysPlanned: 2,
        relaysCompleted: 2,
        matchCount: 1,
      })
    ).toBe("present_current")
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
