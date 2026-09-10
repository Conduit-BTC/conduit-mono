import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import {
  __resetFollowedEventMarketDiscoveryTestOverrides,
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  __setFollowedEventMarketDiscoveryTestOverrides,
  discoverFollowedOrganizerEventMarkets,
  FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT,
  type EventMarketRelayCoverage,
  type EventMarketResolution,
  type FollowListReadResult,
  type OrganizerEventMarketsReadResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const MERCHANT = "a".repeat(64)
const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const UNFOLLOWED_SECRET = generateSecretKey()
const RELAY = "wss://event-candidates.test"
const RETAINED_RELAY = "wss://retained-event-candidate.test"
const COMPLETE_COVERAGE: EventMarketRelayCoverage = {
  attemptedRelayCount: 1,
  completeRelayCount: 1,
  partialRelayCount: 0,
  failedRelayCount: 0,
}

function followRead(pubkeys: readonly string[]): FollowListReadResult {
  const event: SignedPublicNostrEvent = {
    id: "d".repeat(64),
    pubkey: MERCHANT,
    created_at: 1_800_000_000,
    kind: 3,
    tags: pubkeys.map((pubkey) => ["p", pubkey]),
    content: "",
    sig: "e".repeat(128),
  }
  return {
    events: [event],
    authors: [
      {
        pubkey: MERCHANT,
        event,
        eventSourceRelayUrls: [RELAY],
        plannedRelayUrls: [RELAY],
        relays: [{ relayUrl: RELAY, status: "success", eventCount: 1 }],
        eventsVerified: true,
        coverage: "complete",
        relayListState: "network",
        relayHintTruncated: false,
        capped: false,
        snapshotState: "network",
      },
    ],
    plannedRelayUrls: [RELAY],
    relays: [],
    eventsVerified: true,
  }
}

function collectionEvent(
  input: {
    secret?: Uint8Array
    dTag?: string
    createdAt?: number
  } = {}
): SignedPublicNostrEvent {
  const secret = input.secret ?? ORGANIZER_SECRET
  const pubkey = getPublicKey(secret)
  const dTag = input.dTag ?? "catalog"
  return finalizeEvent(
    {
      kind: 30405,
      created_at: input.createdAt ?? 1_800_000_000,
      tags: [
        ["d", dTag],
        ["title", `Event ${dTag}`],
        ["a", `31923:${pubkey}:${dTag}`],
      ],
      content: "",
    },
    secret
  )
}

function candidateRead(
  input: {
    events?: SignedPublicNostrEvent[]
    relayStatus?: "success" | "partial" | "failed"
    eventsVerified?: boolean
    capped?: boolean
  } = {}
) {
  const events = input.events ?? []
  return {
    events,
    eventSourceRelayUrls: Object.fromEntries(
      events.map((event) => [event.id, [RELAY]])
    ),
    relays: [
      {
        relayUrl: RELAY,
        status: input.relayStatus ?? "success",
        eventCount: events.length,
      },
    ],
    eventsVerified: input.eventsVerified ?? true,
    plannedRelayCount: 1,
    capped: input.capped ?? false,
  }
}

function market(
  organizerPubkey: string,
  suffix = "catalog",
  state: EventMarketResolution["state"] = "active"
): EventMarketResolution {
  const reference = `30405:${organizerPubkey}:${suffix}`
  return {
    state,
    reference,
    organizerPubkey,
    collectionCoordinate: reference,
    organizerProductCoordinates: [],
    acceptedProductCoordinates: [],
    acceptedProductEvidence: [],
    organizerOnlyProductCoordinates: [],
    participationRequests: [],
    participationBudget: {
      state: "within_budget",
      targetCount: 0,
      targetLimit: 64,
    },
    pickupBudget: {
      state: "within_budget",
      targetCount: 0,
      targetLimit: 64,
    },
    pickups: [],
    coverage: COMPLETE_COVERAGE,
  }
}

function organizerRead(
  markets: EventMarketResolution[],
  state: OrganizerEventMarketsReadResult["state"] = "complete"
): OrganizerEventMarketsReadResult {
  return {
    markets,
    state,
    coverage: COMPLETE_COVERAGE,
    relayListState: "network",
    relayHintTruncated: false,
  }
}

beforeEach(() => {
  __setEventMarketTestOverrides({
    loadCachedEvidence: async () => [],
    loadCachedCollectionEvidence: async () => [],
  })
})

afterEach(() => {
  __resetFollowedEventMarketDiscoveryTestOverrides()
  __resetEventMarketTestOverrides()
})

describe("candidate-first followed event-market discovery", () => {
  it("discovers a followed organizer beyond the former sixteen-author boundary", async () => {
    const earlierPubkeys = Array.from({ length: 19 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0")
    )
    const candidate = collectionEvent()
    const organizerInputs: string[] = []

    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([...earlierPubkeys, ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ events: [candidate] }),
      readOrganizerMarkets: async (input) => {
        organizerInputs.push(input.organizerPubkey)
        expect(input.projection).toBe("discovery")
        expect(input.relayHints).toEqual([RELAY])
        expect(input.candidateCollectionEvents).toEqual([candidate])
        return organizerRead([market(ORGANIZER)])
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
      nowMs: 1_800_000_000_000,
    })

    expect(result.state).toBe("complete")
    expect(result.followedOrganizerCount).toBe(20)
    expect(result.candidateCollectionCount).toBe(1)
    expect(result.searchedOrganizerCount).toBe(1)
    expect(result.truncated).toBe(false)
    expect(organizerInputs).toEqual([ORGANIZER])
    expect(result.markets.map((item) => item.reference)).toEqual([
      `30405:${ORGANIZER}:catalog`,
    ])
  })

  it("filters unfollowed collection candidates before organizer resolution", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({
          events: [collectionEvent({ secret: UNFOLLOWED_SECRET })],
        }),
      readOrganizerMarkets: async () => {
        throw new Error("unfollowed organizer should not be resolved")
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("complete_empty")
    expect(result.candidateCollectionCount).toBe(0)
    expect(result.searchedOrganizerCount).toBe(0)
  })

  it("does not query every followed organizer when no collection candidate exists", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () => candidateRead(),
      readOrganizerMarkets: async () => {
        throw new Error("organizers without candidates should not be resolved")
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result).toMatchObject({
      state: "complete_empty",
      candidateCollectionCount: 0,
      searchedOrganizerCount: 0,
    })
  })

  it("retains a verified followed market when a partial live scan omits it", async () => {
    const retainedCandidate = collectionEvent()
    const organizerInputs: string[] = []
    __setEventMarketTestOverrides({
      loadCachedCollectionEvidence: async (organizerPubkeys) =>
        organizerPubkeys.includes(ORGANIZER)
          ? [
              {
                id: retainedCandidate.id,
                organizerPubkey: ORGANIZER,
                kind: retainedCandidate.kind,
                addressId: "catalog",
                signedEvent: retainedCandidate,
                sourceRelayUrls: [RETAINED_RELAY],
                cachedAt: 1_800_000_000_000,
              },
            ]
          : [],
    })
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER, "b".repeat(64)]),
      readCollectionCandidates: async () =>
        candidateRead({ relayStatus: "partial" }),
      readOrganizerMarkets: async (input) => {
        organizerInputs.push(input.organizerPubkey)
        expect(input.candidateCollectionEvents).toEqual([retainedCandidate])
        expect(input.relayHints).toEqual([RETAINED_RELAY])
        return organizerRead([market(ORGANIZER, "catalog", "stale")], "partial")
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result).toMatchObject({
      state: "partial",
      candidateScanState: "partial",
      candidateCollectionCount: 1,
      searchedOrganizerCount: 1,
    })
    expect(result.markets.map((item) => item.reference)).toEqual([
      `30405:${ORGANIZER}:catalog`,
    ])
    expect(organizerInputs).toEqual([ORGANIZER])
  })

  it("keeps a validated candidate visible while reporting partial relay coverage", async () => {
    const candidate = collectionEvent()
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ events: [candidate], relayStatus: "partial" }),
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.markets).toHaveLength(1)
    expect(result.candidateScanState).toBe("partial")
  })

  it("does not claim absence when the candidate scan is unavailable", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ relayStatus: "failed" }),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("unavailable")
    expect(result.candidateScanState).toBe("unavailable")
  })

  it("marks a saturated candidate scan partial without dropping validated positives", async () => {
    const candidate = collectionEvent()
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ events: [candidate], capped: true }),
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.truncated).toBe(true)
    expect(result.markets).toHaveLength(1)
  })

  it("bounds the candidate frontier independently of follow-list size", () => {
    expect(FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT).toBeGreaterThan(16)
    expect(FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT).toBeLessThanOrEqual(
      256
    )
  })

  it("keeps invalid event-market linkage out of the visible feed", async () => {
    const candidate = collectionEvent()
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ events: [candidate] }),
      readOrganizerMarkets: async () =>
        organizerRead([market(ORGANIZER, "catalog", "malformed")]),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.markets).toEqual([])
  })
})
