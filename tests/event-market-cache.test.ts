import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  EVENT_KINDS,
  getEventMarket,
  resolveEventMarketProductFulfillment,
  type CachedEventMarketEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const SECRET = new Uint8Array(32).fill(41)
const MERCHANT_SECRET = new Uint8Array(32).fill(42)
const ORGANIZER = getPublicKey(SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const COLLECTION = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER}:catalog`
const CALENDAR = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER}:calendar`
const PICKUP = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER}:pickup`
const MERCHANT_PICKUP = `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT}:booth`
const PRODUCT = `${EVENT_KINDS.PRODUCT}:${MERCHANT}:coffee`
const ORGANIZER_RELAY = "wss://organizer-write.example"
const MERCHANT_RELAY = "wss://merchant-write.example"

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
        filter.kinds?.includes(EVENT_KINDS.PRODUCT_COLLECTION as never)
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

afterEach(() => __resetEventMarketTestOverrides())

describe("event-market retained evidence", () => {
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

    harness.setPickupRead({ events: [pickup] })
    const reloaded = await getEventMarket({
      reference: COLLECTION,
      nowMs: 1_750_000_000_000,
    })
    expect(reloaded.state).toBe("active")
    expect(reloaded.pickups).toEqual([])
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
