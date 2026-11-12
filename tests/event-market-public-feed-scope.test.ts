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
  discoverOwnedEventMarkets,
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
import { buildEventMarketAssignmentDraft } from "../packages/core/src/protocol/event-market-assignment"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { __resetRelayHealth } from "../packages/core/src/protocol/relay-health"
import { getEventMarketDiscoveryScope } from "../packages/core/src/protocol/event-market-candidates"

test.each(["cooldown", "account denial"] as const)(
  "direct feed coverage stays partial across repeated %s reads",
  async (mode) => {
    const key = new Uint8Array(32).fill(46)
    const merchantKey = new Uint8Array(32).fill(47)
    const organizer = getPublicKey(key)
    const merchant = getPublicKey(merchantKey)
    const coordinate = `30409:${organizer}:coverage`
    const occurrence = `31922:${organizer}:date`
    const productCoordinate = `30402:${merchant}:product`
    const rows = [
      finalizeEvent(
        {
          ...buildEventMarketRosterDraft({
            dTag: "coverage",
            organizerPubkey: organizer,
            calendarCoordinate: occurrence,
            state: "open",
            merchants: [
              {
                pubkey: merchant,
                mode: "merchant_present",
                assignment: "Booth",
              },
            ],
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
            title: "Coverage",
            start: "2035-01-01",
            end: "2035-01-02",
          }),
          created_at: 100,
        },
        key
      ),
      finalizeEvent(
        {
          ...buildEventMarketAuthorizationDraft({
            marketCoordinate: coordinate,
            merchantPubkey: merchant,
            state: "active",
            sequence: 0,
            parentIds: [],
          }),
          created_at: 100,
        },
        key
      ),
      finalizeEvent(
        {
          kind: 30402,
          created_at: 100,
          content: "Fixture item",
          tags: [
            ["d", "product"],
            ["title", "Fixture"],
            ["price", "10", "SATS"],
            ["type", "simple", "physical"],
            ["image", "https://image.synthetic.invalid/item.png"],
          ],
        },
        merchantKey
      ),
      finalizeEvent(
        {
          ...buildEventMarketAssignmentDraft({
            marketCoordinate: coordinate,
            occurrenceCoordinate: occurrence,
            productCoordinate,
            merchantPubkey: merchant,
            state: "active",
            inventory: { mode: "untracked" },
            fulfillmentMethods: ["pickup"],
          }),
          created_at: 100,
        },
        merchantKey
      ),
    ]
    const feed = [
      "wss://coverage-a.event-scope-fixture.net",
      "wss://coverage-b.event-scope-fixture.net",
    ]
    const previousConfig = { ...config }
    const previousSocket = globalThis.WebSocket
    const previousFetch = globalThis.fetch
    const destinations: string[] = []
    const kinds = new Set<number>()
    const state = emptyAccountNetworkLocalState(organizer)
    if (mode === "account denial")
      state.exclusions = [
        {
          relayUrl: feed[1]!,
          committedAt: 1,
          relayListFrontier: { eventId: null, createdAt: null },
          inboxDeclarationFrontier: { eventId: null, createdAt: null },
        },
      ]
    class FixtureSocket implements PublicRelayReadSocket {
      readyState = 0
      onopen: PublicRelayReadSocket["onopen"] = null
      onmessage: PublicRelayReadSocket["onmessage"] = null
      onerror: PublicRelayReadSocket["onerror"] = null
      onclose: PublicRelayReadSocket["onclose"] = null
      constructor(readonly url: string) {
        destinations.push(url)
        if (!feed.includes(url)) throw new Error("Unexpected feed destination")
        queueMicrotask(() => {
          if (url === feed[1]) {
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
        for (const kind of filter.kinds ?? []) kinds.add(kind)
        queueMicrotask(() => {
          for (const row of rows.filter((row) => matchFilter(filter, row)))
            this.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify(["EVENT", id, row]),
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
    __resetRelayHealth()
    Object.assign(config, {
      commerceDiscoveryRelayUrls: feed,
      appCommerceRelayUrls: feed,
      e2eRelayIsolationEnabled: false,
    })
    globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket
    globalThis.fetch = (async () => {
      throw new Error("Unexpected metadata network")
    }) as typeof fetch
    const dependencies = {
      plan: getEventMarketReadPlan,
      fetch: (
        filter: Parameters<typeof fetchSignedEventsFanoutDetailed>[0],
        options: Parameters<typeof fetchSignedEventsFanoutDetailed>[1]
      ) =>
        fetchSignedEventsFanoutDetailed(filter, {
          ...options,
          accountNetworkLocalStateRepository: { get: async () => state },
        }),
      load: async () => [],
      retain: async () => {},
    }
    try {
      for (let round = 0; round < 3; round++) {
        closePublicRelayConnections()
        const input = {
          readScope: "public_feed" as const,
          ...(mode === "account denial"
            ? { accountPubkey: organizer, authenticatedPubkey: organizer }
            : {}),
        }
        const roster = await readEventMarketRoster(
          { ...input, reference: coordinate },
          dependencies
        )
        expect(roster.resolution.state).toBe("current")
        expect(roster.coverage).toBe("partial")
        expect(roster.calendarCoverage).toBe("partial")
        const authorization = await readEventMarketAuthorization(
          { ...input, marketCoordinate: coordinate, merchantPubkey: merchant },
          dependencies
        )
        expect(authorization.resolution.state).toBe("active")
        expect(authorization.coverage).toBe("partial")
        const product = await readEventMarketProduct(
          {
            ...input,
            marketRead: roster,
            productCoordinate,
            selectedOccurrenceCoordinate: occurrence,
          },
          dependencies
        )
        expect(product.resolution.state).toBe("eligible")
        expect(product.coverage).toBe("partial")
        expect(product.actionable).toBe(false)
        const catalog = await readEventMarketCatalog(
          {
            reference: coordinate,
            accountPubkey: input.accountPubkey,
            authenticatedPubkey: input.authenticatedPubkey,
            selectedOccurrenceCoordinate: occurrence,
          },
          dependencies
        )
        expect(catalog.coverage).toBe("partial")
      }
      expect([...kinds]).toEqual(
        expect.arrayContaining([30409, 31922, 3841, 30402, 30410, 5])
      )
      expect(destinations.every((url) => feed.includes(url))).toBe(true)
      expect(destinations.filter((url) => url === feed[1]).length).toBe(
        mode === "cooldown" ? 1 : 0
      )
    } finally {
      closePublicRelayConnections()
      __resetRelayHealth()
      Object.assign(config, previousConfig)
      globalThis.WebSocket = previousSocket
      globalThis.fetch = previousFetch
    }
  }
)

test("owner management finds an off-feed market on a new device without widening public discovery", async () => {
  const key = new Uint8Array(32).fill(45)
  const owner = getPublicKey(key)
  const coordinate = `30409:${owner}:owned`
  const calendarCoordinate = `31922:${owner}:owned-date`
  const advertised = Array.from(
    { length: 12 },
    (_, index) => `wss://owner-${index}.event-scope-fixture.net`
  )
  const source = advertised.at(-1)!
  const rows = [
    finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "owned",
          organizerPubkey: owner,
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
          dTag: "owned-date",
          title: "Owned event",
          start: "2035-01-01",
          end: "2035-01-02",
        }),
        created_at: 100,
      },
      key
    ),
  ]
  __setEventMarketTestOverrides({
    readAccountRelaySettingsPlanningSnapshot: async () => ({
      settings: { version: 1, entries: [], updatedAt: 1 },
      signedRelayListAuthoritative: false,
    }),
    getRelayLists: async () =>
      new Map([
        [
          owner,
          {
            pubkey: owner,
            writeRelayUrls: advertised,
            readRelayUrls: [],
            eventCreatedAt: 1,
            cachedAt: 1,
          },
        ],
      ]),
  })
  const destinations = new Set<string>()
  const dependencies = {
    plan: getEventMarketReadPlan,
    planDiscovery: getEventMarketDiscoveryReadPlan,
    load: async () => [],
    loadDiscovered: async () => [],
    retain: async () => {},
    fetch: async (
      filter: Parameters<typeof fetchSignedEventsFanoutDetailed>[0],
      options: Parameters<typeof fetchSignedEventsFanoutDetailed>[1]
    ) => {
      const urls = options?.relayUrls ?? []
      urls.forEach((url) => destinations.add(url))
      return {
        events: urls.includes(source)
          ? rows.filter((row) => matchFilter(filter, row))
          : [],
        relays: urls.map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
        })),
      }
    },
  }
  try {
    const owned = await discoverOwnedEventMarkets(
      { organizerPubkey: owner, authenticatedPubkey: owner },
      dependencies
    )
    expect(owned.markets).toHaveLength(1)
    expect(owned.markets[0]?.coordinate).toBe(coordinate)
    expect(owned.markets[0]?.calendar?.coordinate).toBe(calendarCoordinate)
    expect(owned.markets[0]?.readScope).toBeUndefined()
    expect(destinations.has(source)).toBe(true)
    destinations.clear()
    const authorityPlan = await getEventMarketReadPlan({
      organizerPubkey: owner,
      authenticatedPubkey: owner,
    })
    const continuationInput = {
      authors: [owner],
      accountPubkey: owner,
      authenticatedPubkey: owner,
      plan: { ...authorityPlan, relayUrls: authorityPlan.candidateRelayUrls },
    }
    const ownerScope = getEventMarketDiscoveryScope(continuationInput)
    expect(ownerScope).not.toBe(
      getEventMarketDiscoveryScope({
        ...continuationInput,
        readScope: "public_feed",
      })
    )
    const publicRead = await discoverFutureEventMarkets(
      {
        organizerPubkeys: [owner],
        authenticatedPubkey: owner,
        continuation: {
          scope: ownerScope,
          pages: [],
          pendingCoordinates: [{ coordinate, relayHints: [source] }],
        },
      },
      dependencies
    )
    expect(publicRead.markets).toEqual([])
    expect(
      [...destinations].every((url) =>
        config.commerceDiscoveryRelayUrls.includes(url)
      )
    ).toBe(true)
    destinations.clear()
    await expect(
      discoverOwnedEventMarkets(
        { organizerPubkey: owner, authenticatedPubkey: "a".repeat(64) },
        dependencies
      )
    ).rejects.toThrow("Authenticated Event Market owner")
    expect(destinations.size).toBe(0)
  } finally {
    __resetEventMarketTestOverrides()
  }
})

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
