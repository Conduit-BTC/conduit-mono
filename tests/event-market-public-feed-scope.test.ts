import { expect, test } from "bun:test"
import { finalizeEvent, getPublicKey, matchFilter } from "nostr-tools"
import { config } from "../packages/core/src/config"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  buildEventMarketCalendarDraft,
  encodeEventMarketNaddr,
  getEventMarketReadPlan,
  getEventMarketDiscoveryReadPlan,
} from "../packages/core/src/protocol/event-market"
import { buildEventMarketRosterDraft } from "../packages/core/src/protocol/event-market-roster"
import {
  discoverFutureEventMarkets,
  readEventMarketCatalog,
  readEventMarketRoster,
  readEventMarketProduct,
} from "../packages/core/src/protocol/event-market-roster-read"
import {
  closePublicRelayConnections,
  fetchSignedEventsFanoutDetailed,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"
import {
  isEventMarketAuthorizationWriteReady,
  isEventMarketCalendarWriteReady,
  isEventMarketRosterWriteReady,
} from "../packages/core/src/protocol/event-market-write-readiness"
import type { EventMarketRosterReadResult } from "../packages/core/src/protocol/event-market-roster-read"
import {
  readEventMarketAuthorization,
  type EventMarketAuthorizationReadResult,
} from "../packages/core/src/protocol/event-market-authorization-read"
import { buildEventMarketAuthorizationDraft } from "../packages/core/src/protocol/event-market-authorization"

test("complete feed display cannot authorize organizer writes or a first grant", () => {
  const roster = {
    readScope: "public_feed",
    resolution: { state: "current" },
    coverage: "complete",
    calendarCoverage: "complete",
    retained: true,
  } as unknown as EventMarketRosterReadResult
  const authorization = {
    readScope: "public_feed",
    resolution: { state: "missing" },
    coverage: "complete",
    retained: true,
  } as unknown as EventMarketAuthorizationReadResult
  expect(isEventMarketRosterWriteReady(roster)).toBe(false)
  expect(isEventMarketCalendarWriteReady(roster)).toBe(false)
  expect(isEventMarketAuthorizationWriteReady(authorization)).toBe(false)
  // Existing authority evidence retains its complete-read compatibility path.
  expect(
    isEventMarketRosterWriteReady({ ...roster, readScope: undefined })
  ).toBe(true)
  expect(
    isEventMarketAuthorizationWriteReady({
      ...authorization,
      readScope: undefined,
    })
  ).toBe(true)
})

test.each(["healthy", "partial", "outage"] as const)(
  "discovery and refresh preserve cached tombstones with fixed socket destinations during %s",
  async (mode) => {
    const key = new Uint8Array(32).fill(22)
    const organizer = getPublicKey(key)
    const coordinate = `30409:${organizer}:market`
    const roster = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "market",
          organizerPubkey: organizer,
          calendarCoordinate: `31922:${organizer}:date`,
          state: "open",
          merchants: [],
        }),
        created_at: 100,
      },
      key
    )
    const deletion = finalizeEvent(
      {
        kind: 5,
        content: "",
        tags: [
          ["a", coordinate],
          ["k", "30409"],
        ],
        created_at: 200,
      },
      key
    )
    const advertised = Array.from(
      { length: 120 },
      (_, i) => `wss://event-advertised-${i}.event-scope-fixture.net`
    )
    const feed = [
      "wss://event-feed-one.event-scope-fixture.net",
      "wss://event-feed-two.event-scope-fixture.net",
    ]
    const previousConfig = { ...config }
    const previousSocket = globalThis.WebSocket
    const previousFetch = globalThis.fetch
    const attempted = new Set<string>()
    const requests: number[] = []
    let unexpected = 0
    let listLookups = 0
    class FixtureSocket implements PublicRelayReadSocket {
      readyState = 0
      onopen: PublicRelayReadSocket["onopen"] = null
      onmessage: PublicRelayReadSocket["onmessage"] = null
      onerror: PublicRelayReadSocket["onerror"] = null
      onclose: PublicRelayReadSocket["onclose"] = null
      constructor(readonly url: string) {
        attempted.add(url)
        if (!feed.includes(url)) {
          unexpected++
          throw new Error("Unexpected feed destination")
        }
        queueMicrotask(() => {
          if (mode === "outage" || (mode === "partial" && url === feed[1])) {
            this.onerror?.(new Event("error"))
            return
          }
          this.readyState = 1
          this.onopen?.(new Event("open"))
        })
      }
      send(payload: string) {
        const [type, id, filter] = JSON.parse(payload)
        if (type !== "REQ") return
        requests.push(...(filter.kinds ?? []))
        queueMicrotask(() => {
          if (matchFilter(filter, roster))
            this.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify(["EVENT", id, roster]),
              })
            )
          this.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(["EOSE", id]) })
          )
        })
      }
      close() {
        this.readyState = 3
        this.onclose?.(new Event("close"))
      }
    }
    Object.assign(config, {
      commerceDiscoveryRelayUrls: feed,
      appCommerceRelayUrls: feed,
      e2eRelayIsolationEnabled: false,
    })
    globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket
    globalThis.fetch = (async () => {
      unexpected++
      throw new Error("Unexpected metadata network")
    }) as typeof fetch
    __setEventMarketTestOverrides({
      getRelayLists: async () => {
        listLookups++
        return new Map([
          [
            organizer,
            {
              pubkey: organizer,
              writeRelayUrls: advertised,
              readRelayUrls: [],
              cachedAt: 1,
              eventCreatedAt: 1,
            },
          ],
        ])
      },
    })
    const dependencies = {
      plan: getEventMarketReadPlan,
      planDiscovery: getEventMarketDiscoveryReadPlan,
      fetch: fetchSignedEventsFanoutDetailed,
      load: async () => [roster, deletion],
      loadDiscovered: async () => [roster],
      retain: async () => {},
    }
    try {
      for (let refresh = 0; refresh < 2; refresh++) {
        const result = await discoverFutureEventMarkets(
          { organizerPubkeys: [organizer] },
          dependencies
        )
        expect(result.markets[0]?.resolution.state).toBe("deleted")
        expect(result.markets[0]?.readScope).toBe("public_feed")
        expect(isEventMarketRosterWriteReady(result.markets[0])).toBe(false)
        if (mode !== "healthy") expect(result.coverage).not.toBe("complete")
      }
      const catalog = await readEventMarketCatalog(
        { reference: encodeEventMarketNaddr(coordinate, advertised) },
        dependencies
      )
      expect(catalog.marketRead.resolution.state).toBe("deleted")
      expect(catalog.products).toEqual([])
      expect(catalog.marketRead.readScope).toBe("public_feed")
      expect(attempted.size).toBeGreaterThan(0)
      expect([...attempted].every((url) => feed.includes(url))).toBe(true)
      expect(listLookups).toBe(0)
      expect(unexpected).toBe(0)
      if (mode !== "outage")
        expect(new Set(requests)).toEqual(new Set([30409, 5]))
    } finally {
      closePublicRelayConnections()
      __resetEventMarketTestOverrides()
      Object.assign(config, previousConfig)
      globalThis.WebSocket = previousSocket
      globalThis.fetch = previousFetch
    }
  }
)

test("an authority product read cannot upgrade a feed roster or initiate wider lookups", async () => {
  const result = await readEventMarketProduct(
    {
      marketRead: {
        readScope: "public_feed",
        coverage: "complete",
        retained: true,
      } as EventMarketRosterReadResult,
      productCoordinate: `30402:${"a".repeat(64)}:product`,
    },
    {
      plan: async () => {
        throw new Error("Must not plan an authority read")
      },
      fetch: async () => {
        throw new Error("Must not fetch authority")
      },
      load: async () => {
        throw new Error("Must not load authority")
      },
      retain: async () => {},
    }
  )
  expect(result.actionable).toBe(false)
  expect(result.readScope).toBe("public_feed")
})

test("feed authorization preserves known revokes and cannot replace full action evidence", async () => {
  const key = new Uint8Array(32).fill(23)
  const organizer = getPublicKey(key)
  const merchant = getPublicKey(new Uint8Array(32).fill(24))
  const marketCoordinate = `30409:${organizer}:market`
  const grant = finalizeEvent(
    {
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "active",
        sequence: 0,
        parentIds: [],
      }),
      created_at: 100,
    },
    key
  )
  const revoke = finalizeEvent(
    {
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "revoked",
        sequence: 1,
        parentIds: [grant.id],
      }),
      created_at: 200,
    },
    key
  )
  const advertised = Array.from(
    { length: 120 },
    (_, i) => `wss://authority-${i}.event-scope-fixture.net`
  )
  __setEventMarketTestOverrides({
    getRelayLists: async () =>
      new Map([
        [
          organizer,
          {
            pubkey: organizer,
            writeRelayUrls: advertised,
            readRelayUrls: [],
            cachedAt: 1,
            eventCreatedAt: 1,
          },
        ],
      ]),
  })
  let cached = [grant]
  const destinations = new Set<string>()
  const dependencies = {
    plan: getEventMarketReadPlan,
    load: async () => cached,
    retain: async () => {},
    fetch: async (
      filter: Parameters<typeof fetchSignedEventsFanoutDetailed>[0],
      options: Parameters<typeof fetchSignedEventsFanoutDetailed>[1]
    ) => {
      options?.relayUrls?.forEach((url) => destinations.add(url))
      return {
        events: [grant].filter((event) => matchFilter(filter, event)),
        relays: (options?.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
        })),
      }
    },
  }
  try {
    const feed = await readEventMarketAuthorization(
      { marketCoordinate, merchantPubkey: merchant, readScope: "public_feed" },
      dependencies
    )
    expect(feed.resolution.state).toBe("active")
    expect(feed.actionable).toBe(false)
    expect(isEventMarketAuthorizationWriteReady(feed)).toBe(false)
    expect([...destinations].some((url) => advertised.includes(url))).toBe(
      false
    )
    destinations.clear()
    const authority = await readEventMarketAuthorization(
      { marketCoordinate, merchantPubkey: merchant },
      dependencies
    )
    expect(authority.resolution.state).toBe("active")
    expect(authority.actionable).toBe(true)
    expect(advertised.every((url) => destinations.has(url))).toBe(true)
    cached = [grant, revoke]
    const revoked = await readEventMarketAuthorization(
      { marketCoordinate, merchantPubkey: merchant, readScope: "public_feed" },
      dependencies
    )
    expect(revoked.resolution.state).toBe("revoked")
    expect(revoked.actionable).toBe(false)
    expect(
      revoked.observedEvidence.some((event) => event.id === revoke.id)
    ).toBe(true)
    expect(revoked.coverage).toBe("stale")
  } finally {
    __resetEventMarketTestOverrides()
  }
})

test("public roster hydration reads calendar and deletions only on configured feed sources", async () => {
  const key = new Uint8Array(32).fill(21)
  const organizer = getPublicKey(key)
  const coordinate = `30409:${organizer}:market`
  const calendarCoordinate = `31922:${organizer}:date`
  const rows = [
    finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "market",
          organizerPubkey: organizer,
          calendarCoordinate,
          state: "open",
          merchants: [],
        }),
        created_at: 100,
      },
      key
    ),
    finalizeEvent(
      {
        ...buildEventMarketCalendarDraft({
          kind: 31922,
          dTag: "date",
          title: "Market date",
          start: "2030-01-01",
          end: "2030-01-02",
        }),
        created_at: 100,
      },
      key
    ),
  ]
  const advertised = Array.from(
    { length: 120 },
    (_, i) => `wss://advertised-${i}.event-scope-fixture.net`
  )
  let listLookups = 0
  __setEventMarketTestOverrides({
    getRelayLists: async () => {
      listLookups++
      return new Map([
        [
          organizer,
          {
            pubkey: organizer,
            writeRelayUrls: advertised,
            readRelayUrls: [],
            cachedAt: 1,
            eventCreatedAt: 1,
          },
        ],
      ])
    },
  })
  const destinations = new Set<string>()
  const kinds = new Set<number>()
  try {
    const result = await readEventMarketRoster(
      {
        reference: encodeEventMarketNaddr(coordinate, advertised),
        readScope: "public_feed",
      },
      {
        plan: getEventMarketReadPlan,
        load: async () => [],
        retain: async () => {},
        fetch: async (filter, options) => {
          options.relayUrls?.forEach((url) => destinations.add(url))
          filter.kinds?.forEach((kind) => kinds.add(kind))
          return {
            events: rows.filter((event) => matchFilter(filter, event)),
            relays: (options.relayUrls ?? []).map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
            })),
          }
        },
      }
    )
    expect(result.resolution.state).toBe("current")
    expect(result.calendar?.coordinate).toBe(calendarCoordinate)
    expect(result.readScope).toBe("public_feed")
    expect(destinations).toEqual(
      new Set(
        config.commerceDiscoveryRelayUrls.filter((url) =>
          config.appCommerceRelayUrls.includes(url)
        )
      )
    )
    expect(kinds).toEqual(new Set([30409, 31922, 5]))
    expect(listLookups).toBe(0)
    expect(isEventMarketRosterWriteReady(result)).toBe(false)
  } finally {
    __resetEventMarketTestOverrides()
  }
})
