import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { nip19 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  applyE2eRelayIsolation,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  config,
  createDefaultAccountNetworkRoutingPolicy,
  decodeEventMarketReference,
  emptyAccountNetworkLocalState,
  EVENT_KINDS,
  filterEligibleAccountRelayUrls,
  getEventMarket,
  getOrganizerEventMarkets,
  getOrganizerEventMarketsDetailed,
  parseProductEvent,
  resolveEventMarketProductFulfillment,
  resolveEventMarketProductParticipation,
  type CachedEventMarketEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { buildPickupFulfillmentTerms } from "../apps/market/src/lib/event-market-adapter"

const SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const COLLECTION = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER}:catalog`
const CALENDAR = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER}:calendar`
const PICKUP = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER}:pickup`
const MERCHANT_PICKUP = `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT}:booth`
const PRODUCT = `${EVENT_KINDS.PRODUCT}:${MERCHANT}:coffee`
const ORGANIZER_RELAY = "wss://organizer-write.example"
const MERCHANT_RELAY = "wss://merchant-write.example"
const originalConfig = structuredClone(config)

function sign(
  draft: { kind: number; content: string; tags: string[][] },
  createdAt: number
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: draft.kind,
      content: draft.content,
      tags: draft.tags,
      created_at: createdAt,
    },
    SECRET
  )
}

function signAs(
  secret: Uint8Array,
  draft: { kind: number; content?: string; tags: string[][] },
  createdAt: number
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: draft.kind,
      content: draft.content ?? "",
      tags: draft.tags,
      created_at: createdAt,
    },
    secret
  )
}

function productRevision(
  createdAt: number,
  requestsCollection: boolean
): SignedPublicNostrEvent {
  return signAs(
    MERCHANT_SECRET,
    {
      kind: EVENT_KINDS.PRODUCT,
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ...(requestsCollection ? [["a", COLLECTION]] : []),
        ["shipping_option", PICKUP],
      ],
    },
    createdAt
  )
}

function graph(
  productCoordinates: readonly string[] = []
): SignedPublicNostrEvent[] {
  return [
    sign(
      buildEventMarketCalendarDraft({
        kind: EVENT_KINDS.CALENDAR_TIME,
        dTag: "calendar",
        title: "Public market",
        start: 1_800_000_000,
        end: 1_800_003_600,
        startTzid: "UTC",
        endTzid: "UTC",
      }),
      100
    ),
    sign(
      buildEventMarketPickupDraft({
        dTag: "pickup",
        title: "Market pickup",
        price: 0,
        currency: "SATS",
        countries: ["US"],
        location: "Public market hall",
      }),
      101
    ),
    sign(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Market catalog",
        eventCoordinate: CALENDAR,
        pickupCoordinate: PICKUP,
        productCoordinates: [...productCoordinates],
      }),
      102
    ),
  ]
}

const SATURATED_ORGANIZER_PAGE = Array.from({ length: 500 }, (_, index) =>
  sign(
    buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_TIME,
      dTag: `newer-${index}`,
      title: `Newer organizer record ${index}`,
      start: 1_900_000_000 + index,
    }),
    1_000 + index
  )
)

function merchantPickupEvent(
  createdAt = 101,
  dTag = "booth"
): SignedPublicNostrEvent {
  return signAs(
    MERCHANT_SECRET,
    buildEventMarketPickupDraft({
      dTag,
      title: "Merchant booth",
      price: 0,
      currency: "SATS",
      countries: ["US"],
      location: "Public market hall",
    }),
    createdAt
  )
}

function merchantPickupGraph(): SignedPublicNostrEvent[] {
  return [
    sign(
      buildEventMarketCalendarDraft({
        kind: EVENT_KINDS.CALENDAR_TIME,
        dTag: "calendar",
        title: "Public market",
        start: 1_800_000_000,
        end: 1_800_003_600,
      }),
      100
    ),
    sign(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Market catalog",
        eventCoordinate: CALENDAR,
        productCoordinates: [PRODUCT],
      }),
      102
    ),
  ]
}

function merchantPickupProductRevision(createdAt = 100) {
  return signAs(
    MERCHANT_SECRET,
    {
      kind: EVENT_KINDS.PRODUCT,
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["a", COLLECTION],
        ["shipping_option", MERCHANT_PICKUP],
      ],
    },
    createdAt
  )
}

function cacheHarness(initial: CachedEventMarketEvidence[] = []) {
  let rows = [...initial]
  __setEventMarketTestOverrides({
    getRelayLists: async () =>
      new Map([
        [
          ORGANIZER,
          {
            pubkey: ORGANIZER,
            readRelayUrls: ["wss://read.example"],
            writeRelayUrls: ["wss://write.example"],
            eventCreatedAt: 1,
            cachedAt: Date.now(),
          },
        ],
      ]),
    loadCachedEvidence: async () => rows,
    persistCachedEvidence: async ({ events }) => {
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const event of events) {
        byId.set(event.id, {
          id: event.id,
          organizerPubkey: ORGANIZER,
          kind: event.kind,
          signedEvent: event,
          sourceRelayUrls: ["wss://write.example"],
          cachedAt: 1_700_000_000_000,
        })
      }
      rows = Array.from(byId.values())
    },
  })
  return {
    setFetch(events: SignedPublicNostrEvent[], status: "success" | "failed") {
      __setEventMarketTestOverrides({
        fetchEventsFanoutDetailed: async (filter) => ({
          events: filter.kinds?.includes(EVENT_KINDS.PRODUCT)
            ? []
            : events.map((event) => new NDKEvent(undefined, event)),
          relays: [
            {
              relayUrl: "wss://write.example",
              status,
              eventCount: status === "failed" ? 0 : events.length,
            },
          ],
          eventsVerified: true,
        }),
      })
    },
  }
}

type TagFilter = NDKFilter & {
  "#a"?: string[]
  "#d"?: string[]
  "#e"?: string[]
}

function participationCacheHarness() {
  let rows: CachedEventMarketEvidence[] = []
  let discovery: SignedPublicNostrEvent[] = []
  let frontier: SignedPublicNostrEvent[] = []
  let deletions: SignedPublicNostrEvent[] = []
  __setEventMarketTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [],
            writeRelayUrls:
              pubkey === MERCHANT ? [MERCHANT_RELAY] : [ORGANIZER_RELAY],
            eventCreatedAt: 1,
            cachedAt: Date.now(),
          },
        ])
      ),
    loadCachedEvidence: async () => rows,
    persistCachedEvidence: async ({ events }) => {
      const bySignedId = new Map(
        rows.map((row) => [row.signedEvent.id.toLowerCase(), row])
      )
      for (const event of events) {
        bySignedId.set(event.id.toLowerCase(), {
          id: event.id.toLowerCase(),
          organizerPubkey: ORGANIZER,
          kind: event.kind,
          signedEvent: event,
          sourceRelayUrls: [
            event.pubkey === MERCHANT ? MERCHANT_RELAY : ORGANIZER_RELAY,
          ],
          cachedAt: Date.now(),
        })
      }
      rows = Array.from(bySignedId.values())
    },
    fetchEventsFanoutDetailed: async (rawFilter, options) => {
      const filter = rawFilter as TagFilter
      let events: SignedPublicNostrEvent[] = []
      if (filter.authors?.includes(ORGANIZER)) {
        events = graph([PRODUCT])
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#a"]?.includes(COLLECTION)
      ) {
        events = discovery
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#d"]?.includes("coffee")
      ) {
        events = frontier
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.DELETION
      ) {
        events = deletions.filter((event) =>
          event.tags.some(
            (tag) =>
              (tag[0] === "a" && filter["#a"]?.includes(tag[1] ?? "")) ||
              (tag[0] === "e" && filter["#e"]?.includes(tag[1] ?? ""))
          )
        )
      }
      const relayUrls = options.relayUrls ?? []
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
  return {
    setRead(input: {
      discovery: SignedPublicNostrEvent[]
      frontier: SignedPublicNostrEvent[]
      deletions?: SignedPublicNostrEvent[]
    }) {
      discovery = input.discovery
      frontier = input.frontier
      deletions = input.deletions ?? []
    },
  }
}

function organizerFrontierCacheHarness() {
  const [calendar, pickup] = graph()
  let rows: CachedEventMarketEvidence[] = []
  let collections: SignedPublicNostrEvent[] = []
  let deletions: SignedPublicNostrEvent[] = []
  __setEventMarketTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [],
            writeRelayUrls:
              pubkey === MERCHANT ? [MERCHANT_RELAY] : [ORGANIZER_RELAY],
            eventCreatedAt: 1,
            cachedAt: Date.now(),
          },
        ])
      ),
    loadCachedEvidence: async () => rows,
    persistCachedEvidence: async ({ events }) => {
      const byId = new Map(
        rows.map((row) => [row.signedEvent.id.toLowerCase(), row])
      )
      for (const event of events) {
        byId.set(event.id.toLowerCase(), {
          id: event.id.toLowerCase(),
          organizerPubkey: ORGANIZER,
          kind: event.kind,
          signedEvent: event,
          sourceRelayUrls: [ORGANIZER_RELAY],
          cachedAt: Date.now(),
        })
      }
      rows = Array.from(byId.values())
    },
    fetchEventsFanoutDetailed: async (rawFilter, options) => {
      const filter = rawFilter as TagFilter
      const isBroadOrganizerRead =
        filter.authors?.includes(ORGANIZER) && (filter.kinds?.length ?? 0) > 1
      let events: SignedPublicNostrEvent[] = []
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
        (!filter["#d"] || filter["#d"].includes("catalog"))
      ) {
        events = collections
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.CALENDAR_TIME &&
        filter["#d"]?.includes("calendar")
      ) {
        events = [calendar!]
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === (EVENT_KINDS.SHIPPING_OPTION as never) &&
        filter["#d"]?.includes("pickup")
      ) {
        events = [pickup!]
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.DELETION
      ) {
        events = deletions.filter((event) =>
          event.tags.some(
            (tag) =>
              (tag[0] === "a" && filter["#a"]?.includes(tag[1] ?? "")) ||
              (tag[0] === "e" && filter["#e"]?.includes(tag[1] ?? ""))
          )
        )
      }
      return {
        events: events.map((event) => new NDKEvent(undefined, event)),
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: isBroadOrganizerRead ? 500 : events.length,
        })),
        eventsVerified: true,
      }
    },
  })
  return {
    setRead(input: {
      collections: SignedPublicNostrEvent[]
      deletions?: SignedPublicNostrEvent[]
    }) {
      collections = input.collections
      deletions = input.deletions ?? []
    },
  }
}

function coordinateScopedSaturationHarness(
  evidence: readonly SignedPublicNostrEvent[]
) {
  __setEventMarketTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [],
            writeRelayUrls: [
              `wss://${pubkey.slice(0, 12)}.event-market.example`,
            ],
            eventCreatedAt: 1,
            cachedAt: Date.now(),
          },
        ])
      ),
    loadCachedEvidence: async () => [],
    persistCachedEvidence: async () => undefined,
    fetchEventsFanoutDetailed: async (rawFilter, options) => {
      const filter = rawFilter as TagFilter
      const events = evidence.filter(
        (event) =>
          (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          ["a", "d", "e"].every((tagName) => {
            const values = filter[`#${tagName}` as "#a" | "#d" | "#e"]
            return (
              !values ||
              event.tags.some(
                (tag) => tag[0] === tagName && values.includes(tag[1]!)
              )
            )
          })
      )
      return {
        events: events.map((event) => new NDKEvent(undefined, event)),
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: events.length,
        })),
        eventsVerified: true,
      }
    },
  })
}

function merchantPickupCacheHarness() {
  let rows: CachedEventMarketEvidence[] = []
  let pickupEvents: SignedPublicNostrEvent[] = [merchantPickupEvent()]
  let pickupDeletions: SignedPublicNostrEvent[] = []
  let pickupStatus: "success" | "partial" | "failed" = "success"
  const product = merchantPickupProductRevision()
  __setEventMarketTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [],
            writeRelayUrls:
              pubkey === MERCHANT ? [MERCHANT_RELAY] : [ORGANIZER_RELAY],
            eventCreatedAt: 1,
            cachedAt: Date.now(),
          },
        ])
      ),
    loadCachedEvidence: async () => rows,
    persistCachedEvidence: async ({ events }) => {
      const byId = new Map(
        rows.map((row) => [row.signedEvent.id.toLowerCase(), row])
      )
      for (const event of events) {
        byId.set(event.id.toLowerCase(), {
          id: `${ORGANIZER}:${event.id.toLowerCase()}`,
          organizerPubkey: ORGANIZER,
          kind: event.kind,
          signedEvent: event,
          sourceRelayUrls: [
            event.pubkey === MERCHANT ? MERCHANT_RELAY : ORGANIZER_RELAY,
          ],
          cachedAt: Date.now(),
        })
      }
      rows = Array.from(byId.values())
    },
    fetchEventsFanoutDetailed: async (rawFilter, options) => {
      const filter = rawFilter as TagFilter
      let events: SignedPublicNostrEvent[] = []
      let status: "success" | "partial" | "failed" = "success"
      if (
        filter.authors?.includes(ORGANIZER) &&
        filter.kinds?.some((kind) =>
          [
            EVENT_KINDS.PRODUCT_COLLECTION,
            EVENT_KINDS.CALENDAR_DATE,
            EVENT_KINDS.CALENDAR_TIME,
          ].includes(kind)
        )
      ) {
        events = merchantPickupGraph()
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        (filter["#a"]?.includes(COLLECTION) || filter["#d"]?.includes("coffee"))
      ) {
        events = [product]
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === (EVENT_KINDS.SHIPPING_OPTION as never) &&
        filter.authors?.includes(MERCHANT)
      ) {
        events = pickupStatus === "failed" ? [] : pickupEvents
        status = pickupStatus
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.DELETION &&
        filter.authors?.includes(MERCHANT)
      ) {
        events = pickupStatus === "failed" ? [] : pickupDeletions
        status = pickupStatus
      }
      return {
        events: events.map((event) => new NDKEvent(undefined, event)),
        relays: (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status,
          eventCount: events.length,
        })),
        eventsVerified: true,
      }
    },
  })
  return {
    setPickupRead(input: {
      events?: SignedPublicNostrEvent[]
      deletions?: SignedPublicNostrEvent[]
      status?: "success" | "partial" | "failed"
    }) {
      pickupEvents = input.events ?? []
      pickupDeletions = input.deletions ?? []
      pickupStatus = input.status ?? "success"
    },
    rows: () => rows,
  }
}

type CollectionDiscoveryRelayStatus = "success" | "partial" | "failed"

function saturatedCollectionDiscoveryHarness(input: {
  cachedRecords?: readonly CachedEventMarketEvidence[]
  discoveryEvents?: readonly SignedPublicNostrEvent[]
  discoveryStatus?: (relayUrl: string) => CollectionDiscoveryRelayStatus
  eventsVerified?: boolean
  includeExactRecords?: boolean
}) {
  const [calendar, pickup, collection] = graph()
  const discoveryEvents = input.discoveryEvents ?? [collection!]
  const collectionDiscoveryRelayPlans: string[][] = []
  const collectionDiscoveryStatuses: CollectionDiscoveryRelayStatus[] = []
  const persistedEventIds: string[] = []
  __setEventMarketTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [ORGANIZER_RELAY, "wss://relay.plebeian.market"],
            writeRelayUrls: [ORGANIZER_RELAY, "wss://relay.plebeian.market"],
            eventCreatedAt: 1,
            cachedAt: Date.now(),
          },
        ])
      ),
    loadCachedEvidence: async () => [...(input.cachedRecords ?? [])],
    persistCachedEvidence: async ({ events }) => {
      persistedEventIds.push(...events.map((event) => event.id.toLowerCase()))
    },
    fetchEventsFanoutDetailed: async (rawFilter, options) => {
      const filter = rawFilter as TagFilter
      const broadRead =
        filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5
      const collectionDiscovery =
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
        !filter["#d"]
      if (collectionDiscovery) {
        collectionDiscoveryRelayPlans.push([...(options.relayUrls ?? [])])
      }
      let events: readonly SignedPublicNostrEvent[] = []
      if (broadRead) {
        events = SATURATED_ORGANIZER_PAGE
      } else if (collectionDiscovery) {
        events = discoveryEvents
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
        filter["#d"]?.includes("catalog")
      ) {
        events = input.includeExactRecords === false ? [] : [collection!]
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.CALENDAR_TIME &&
        filter["#d"]?.includes("calendar")
      ) {
        events = input.includeExactRecords === false ? [] : [calendar!]
      } else if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === (EVENT_KINDS.SHIPPING_OPTION as never) &&
        filter["#d"]?.includes("pickup")
      ) {
        events = input.includeExactRecords === false ? [] : [pickup!]
      }
      return {
        events: events.map((event) => new NDKEvent(undefined, event)),
        relays: (options.relayUrls ?? []).map((relayUrl) => {
          const status = collectionDiscovery
            ? (input.discoveryStatus?.(relayUrl) ?? "success")
            : "success"
          if (collectionDiscovery) collectionDiscoveryStatuses.push(status)
          return {
            relayUrl,
            status,
            eventCount: status === "failed" ? 0 : events.length,
          }
        }),
        eventsVerified: collectionDiscovery
          ? (input.eventsVerified ?? true)
          : true,
      }
    },
  })
  return {
    collectionDiscoveryRelayPlans,
    collectionDiscoveryStatuses,
    persistedEventIds,
  }
}

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig))
  __resetEventMarketTestOverrides()
})

describe("event-market retained evidence", () => {
  it("preserves a signed closure across restart and older or stripped relay revisions", async () => {
    const initialGraph = graph()
    const originalCollection = initialGraph.find(
      (event) => event.kind === EVENT_KINDS.PRODUCT_COLLECTION
    )!
    const open = sign(
      {
        ...originalCollection,
        tags: [
          ...originalCollection.tags,
          ["conduit_event_market", "1", "open"],
        ],
      },
      200
    )
    const closed = sign(
      {
        ...originalCollection,
        tags: [
          ...originalCollection.tags,
          ["conduit_event_market", "1", "closed"],
        ],
      },
      300
    )
    const durable = [
      ...initialGraph.filter(
        (event) => event.kind !== EVENT_KINDS.PRODUCT_COLLECTION
      ),
      closed,
    ].map((event): CachedEventMarketEvidence => ({
      id: event.id,
      organizerPubkey: ORGANIZER,
      kind: event.kind,
      signedEvent: event,
      sourceRelayUrls: ["wss://write.example"],
      cachedAt: 1_750_000_000_000,
    }))
    __resetEventMarketTestOverrides()
    const harness = cacheHarness(durable)
    harness.setFetch(
      [
        ...initialGraph.filter(
          (event) => event.kind !== EVENT_KINDS.PRODUCT_COLLECTION
        ),
        open,
      ],
      "success"
    )
    const retained = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(retained.collection?.orderAcceptance).toBe("closed")
    expect(["ended", "stale"]).toContain(retained.state)
    const stripped = sign(originalCollection, 400)
    harness.setFetch(
      [
        ...initialGraph.filter(
          (event) => event.kind !== EVENT_KINDS.PRODUCT_COLLECTION
        ),
        stripped,
      ],
      "success"
    )
    expect(
      (
        await getEventMarket({
          reference: COLLECTION,
          nowMs: 1_750_000_000_000,
        })
      ).state
    ).toBe("malformed")
  })

  it("requires an advertised organizer pickup only when a selected product uses it", async () => {
    const organizerGraph = graph([PRODUCT])
    const organizerPickup = organizerGraph[1]!
    let product = productRevision(103, true)
    let organizerPickupAvailable = true
    let organizerDeletion: SignedPublicNostrEvent | undefined = undefined
    const filters: TagFilter[] = []
    cacheHarness()
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        filters.push(filter)
        const events = [
          ...organizerGraph.filter(
            (event) =>
              organizerPickupAvailable || event.id !== organizerPickup.id
          ),
          merchantPickupEvent(),
          product,
          ...(organizerDeletion ? [organizerDeletion] : []),
        ].filter(
          (event) =>
            (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            ["a", "d", "e"].every((tagName) => {
              const values = filter[`#${tagName}` as "#a" | "#d" | "#e"]
              return (
                !values ||
                event.tags.some(
                  (tag) => tag[0] === tagName && values.includes(tag[1]!)
                )
              )
            })
        )
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })
    const read = () =>
      getEventMarket({
        reference: COLLECTION,
        selectedProductCoordinates: [PRODUCT],
        nowMs: 1_750_000_000_000,
      })
    expect((await read()).state).toBe("active")
    organizerPickupAvailable = false
    expect((await read()).state).toBe("stale")

    product = merchantPickupProductRevision(104)
    filters.length = 0
    const merchantPickup = await read()
    expect(merchantPickup.state).toBe("active")
    expect(merchantPickup.pickups.map((pickup) => pickup.coordinate)).toEqual([
      MERCHANT_PICKUP,
    ])
    expect(
      filters.some(
        (filter) =>
          filter.authors?.includes(ORGANIZER) &&
          (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION as never) ||
            filter["#a"]?.includes(PICKUP) ||
            filter["#e"]?.includes(organizerPickup.id))
      )
    ).toBe(false)

    organizerDeletion = sign(
      { kind: EVENT_KINDS.DELETION, content: "", tags: [["a", PICKUP]] },
      105
    )
    // Browse still observes the organizer pickup deletion and retains it.
    expect(
      (
        await getEventMarket({
          reference: COLLECTION,
          nowMs: 1_750_000_000_000,
        })
      ).state
    ).toBe("deleted")
    expect((await read()).state).toBe("active")
    product = productRevision(106, true)
    expect((await read()).state).toBe("deleted")
  })

  it("checks only selected event products and retains their withdrawal and deletion safeguards", async () => {
    const otherMerchant = getPublicKey(generateSecretKey())
    const unrelatedProducts = Array.from(
      { length: 70 },
      (_, index) => `${EVENT_KINDS.PRODUCT}:${otherMerchant}:unrelated-${index}`
    )
    let organizerEvents = graph([PRODUCT, ...unrelatedProducts])
    let productEvents = [productRevision(103, true)]
    const filters: TagFilter[] = []
    cacheHarness()
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        filters.push(filter)
        const events = [...organizerEvents, ...productEvents].filter(
          (event) =>
            (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            ["a", "d", "e"].every((tagName) => {
              const values = filter[`#${tagName}` as "#a" | "#d" | "#e"]
              return (
                !values ||
                event.tags.some(
                  (tag) => tag[0] === tagName && values.includes(tag[1]!)
                )
              )
            })
        )
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })
    const readSelected = () =>
      getEventMarket({
        reference: COLLECTION,
        selectedProductCoordinates: [PRODUCT],
        nowMs: 1_750_000_000_000,
      })
    const current = await readSelected()
    expect(current.state).toBe("active")
    expect(current.collection?.productCoordinates).toHaveLength(71)
    expect(current.acceptedProductCoordinates).toEqual([PRODUCT])
    expect(current.participationBudget.targetCount).toBe(1)
    expect(
      filters.some(
        (filter) => filter.kinds?.includes(EVENT_KINDS.PRODUCT) && filter["#a"]
      )
    ).toBe(false)
    expect(
      filters.some((filter) => filter.authors?.includes(otherMerchant))
    ).toBe(false)
    expect(filters.every((filter) => filter.kinds?.length === 1)).toBe(true)
    expect(
      filters
        .flatMap((filter) => filter["#d"] ?? [])
        .every((dTag) =>
          ["catalog", "calendar", "pickup", "coffee"].includes(dTag)
        )
    ).toBe(true)

    productEvents = [productRevision(104, false)]
    expect((await readSelected()).acceptedProductCoordinates).toEqual([])
    // An older positive read cannot erase the retained signed withdrawal.
    productEvents = [productRevision(103, true)]
    expect((await readSelected()).acceptedProductCoordinates).toEqual([])
    productEvents = [
      productRevision(105, true),
      signAs(
        MERCHANT_SECRET,
        { kind: EVENT_KINDS.DELETION, tags: [["a", PRODUCT]] },
        106
      ),
    ]
    expect((await readSelected()).acceptedProductCoordinates).toEqual([])
    productEvents = [productRevision(107, true)]
    expect((await readSelected()).acceptedProductCoordinates).toEqual([PRODUCT])
    organizerEvents = [
      ...organizerEvents.filter(
        (event) => event.kind !== EVENT_KINDS.PRODUCT_COLLECTION
      ),
      sign(
        buildEventMarketCollectionDraft({
          dTag: "catalog",
          title: "Market catalog",
          eventCoordinate: CALENDAR,
          pickupCoordinate: PICKUP,
          productCoordinates: unrelatedProducts,
        }),
        108
      ),
    ]
    expect((await readSelected()).acceptedProductCoordinates).toEqual([])
  })

  it("scopes event participation and pickup reads to one selected merchant", async () => {
    const otherSecret = generateSecretKey()
    const otherMerchant = getPublicKey(otherSecret)
    const otherProduct = `${EVENT_KINDS.PRODUCT}:${otherMerchant}:tea`
    const organizerEvents = graph([PRODUCT, otherProduct])
    const productEvents = [
      productRevision(103, true),
      signAs(
        otherSecret,
        {
          kind: EVENT_KINDS.PRODUCT,
          tags: [
            ["d", "tea"],
            ["title", "Tea"],
            ["price", "10", "USD"],
            ["a", COLLECTION],
            ["shipping_option", PICKUP],
          ],
        },
        104
      ),
    ]
    const filters: TagFilter[] = []
    cacheHarness()
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        filters.push(filter)
        const events = [...organizerEvents, ...productEvents].filter(
          (event) =>
            (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            ["a", "d", "e"].every((tagName) => {
              const values = filter[`#${tagName}` as "#a" | "#d" | "#e"]
              return (
                !values ||
                event.tags.some(
                  (tag) => tag[0] === tagName && values.includes(tag[1]!)
                )
              )
            })
        )
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    const readMerchant = (selectedMerchantPubkey: string) =>
      getEventMarket({
        reference: COLLECTION,
        selectedMerchantPubkey,
        nowMs: 1_750_000_000_000,
      })

    const selected = await readMerchant(MERCHANT)
    expect(selected.state).toBe("active")
    expect(selected.collection?.coordinate).toBe(COLLECTION)
    expect(selected.calendar?.coordinate).toBe(CALENDAR)
    expect(selected.organizerProductCoordinates).toEqual([PRODUCT])
    expect(selected.acceptedProductCoordinates).toEqual([PRODUCT])
    expect(selected.participationBudget.targetCount).toBe(1)
    expect(
      filters.some((filter) => filter.authors?.includes(otherMerchant))
    ).toBe(false)
    expect(
      filters.flatMap((filter) => filter["#d"] ?? []).includes("tea")
    ).toBe(false)

    for (const selectedMerchantPubkey of ["f".repeat(64), "not-a-pubkey"]) {
      filters.length = 0
      const empty = await readMerchant(selectedMerchantPubkey)
      expect(empty.state).toBe("active")
      expect(empty.collection?.coordinate).toBe(COLLECTION)
      expect(empty.calendar?.coordinate).toBe(CALENDAR)
      expect(empty.organizerProductCoordinates).toEqual([])
      expect(empty.acceptedProductCoordinates).toEqual([])
      expect(empty.participationBudget.targetCount).toBe(0)
      expect(
        filters.some(
          (filter) =>
            filter.authors?.includes(MERCHANT) ||
            filter.authors?.includes(otherMerchant)
        )
      ).toBe(false)
    }
  })

  it("never turns a remote naddr loopback hint into signed-in relay I/O", async () => {
    const remoteLoopbackRelay = "ws://127.0.0.1:4789"
    const portableRelay = "wss://portable.relay.conduit.market/events"
    const ownerRelay = "ws://owner-network.example:4848"
    const attemptedRelayUrls: string[] = []
    const relayPlans: string[][] = []
    const ownerSelectedRelayUrls: string[] = []
    const authenticatedPubkeys: Array<string | null | undefined> = []
    __setEventMarketTestOverrides({
      getRelayLists: async () => new Map(),
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: {
          version: 1,
          updatedAt: 1,
          entries: [
            {
              url: ownerRelay,
              readEnabled: true,
              writeEnabled: false,
              section: "public",
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
            },
          ],
        },
        signedRelayListAuthoritative: true,
      }),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (_filter, options) => {
        relayPlans.push([...(options.relayUrls ?? [])])
        attemptedRelayUrls.push(...(options.relayUrls ?? []))
        ownerSelectedRelayUrls.push(...(options.ownerSelectedRelayUrls ?? []))
        authenticatedPubkeys.push(options.authenticatedPubkey)
        return {
          events: [],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
          eventsVerified: true,
        }
      },
    })
    const remoteReference = nip19.naddrEncode({
      kind: EVENT_KINDS.PRODUCT_COLLECTION,
      pubkey: ORGANIZER,
      identifier: "catalog",
      relays: [remoteLoopbackRelay, portableRelay],
    })

    await getEventMarket({
      reference: remoteReference,
      authenticatedPubkey: MERCHANT,
    })

    expect(relayPlans.length).toBeGreaterThan(0)
    expect(
      relayPlans.every((relayUrls) => relayUrls[0] === portableRelay)
    ).toBe(true)
    expect(attemptedRelayUrls).toContain(portableRelay)
    expect(attemptedRelayUrls).toContain(ownerRelay)
    expect(ownerSelectedRelayUrls).toContain(ownerRelay)
    expect(attemptedRelayUrls).not.toContain(remoteLoopbackRelay)
    expect(authenticatedPubkeys.every((value) => value === MERCHANT)).toBe(true)
  })

  it("keeps only the exact configured E2E loopback in the composed read plan", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const otherLoopbackRelayUrl = "ws://127.0.0.1:7788"
    const remoteSecureRelayUrl = "wss://remote-hint.example"
    const relayPlans: string[][] = []
    const ownerSelectedRelayPlans: string[][] = []
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    __setEventMarketTestOverrides({
      getRelayLists: async () => new Map(),
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: { version: 1, updatedAt: 1, entries: [] },
        signedRelayListAuthoritative: true,
      }),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (_filter, options) => {
        relayPlans.push([...(options.relayUrls ?? [])])
        ownerSelectedRelayPlans.push([
          ...(options.ownerSelectedRelayUrls ?? []),
        ])
        return {
          events: [],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
          eventsVerified: true,
        }
      },
    })
    const remoteReference = nip19.naddrEncode({
      kind: EVENT_KINDS.PRODUCT_COLLECTION,
      pubkey: ORGANIZER,
      identifier: "catalog",
      relays: [isolatedRelayUrl, otherLoopbackRelayUrl, remoteSecureRelayUrl],
    })

    expect(decodeEventMarketReference(remoteReference)?.relayHints).toEqual([
      isolatedRelayUrl,
    ])

    await getEventMarket({
      reference: remoteReference,
      authenticatedPubkey: ORGANIZER,
    })

    expect(relayPlans.length).toBeGreaterThan(0)
    expect(
      relayPlans.every(
        (relayUrls) =>
          relayUrls.length === 1 && relayUrls[0] === isolatedRelayUrl
      )
    ).toBe(true)
    expect(
      ownerSelectedRelayPlans.every((relayUrls) => relayUrls.length === 0)
    ).toBe(true)
  })

  it("threads live account authority through exact and organizer Event Market reads", async () => {
    const ownerRelay = "ws://owner-event-market.example:4848"
    const shouldContinue = () => true
    const fanoutPredicates: Array<(() => boolean) | undefined> = []
    const relayListPredicates: Array<(() => boolean) | undefined> = []
    const [calendar, pickup, collection] = graph([PRODUCT])
    const product = productRevision(103, true)
    const relayListFor = (pubkey: string) => ({
      pubkey,
      readRelayUrls: [ORGANIZER_RELAY],
      writeRelayUrls: [ORGANIZER_RELAY],
      eventCreatedAt: 1,
      cachedAt: Date.now(),
    })

    __setEventMarketTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: {
          version: 1,
          updatedAt: 1,
          entries: [
            {
              url: ownerRelay,
              readEnabled: true,
              writeEnabled: true,
              section: "public",
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
            },
          ],
        },
        signedRelayListAuthoritative: true,
      }),
      getRelayListsDetailed: async (pubkeys, options = {}) => {
        relayListPredicates.push(options.shouldContinue)
        return {
          relayLists: new Map(
            pubkeys.map((pubkey) => [pubkey, relayListFor(pubkey)])
          ),
          resolutionStates: new Map(
            pubkeys.map((pubkey) => [pubkey, "network" as const])
          ),
        }
      },
      getRelayLists: async (pubkeys, options = {}) => {
        relayListPredicates.push(options.shouldContinue)
        return new Map(pubkeys.map((pubkey) => [pubkey, relayListFor(pubkey)]))
      },
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        fanoutPredicates.push(options.shouldContinue)
        const filter = rawFilter as TagFilter
        const isBroadOrganizerRead =
          (filter.kinds?.length ?? 0) > 1 &&
          filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION)
        let events: SignedPublicNostrEvent[] = []
        if (isBroadOrganizerRead) {
          events = [calendar, pickup, collection]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION
        ) {
          events = [collection]
        } else if (
          filter.kinds?.includes(EVENT_KINDS.CALENDAR_TIME) ||
          filter.kinds?.includes(EVENT_KINDS.CALENDAR_DATE)
        ) {
          events = [calendar]
        } else if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          events = [pickup]
        } else if (filter.kinds?.includes(EVENT_KINDS.PRODUCT)) {
          events = [product]
        }
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: isBroadOrganizerRead ? 500 : events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    const expectLiveAuthority = () => {
      expect(fanoutPredicates.length).toBeGreaterThan(6)
      expect(relayListPredicates.length).toBeGreaterThan(1)
      expect(
        fanoutPredicates.every((predicate) => predicate === shouldContinue)
      ).toBe(true)
      expect(
        relayListPredicates.every((predicate) => predicate === shouldContinue)
      ).toBe(true)
    }

    await getEventMarket({
      reference: COLLECTION,
      authenticatedPubkey: ORGANIZER,
      shouldContinue,
    })
    expectLiveAuthority()

    fanoutPredicates.length = 0
    relayListPredicates.length = 0
    await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      authenticatedPubkey: ORGANIZER,
      shouldContinue,
    })
    expectLiveAuthority()
  })

  it("backfills an enabled App relay after disabled Personal candidates", async () => {
    const personalRelayUrls = Array.from(
      { length: 6 },
      (_, index) => `wss://personal-event-market-${index}.example`
    )
    const appRelayUrls = Array.from(
      { length: 3 },
      (_, index) => `wss://app-event-market-${index}.example`
    )
    Object.assign(config, {
      appCommerceRelayUrls: [],
      commerceDiscoveryRelayUrls: [],
      appReadRelayUrls: appRelayUrls,
    })
    const localState = emptyAccountNetworkLocalState(MERCHANT, () => 1)
    localState.routingPolicy = {
      ...createDefaultAccountNetworkRoutingPolicy(),
      personalRelaysEnabled: false,
      personalRelaysTouched: true,
    }
    const repository = { get: async () => localState }
    const reads: Array<{
      candidates: string[]
      attempted: string[]
      maxRelayAttempts?: number
    }> = []
    const evidence = graph()

    __setEventMarketTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: {
          version: 1,
          updatedAt: 1,
          entries: personalRelayUrls.map((url) => ({
            url,
            readEnabled: true,
            writeEnabled: true,
            section: "public" as const,
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
      }),
      getRelayLists: async () => new Map(),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        const candidates = [...(options.relayUrls ?? [])]
        const eligible = await filterEligibleAccountRelayUrls({
          accountPubkey: options.accountPubkey ?? MERCHANT,
          authenticatedPubkey: options.authenticatedPubkey,
          candidateRelayUrls: candidates,
          ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
          appRelayUrls: options.appRelayUrls,
          personalRelayUrls: options.personalRelayUrls,
          repository,
        })
        const attempted = eligible.slice(
          0,
          options.maxRelayAttempts ?? eligible.length
        )
        reads.push({
          candidates,
          attempted,
          maxRelayAttempts: options.maxRelayAttempts,
        })
        const events = evidence.filter(
          (event) =>
            (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            ["a", "d", "e"].every((tagName) => {
              const values = filter[`#${tagName}` as "#a" | "#d" | "#e"]
              return (
                !values ||
                event.tags.some(
                  (tag) => tag[0] === tagName && values.includes(tag[1]!)
                )
              )
            })
        )
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: attempted.map((relayUrl) => ({
            relayUrl,
            status: relayUrl === appRelayUrls[2] ? "success" : "failed",
            eventCount: relayUrl === appRelayUrls[2] ? events.length : 0,
          })),
          eventsVerified: true,
        }
      },
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      includeParticipation: false,
      authenticatedPubkey: MERCHANT,
      accountNetworkLocalStateRepository: repository,
    })

    expect(reads.length).toBeGreaterThan(0)
    expect(reads[0]?.candidates.slice(0, 8)).toEqual([
      ...personalRelayUrls,
      ...appRelayUrls.slice(0, 2),
    ])
    expect(reads[0]?.candidates[8]).toBe(appRelayUrls[2])
    for (const read of reads) {
      expect(read.candidates).toContain(appRelayUrls[2])
      expect(read.maxRelayAttempts).toBe(8)
      expect(read.attempted.length).toBeLessThanOrEqual(8)
      expect(read.attempted).toContain(appRelayUrls[2])
      expect(
        read.attempted.some((relayUrl) => personalRelayUrls.includes(relayUrl))
      ).toBe(false)
    }
    expect(result.state).toBe("partial")
    expect(result.coverage.completeRelayCount).toBe(1)
    expect(result.coverage.failedRelayCount).toBe(2)
  })

  it("uses a verified candidate collection when the organizer read omits it", async () => {
    const [calendar, pickup, collection] = graph()
    const harness = cacheHarness()
    harness.setFetch([calendar!, pickup!], "success")

    const result = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
      projection: "discovery",
      relayHints: [ORGANIZER_RELAY],
      candidateCollectionEvents: [collection!],
      candidateCollectionSourceRelayUrlsById: new Map([
        [collection!.id, [ORGANIZER_RELAY]],
      ]),
    })

    expect(result.state).toBe("complete")
    expect(result.markets).toHaveLength(1)
    expect(result.markets[0]).toMatchObject({
      state: "active",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
    })
  })

  it("keeps a newer retained collection stale when only an older revision is live", async () => {
    const [calendar, pickup, retainedCollection] = graph()
    const liveCollection = sign(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Older live catalog",
        eventCoordinate: CALENDAR,
        pickupCoordinate: PICKUP,
      }),
      90
    )
    const harness = cacheHarness()
    harness.setFetch([calendar!, pickup!], "success")

    const result = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
      projection: "discovery",
      relayHints: [ORGANIZER_RELAY],
      candidateCollectionEvents: [retainedCollection!, liveCollection],
      candidateCollectionSourceRelayUrlsById: new Map([
        [retainedCollection!.id, [ORGANIZER_RELAY]],
        [liveCollection.id, [ORGANIZER_RELAY]],
      ]),
      candidateCollectionLiveEventIds: new Set([liveCollection.id]),
    })

    expect(result.state).toBe("complete")
    expect(result.markets).toHaveLength(1)
    expect(result.markets[0]).toMatchObject({
      state: "stale",
      collection: { eventId: retainedCollection!.id },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
    })
  })

  it("keeps a large valid event visible in the discovery-card projection", async () => {
    const productCoordinates = Array.from(
      { length: 65 },
      (_, index) => `${EVENT_KINDS.PRODUCT}:${MERCHANT}:product-${index}`
    )
    const harness = cacheHarness()
    harness.setFetch(graph(productCoordinates), "success")

    const result = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
      projection: "discovery",
    })

    expect(result.state).toBe("complete")
    expect(result.markets).toHaveLength(1)
    expect(result.markets[0]).toMatchObject({
      state: "active",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
      organizerProductCoordinates: [],
      participationBudget: { state: "within_budget", targetCount: 0 },
    })
  })

  it("discovers an older active catalog behind 500 newer organizer records", async () => {
    const [calendar, pickup, collection] = graph()
    const observedFilters: TagFilter[] = []
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [ORGANIZER_RELAY],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            },
          ])
        ),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        observedFilters.push(filter)
        let events: SignedPublicNostrEvent[] = []
        if (filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5) {
          events = SATURATED_ORGANIZER_PAGE
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          filter["#d"]?.includes("catalog")
        ) {
          events = [collection!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          !filter["#d"]
        ) {
          events = [collection!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.CALENDAR_TIME &&
          filter["#d"]?.includes("calendar")
        ) {
          events = [calendar!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === (EVENT_KINDS.SHIPPING_OPTION as never) &&
          filter["#d"]?.includes("pickup")
        ) {
          events = [pickup!]
        }
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    const markets = await getOrganizerEventMarkets({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })

    expect(markets).toHaveLength(1)
    expect(markets[0]).toMatchObject({
      state: "active",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
    })
    expect(
      observedFilters.some(
        (filter) =>
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          !filter["#d"]
      )
    ).toBe(true)
    expect(
      observedFilters.some(
        (filter) =>
          filter.kinds?.[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          filter["#d"]?.includes("catalog")
      )
    ).toBe(true)
  })

  it("recovers a hidden catalog from a relay that failed the saturated broad read", async () => {
    const recoveryRelay = "wss://relay.plebeian.market"
    const [calendar, pickup, collection] = graph()
    const collectionDiscoveryRelayPlans: string[][] = []
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [ORGANIZER_RELAY, recoveryRelay],
              writeRelayUrls: [ORGANIZER_RELAY, recoveryRelay],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            },
          ])
        ),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        const broadRead =
          filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5
        const collectionDiscovery =
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          !filter["#d"]
        if (collectionDiscovery) {
          collectionDiscoveryRelayPlans.push([...(options.relayUrls ?? [])])
        }
        let events: SignedPublicNostrEvent[] = []
        if (broadRead) {
          events = SATURATED_ORGANIZER_PAGE
        } else if (collectionDiscovery) {
          events = [collection!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          filter["#d"]?.includes("catalog")
        ) {
          events = [collection!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.CALENDAR_TIME &&
          filter["#d"]?.includes("calendar")
        ) {
          events = [calendar!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === (EVENT_KINDS.SHIPPING_OPTION as never) &&
          filter["#d"]?.includes("pickup")
        ) {
          events = [pickup!]
        }
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status:
              broadRead && relayUrl.startsWith(recoveryRelay)
                ? ("failed" as const)
                : ("success" as const),
            eventCount:
              broadRead && relayUrl.startsWith(recoveryRelay)
                ? 0
                : collectionDiscovery
                  ? relayUrl.startsWith(recoveryRelay)
                    ? events.length
                    : 0
                  : events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    const markets = await getOrganizerEventMarkets({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })

    expect(markets).toHaveLength(1)
    expect(markets[0]).toMatchObject({
      state: "partial",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
      coverage: {
        partialRelayCount: 1,
        failedRelayCount: 0,
      },
    })
    expect(markets[0]?.coverage.attemptedRelayCount).toBeGreaterThan(1)
    expect(collectionDiscoveryRelayPlans).toHaveLength(1)
    expect(collectionDiscoveryRelayPlans[0]!.length).toBeGreaterThan(1)
    expect(
      collectionDiscoveryRelayPlans[0]?.some((relayUrl) =>
        relayUrl.startsWith(recoveryRelay)
      )
    ).toBe(true)
  })

  it("preserves a discovered catalog when another collection relay is unavailable", async () => {
    const unavailableRelay = "wss://relay.plebeian.market"
    const { collectionDiscoveryRelayPlans } =
      saturatedCollectionDiscoveryHarness({
        discoveryStatus: (relayUrl) =>
          relayUrl.startsWith(unavailableRelay) ? "failed" : "success",
      })

    const markets = await getOrganizerEventMarkets({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })

    expect(markets).toHaveLength(1)
    expect(collectionDiscoveryRelayPlans).toEqual([
      expect.arrayContaining([expect.stringContaining(unavailableRelay)]),
    ])
    expect(markets[0]).toMatchObject({
      state: "partial",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
      coverage: {
        partialRelayCount: 1,
        failedRelayCount: 0,
      },
    })
  })

  it("preserves verified catalog evidence when no collection relay reaches EOSE", async () => {
    const unavailableRelay = "wss://relay.plebeian.market"
    const { collectionDiscoveryStatuses } = saturatedCollectionDiscoveryHarness(
      {
        discoveryStatus: (relayUrl) =>
          relayUrl.startsWith(unavailableRelay) ? "failed" : "partial",
      }
    )

    const markets = await getOrganizerEventMarkets({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })

    expect(collectionDiscoveryStatuses).toContain("partial")
    expect(collectionDiscoveryStatuses).toContain("failed")
    expect(collectionDiscoveryStatuses).not.toContain("success")
    expect(markets).toHaveLength(1)
    expect(markets[0]).toMatchObject({
      state: "partial",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
      coverage: {
        completeRelayCount: 0,
        failedRelayCount: 0,
      },
    })
    expect(markets[0]?.coverage.partialRelayCount).toBeGreaterThan(0)
  })

  it("fails visibly when incomplete saturated discovery has no usable catalog", async () => {
    const unavailableRelay = "wss://relay.plebeian.market"
    saturatedCollectionDiscoveryHarness({
      discoveryEvents: [],
      discoveryStatus: (relayUrl) =>
        relayUrl.startsWith(unavailableRelay) ? "failed" : "success",
    })

    await expect(
      getOrganizerEventMarkets({
        organizerPubkey: ORGANIZER,
        nowMs: 1_750_000_000_000,
      })
    ).rejects.toThrow("collection discovery did not complete")
  })

  it("fails closed when saturated collection evidence is unverified", async () => {
    saturatedCollectionDiscoveryHarness({ eventsVerified: false })

    await expect(
      getOrganizerEventMarkets({
        organizerPubkey: ORGANIZER,
        nowMs: 1_750_000_000_000,
      })
    ).rejects.toThrow("collection discovery did not complete")
  })

  it("retains cached catalog evidence when new saturated discovery is unverified", async () => {
    const cachedEvents = graph()
    const unverifiedCollection = sign(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Unverified replacement",
        eventCoordinate: CALENDAR,
        pickupCoordinate: PICKUP,
      }),
      200
    )
    const cachedRecords = cachedEvents.map(
      (event): CachedEventMarketEvidence => ({
        id: event.id.toLowerCase(),
        organizerPubkey: ORGANIZER,
        kind: event.kind,
        signedEvent: event,
        sourceRelayUrls: [ORGANIZER_RELAY],
        cachedAt: 1_700_000_000_000,
      })
    )
    const { persistedEventIds } = saturatedCollectionDiscoveryHarness({
      cachedRecords,
      discoveryEvents: [unverifiedCollection],
      eventsVerified: false,
      includeExactRecords: false,
    })

    const markets = await getOrganizerEventMarkets({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })

    expect(markets).toHaveLength(1)
    expect(markets[0]).toMatchObject({
      state: "stale",
      collection: {
        coordinate: COLLECTION,
        title: "Market catalog",
      },
      coverage: {
        failedRelayCount: 0,
      },
    })
    expect(markets[0]?.coverage.partialRelayCount).toBeGreaterThan(0)
    expect(persistedEventIds).not.toContain(
      unverifiedCollection.id.toLowerCase()
    )
  })

  it("fails visibly when saturated collection discovery exceeds its budget", async () => {
    const collectionEvents = Array.from({ length: 65 }, (_, index) =>
      sign(
        buildEventMarketCollectionDraft({
          dTag: `catalog-${index}`,
          title: `Catalog ${index}`,
          eventCoordinate: CALENDAR,
        }),
        2_000 + index
      )
    )
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [ORGANIZER_RELAY],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            },
          ])
        ),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        const events =
          filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5
            ? SATURATED_ORGANIZER_PAGE
            : filter.kinds?.length === 1 &&
                filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
                !filter["#d"]
              ? collectionEvents
              : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    await expect(
      getOrganizerEventMarkets({
        organizerPubkey: ORGANIZER,
        nowMs: 1_750_000_000_000,
      })
    ).rejects.toThrow("bounded collection scan")
  })

  it("fails visibly when saturated collection discovery is unavailable", async () => {
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [ORGANIZER_RELAY],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            },
          ])
        ),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        const broadRead =
          filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5
        const events = broadRead ? SATURATED_ORGANIZER_PAGE : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: broadRead ? ("success" as const) : ("failed" as const),
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    await expect(
      getOrganizerEventMarkets({
        organizerPubkey: ORGANIZER,
        nowMs: 1_750_000_000_000,
      })
    ).rejects.toThrow("collection discovery did not complete")
  })

  it("bounds exact calendar recovery after saturated list discovery", async () => {
    const collection = sign(
      {
        kind: EVENT_KINDS.PRODUCT_COLLECTION,
        content: "",
        tags: [
          ["d", "catalog"],
          ["title", "Conflicting calendar catalog"],
          ...Array.from({ length: 65 }, (_, index) => [
            "a",
            `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER}:calendar-${index}`,
          ]),
        ],
      },
      2_000
    )
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [ORGANIZER_RELAY],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            },
          ])
        ),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        const events =
          filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5
            ? SATURATED_ORGANIZER_PAGE
            : filter.kinds?.length === 1 &&
                filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION
              ? [collection]
              : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    await expect(
      getOrganizerEventMarkets({
        organizerPubkey: ORGANIZER,
        nowMs: 1_750_000_000_000,
      })
    ).rejects.toThrow("bounded calendar frontier")
  })

  it("recovers an exact catalog frontier when 500 newer organizer records fill the broad read", async () => {
    const [calendar, pickup, collection] = graph()
    const unrelated = Array.from({ length: 501 }, (_, index) =>
      sign(
        buildEventMarketCalendarDraft({
          kind: EVENT_KINDS.CALENDAR_TIME,
          dTag: `unrelated-${index}`,
          title: `Unrelated event ${index}`,
          start: 1_900_000_000 + index,
        }),
        1_000 + index
      )
    )
    const broadPage = unrelated.slice(1)
    const observedFilters: TagFilter[] = []
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [ORGANIZER_RELAY],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            },
          ])
        ),
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        observedFilters.push(filter)
        let events: SignedPublicNostrEvent[] = []
        if (filter.authors?.includes(ORGANIZER) && filter.kinds?.length === 5) {
          events = broadPage
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          filter["#d"]?.includes("catalog")
        ) {
          events = [collection!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.CALENDAR_TIME &&
          filter["#d"]?.includes("calendar")
        ) {
          events = [calendar!]
        } else if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === (EVENT_KINDS.SHIPPING_OPTION as never) &&
          filter["#d"]?.includes("pickup")
        ) {
          events = [pickup!]
        }
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })

    const resolution = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })

    expect(resolution).toMatchObject({
      state: "active",
      collection: { coordinate: COLLECTION },
      calendar: { coordinate: CALENDAR },
      pickup: { coordinate: PICKUP },
    })
    expect(
      observedFilters.some(
        (filter) =>
          filter.kinds?.[0] === EVENT_KINDS.PRODUCT_COLLECTION &&
          filter["#d"]?.includes("catalog")
      )
    ).toBe(true)
    expect(
      observedFilters.some(
        (filter) =>
          filter.kinds?.[0] === EVENT_KINDS.CALENDAR_TIME &&
          filter["#d"]?.includes("calendar")
      )
    ).toBe(true)
    expect(
      observedFilters.some(
        (filter) =>
          filter.kinds?.[0] === EVENT_KINDS.DELETION &&
          filter["#a"]?.includes(COLLECTION)
      )
    ).toBe(true)
    expect(
      observedFilters.some(
        (filter) =>
          filter.kinds?.[0] === EVENT_KINDS.DELETION &&
          filter["#a"]?.includes(CALENDAR)
      )
    ).toBe(true)
  })

  it("resolves live and partial merchant booth pickup frontiers", async () => {
    const harness = merchantPickupCacheHarness()
    const live = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(live.state).toBe("active")
    expect(
      resolveEventMarketProductFulfillment(
        {
          id: PRODUCT,
          shippingOptionRefs: [{ coordinate: MERCHANT_PICKUP }],
        },
        live
      )
    ).toMatchObject({
      status: "resolved",
      handoffMode: "merchant_handoff",
      handoffPubkey: MERCHANT,
    })

    harness.setPickupRead({
      events: [merchantPickupEvent()],
      status: "partial",
    })
    const partial = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(partial.state).toBe("partial")
    expect(partial.pickups).toHaveLength(1)
  })

  it("keeps a missing degraded direct booth fail-closed for that product", async () => {
    const harness = merchantPickupCacheHarness()
    harness.setPickupRead({ status: "failed" })

    const market = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })

    expect(market.state).toBe("partial")
    expect(market.acceptedProductCoordinates).toEqual([PRODUCT])
    expect(market.pickups).toEqual([])
    expect(
      resolveEventMarketProductFulfillment(
        {
          id: PRODUCT,
          shippingOptionRefs: [{ coordinate: MERCHANT_PICKUP }],
        },
        market
      )
    ).toMatchObject({
      status: "ambiguous",
      reason: "missing_pickup_evidence",
    })
  })

  it("keeps a malformed direct booth terminal across a mounted cache reload", async () => {
    const currentPickup = merchantPickupEvent()
    const malformedPickup = signAs(
      MERCHANT_SECRET,
      {
        kind: currentPickup.kind,
        content: currentPickup.content,
        tags: currentPickup.tags.filter((tag) => tag[0] !== "service"),
      },
      currentPickup.created_at + 1
    )
    const harness = merchantPickupCacheHarness()
    harness.setPickupRead({ events: [malformedPickup] })

    const fresh = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(
      fresh.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "malformed_pickup_evidence",
    })

    harness.setPickupRead({ status: "failed" })
    const reloaded = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(
      reloaded.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "malformed_pickup_evidence",
    })
  })

  it("retains bounded merchant pickup evidence only as stale across reload", async () => {
    const harness = merchantPickupCacheHarness()
    const unrelated = merchantPickupEvent(101, "unrelated")
    harness.setPickupRead({ events: [merchantPickupEvent(), unrelated] })
    await expect(
      getEventMarket({ reference: COLLECTION, nowMs: 1_750_000_000_000 })
    ).resolves.toMatchObject({ state: "active" })
    expect(
      harness.rows().some((row) => row.signedEvent.id === unrelated.id)
    ).toBe(false)

    harness.setPickupRead({ status: "failed" })
    const reloaded = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(reloaded.state).toBe("stale")
    expect(reloaded.pickups[0]?.coordinate).toBe(MERCHANT_PICKUP)
  })

  it("keeps a live merchant pickup actionable when another merchant pickup is retained", async () => {
    const otherSecret = generateSecretKey()
    const otherMerchant = getPublicKey(otherSecret)
    const otherProduct = `${EVENT_KINDS.PRODUCT}:${otherMerchant}:tea`
    const otherPickup = `${EVENT_KINDS.SHIPPING_OPTION}:${otherMerchant}:booth`
    const records = [
      ...merchantPickupGraph().filter(
        (event) => event.kind !== EVENT_KINDS.PRODUCT_COLLECTION
      ),
      sign(
        buildEventMarketCollectionDraft({
          dTag: "catalog",
          title: "Market catalog",
          eventCoordinate: CALENDAR,
          productCoordinates: [PRODUCT, otherProduct],
        }),
        102
      ),
      merchantPickupProductRevision(),
      merchantPickupEvent(),
      signAs(
        otherSecret,
        {
          kind: EVENT_KINDS.PRODUCT,
          tags: [
            ["d", "tea"],
            ["title", "Tea"],
            ["price", "25", "USD"],
            ["a", COLLECTION],
            ["shipping_option", otherPickup],
          ],
        },
        100
      ),
      signAs(
        otherSecret,
        buildEventMarketPickupDraft({
          dTag: "booth",
          title: "Tea booth",
          price: 0,
          currency: "SATS",
          countries: ["US"],
          location: "Public market hall",
        }),
        101
      ),
    ]
    cacheHarness()
    let otherPickupRead: "live" | "failed" | "empty" = "live"
    const readFilters: TagFilter[] = []
    __setEventMarketTestOverrides({
      fetchEventsFanoutDetailed: async (rawFilter, options) => {
        const filter = rawFilter as TagFilter
        readFilters.push(filter)
        const omitted =
          otherPickupRead !== "live" &&
          !!filter.authors?.includes(otherMerchant) &&
          !!filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION as never)
        const failed = omitted && otherPickupRead === "failed"
        const events = omitted
          ? []
          : records.filter(
              (event) =>
                (!filter.kinds || filter.kinds.includes(event.kind as never)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                ["a", "d", "e"].every((tagName) => {
                  const values = filter[`#${tagName}` as "#a" | "#d" | "#e"]
                  return (
                    !values ||
                    event.tags.some(
                      (tag) => tag[0] === tagName && values.includes(tag[1]!)
                    )
                  )
                })
            )
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: failed ? ("failed" as const) : ("success" as const),
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      },
    })
    await expect(
      getEventMarket({ reference: COLLECTION, nowMs: 1_750_000_000_000 })
    ).resolves.toMatchObject({ state: "active" })

    readFilters.length = 0
    const selected = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(selected.acceptedProductCoordinates).toEqual([PRODUCT])
    expect(selected.pickups.map((pickup) => pickup.coordinate)).toEqual([
      MERCHANT_PICKUP,
    ])
    expect(
      readFilters.some((filter) => filter.authors?.includes(otherMerchant))
    ).toBe(false)

    const productEvents = records.filter(
      (event) => event.kind === EVENT_KINDS.PRODUCT
    )
    for (const nextRead of ["failed", "empty", "live"] as const) {
      otherPickupRead = nextRead
      const reloaded = await getEventMarket({
        reference: COLLECTION,
        nowMs: 1_750_000_000_000,
      })
      for (const event of productEvents) {
        const product = parseProductEvent(event)
        const expectedReady = event.pubkey === MERCHANT || nextRead === "live"
        expect(
          reloaded.acceptedProductEvidence.find(
            (evidence) => evidence.productCoordinate === product.id
          )?.fulfillmentStatus
        ).toBe(expectedReady ? "resolved" : "ambiguous")
        expect(
          resolveEventMarketProductParticipation(product, reloaded)
            .purchaseReady
        ).toBe(expectedReady)
        const terms = buildPickupFulfillmentTerms(product, reloaded, {
          eventId: event.id,
          eventCreatedAt: event.created_at,
        })
        if (expectedReady) {
          expect(terms?.option.coordinate).toBe(
            event.pubkey === MERCHANT ? MERCHANT_PICKUP : otherPickup
          )
        } else {
          expect(terms).toBeNull()
        }
      }
    }
  })

  it("retains same-author merchant pickup deletion across reload", async () => {
    const pickup = merchantPickupEvent()
    const deletion = signAs(
      MERCHANT_SECRET,
      {
        kind: EVENT_KINDS.DELETION,
        tags: [["a", MERCHANT_PICKUP]],
      },
      200
    )
    const harness = merchantPickupCacheHarness()
    harness.setPickupRead({ events: [pickup], deletions: [deletion] })
    const deleted = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(deleted.state).toBe("active")
    expect(
      resolveEventMarketProductFulfillment(
        {
          id: PRODUCT,
          shippingOptionRefs: [{ coordinate: MERCHANT_PICKUP }],
        },
        deleted
      )
    ).toMatchObject({
      status: "ambiguous",
      reason: "missing_pickup_evidence",
    })
    expect(
      deleted.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "deleted_pickup_evidence",
    })

    harness.setPickupRead({ events: [pickup] })
    const reloaded = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(reloaded.state).toBe("active")
    expect(reloaded.pickups).toEqual([])
    expect(
      reloaded.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "deleted_pickup_evidence",
    })
  })

  it("does not relax a complete pickup deletion when another coordinate saturates", async () => {
    const otherSecret = generateSecretKey()
    const otherMerchant = getPublicKey(otherSecret)
    const otherProduct = `${EVENT_KINDS.PRODUCT}:${otherMerchant}:tea`
    const otherPickup = `${EVENT_KINDS.SHIPPING_OPTION}:${otherMerchant}:stand`
    const [calendar] = graph()
    const collection = sign(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Market catalog",
        eventCoordinate: CALENDAR,
        productCoordinates: [PRODUCT, otherProduct],
      }),
      102
    )
    const otherProductRequest = signAs(
      otherSecret,
      {
        kind: EVENT_KINDS.PRODUCT,
        tags: [
          ["d", "tea"],
          ["title", "Tea"],
          ["price", "10", "USD"],
          ["a", COLLECTION],
          ["shipping_option", otherPickup],
        ],
      },
      103
    )
    const saturatedPickupRevisions = Array.from({ length: 4 }, (_, index) =>
      merchantPickupEvent(110 + index)
    )
    const deletedPickup = signAs(
      otherSecret,
      buildEventMarketPickupDraft({
        dTag: "stand",
        title: "Tea stand",
        price: 0,
        currency: "SATS",
        countries: ["US"],
        location: "Public market hall",
      }),
      110
    )
    const deletion = signAs(
      otherSecret,
      {
        kind: EVENT_KINDS.DELETION,
        tags: [["e", deletedPickup.id]],
      },
      120
    )
    coordinateScopedSaturationHarness([
      calendar!,
      collection,
      merchantPickupProductRevision(103),
      otherProductRequest,
      ...saturatedPickupRevisions,
      deletedPickup,
      deletion,
    ])

    const resolution = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT, otherProduct],
      nowMs: 1_750_000_000_000,
    })

    expect(resolution.state).toBe("active")
    expect(
      resolution.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "resolved",
      pickupCoordinate: MERCHANT_PICKUP,
    })
    expect(
      resolution.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === otherProduct
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "deleted_pickup_evidence",
    })
  })

  it("does not relax a complete product deletion when another coordinate saturates", async () => {
    const otherSecret = generateSecretKey()
    const otherMerchant = getPublicKey(otherSecret)
    const otherProduct = `${EVENT_KINDS.PRODUCT}:${otherMerchant}:tea`
    const [calendar, pickup] = graph()
    const collection = sign(
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Market catalog",
        eventCoordinate: CALENDAR,
        pickupCoordinate: PICKUP,
        productCoordinates: [PRODUCT, otherProduct],
      }),
      102
    )
    const saturatedProductRevisions = Array.from({ length: 4 }, (_, index) =>
      productRevision(110 + index, true)
    )
    const deletedProduct = signAs(
      otherSecret,
      {
        kind: EVENT_KINDS.PRODUCT,
        tags: [
          ["d", "tea"],
          ["title", "Tea"],
          ["price", "10", "USD"],
          ["a", COLLECTION],
          ["shipping_option", PICKUP],
        ],
      },
      110
    )
    const deletion = signAs(
      otherSecret,
      {
        kind: EVENT_KINDS.DELETION,
        tags: [["e", deletedProduct.id]],
      },
      120
    )
    coordinateScopedSaturationHarness([
      calendar!,
      pickup!,
      collection,
      ...saturatedProductRevisions,
      deletedProduct,
      deletion,
    ])

    const resolution = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT, otherProduct],
      nowMs: 1_750_000_000_000,
    })

    expect(resolution.state).toBe("active")
    expect(resolution.acceptedProductCoordinates).toEqual([PRODUCT])
    expect(resolution.organizerOnlyProductCoordinates).toEqual([otherProduct])
    expect(resolution.browseExcludedProductCoordinates).toEqual([otherProduct])
  })

  it("keeps a saturated selected pickup frontier recoverable until an older live revision is observed", async () => {
    const pickupRevisions = Array.from({ length: 5 }, (_, index) =>
      merchantPickupEvent(100 + index)
    )
    const survivingPickup = pickupRevisions[0]!
    const saturatedFrontier = pickupRevisions.slice(1)
    const deletions = saturatedFrontier.map((pickup, index) =>
      signAs(
        MERCHANT_SECRET,
        {
          kind: EVENT_KINDS.DELETION,
          tags: [["e", pickup.id]],
        },
        200 + index
      )
    )
    const harness = merchantPickupCacheHarness()
    harness.setPickupRead({ events: saturatedFrontier, deletions })

    const degraded = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(degraded.state).toBe("partial")
    expect(
      degraded.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "missing_pickup_evidence",
    })

    harness.setPickupRead({ events: [survivingPickup] })
    const recovered = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(recovered.state).toBe("active")
    expect(recovered.pickups).toEqual([
      expect.objectContaining({ eventId: survivingPickup.id }),
    ])
    expect(
      recovered.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "resolved",
      pickupCoordinate: MERCHANT_PICKUP,
    })
  })

  it("keeps a current malformed pickup terminal when its exact frontier is saturated", async () => {
    const currentPickup = merchantPickupEvent(200)
    const malformedPickup = signAs(
      MERCHANT_SECRET,
      {
        kind: currentPickup.kind,
        content: currentPickup.content,
        tags: currentPickup.tags.filter((tag) => tag[0] !== "service"),
      },
      currentPickup.created_at + 1
    )
    const harness = merchantPickupCacheHarness()
    harness.setPickupRead({
      events: [
        malformedPickup,
        merchantPickupEvent(102),
        merchantPickupEvent(101),
        merchantPickupEvent(100),
      ],
    })

    const resolution = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(resolution.state).toBe("active")
    expect(
      resolution.acceptedProductEvidence.find(
        (evidence) => evidence.productCoordinate === PRODUCT
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "malformed_pickup_evidence",
    })
  })

  it("keeps a saturated selected product frontier retryable until an older live request is observed", async () => {
    const productRevisions = Array.from({ length: 5 }, (_, index) =>
      productRevision(100 + index, true)
    )
    const survivingRequest = productRevisions[0]!
    const saturatedFrontier = productRevisions.slice(1)
    const deletions = saturatedFrontier.map((product, index) =>
      signAs(
        MERCHANT_SECRET,
        {
          kind: EVENT_KINDS.DELETION,
          tags: [["e", product.id]],
        },
        200 + index
      )
    )
    const harness = participationCacheHarness()
    harness.setRead({
      discovery: saturatedFrontier,
      frontier: saturatedFrontier,
      deletions,
    })

    const degraded = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(degraded.state).toBe("partial")
    expect(degraded.acceptedProductCoordinates).toEqual([])

    harness.setRead({
      discovery: [survivingRequest],
      frontier: [survivingRequest],
    })
    const recovered = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(recovered.state).toBe("active")
    expect(recovered.acceptedProductEvidence).toEqual([
      expect.objectContaining({
        productCoordinate: PRODUCT,
        eventId: survivingRequest.id,
      }),
    ])
  })

  it("keeps a current signed withdrawal terminal when its product frontier is saturated", async () => {
    const withdrawal = productRevision(200, false)
    const harness = participationCacheHarness()
    harness.setRead({
      discovery: [withdrawal],
      frontier: [
        withdrawal,
        productRevision(102, true),
        productRevision(101, true),
        productRevision(100, true),
      ],
    })

    const resolution = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(resolution.state).toBe("active")
    expect(resolution.acceptedProductCoordinates).toEqual([])
    expect(resolution.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })

  it("keeps a saturated selected organizer frontier degraded until an older live collection is observed", async () => {
    const collectionRevisions = Array.from({ length: 5 }, (_, index) =>
      sign(
        buildEventMarketCollectionDraft({
          dTag: "catalog",
          title: `Market catalog ${index}`,
          eventCoordinate: CALENDAR,
          pickupCoordinate: PICKUP,
          productCoordinates: [PRODUCT],
        }),
        110 + index
      )
    )
    const survivingCollection = collectionRevisions[0]!
    const saturatedFrontier = collectionRevisions.slice(1)
    const deletions = saturatedFrontier.map((collection, index) =>
      sign(
        {
          kind: EVENT_KINDS.DELETION,
          content: "",
          tags: [["e", collection.id]],
        },
        200 + index
      )
    )
    const harness = organizerFrontierCacheHarness()
    harness.setRead({ collections: saturatedFrontier, deletions })

    const degraded = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(degraded.state).toBe("partial")
    expect(degraded.collection).toBeUndefined()

    harness.setRead({ collections: [survivingCollection] })
    const recovered = await getEventMarket({
      reference: COLLECTION,
      selectedProductCoordinates: [PRODUCT],
      nowMs: 1_750_000_000_000,
    })
    expect(recovered.state).toBe("active")
    expect(recovered.collection?.eventId).toBe(survivingCollection.id)
  })

  it("keeps a saturated organizer-list frontier degraded until an older live collection is observed", async () => {
    const collectionRevisions = Array.from({ length: 5 }, (_, index) =>
      sign(
        buildEventMarketCollectionDraft({
          dTag: "catalog",
          title: `Market catalog ${index}`,
          eventCoordinate: CALENDAR,
          pickupCoordinate: PICKUP,
          productCoordinates: [PRODUCT],
        }),
        110 + index
      )
    )
    const survivingCollection = collectionRevisions[0]!
    const saturatedFrontier = collectionRevisions.slice(1)
    const deletions = saturatedFrontier.map((collection, index) =>
      sign(
        {
          kind: EVENT_KINDS.DELETION,
          content: "",
          tags: [["e", collection.id]],
        },
        200 + index
      )
    )
    const harness = organizerFrontierCacheHarness()
    harness.setRead({ collections: saturatedFrontier, deletions })

    const degraded = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })
    expect(degraded.markets).toHaveLength(1)
    expect(degraded.markets[0]).toMatchObject({
      state: "partial",
      deletion: { record: "collection" },
    })

    harness.setRead({ collections: [survivingCollection] })
    const recovered = await getOrganizerEventMarketsDetailed({
      organizerPubkey: ORGANIZER,
      nowMs: 1_750_000_000_000,
    })
    expect(recovered.markets).toHaveLength(1)
    expect(recovered.markets[0]).toMatchObject({
      state: "active",
      collection: { eventId: survivingCollection.id },
    })
  })

  it("keeps a coordinate deletion terminal when an exact organizer frontier is saturated", async () => {
    const saturatedFrontier = Array.from({ length: 4 }, (_, index) =>
      sign(
        buildEventMarketCollectionDraft({
          dTag: "catalog",
          title: `Deleted market catalog ${index}`,
          eventCoordinate: CALENDAR,
          pickupCoordinate: PICKUP,
        }),
        110 + index
      )
    )
    const coordinateDeletion = sign(
      {
        kind: EVENT_KINDS.DELETION,
        content: "",
        tags: [["a", COLLECTION]],
      },
      200
    )
    const harness = organizerFrontierCacheHarness()
    harness.setRead({
      collections: saturatedFrontier,
      deletions: [coordinateDeletion],
    })

    await expect(
      getEventMarket({
        reference: COLLECTION,
        selectedProductCoordinates: [PRODUCT],
        nowMs: 1_750_000_000_000,
      })
    ).resolves.toMatchObject({ state: "deleted" })
  })

  it("does not resurrect a collection when a later relay read omits deletion", async () => {
    const records = graph()
    const deletion = sign(
      {
        kind: EVENT_KINDS.DELETION,
        content: "",
        tags: [["a", COLLECTION]],
      },
      103
    )
    const harness = cacheHarness()
    harness.setFetch([...records, deletion], "success")

    await expect(
      getEventMarket({ reference: COLLECTION, nowMs: 1_750_000_000_000 })
    ).resolves.toMatchObject({ state: "deleted" })

    harness.setFetch(records, "success")
    await expect(
      getEventMarket({ reference: COLLECTION, nowMs: 1_750_000_000_000 })
    ).resolves.toMatchObject({ state: "deleted" })
  })

  it("exposes retained records as stale when all live relays fail", async () => {
    const cached = graph().map((event): CachedEventMarketEvidence => ({
      id: event.id,
      organizerPubkey: ORGANIZER,
      kind: event.kind,
      signedEvent: event,
      sourceRelayUrls: ["wss://write.example"],
      cachedAt: 1_700_000_000_000,
    }))
    const harness = cacheHarness(cached)
    harness.setFetch([], "failed")

    const resolution = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(resolution.state).toBe("stale")
    expect(resolution.collection?.coordinate).toBe(COLLECTION)
    expect(resolution.calendar?.coordinate).toBe(CALENDAR)
    expect(resolution.pickup?.coordinate).toBe(PICKUP)
  })

  it("keeps same-author coordinate and exact-event request tombstones across reloads", async () => {
    for (const target of ["coordinate", "event"] as const) {
      const request = productRevision(100, true)
      const deletion = signAs(
        MERCHANT_SECRET,
        {
          kind: EVENT_KINDS.DELETION,
          tags: [
            [
              target === "coordinate" ? "a" : "e",
              target === "coordinate" ? PRODUCT : request.id,
            ],
          ],
        },
        200
      )
      const harness = participationCacheHarness()
      harness.setRead({
        discovery: [request],
        frontier: [request],
        deletions: [deletion],
      })
      const first = await getEventMarket({
        reference: COLLECTION,
        nowMs: 1_750_000_000_000,
      })
      expect(first.acceptedProductCoordinates).toEqual([])

      // The next complete relay view still has the old positive request but
      // omits the already-observed deletion. Retained deletion evidence wins.
      harness.setRead({ discovery: [request], frontier: [request] })
      const reloaded = await getEventMarket({
        reference: COLLECTION,
        nowMs: 1_750_000_000_000,
      })
      expect(reloaded.acceptedProductCoordinates).toEqual([])
      expect(reloaded.organizerOnlyProductCoordinates).toEqual([PRODUCT])
    }
  })

  it("keeps a newer signed withdrawal when a later relay view returns only the old request", async () => {
    const request = productRevision(100, true)
    const withdrawal = productRevision(200, false)
    const harness = participationCacheHarness()
    harness.setRead({ discovery: [request], frontier: [withdrawal] })

    await expect(
      getEventMarket({
        reference: COLLECTION,
        nowMs: 1_750_000_000_000,
      })
    ).resolves.toMatchObject({ acceptedProductCoordinates: [] })

    harness.setRead({ discovery: [request], frontier: [request] })
    const reloaded = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(reloaded.acceptedProductCoordinates).toEqual([])
    expect(reloaded.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })

  it("never authorizes from a cached positive request alone", async () => {
    const request = productRevision(100, true)
    const harness = participationCacheHarness()
    harness.setRead({ discovery: [request], frontier: [request] })

    const live = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(live.acceptedProductCoordinates).toEqual([PRODUCT])

    harness.setRead({ discovery: [], frontier: [] })
    const cachedOnlyRequest = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(cachedOnlyRequest.acceptedProductCoordinates).toEqual([])
    expect(cachedOnlyRequest.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })
})
