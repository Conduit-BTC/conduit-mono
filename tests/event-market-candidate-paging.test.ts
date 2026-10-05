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
import { fixture } from "./helpers/future-market-discovery-fixture"

describe("event candidate discovery paging", () => {
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
    })
    state.dependencies.plan = getEventMarketReadPlan
    const fetch = state.dependencies.fetch
    state.dependencies.fetch = async (filter, options) => {
      const attempted = (options.relayUrls ?? []).slice(
        0,
        options.maxRelayAttempts ?? Infinity
      )
      const result = attempted.includes(source)
        ? await fetch(filter, options)
        : { events: [] }
      return {
        events: result.events,
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
        widened.candidateRelayUrls.slice(0, widened.maxRelayAttempts)
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
