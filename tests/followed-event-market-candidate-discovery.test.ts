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
  resolveEventMarketEvidence,
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
      requestCount: 1,
      skippedReadCount: 0,
      executionBoundedReadCount: 0,
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

  describe("event collection classification", () => {
    const ordinary = (createdAt = 200, dTag = "catalog") =>
      finalizeEvent(
        {
          kind: 30405,
          created_at: createdAt,
          tags: [
            ["d", dTag],
            ["title", "Products"],
            ["a", `30402:${ORGANIZER}:product`],
          ],
          content: "",
        },
        ORGANIZER_SECRET
      )

    function configure(
      live: SignedPublicNostrEvent[],
      retained: SignedPublicNostrEvent[] = []
    ) {
      const hydrated: SignedPublicNostrEvent[][] = []
      const calendar = finalizeEvent(
        {
          kind: 31923,
          created_at: 100,
          tags: [
            ["d", "catalog"],
            ["title", "Event"],
            ["start", "1900000000"],
            ["D", String(Math.floor(1900000000 / 86400))],
          ],
          content: "",
        },
        ORGANIZER_SECRET
      )
      __setFollowedEventMarketDiscoveryTestOverrides({
        readFollowLists: async () => followRead([ORGANIZER]),
        readCollectionCandidates: async () => candidateRead({ events: live }),
        readRetainedCollectionCandidates: async () => ({
          events: retained,
          eventSourceRelayUrls: Object.fromEntries(
            retained.map((event) => [event.id, [RETAINED_RELAY]])
          ),
        }),
        readOrganizerMarkets: async (input) => {
          const events = [...(input.candidateCollectionEvents ?? [])]
          hydrated.push(events)
          const coordinates = new Set(
            events.map(
              (event) =>
                `30405:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
            )
          )
          return organizerRead(
            [...coordinates].map((reference) =>
              resolveEventMarketEvidence({
                reference,
                events: [...events, calendar],
                nowMs: 1800000000000,
              })
            )
          )
        },
      })
      return hydrated
    }

    it("excludes ordinary product collections without organizer hydration", async () => {
      const hydrated = configure([ordinary()])
      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
      })
      expect(result).toMatchObject({
        state: "complete_empty",
        candidateCollectionCount: 0,
        searchedOrganizerCount: 0,
        markets: [],
      })
      expect(hydrated).toEqual([])
    })

    it("keeps an event complete when ordinary collections share its organizer", async () => {
      const event = collectionEvent({ createdAt: 100 })
      const hydrated = configure([event, ordinary(200, "products")])
      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
        nowMs: 1800000000000,
      })
      expect(result.state).toBe("complete")
      expect(result.candidateCollectionCount).toBe(1)
      expect(result.markets).toHaveLength(1)
      expect(hydrated).toEqual([[event]])
    })

    for (const claims of [
      [["a", "31923:invalid:calendar"]],
      [
        ["a", `31923:${ORGANIZER}:catalog`],
        ["a", `31922:${ORGANIZER}:other`],
      ],
    ]) {
      it(`keeps ${claims.length === 1 ? "malformed" : "conflicting"} event claims partial and invisible`, async () => {
        const candidate = finalizeEvent(
          {
            kind: 30405,
            created_at: 100,
            tags: [["d", "catalog"], ["title", "Event"], ...claims],
            content: "",
          },
          ORGANIZER_SECRET
        )
        const hydrated = configure([candidate])
        const result = await discoverFollowedOrganizerEventMarkets({
          merchantPubkey: MERCHANT,
        })
        expect(result.state).toBe("partial")
        expect(result.markets).toEqual([])
        expect(hydrated).toEqual([[candidate]])
      })
    }

    it("keeps a claimed event with an extra malformed d tag partial", async () => {
      const event = collectionEvent()
      const malformed = finalizeEvent(
        { ...event, tags: [...event.tags, ["d"]] },
        ORGANIZER_SECRET
      )
      const hydrated = configure([malformed])
      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
      })
      expect(result.state).toBe("partial")
      expect(result.markets).toEqual([])
      expect(hydrated).toEqual([])
    })

    for (const source of ["live", "retained", "split", "reverse"] as const) {
      it(`preserves a removed event link across ${source} revisions`, async () => {
        const older = collectionEvent({ createdAt: 100 })
        const newer = ordinary()
        const live =
          source === "live"
            ? [older, newer]
            : source === "split"
              ? [newer]
              : source === "reverse"
                ? [older]
                : []
        const retained =
          source === "retained"
            ? [older, newer]
            : source === "split"
              ? [older]
              : source === "reverse"
                ? [newer]
                : []
        const hydrated = configure(live, retained)
        const result = await discoverFollowedOrganizerEventMarkets({
          merchantPubkey: MERCHANT,
          nowMs: 1800000000000,
        })
        expect(result.state).toBe("partial")
        expect(result.markets).toEqual([])
        expect(result.candidateCollectionCount).toBe(1)
        expect(hydrated).toHaveLength(1)
        expect(hydrated[0]).toContainEqual(newer)
      })
    }
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
          expect(input.candidateCollectionLiveEventIds).toEqual(new Set())
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

  it("keeps exact live provenance when retained and live revisions share a coordinate", async () => {
    const liveCandidate = collectionEvent({ createdAt: 100 })
    const retainedCandidate = collectionEvent({ createdAt: 200 })
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead([ORGANIZER]),
      readCollectionCandidates: async () =>
        candidateRead({ events: [liveCandidate] }),
      readRetainedCollectionCandidates: async () => ({
        events: [retainedCandidate],
        eventSourceRelayUrls: {
          [retainedCandidate.id]: [RETAINED_RELAY],
        },
      }),
      readOrganizerMarkets: async (input) => {
        expect(
          new Set(input.candidateCollectionEvents?.map((event) => event.id))
        ).toEqual(new Set([liveCandidate.id, retainedCandidate.id]))
        expect(input.candidateCollectionLiveEventIds).toEqual(
          new Set([liveCandidate.id])
        )
        return organizerRead([market(ORGANIZER, "catalog", "stale")], "partial")
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.markets).toEqual([
      expect.objectContaining({ state: "stale" }),
    ])
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

  it("bounds total candidate work across relay and author chunks while retaining positives", async () => {
    const authors = [
      ...Array.from({ length: 192 }, (_, index) =>
        (index + 1).toString(16).padStart(64, "0")
      ),
      ORGANIZER,
    ]
    const candidate = collectionEvent()
    let requests = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      candidateReadRequestLimit: 4,
      collectionCandidateRelayUrls: [RELAY, RETAINED_RELAY],
      fetchCollectionCandidateEvents: async (filter, options) => {
        requests += 1
        const events = filter.authors?.includes(ORGANIZER) ? [candidate] : []
        const relayUrl = options.relayUrls[0]!
        return {
          events,
          eventSourceRelayUrls: {},
          eventsVerified: true,
          relays: [{ relayUrl, status: "success", eventCount: events.length }],
        }
      },
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })
    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: authors,
      perspective: {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      },
    })
    expect(requests).toBe(4)
    expect(result).toMatchObject({ state: "partial", truncated: true })
    expect(result.markets).toHaveLength(1)
    expect(result.candidateScanCoverage).toMatchObject({
      plannedReadCount: 8,
      requestCount: 4,
      skippedReadCount: 4,
    })
  })

  it("bounds a noncooperative candidate boundary read without losing its verified page", async () => {
    const candidate = collectionEvent()
    let readerSignal: AbortSignal | undefined
    __setFollowedEventMarketDiscoveryTestOverrides({
      candidateReadDeadlineMs: 5,
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async (filter, options) => {
        readerSignal = options.signal
        if (filter.since !== undefined) return new Promise(() => {})
        return {
          events: [candidate],
          eventSourceRelayUrls: {},
          eventsVerified: true,
          relays: [{ relayUrl: RELAY, status: "success", eventCount: 129 }],
        }
      },
      readOrganizerMarkets: async () => organizerRead([market(ORGANIZER)]),
    })
    let timeout: ReturnType<typeof setTimeout>
    const result = await Promise.race([
      discoverPerspectiveEventMarkets({
        organizerPubkeys: [ORGANIZER],
        perspective: {
          source: "conduit",
          coverage: "complete",
          eventObserved: false,
          snapshotState: "curated",
          truncated: false,
        },
      }),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 200)
      }),
    ]).finally(() => clearTimeout(timeout))
    expect(result).toBeDefined()
    expect(readerSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ state: "partial", truncated: true })
    expect(result?.markets).toHaveLength(1)
    expect(result?.candidateScanCoverage).toMatchObject({
      requestCount: 2,
      executionBoundedReadCount: 1,
      partialReadCount: 1,
    })
  })

  it("counts boundary requests against the shared work limit and retains the signed page", async () => {
    const candidate = collectionEvent()
    let requests = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      candidateReadRequestLimit: 1,
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async () => {
        requests += 1
        return {
          events: [candidate],
          eventSourceRelayUrls: {},
          eventsVerified: true,
          relays: [{ relayUrl: RELAY, status: "success", eventCount: 129 }],
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
    expect(requests).toBe(1)
    expect(result).toMatchObject({ state: "partial", truncated: true })
    expect(result.markets).toHaveLength(1)
    expect(result.candidateScanCoverage).toMatchObject({
      requestCount: 1,
      mainPageCount: 1,
      boundaryPageCount: 0,
      executionBoundedReadCount: 1,
      partialReadCount: 1,
    })
  })

  for (const cancellation of ["signal", "session"] as const) {
    it(`aborts a noncooperative candidate read on ${cancellation} cancellation without hydration`, async () => {
      const controller = new AbortController()
      let active = true
      let readerSignal: AbortSignal | undefined
      let hydrationCalls = 0
      let started: () => void = () => undefined
      const readStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      __setFollowedEventMarketDiscoveryTestOverrides({
        collectionCandidateRelayUrls: [RELAY],
        fetchCollectionCandidateEvents: async (_filter, options) => {
          readerSignal = options.signal
          started()
          return new Promise(() => {})
        },
        readOrganizerMarkets: async () => {
          hydrationCalls += 1
          return organizerRead([])
        },
      })
      const read = discoverPerspectiveEventMarkets({
        organizerPubkeys: [ORGANIZER],
        signal: controller.signal,
        shouldContinue: () => active,
        perspective: {
          source: "conduit",
          coverage: "complete",
          eventObserved: false,
          snapshotState: "curated",
          truncated: false,
        },
      })
      await readStarted
      if (cancellation === "signal") controller.abort()
      else active = false
      let timeout: ReturnType<typeof setTimeout>
      const outcome = await Promise.race([
        read.then(
          () => "resolved",
          (error: unknown) => error
        ),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), 200)
        }),
      ]).finally(() => clearTimeout(timeout))
      expect(outcome).toMatchObject({ name: "AbortError" })
      expect(readerSignal?.aborted).toBe(true)
      expect(hydrationCalls).toBe(0)
    })
  }

  it("aborts sibling candidate readers when one observes a revoked session before the poll", async () => {
    let active = true
    let siblingStarted: () => void = () => undefined
    const sibling = new Promise<void>((resolve) => {
      siblingStarted = resolve
    })
    const signals: AbortSignal[] = []
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY, RETAINED_RELAY],
      fetchCollectionCandidateEvents: async (_filter, options) => {
        signals.push(options.signal!)
        if (options.relayUrls[0] === RELAY) {
          await sibling
          active = false
          return {
            events: [],
            eventSourceRelayUrls: {},
            eventsVerified: true,
            relays: [{ relayUrl: RELAY, status: "success", eventCount: 0 }],
          }
        }
        siblingStarted()
        return new Promise(() => {})
      },
    })
    await expect(
      discoverPerspectiveEventMarkets({
        organizerPubkeys: [ORGANIZER],
        shouldContinue: () => active,
        perspective: {
          source: "conduit",
          coverage: "complete",
          eventObserved: false,
          snapshotState: "curated",
          truncated: false,
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
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

  it("carries only explicit owner relay transport authority into candidate reads", async () => {
    const ownerRelay = "ws://127.0.0.1:4888"
    const disabledRelay = "ws://127.0.0.1:4889"
    const readRelays: string[] = []
    __setFollowedEventMarketDiscoveryTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async (account) => {
        expect(account).toBe(MERCHANT)
        return {
          settings: {
            version: 1,
            updatedAt: 1,
            entries: [ownerRelay, disabledRelay].map((url, index) => ({
              url,
              readEnabled: index === 0,
              writeEnabled: false,
              section: "commerce" as const,
              capabilities: {
                nip11: false,
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
            })),
          },
          signedRelayListAuthoritative: true,
        }
      },
      fetchCollectionCandidateEvents: async (_filter, options) => {
        readRelays.push(...options.relayUrls)
        expect(options.ownerSelectedRelayUrls).toEqual([ownerRelay])
        expect(options.authenticatedPubkey).toBe(MERCHANT)
        return {
          events: [],
          eventSourceRelayUrls: {},
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
          eventsVerified: true,
        }
      },
    })
    await discoverPerspectiveEventMarkets({
      organizerPubkeys: [ORGANIZER],
      authenticatedPubkey: MERCHANT,
      perspective: {
        source: "conduit",
        coverage: "complete",
        eventObserved: false,
        snapshotState: "curated",
        truncated: false,
      },
    })
    expect(readRelays).toContain(ownerRelay)
    expect(readRelays).not.toContain(disabledRelay)
  })

  it("stops after account authority changes during a candidate page", async () => {
    let active = true
    let calls = 0
    let hydrationCalls = 0
    const events = Array.from({ length: 129 }, (_, index) =>
      collectionEvent({ dTag: `cancel-${index}`, createdAt: 1000 - index })
    )
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY],
      fetchCollectionCandidateEvents: async () => {
        calls += 1
        active = false
        return {
          events,
          eventSourceRelayUrls: {},
          relays: [
            { relayUrl: RELAY, status: "success", eventCount: events.length },
          ],
          eventsVerified: true,
        }
      },
      readOrganizerMarkets: async () => {
        hydrationCalls += 1
        return organizerRead([])
      },
    })
    await expect(
      discoverPerspectiveEventMarkets({
        organizerPubkeys: [ORGANIZER],
        shouldContinue: () => active,
        perspective: {
          source: "conduit",
          coverage: "complete",
          eventObserved: false,
          snapshotState: "curated",
          truncated: false,
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(1)
    expect(hydrationCalls).toBe(0)
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
    const controller = new AbortController()
    const shouldContinue = () => true
    const repository = { get: async () => null }
    let candidateEventCount = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      collectionCandidateRelayUrls: [RELAY],
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: { version: 1, updatedAt: 1, entries: [] },
        signedRelayListAuthoritative: true,
      }),
      fetchCollectionCandidateEvents: async (filter, options) => {
        expect(options.authenticatedPubkey).toBe(MERCHANT)
        expect(options.accountPubkey).toBe(MERCHANT)
        expect(options.signal).toBeInstanceOf(AbortSignal)
        expect(options.signal?.aborted).toBe(false)
        expect(options.shouldContinue).toBe(shouldContinue)
        expect(options.accountNetworkLocalStateRepository).toBe(repository)
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
        expect(input.authenticatedPubkey).toBe(MERCHANT)
        expect(input.shouldContinue).toBe(shouldContinue)
        expect(input.accountNetworkLocalStateRepository).toBe(repository)
        candidateEventCount = input.candidateCollectionEvents?.length ?? 0
        return organizerRead([market(ORGANIZER, "older")])
      },
    })

    const result = await discoverPerspectiveEventMarkets({
      organizerPubkeys: [ORGANIZER],
      authenticatedPubkey: MERCHANT,
      signal: controller.signal,
      shouldContinue,
      accountNetworkLocalStateRepository: repository,
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
