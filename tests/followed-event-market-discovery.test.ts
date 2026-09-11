import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import {
  __resetEventMarketTestOverrides,
  __resetFollowedEventMarketDiscoveryTestOverrides,
  __setEventMarketTestOverrides,
  __setFollowedEventMarketDiscoveryTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  discoverFollowedOrganizerEventMarkets,
  EVENT_KINDS,
  EventMarketDiscoveryBoundError,
  getOrganizerEventMarketsDetailed,
  type EventMarketRelayCoverage,
  type EventMarketResolution,
  type FollowListCoverageState,
  type FollowListReadResult,
  type OrganizerEventMarketsReadResult,
  type RelayListResolutionState,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const MERCHANT = "a".repeat(64)
const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const OTHER_ORGANIZER_SECRET = generateSecretKey()
const OTHER_ORGANIZER = getPublicKey(OTHER_ORGANIZER_SECRET)
const RELAY = "wss://event-discovery.test"
const COMPLETE_COVERAGE: EventMarketRelayCoverage = {
  attemptedRelayCount: 1,
  completeRelayCount: 1,
  partialRelayCount: 0,
  failedRelayCount: 0,
}

function followEvent(pubkeys: readonly string[]): SignedPublicNostrEvent {
  return {
    id: "d".repeat(64),
    pubkey: MERCHANT,
    created_at: 1_800_000_000,
    kind: 3,
    tags: pubkeys.map((pubkey) => ["p", pubkey]),
    content: "",
    sig: "e".repeat(128),
  }
}

function followRead(input: {
  pubkeys?: readonly string[]
  coverage?: FollowListCoverageState
  eventObserved?: boolean
  capped?: boolean
}): FollowListReadResult {
  const event =
    input.eventObserved === false ? undefined : followEvent(input.pubkeys ?? [])
  const coverage = input.coverage ?? "complete"
  return {
    events: event ? [event] : [],
    authors: [
      {
        pubkey: MERCHANT,
        ...(event ? { event } : {}),
        eventSourceRelayUrls: event ? [RELAY] : [],
        plannedRelayUrls: [RELAY],
        relays: [
          {
            relayUrl: RELAY,
            status:
              coverage === "complete"
                ? "success"
                : coverage === "limited"
                  ? "partial"
                  : "failed",
            eventCount: event ? 1 : 0,
          },
        ],
        eventsVerified: true,
        coverage,
        relayListState: "network",
        relayHintTruncated: false,
        capped: input.capped ?? false,
        snapshotState: event ? "network" : "none",
      },
    ],
    plannedRelayUrls: [RELAY],
    relays: [],
    eventsVerified: true,
  }
}

function collectionCandidate(
  secret = ORGANIZER_SECRET,
  suffix = "catalog"
): SignedPublicNostrEvent {
  const organizerPubkey = getPublicKey(secret)
  return finalizeEvent(
    {
      kind: 30405,
      created_at: 1_800_000_000,
      tags: [
        ["d", suffix],
        ["title", `Event ${suffix}`],
        ["a", `31923:${organizerPubkey}:${suffix}`],
      ],
      content: "",
    },
    secret
  )
}

function candidateRead(
  events: SignedPublicNostrEvent[],
  input: {
    relayStatus?: "success" | "partial" | "failed"
    eventsVerified?: boolean
    capped?: boolean
  } = {}
) {
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
  state: EventMarketResolution["state"] = "active",
  suffix = "catalog"
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

function marketWithCalendarEnd(
  organizerPubkey: string,
  state: EventMarketResolution["state"],
  suffix: string,
  end: number
): EventMarketResolution {
  const resolution = market(organizerPubkey, state, suffix)
  const calendarCoordinate = `31923:${organizerPubkey}:${suffix}`
  return {
    ...resolution,
    calendarCoordinate,
    calendar: {
      coordinate: calendarCoordinate,
      eventId: (suffix === "ended" ? "1" : "2").repeat(64),
      authorPubkey: organizerPubkey,
      dTag: suffix,
      kind: 31923,
      title: `Event ${suffix}`,
      content: "",
      locations: [],
      start: end - 3_600_000,
      end,
      createdAt: 1_800_000_000,
    },
  }
}

function organizerRead(
  input: {
    markets?: EventMarketResolution[]
    state?: OrganizerEventMarketsReadResult["state"]
  } = {}
): OrganizerEventMarketsReadResult {
  return {
    markets: input.markets ?? [],
    state: input.state ?? "complete",
    coverage: COMPLETE_COVERAGE,
    relayListState: "network",
    relayHintTruncated: false,
  }
}

afterEach(() => {
  __resetFollowedEventMarketDiscoveryTestOverrides()
  __resetEventMarketTestOverrides()
})

beforeEach(() => {
  __setEventMarketTestOverrides({
    loadCachedEvidence: async () => [],
    loadCachedCollectionEvidence: async () => [],
  })
})

describe("followed organizer event-market discovery", () => {
  it("never synthesizes the viewed merchant as the authenticated account", async () => {
    const viewer = "d".repeat(64)
    const followAccounts: Array<string | null | undefined> = []
    const organizerAccounts: Array<string | null | undefined> = []
    __setFollowedEventMarketDiscoveryTestOverrides({
      readCollectionCandidates: async () =>
        candidateRead([collectionCandidate()]),
      readFollowLists: async (query) => {
        followAccounts.push(query.authenticatedPubkey)
        return followRead({ pubkeys: [ORGANIZER] })
      },
      readOrganizerMarkets: async (input) => {
        organizerAccounts.push(input.authenticatedPubkey)
        return organizerRead()
      },
    })

    await discoverFollowedOrganizerEventMarkets({ merchantPubkey: MERCHANT })
    await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
      authenticatedPubkey: viewer,
    })

    expect(followAccounts).toEqual([undefined, viewer])
    expect(organizerAccounts).toEqual([undefined, viewer])
    expect(followAccounts).not.toContain(MERCHANT)
    expect(organizerAccounts).not.toContain(MERCHANT)
  })

  it("returns a current market from a followed organizer", async () => {
    const organizerInputs: string[] = []
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () =>
        followRead({ pubkeys: [ORGANIZER], eventObserved: true }),
      readCollectionCandidates: async () =>
        candidateRead([collectionCandidate()]),
      readOrganizerMarkets: async (input) => {
        organizerInputs.push(input.organizerPubkey)
        expect(input.projection).toBe("discovery")
        return organizerRead({ markets: [market(ORGANIZER)] })
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
      nowMs: 1_800_000_000_000,
    })

    expect(result.state).toBe("complete")
    expect(result.markets.map((item) => item.reference)).toEqual([
      `30405:${ORGANIZER}:catalog`,
    ])
    expect(organizerInputs).toEqual([ORGANIZER])
  })

  it("distinguishes a complete empty follow view from partial and unavailable reads", async () => {
    const scenarios = [
      {
        coverage: "complete" as const,
        eventObserved: true,
        organizerState: "complete" as const,
        expected: "complete_empty" as const,
      },
      {
        coverage: "limited" as const,
        eventObserved: true,
        organizerState: "complete" as const,
        expected: "partial" as const,
      },
      {
        coverage: "unavailable" as const,
        eventObserved: false,
        organizerState: "complete" as const,
        expected: "unavailable" as const,
      },
      {
        coverage: "complete" as const,
        eventObserved: true,
        organizerState: "partial" as const,
        expected: "partial" as const,
      },
      {
        coverage: "complete" as const,
        eventObserved: true,
        organizerState: "unavailable" as const,
        expected: "unavailable" as const,
      },
    ]

    for (const scenario of scenarios) {
      __resetFollowedEventMarketDiscoveryTestOverrides()
      __setFollowedEventMarketDiscoveryTestOverrides({
        readFollowLists: async () =>
          followRead({
            pubkeys: [ORGANIZER],
            coverage: scenario.coverage,
            eventObserved: scenario.eventObserved,
          }),
        readCollectionCandidates: async () =>
          candidateRead(scenario.eventObserved ? [collectionCandidate()] : [], {
            relayStatus:
              scenario.organizerState === "unavailable"
                ? "failed"
                : scenario.organizerState === "partial"
                  ? "partial"
                  : "success",
          }),
        readOrganizerMarkets: async () =>
          organizerRead({ state: scenario.organizerState }),
      })

      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
      })
      expect(result.state).toBe(scenario.expected)
      expect(result.markets).toEqual([])
      expect(result.followListEventObserved).toBe(scenario.eventObserved)
    }
  })

  it("preserves the distinction between a signed empty follow list and no observed list", async () => {
    for (const eventObserved of [true, false]) {
      __resetFollowedEventMarketDiscoveryTestOverrides()
      __setFollowedEventMarketDiscoveryTestOverrides({
        readFollowLists: async () =>
          followRead({ pubkeys: [], eventObserved, coverage: "complete" }),
      })

      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
      })

      expect(result.state).toBe("complete_empty")
      expect(result.followListEventObserved).toBe(eventObserved)
      expect(result.searchedOrganizerCount).toBe(0)
    }
  })

  it("keeps discovered events visible when another followed-organizer read is unavailable", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () =>
        followRead({ pubkeys: [ORGANIZER, OTHER_ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([
          collectionCandidate(),
          collectionCandidate(OTHER_ORGANIZER_SECRET),
        ]),
      readOrganizerMarkets: async (input) =>
        input.organizerPubkey === ORGANIZER
          ? organizerRead({ markets: [market(ORGANIZER)] })
          : organizerRead({ state: "unavailable" }),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.failedOrganizerCount).toBe(1)
    expect(result.markets.map((item) => item.reference)).toEqual([
      `30405:${ORGANIZER}:catalog`,
    ])
  })

  it("marks an active market partial when its organizer read is incomplete", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([collectionCandidate()]),
      readOrganizerMarkets: async () =>
        organizerRead({
          markets: [market(ORGANIZER)],
          state: "partial",
        }),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.markets).toHaveLength(1)
  })

  it("treats ended, deleted, and unfollowed candidates as absent", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([
          collectionCandidate(ORGANIZER_SECRET, "ended"),
          collectionCandidate(ORGANIZER_SECRET, "deleted"),
          collectionCandidate(OTHER_ORGANIZER_SECRET, "unfollowed"),
        ]),
      readOrganizerMarkets: async () =>
        organizerRead({
          markets: [
            market(ORGANIZER, "ended", "ended"),
            market(ORGANIZER, "deleted", "deleted"),
            market(OTHER_ORGANIZER, "active", "unfollowed"),
          ],
        }),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("complete_empty")
    expect(result.markets).toEqual([])
  })

  it("reports unusable followed-organizer evidence as degraded", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([
          collectionCandidate(ORGANIZER_SECRET, "malformed"),
          collectionCandidate(ORGANIZER_SECRET, "conflicting"),
          collectionCandidate(ORGANIZER_SECRET, "unsupported"),
        ]),
      readOrganizerMarkets: async () =>
        organizerRead({
          markets: [
            market(ORGANIZER, "malformed", "malformed"),
            market(ORGANIZER, "conflicting", "conflicting"),
            market(ORGANIZER, "unsupported", "unsupported"),
          ],
        }),
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result.state).toBe("partial")
    expect(result.markets).toEqual([])
  })

  it("preserves stale and partial positive graphs as a truthful partial view", async () => {
    for (const state of ["stale", "partial"] as const) {
      __resetFollowedEventMarketDiscoveryTestOverrides()
      __setFollowedEventMarketDiscoveryTestOverrides({
        readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
        readCollectionCandidates: async () =>
          candidateRead([collectionCandidate()]),
        readOrganizerMarkets: async () =>
          organizerRead({ markets: [market(ORGANIZER, state)] }),
      })

      const result = await discoverFollowedOrganizerEventMarkets({
        merchantPubkey: MERCHANT,
      })
      expect(result.state).toBe("partial")
      expect(result.markets).toHaveLength(1)
      expect(result.markets[0]?.state).toBe(state)
    }
  })

  it("omits ended stale graphs while preserving future stale graphs", async () => {
    const nowMs = 1_800_000_000_000
    const future = marketWithCalendarEnd(
      ORGANIZER,
      "stale",
      "future",
      nowMs + 60_000
    )
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([
          collectionCandidate(ORGANIZER_SECRET, "ended"),
          collectionCandidate(ORGANIZER_SECRET, "future"),
        ]),
      readOrganizerMarkets: async (input) => {
        expect(input.nowMs).toBe(nowMs)
        return {
          ...organizerRead({
            markets: [
              marketWithCalendarEnd(ORGANIZER, "stale", "ended", nowMs),
              future,
            ],
            state: "unavailable",
          }),
          coverage: {
            attemptedRelayCount: 1,
            completeRelayCount: 0,
            partialRelayCount: 0,
            failedRelayCount: 1,
          },
        }
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
      nowMs,
    })

    expect(result.state).toBe("partial")
    expect(result.markets.map((item) => item.reference)).toEqual([
      future.reference,
    ])
  })

  it("bounds candidate validation concurrency without truncating the follow list", async () => {
    const secrets = Array.from({ length: 8 }, () => generateSecretKey())
    const pubkeys = secrets.map(getPublicKey)
    const observed: string[] = []
    let active = 0
    let maxActive = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () =>
        followRead({ pubkeys: [...pubkeys].reverse() }),
      readCollectionCandidates: async () =>
        candidateRead(secrets.map((secret) => collectionCandidate(secret))),
      readOrganizerMarkets: async (input) => {
        observed.push(input.organizerPubkey)
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return organizerRead()
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(observed).toEqual([...pubkeys].sort())
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(result.searchedOrganizerCount).toBe(pubkeys.length)
    expect(result.truncated).toBe(false)
    expect(result.state).toBe("complete_empty")
  })

  it("reports a bounded organizer frontier as partial and truncated", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([collectionCandidate()]),
      readOrganizerMarkets: async () => {
        throw new EventMarketDiscoveryBoundError("bounded")
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result).toMatchObject({
      state: "partial",
      truncated: true,
      boundedOrganizerCount: 1,
      failedOrganizerCount: 0,
    })
  })

  it("returns accumulated events as partial when the organizer phase reaches its deadline", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      organizerReadDeadlineMs: 5,
      readFollowLists: async () =>
        followRead({ pubkeys: [ORGANIZER, OTHER_ORGANIZER] }),
      readCollectionCandidates: async () =>
        candidateRead([
          collectionCandidate(),
          collectionCandidate(OTHER_ORGANIZER_SECRET),
        ]),
      readOrganizerMarkets: async (input) => {
        if (input.organizerPubkey === ORGANIZER) {
          return organizerRead({ markets: [market(ORGANIZER)] })
        }
        return await new Promise<OrganizerEventMarketsReadResult>(
          (_resolve, reject) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted")
                error.name = "AbortError"
                reject(error)
              },
              { once: true }
            )
          }
        )
      },
    })

    const result = await discoverFollowedOrganizerEventMarkets({
      merchantPubkey: MERCHANT,
    })

    expect(result).toMatchObject({
      state: "partial",
      searchedOrganizerCount: 2,
      boundedOrganizerCount: 1,
      failedOrganizerCount: 0,
      truncated: true,
    })
    expect(result.markets.map((item) => item.reference)).toEqual([
      `30405:${ORGANIZER}:catalog`,
    ])
  })
})

describe("organizer event-market read coverage", () => {
  function configureRead(input: {
    relayListState: RelayListResolutionState
    relayUrls?: string[]
    relayStatus?: "success" | "partial" | "failed"
  }): void {
    const relayUrls = input.relayUrls ?? []
    __setEventMarketTestOverrides({
      getRelayListsDetailed: async (pubkeys) => ({
        relayLists: new Map(
          relayUrls.length > 0
            ? pubkeys.map((pubkey) => [
                pubkey,
                {
                  pubkey,
                  readRelayUrls: [...relayUrls],
                  writeRelayUrls: [...relayUrls],
                  eventCreatedAt: 1,
                  cachedAt: 1,
                },
              ])
            : []
        ),
        resolutionStates: new Map(
          pubkeys.map((pubkey) => [pubkey, input.relayListState])
        ),
      }),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (_filter, options) => ({
        events: [],
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: input.relayStatus ?? "success",
          eventCount: 0,
        })),
        eventsVerified: true,
      }),
    })
  }

  it("does not certify empty fallback reads after incomplete relay-list discovery", async () => {
    for (const relayListState of [
      "partial-network",
      "stale-cache",
      "lookup-unavailable",
    ] as const) {
      __resetEventMarketTestOverrides()
      configureRead({ relayListState })
      const result = await getOrganizerEventMarketsDetailed({
        organizerPubkey: ORGANIZER,
        projection: "discovery",
      })
      expect(result.markets).toEqual([])
      expect(result.state).toBe("partial")
      expect(result.relayListState).toBe(relayListState)
    }
  })

  it("distinguishes a complete empty read from unavailable transport", async () => {
    configureRead({ relayListState: "missing" })
    await expect(
      getOrganizerEventMarketsDetailed({
        organizerPubkey: ORGANIZER,
        projection: "discovery",
      })
    ).resolves.toMatchObject({ markets: [], state: "complete" })

    __resetEventMarketTestOverrides()
    configureRead({ relayListState: "missing", relayStatus: "failed" })
    await expect(
      getOrganizerEventMarketsDetailed({
        organizerPubkey: ORGANIZER,
        projection: "discovery",
      })
    ).resolves.toMatchObject({ markets: [], state: "unavailable" })
  })

  it("reports a usable but partial relay read as partial", async () => {
    configureRead({ relayListState: "missing", relayStatus: "partial" })

    await expect(
      getOrganizerEventMarketsDetailed({
        organizerPubkey: ORGANIZER,
        projection: "discovery",
      })
    ).resolves.toMatchObject({ markets: [], state: "partial" })
  })

  it("reports omitted organizer relay hints as partial", async () => {
    const relayUrls = Array.from(
      { length: 12 },
      (_, index) => `wss://relay.damus.io/conduit-discovery-${index}`
    )
    configureRead({ relayListState: "network", relayUrls })

    const result = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      projection: "discovery",
    })

    expect(result.markets).toEqual([])
    expect(result.relayHintTruncated).toBe(true)
    expect(result.state).toBe("partial")
  })

  it("keeps organizer write relays ahead of candidate source hints", async () => {
    const organizerRelayUrls = Array.from(
      { length: 3 },
      (_, index) => `wss://relay.damus.io/organizer-${index}`
    )
    const candidateRelayUrls = Array.from(
      { length: 6 },
      (_, index) => `wss://relay.damus.io/candidate-${index}`
    )
    const calendarCoordinate = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER}:relay-calendar`
    const pickupCoordinate = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER}:relay-pickup`
    const calendar = finalizeEvent(
      {
        ...buildEventMarketCalendarDraft({
          kind: EVENT_KINDS.CALENDAR_TIME,
          dTag: "relay-calendar",
          title: "Relay-priority event",
          start: 1_800_000_000,
          end: 1_800_003_600,
        }),
        created_at: 100,
      },
      ORGANIZER_SECRET
    )
    const pickup = finalizeEvent(
      {
        ...buildEventMarketPickupDraft({
          dTag: "relay-pickup",
          title: "Relay-priority pickup",
          price: 0,
          currency: "SATS",
          countries: ["US"],
          location: "Organizer booth",
        }),
        created_at: 101,
      },
      ORGANIZER_SECRET
    )
    const collection = finalizeEvent(
      {
        ...buildEventMarketCollectionDraft({
          dTag: "relay-catalog",
          title: "Relay-priority catalog",
          eventCoordinate: calendarCoordinate,
          pickupCoordinate,
        }),
        created_at: 102,
      },
      ORGANIZER_SECRET
    )
    const observedRelaySets: string[][] = []
    configureRead({ relayListState: "network", relayUrls: organizerRelayUrls })
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (_filter, options) => {
        const relayUrls = [...(options.relayUrls ?? [])]
        observedRelaySets.push(relayUrls)
        const events = relayUrls.includes(organizerRelayUrls[2]!)
          ? [collection, pickup, calendar]
          : [collection, pickup]
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    const result = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      projection: "discovery",
      relayHints: candidateRelayUrls,
      candidateCollectionEvents: [collection],
      candidateCollectionSourceRelayUrlsById: new Map([
        [collection.id, candidateRelayUrls],
      ]),
      nowMs: 1_799_000_000_000,
    })

    expect(observedRelaySets.length).toBeGreaterThan(0)
    const organizerReadRelays = observedRelaySets[0]!
    expect(organizerReadRelays.slice(0, organizerRelayUrls.length)).toEqual(
      organizerRelayUrls
    )
    expect(organizerReadRelays).toHaveLength(8)
    expect(result.relayHintTruncated).toBe(false)
    expect(result.state).toBe("complete")
    expect(result.markets).toHaveLength(1)
    expect(result.markets[0]).toMatchObject({
      reference: `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER}:relay-catalog`,
      state: "active",
    })
  })
})
