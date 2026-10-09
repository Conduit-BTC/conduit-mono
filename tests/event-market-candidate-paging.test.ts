import { describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  buildEventMarketRosterDraft,
  discoverFutureEventMarkets,
  getEventMarketReadPlan,
} from "@conduit/core"
import {
  scanEventMarketCandidates,
  type EventMarketDiscoveryContinuation,
} from "../packages/core/src/protocol/event-market-candidates"
import {
  fetchSignedEventsFanoutDetailed,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import {
  deferred,
  until,
  fixture,
} from "./helpers/future-market-discovery-fixture"

describe("event candidate discovery paging", () => {
  it.each([0, 2])(
    "bounds distinct admitted discovery relays across pages and continuation with %i suppressed candidates",
    async (suppressedCount) => {
      const state = fixture(1)
      const relays = Array.from(
        { length: 10 },
        (_, index) => `wss://bounded-${index}.relay.dev`
      )
      const plan = {
        ...(await state.dependencies.planDiscovery!({})),
        relayUrls: relays,
        candidateRelayUrls: relays,
        maxRelayAttempts: 8,
      }
      const contacted = new Set<string>()
      let suppress = true
      const input = {
        authors: Array.from({ length: 1_025 }, (_, index) =>
          index.toString(16).padStart(64, "0")
        ),
        plan,
        options: {},
        fetch: async (_filter: unknown, options: { relayUrls?: string[] }) => {
          const relayUrl = options.relayUrls![0]!
          if (suppress && relays.indexOf(relayUrl) < suppressedCount)
            return { events: [], relays: [], admittedRelayUrls: [] }
          contacted.add(relayUrl)
          return {
            events: [],
            relays: [{ relayUrl, status: "success" as const }],
            admittedRelayUrls: [relayUrl],
          }
        },
        observe: async () => {},
        assertCurrent: () => {},
      }
      const first = await scanEventMarketCandidates(input)
      const selected = relays.slice(suppressedCount, suppressedCount + 8)
      expect([...contacted].sort()).toEqual([...selected].sort())
      expect(first.pages.length).toBeGreaterThan(0)
      suppress = false
      const continuation = JSON.parse(
        JSON.stringify({ ...first, pendingCoordinates: [] })
      ) as EventMarketDiscoveryContinuation
      const next = await scanEventMarketCandidates({ ...input, continuation })
      expect([...contacted].sort()).toEqual([...selected].sort())
      expect(next.pages).toEqual([])
      expect(next.incomplete).toBe(false)
    }
  )

  it("backfills only live-policy-admitted sources through the real public reader", async () => {
    const state = fixture(1)
    const relays = Array.from(
      { length: 12 },
      (_, index) => `wss://admission-${index}.relay.dev`
    )
    const owner = "a".repeat(64)
    const contacted = new Set<string>()
    const targets = relayTargetsFromUrls(relays.slice(2), {
      kind: "public_hint",
      operation: "read",
    })
    const scan = await scanEventMarketCandidates({
      authors: [state.records[0]!.author],
      accountPubkey: owner,
      plan: {
        ...(await state.dependencies.planDiscovery!({})),
        relayUrls: relays,
        candidateRelayUrls: relays,
        relayTargets: targets,
        maxRelayAttempts: 8,
      },
      options: {
        accountPubkey: owner,
        authenticatedPubkey: owner,
        relayTargets: targets,
        accountNetworkLocalStateRepository: {
          get: async () => emptyAccountNetworkLocalState(owner),
        },
        reuseRelayConnections: false,
        skipHealthFilter: true,
        socketScope: {
          createWebSocket: (url) => {
            contacted.add(url)
            const socket: PublicRelayReadSocket = {
              readyState: 0,
              onopen: null,
              onmessage: null,
              onclose: null,
              onerror: null,
              send: (payload) => {
                const [type, id] = JSON.parse(payload)
                if (type === "REQ")
                  queueMicrotask(() =>
                    socket.onmessage?.({
                      data: JSON.stringify(["EOSE", id]),
                    } as MessageEvent<string>)
                  )
              },
              close: () => {
                socket.readyState = 3
              },
            }
            queueMicrotask(() => {
              socket.readyState = 1
              socket.onopen?.(new Event("open"))
            })
            return socket
          },
        },
      },
      fetch: fetchSignedEventsFanoutDetailed,
      observe: async () => {},
      assertCurrent: () => {},
    })
    expect([...contacted].sort()).toEqual(relays.slice(2, 10).sort())
    expect(scan.admittedRelayUrls.sort()).toEqual([...contacted].sort())
    expect(scan.incomplete).toBe(false)
  })

  it("refreshes completed exact hydration when a duplicate gains a delayed source", async () => {
    const state = fixture(1)
    const record = state.records[0]!
    const relays = ["wss://first.relay.dev", "wss://delayed.relay.dev"]
    const delayed = deferred<void>()
    const progress: Array<boolean> = []
    const basePlan = await state.dependencies.planDiscovery!({})
    state.dependencies.planDiscovery = async () => ({
      ...basePlan,
      relayUrls: relays,
      candidateRelayUrls: relays,
      maxRelayAttempts: 2,
    })
    state.dependencies.plan = async (input) => ({
      ...basePlan,
      relayUrls: input.relayHints?.length
        ? [...input.relayHints]
        : [relays[0]!],
      candidateRelayUrls: input.relayHints?.length
        ? [...input.relayHints]
        : [relays[0]!],
    })
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const sources = options.relayUrls ?? []
      if (filter.kinds?.includes(30409) && !filter["#d"]) {
        if (sources.includes(relays[1]!)) await delayed.promise
        return {
          events: [record.roster],
          relays: sources.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
          })),
        }
      }
      const result = await fetch(filter, options)
      return {
        events: result.events.filter(
          (event) => event.kind !== 31923 || sources.includes(relays[1]!)
        ),
        relays: sources.map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
        })),
      }
    }
    const result = discoverFutureEventMarkets(
      {
        onProgress: (value) =>
          progress.push(Boolean(value.markets[0]?.calendar)),
      },
      state.dependencies
    )
    try {
      await until(() => progress.length > 0)
      expect(progress).toEqual([false])
    } finally {
      delayed.resolve()
    }
    const final = await result
    expect(final.markets[0]?.calendar?.eventId).toBe(record.calendar.id)
    expect(final.markets[0]?.observedRelayUrls).toContain(relays[1]!)
    expect(final.coverage).toBe("complete")
  })

  it("hydrates continued coordinates from their observed source beyond the exact relay prefix", async () => {
    const state = fixture(1)
    const record = state.records[0]!
    const relays = Array.from(
      { length: 10 },
      (_, index) => `wss://discovery-${index}.relay.dev`
    )
    const source = relays[9]!
    const rosters = Array.from({ length: 129 }, (_, index) =>
      finalizeEvent(
        {
          ...buildEventMarketRosterDraft({
            organizerPubkey: record.author,
            dTag: `continued-${index}`,
            calendarCoordinate: `31923:${record.author}:date-0`,
            state: "open",
            merchants: [],
          }),
          created_at: 100,
        },
        record.secret
      )
    )
    state.live.splice(0, state.live.length, ...rosters, record.calendar)
    const basePlan = await state.dependencies.planDiscovery!({})
    state.dependencies.planDiscovery = async () => ({
      ...basePlan,
      relayUrls: relays,
      candidateRelayUrls: relays,
      maxRelayAttempts: 8,
    })
    state.dependencies.plan = getEventMarketReadPlan
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const attempted = (options.relayUrls ?? [])
        .filter((relayUrl) => !relays.slice(0, 2).includes(relayUrl))
        .slice(0, options.maxRelayAttempts ?? Infinity)
      const result = attempted.includes(source)
        ? await fetch(filter, options)
        : { events: [] }
      return {
        events: result.events,
        admittedRelayUrls: attempted,
        relays: attempted.map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
        })),
      }
    }
    __setEventMarketTestOverrides({ getRelayLists: async () => new Map() })
    try {
      // Replacing observed provenance with the full discovery plan buries the
      // actual source behind the planner's eight-relay attempt bound.
      const widened = await getEventMarketReadPlan({
        organizerPubkey: record.author,
        relayHints: relays,
      })
      expect(
        widened.candidateRelayUrls
          .filter((relayUrl) => !relays.slice(0, 2).includes(relayUrl))
          .slice(0, widened.maxRelayAttempts)
      ).not.toContain(source)
      const first = await discoverFutureEventMarkets({}, state.dependencies)
      expect(first.markets).toHaveLength(128)
      expect(first.continuation?.pendingCoordinates).toHaveLength(1)
      expect(first.markets.every((read) => read.calendar)).toBe(true)
      // Round-trip the state just as a retained query continuation would.
      const serialized = JSON.stringify(first.continuation)
      const continuation = JSON.parse(
        serialized
      ) as EventMarketDiscoveryContinuation
      const next = await discoverFutureEventMarkets(
        { continuation },
        state.dependencies
      )
      expect(next.markets).toHaveLength(1)
      expect(next.markets[0]?.resolution.state).toBe("current")
      expect(next.markets[0]?.calendar?.eventId).toBe(record.calendar.id)
      expect(next.markets[0]?.observedRelayUrls).toContain(source)
      expect(next.continuation).toBeUndefined()
      const switched = await discoverFutureEventMarkets(
        { organizerPubkeys: [], continuation },
        state.dependencies
      )
      expect(switched.markets).toEqual([])
    } finally {
      __resetEventMarketTestOverrides()
    }
  }, 20_000)

  it("opens public discovery while keeping an empty Following audience empty", async () => {
    const state = fixture()
    const { discoverFutureEventMarkets } = await import("@conduit/core")
    const publicResult = await discoverFutureEventMarkets(
      {},
      state.dependencies
    )
    expect(publicResult.markets).toHaveLength(2)
    expect(publicResult.coverage).toBe("complete")
    const following = await discoverFutureEventMarkets(
      { organizerPubkeys: [] },
      state.dependencies
    )
    expect(following.markets).toEqual([])
    expect(following.coverage).toBe("complete")
  })

  it("reads older records after exhausting a shared timestamp without skipping ties", async () => {
    const state = fixture(1)
    const record = state.records[0]!
    state.live.splice(
      0,
      state.live.length,
      ...Array.from({ length: 140 }, (_, index) =>
        finalizeEvent(
          {
            kind: 30409,
            created_at: index < 135 ? 100 : 99,
            tags: [["d", `fair-${index}`]],
            content: "",
          },
          record.secret
        )
      )
    )
    const seen = new Set<string>()
    const filters: Array<{ since?: number; until?: number }> = []
    const scan = await scanEventMarketCandidates({
      authors: [record.author],
      plan: await state.dependencies.planDiscovery!({}),
      options: {},
      fetch: (filter, options) => {
        filters.push(filter)
        return state.dependencies.fetch(filter, options)
      },
      observe: async (events) => {
        events.forEach((event) => seen.add(event.id))
      },
      assertCurrent: () => {},
    })
    expect(seen.size).toBe(140)
    expect(filters).toContainEqual(
      expect.objectContaining({ since: 100, until: 100 })
    )
    expect(filters).toContainEqual(expect.objectContaining({ until: 99 }))
    expect(scan.pages).toEqual([])
    expect(scan.incomplete).toBe(false)
  })

  it("continues remaining author batches after the request budget and fences the audience", async () => {
    const state = fixture(1)
    const plan = await state.dependencies.planDiscovery!({})
    const authors = Array.from({ length: 8_193 }, (_, index) =>
      index.toString(16).padStart(64, "0")
    )
    let calls = 0
    const input = {
      authors,
      plan,
      options: {},
      fetch: async () => {
        calls++
        return {
          events: [],
          relays: [
            { relayUrl: plan.relayUrls[0]!, status: "success" as const },
          ],
        }
      },
      observe: async () => {},
      assertCurrent: () => {},
    }
    const first = await scanEventMarketCandidates(input)
    expect(calls).toBe(128)
    expect(first.pages).toHaveLength(1)
    const continuation = {
      scope: first.scope,
      pages: first.pages,
      pendingCoordinates: [],
    }
    const second = await scanEventMarketCandidates({ ...input, continuation })
    expect(calls).toBe(129)
    expect(second.pages).toEqual([])
    const switched = await scanEventMarketCandidates({
      ...input,
      authors: [],
      continuation,
    })
    expect(calls).toBe(129)
    expect(switched.pages).toEqual([])
  })

  it("retains failed pages and rejects malformed records while healthy relays keep painting", async () => {
    const state = fixture(1)
    const plan = await state.dependencies.planDiscovery!({})
    plan.relayUrls.push("wss://optional.example")
    const seen = new Set<string>()
    const scan = await scanEventMarketCandidates({
      plan,
      options: {},
      fetch: async (filter, options) =>
        options.relayUrls?.[0] === "wss://optional.example"
          ? {
              events: [{ ...state.records[0]!.roster, sig: "0".repeat(128) }],
              relays: [
                { relayUrl: "wss://optional.example", status: "partial" },
              ],
            }
          : state.dependencies.fetch(filter, options),
      observe: async (events) => {
        events.forEach((event) => seen.add(event.id))
      },
      assertCurrent: () => {},
    })
    expect(seen.size).toBe(1)
    expect(scan.available).toBe(true)
    expect(scan.incomplete).toBe(true)
    expect(scan.pages.map((page) => page.relayUrl)).toEqual([
      "wss://optional.example",
    ])
  })
})
