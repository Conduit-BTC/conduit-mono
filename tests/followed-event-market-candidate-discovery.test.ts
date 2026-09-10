import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Filter,
} from "nostr-tools"
import {
  __resetFollowedEventMarketDiscoveryTestOverrides,
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  __setFollowedEventMarketDiscoveryTestOverrides,
  discoverFollowedOrganizerEventMarkets,
  discoverPerspectiveEventMarkets,
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
  const relayStatus = input.relayStatus ?? "success"
  const eventsVerified = input.eventsVerified ?? true
  const capped = input.capped ?? false
  const complete = relayStatus === "success" && eventsVerified && !capped
  const failed = relayStatus === "failed"
  return {
    events,
    eventSourceRelayUrls: Object.fromEntries(
      events.map((event) => [event.id, [RELAY]])
    ),
    relays: [
      {
        relayUrl: RELAY,
        status: relayStatus,
        eventCount: events.length,
      },
    ],
    eventsVerified,
    plannedRelayCount: 1,
    capped,
    coverage: {
      plannedRelayUrls: [RELAY],
      authorChunkCount: 1,
      plannedReadCount: 1,
      reads: [],
      completeReadCount: complete ? 1 : 0,
      partialReadCount: !complete && !failed ? 1 : 0,
      failedReadCount: failed ? 1 : 0,
      mainPageCount: 1,
      boundaryPageCount: 0,
      saturatedPageCount: capped ? 1 : 0,
      pageBudgetExhaustedReadCount: capped ? 1 : 0,
      verificationTruncatedReadCount: eventsVerified ? 0 : 1,
    },
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

  it("retains a verified followed market across omitted live-scan states", async () => {
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
    const scenarios = [
      { relayStatus: "success" as const, capped: false, scan: "complete" },
      { relayStatus: "partial" as const, capped: false, scan: "partial" },
      { relayStatus: "success" as const, capped: true, scan: "partial" },
      { relayStatus: "failed" as const, capped: false, scan: "unavailable" },
    ] as const

    for (const scenario of scenarios) {
      __resetFollowedEventMarketDiscoveryTestOverrides()
      __setFollowedEventMarketDiscoveryTestOverrides({
        readFollowLists: async () => followRead([ORGANIZER, "b".repeat(64)]),
        readCollectionCandidates: async () =>
          candidateRead({
            relayStatus: scenario.relayStatus,
            capped: scenario.capped,
          }),
        readOrganizerMarkets: async (input) => {
          organizerInputs.push(input.organizerPubkey)
          expect(input.candidateCollectionEvents).toEqual([retainedCandidate])
          expect(input.relayHints).toEqual([RETAINED_RELAY])
          return organizerRead(
            [market(ORGANIZER, "catalog", "stale")],
            "partial"
          )
        },
      })

      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
      })

      expect(result).toMatchObject({
        state: "partial",
        candidateScanState: scenario.scan,
        candidateCollectionCount: 1,
        searchedOrganizerCount: 1,
      })
      expect(result.markets.map((item) => item.reference)).toEqual([
        `30405:${ORGANIZER}:catalog`,
      ])
    }
    expect(organizerInputs).toEqual(scenarios.map(() => ORGANIZER))
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

  it("keeps each candidate relay page within the client read budget", () => {
    expect(FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT).toBeGreaterThan(16)
    expect(FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT).toBeLessThanOrEqual(
      256
    )
  })

  it("scopes relay reads to every selected perspective author in bounded chunks", async () => {
    const selectedAuthors = Array.from({ length: 65 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0")
    )
    const filters: Filter[] = []
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async (filter, options) => {
        filters.push(filter)
        expect(options.relayUrls).toEqual([RELAY])
        return {
          events: [],
          eventSourceRelayUrls: {},
          relays: [{ relayUrl: RELAY, status: "success", eventCount: 0 }],
          eventsVerified: true,
        }
      },
    })

    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: selectedAuthors,
      perspective: {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      },
    })

    expect(result.state).toBe("complete_empty")
    expect(result.perspective).toMatchObject({
      source: "conduit",
      authorCount: 65,
      snapshotState: "curated",
    })
    expect(result.candidateScanCoverage).toMatchObject({
      authorChunkCount: 2,
      plannedReadCount: 2,
      completeReadCount: 2,
    })
    expect(result.candidateScanCoverage.reads).toEqual([
      expect.objectContaining({
        relayUrl: RELAY,
        authorChunkIndex: 0,
        authorCount: 64,
        state: "complete",
      }),
      expect.objectContaining({
        relayUrl: RELAY,
        authorChunkIndex: 1,
        authorCount: 1,
        state: "complete",
      }),
    ])
    expect(filters.map((filter) => filter.authors?.length)).toEqual([64, 1])
    expect(new Set(filters.flatMap((filter) => filter.authors ?? []))).toEqual(
      new Set(selectedAuthors)
    )
    expect(filters.every((filter) => filter.since === undefined)).toBe(true)
  })

  it("paginates descending and closes an equal-created-at boundary without a global frontier cutoff", async () => {
    const newer = Array.from({ length: 128 }, (_, index) =>
      collectionEvent({ dTag: `newer-${index}`, createdAt: 1_000 - index })
    )
    const boundaryA = collectionEvent({
      dTag: "boundary-a",
      createdAt: 500,
    })
    const boundaryB = collectionEvent({
      dTag: "boundary-b",
      createdAt: 500,
    })
    const older = collectionEvent({ dTag: "older", createdAt: 400 })
    const filters: Filter[] = []
    let candidateEventCount = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async (filter) => {
        filters.push(filter)
        const events =
          filter.since === 500
            ? [boundaryA, boundaryB]
            : filter.until === 499
              ? [older]
              : [...newer, boundaryA]
        return {
          events,
          eventSourceRelayUrls: Object.fromEntries(
            events.map((event) => [event.id, [RELAY]])
          ),
          relays: [
            { relayUrl: RELAY, status: "success", eventCount: events.length },
          ],
          eventsVerified: true,
        }
      },
      readOrganizerMarkets: async (input) => {
        candidateEventCount = input.candidateCollectionEvents?.length ?? 0
        return organizerRead([market(ORGANIZER, "older")])
      },
    })

    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: [ORGANIZER],
      perspective: {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      },
    })

    expect(result.state).toBe("complete")
    expect(result.candidateCollectionCount).toBe(131)
    expect(candidateEventCount).toBe(131)
    expect(result.candidateScanCoverage).toMatchObject({
      mainPageCount: 2,
      boundaryPageCount: 1,
      saturatedPageCount: 1,
      pageBudgetExhaustedReadCount: 0,
    })
    expect(result.candidateScanCoverage.reads[0].pages).toEqual([
      expect.objectContaining({
        pageIndex: 0,
        mainRelayStatus: "success",
        mainCompletedAtEose: true,
        saturated: true,
        boundaryCreatedAt: 500,
        boundaryRelayStatus: "success",
        boundaryCompletedAtEose: true,
        boundarySaturated: false,
      }),
      expect.objectContaining({
        pageIndex: 1,
        until: 499,
        mainRelayStatus: "success",
        mainCompletedAtEose: true,
        saturated: false,
      }),
    ])
    expect(filters[0]).toMatchObject({
      kinds: [30405],
      authors: [ORGANIZER],
      limit: FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT + 1,
    })
    expect(filters[0].since).toBeUndefined()
    expect(filters[1]).toMatchObject({ since: 500, until: 500 })
    expect(filters[2]).toMatchObject({ until: 499 })
    expect(filters[2].since).toBeUndefined()
  })

  it("reports exhausted page coverage as partial while preserving verified positives", async () => {
    const pageEvents = [400, 300, 200, 100].map((createdAt) =>
      collectionEvent({ dTag: `page-${createdAt}`, createdAt })
    )
    let mainPageIndex = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async (filter) => {
        const boundaryRead = filter.since !== undefined
        const event = boundaryRead
          ? pageEvents.find(
              (candidate) => candidate.created_at === filter.since
            )!
          : pageEvents[mainPageIndex++]
        return {
          events: [event],
          eventSourceRelayUrls: { [event.id]: [RELAY] },
          relays: [
            {
              relayUrl: RELAY,
              status: "success",
              eventCount: boundaryRead
                ? 1
                : FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT + 1,
            },
          ],
          eventsVerified: true,
        }
      },
      readOrganizerMarkets: async () =>
        organizerRead([market(ORGANIZER, "page-400")]),
    })

    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: [ORGANIZER],
      perspective: {
        source: "combined",
        coverage: "complete",
        eventObserved: true,
        snapshotState: "network",
        truncated: false,
      },
    })

    expect(result.state).toBe("partial")
    expect(result.truncated).toBe(true)
    expect(result.markets).toHaveLength(1)
    expect(result.candidateScanCoverage).toMatchObject({
      mainPageCount: 4,
      boundaryPageCount: 4,
      saturatedPageCount: 4,
      pageBudgetExhaustedReadCount: 1,
      partialReadCount: 1,
    })
  })

  it("treats a saturated equal-created-at boundary as partial without dropping its positive", async () => {
    const candidate = collectionEvent({ createdAt: 500 })
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async (filter) => {
        const boundaryRead = filter.since === 500
        return {
          events: [candidate],
          eventSourceRelayUrls: { [candidate.id]: [RELAY] },
          relays: [
            {
              relayUrl: RELAY,
              status: "success",
              eventCount: boundaryRead
                ? 513
                : FOLLOWED_EVENT_MARKET_CANDIDATE_TARGET_LIMIT + 1,
            },
          ],
          eventsVerified: true,
        }
      },
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })

    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: [ORGANIZER],
      perspective: {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      },
    })

    expect(result.state).toBe("partial")
    expect(result.truncated).toBe(true)
    expect(result.markets).toHaveLength(1)
    expect(result.candidateScanCoverage).toMatchObject({
      boundaryPageCount: 1,
      partialReadCount: 1,
      pageBudgetExhaustedReadCount: 0,
    })
    expect(result.candidateScanCoverage.reads[0].pages[0]).toMatchObject({
      boundaryCreatedAt: 500,
      boundaryRelayStatus: "success",
      boundarySaturated: true,
    })
  })

  it("records relay-by-chunk failure without hiding a positive from a complete relay", async () => {
    const secondRelay = "wss://event-candidates-backup.test"
    const candidate = collectionEvent()
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY, secondRelay],
      fetchCollectionCandidateEvents: async (_filter, options) => {
        const relayUrl = options.relayUrls[0]!
        const succeeded = relayUrl === RELAY
        return {
          events: succeeded ? [candidate] : [],
          eventSourceRelayUrls: succeeded ? { [candidate.id]: [RELAY] } : {},
          relays: [
            {
              relayUrl,
              status: succeeded ? "success" : "failed",
              eventCount: succeeded ? 1 : 0,
            },
          ],
          eventsVerified: true,
        }
      },
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })

    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: [ORGANIZER],
      perspective: {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      },
    })

    expect(result.state).toBe("partial")
    expect(result.markets).toHaveLength(1)
    expect(result.candidateScanCoverage).toMatchObject({
      plannedReadCount: 2,
      completeReadCount: 1,
      failedReadCount: 1,
    })
    expect(
      result.candidateScanCoverage.reads.map((read) => read.state)
    ).toEqual(["complete", "failed"])
  })

  it("keeps individually verified positives when another candidate was rejected", async () => {
    const candidate = collectionEvent()
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ events: [candidate], eventsVerified: false }),
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.candidateScanState).toBe("partial")
    expect(result.markets).toHaveLength(1)
  })

  it("uses one shared candidate path for following, conduit, and combined perspectives", async () => {
    const candidate = collectionEvent()
    __setFollowedEventMarketDiscoveryTestOverrides({
      readCollectionCandidates: async (input) => {
        expect(input.organizerPubkeys).toEqual([ORGANIZER])
        return candidateRead({ events: [candidate] })
      },
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })

    for (const source of ["following", "conduit", "combined"] as const) {
      const result = await discoverPerspectiveEventMarkets({
        organizerPubkeys: [ORGANIZER],
        perspective: {
          source,
          coverage: "complete",
          eventObserved: source !== "conduit",
          snapshotState: source === "conduit" ? "curated" : "network",
          truncated: false,
        },
      })
      expect(result.state).toBe("complete")
      expect(result.perspective.source).toBe(source)
      expect(result.markets.map((item) => item.reference)).toEqual([
        `30405:${ORGANIZER}:catalog`,
      ])
    }
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
