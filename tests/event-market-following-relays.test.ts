import { afterEach, expect, it } from "bun:test"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  discoverFutureEventMarkets,
  getEventMarketReadPlan,
} from "@conduit/core"
import { getEventMarketDiscoveryReadPlan } from "../packages/core/src/protocol/event-market"
import {
  scanEventMarketCandidates,
  type EventMarketDiscoveryContinuation,
} from "../packages/core/src/protocol/event-market-candidates"
import { fixture } from "./helpers/future-market-discovery-fixture"

afterEach(__resetEventMarketTestOverrides)

it("discovers a followed organizer only present on its advertised write relay", async () => {
  const state = fixture(1)
  const record = state.records[0]!
  const source = "wss://organizer-write.relay.dev"
  const readOnly = "wss://organizer-read.relay.dev"
  const candidateSources = new Set<string>()
  __setEventMarketTestOverrides({
    getRelayListsDetailed: async (authors) => ({
      relayLists: new Map(
        authors.map((pubkey) => [
          pubkey,
          {
            pubkey,
            writeRelayUrls: [source],
            readRelayUrls: [readOnly],
            eventCreatedAt: 100,
            cachedAt: Date.now(),
          },
        ])
      ),
      resolutionStates: new Map(authors.map((author) => [author, "network"])),
    }),
  })
  state.dependencies.planDiscovery = getEventMarketDiscoveryReadPlan
  state.dependencies.plan = getEventMarketReadPlan
  const fetch = state.dependencies.fetch
  state.dependencies.fetch = async (filter, options) => {
    const attempted = (options.relayUrls ?? []).slice(
      0,
      options.maxRelayAttempts
    )
    if (filter.kinds?.includes(30409) && !filter["#d"])
      attempted.forEach((url) => candidateSources.add(url))
    return {
      events: attempted.includes(source)
        ? (await fetch(filter, options)).events
        : [],
      admittedRelayUrls: attempted,
      relays: attempted.map((relayUrl) => ({
        relayUrl,
        status: "success" as const,
      })),
    }
  }
  const result = await discoverFutureEventMarkets(
    { organizerPubkeys: [record.author] },
    state.dependencies
  )
  expect(result.markets).toHaveLength(1)
  expect(result.markets[0]?.resolution.state).toBe("current")
  expect(result.markets[0]?.calendar?.eventId).toBe(record.calendar.id)
  expect(candidateSources.has(source)).toBe(true)
  expect(candidateSources.has(readOnly)).toBe(false)
  expect(result.markets[0]?.observedRelayUrls).toContain(source)
  expect(
    state.retained
      .get(record.coordinate)
      ?.some((e) => e.id === record.roster.id)
  ).toBe(true)
})

it("keeps author write-relay scans within the shared request and continuation budgets", async () => {
  const authors = Array.from({ length: 1_025 }, (_, index) =>
    index.toString(16).padStart(64, "0")
  )
  const sources = Array.from(
    { length: 8 },
    (_, index) => `wss://organizer-${index}.relay.dev`
  )
  let lookups = 0
  __setEventMarketTestOverrides({
    getRelayListsDetailed: async (requested) => {
      lookups++
      expect(requested).toEqual(authors)
      return {
        relayLists: new Map([
          [
            authors[0]!,
            {
              pubkey: authors[0]!,
              writeRelayUrls: sources,
              readRelayUrls: [],
              eventCreatedAt: 100,
              cachedAt: Date.now(),
            },
          ],
        ]),
        resolutionStates: new Map(
          requested.map((author) => [author, "network"])
        ),
      }
    },
  })
  const plan = await getEventMarketDiscoveryReadPlan({
    organizerPubkeys: authors,
  })
  const contacted = new Set<string>()
  let requests = 0
  const input = {
    authors,
    plan,
    options: {},
    fetch: async (_filter: unknown, options: { relayUrls?: string[] }) => {
      requests++
      const relayUrl = options.relayUrls![0]!
      contacted.add(relayUrl)
      return {
        events: [],
        admittedRelayUrls: [relayUrl],
        relays: [{ relayUrl, status: "success" as const }],
      }
    },
    observe: async () => {},
    assertCurrent: () => {},
  }
  const first = await scanEventMarketCandidates(input)
  expect(lookups).toBe(1)
  expect(requests).toBe(128)
  expect([...contacted].sort()).toEqual([...sources].sort())
  expect(first.pages.length).toBeGreaterThan(0)
  const continuation = JSON.parse(
    JSON.stringify({ ...first, pendingCoordinates: [] })
  ) as EventMarketDiscoveryContinuation
  requests = 0
  const next = await scanEventMarketCandidates({ ...input, continuation })
  expect(requests).toBeLessThanOrEqual(128)
  expect(contacted.size).toBe(8)
  expect(next.pages).toEqual([])
})

it("retains limited coverage when an explicit organizer's relay metadata is unavailable", async () => {
  const state = fixture(1)
  const record = state.records[0]!
  __setEventMarketTestOverrides({
    getRelayListsDetailed: async (authors) => ({
      relayLists: new Map(),
      resolutionStates: new Map(
        authors.map((author) => [author, "lookup-unavailable"])
      ),
    }),
  })
  state.dependencies.planDiscovery = getEventMarketDiscoveryReadPlan
  state.dependencies.fetch = async (_filter, options) => ({
    events: [],
    relays: (options.relayUrls ?? []).map((relayUrl) => ({
      relayUrl,
      status: "success",
    })),
  })
  const result = await discoverFutureEventMarkets(
    { organizerPubkeys: [record.author] },
    state.dependencies
  )
  expect(result.markets).toEqual([])
  expect(result.coverage).toBe("partial")
})

it("keeps a healthy public event when optional organizer relay lookup throws", async () => {
  const state = fixture(1)
  const record = state.records[0]!
  __setEventMarketTestOverrides({
    getRelayListsDetailed: async () => {
      throw new Error("Optional relay metadata unavailable")
    },
  })
  state.dependencies.planDiscovery = getEventMarketDiscoveryReadPlan
  const fetch = state.dependencies.fetch
  state.dependencies.fetch = async (filter, options) => ({
    events: (await fetch(filter, options)).events,
    relays: (options.relayUrls ?? []).map((relayUrl) => ({
      relayUrl,
      status: "success",
    })),
  })
  const result = await discoverFutureEventMarkets(
    { organizerPubkeys: [record.author] },
    state.dependencies
  )
  expect(result.markets[0]?.resolution.state).toBe("current")
  expect(result.markets[0]?.calendar?.eventId).toBe(record.calendar.id)
  expect(result.coverage).toBe("partial")
})
