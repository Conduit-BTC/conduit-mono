import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetEventMarketTestOverrides,
  __resetFollowedEventMarketDiscoveryTestOverrides,
  __setEventMarketTestOverrides,
  __setFollowedEventMarketDiscoveryTestOverrides,
  discoverFollowedOrganizerEventMarkets,
  EventMarketDiscoveryBoundError,
  FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT,
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
const ORGANIZER = "b".repeat(64)
const OTHER_ORGANIZER = "c".repeat(64)
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

describe("followed organizer event-market discovery", () => {
  it("returns a current market from a followed organizer", async () => {
    const organizerInputs: string[] = []
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () =>
        followRead({ pubkeys: [ORGANIZER], eventObserved: true }),
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

  it("rejects ended, deleted, malformed, conflicting, and unfollowed candidates", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
      readOrganizerMarkets: async () =>
        organizerRead({
          markets: [
            market(ORGANIZER, "ended", "ended"),
            market(ORGANIZER, "deleted", "deleted"),
            market(ORGANIZER, "malformed", "malformed"),
            market(ORGANIZER, "conflicting", "conflicting"),
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

  it("preserves stale and partial positive graphs as a truthful partial view", async () => {
    for (const state of ["stale", "partial"] as const) {
      __resetFollowedEventMarketDiscoveryTestOverrides()
      __setFollowedEventMarketDiscoveryTestOverrides({
        readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
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

  it("sorts and bounds followed authors with bounded concurrency", async () => {
    const pubkeys = Array.from({ length: 20 }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0")
    )
    const observed: string[] = []
    let active = 0
    let maxActive = 0
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () =>
        followRead({ pubkeys: [...pubkeys].reverse() }),
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

    expect(observed).toEqual(
      [...pubkeys].sort().slice(0, FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT)
    )
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(result.searchedOrganizerCount).toBe(
      FOLLOWED_EVENT_MARKET_ORGANIZER_LIMIT
    )
    expect(result.truncated).toBe(true)
    expect(result.state).toBe("partial")
  })

  it("reports a bounded organizer frontier as partial and truncated", async () => {
    __setFollowedEventMarketDiscoveryTestOverrides({
      readFollowLists: async () => followRead({ pubkeys: [ORGANIZER] }),
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
})
