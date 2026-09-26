import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { matchFilter, type Filter } from "nostr-tools"

import {
  __resetEventMarketTestOverrides,
  __resetNdkTestState,
  __resetRelayHealth,
  __setEventMarketTestOverrides,
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  EVENT_MARKET_PARTICIPATION_DELETION_TARGET_LIMIT,
  EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
  EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT,
  EVENT_KINDS,
  getEventMarket,
  isRelayInCooldown,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { resolveOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"

const ORGANIZER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const COLLECTION = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER}:catalog`
const CALENDAR = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER}:calendar`
const PICKUP = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER}:pickup`
const PRODUCT = `${EVENT_KINDS.PRODUCT}:${MERCHANT}:coffee`
const RELAY_A = "wss://conduit-congee.fly.dev"
const RELAY_B = "wss://relay.plebeian.market"
const MERCHANT_RELAY = "wss://merchant-write.relay.dev"
const NOW_MS = 1_800_000_100_000

type TagFilter = NDKFilter & {
  "#a"?: string[]
  "#d"?: string[]
  "#e"?: string[]
}

type ReadHarnessOptions = {
  maxRelayAttempts?: number
  independentRelayUrls?: readonly string[]
  ownerSelectedRelayUrls?: readonly string[]
}

function sign(
  secret: Uint8Array,
  event: { kind: number; content?: string; tags: string[][] },
  createdAt: number
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: event.kind,
      content: event.content ?? "",
      tags: event.tags,
      created_at: createdAt,
    },
    secret
  )
}

function graph(
  productCoordinates: readonly string[] = [PRODUCT],
  includeOrganizerPickup = true
): SignedPublicNostrEvent[] {
  return [
    sign(
      ORGANIZER_SECRET,
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
    ...(includeOrganizerPickup
      ? [
          sign(
            ORGANIZER_SECRET,
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
        ]
      : []),
    sign(
      ORGANIZER_SECRET,
      buildEventMarketCollectionDraft({
        dTag: "catalog",
        title: "Market catalog",
        eventCoordinate: CALENDAR,
        ...(includeOrganizerPickup ? { pickupCoordinate: PICKUP } : {}),
        productCoordinates: [...productCoordinates],
      }),
      102
    ),
  ]
}

function productRevision(
  dTag: string,
  createdAt: number,
  requestsCollection: boolean,
  pickupCoordinate = PICKUP
): SignedPublicNostrEvent {
  return sign(
    MERCHANT_SECRET,
    {
      kind: EVENT_KINDS.PRODUCT,
      tags: [
        ["d", dTag],
        ["title", `Product ${dTag}`],
        ["price", "25", "USD"],
        ...(requestsCollection ? [["a", COLLECTION]] : []),
        ["shipping_option", pickupCoordinate],
      ],
    },
    createdAt
  )
}

function buildCatalogFixture(targetCount: number) {
  const dTags = Array.from(
    { length: targetCount },
    (_, index) => `catalog-${index.toString().padStart(3, "0")}`
  )
  const pickupDTags = dTags.map((dTag) => `booth-${dTag}`)
  const pickupCoordinates = pickupDTags.map(
    (dTag) => `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT}:${dTag}`
  )
  const requests = dTags.map((dTag, index) =>
    productRevision(dTag, 100 + index, true, pickupCoordinates[index])
  )
  const pickups = pickupDTags.map((dTag, index) =>
    sign(
      MERCHANT_SECRET,
      buildEventMarketPickupDraft({
        dTag,
        title: `Booth ${index}`,
        price: 0,
        currency: "SATS",
        countries: ["US"],
        location: `Table ${index}`,
      }),
      1_000 + index
    )
  )
  const organizerProducts = dTags.map(
    (dTag) => `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${dTag}`
  )
  return {
    dTags,
    pickupDTags,
    pickupCoordinates,
    requests,
    pickups,
    organizerProducts,
  }
}

function wrapped(events: readonly SignedPublicNostrEvent[]): NDKEvent[] {
  return events.map((event) => new NDKEvent(undefined, event))
}

function relayStatuses(
  eventCount: number,
  relayBStatus: "success" | "partial" | "failed" = "success",
  relayUrls: readonly string[] = [RELAY_A, RELAY_B]
) {
  return relayUrls.map((relayUrl) => {
    const status = relayUrl === RELAY_B ? relayBStatus : ("success" as const)
    return {
      relayUrl,
      status,
      eventCount: status === "failed" ? 0 : eventCount,
    }
  })
}

function installReadHarness(
  fetchResult: (
    filter: TagFilter,
    relayUrls: readonly string[],
    options: ReadHarnessOptions
  ) =>
    | {
        events: SignedPublicNostrEvent[]
        relayBStatus?: "success" | "partial" | "failed"
        admittedRelayUrls?: readonly string[]
      }
    | Promise<{
        events: SignedPublicNostrEvent[]
        relayBStatus?: "success" | "partial" | "failed"
        admittedRelayUrls?: readonly string[]
      }>
): void {
  __setEventMarketTestOverrides({
    getRelayLists: async () =>
      new Map([
        [
          ORGANIZER,
          {
            pubkey: ORGANIZER,
            readRelayUrls: [RELAY_A, RELAY_B],
            writeRelayUrls: [],
            eventCreatedAt: 1,
            cachedAt: 1,
          },
        ],
      ]),
    fetchEventsFanoutDetailed: async (filter, options) => {
      const relayUrls = options.relayUrls ?? []
      const result = await fetchResult(filter as TagFilter, relayUrls, options)
      const admittedRelayUrls = result.admittedRelayUrls ?? relayUrls
      return {
        events: wrapped(result.events),
        relays: relayStatuses(
          result.events.length,
          result.relayBStatus,
          admittedRelayUrls
        ),
        admittedRelayUrls: [...admittedRelayUrls],
        eventsVerified: true,
      }
    },
    loadCachedEvidence: async () => [],
    persistCachedEvidence: async () => undefined,
  })
}

function installProductionReadHarness(
  fetchResult: (
    relayUrl: string,
    filter: TagFilter
  ) => {
    events: SignedPublicNostrEvent[]
    complete?: boolean
  }
): { restore: () => void } {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket"
  )
  __setEventMarketTestOverrides({
    getRelayLists: async (pubkeys) =>
      new Map(
        pubkeys.map((pubkey) => [
          pubkey,
          {
            pubkey,
            readRelayUrls: [RELAY_A, RELAY_B],
            writeRelayUrls: [RELAY_A, RELAY_B],
            eventCreatedAt: 1,
            cachedAt: 1,
          },
        ])
      ),
    loadCachedEvidence: async () => [],
    persistCachedEvidence: async () => undefined,
  })

  class TestSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = TestSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor(readonly url: string) {
      queueMicrotask(() => {
        if (this.readyState !== TestSocket.CONNECTING) return
        this.readyState = TestSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string): void {
      const [type, subscriptionId, rawFilter] = JSON.parse(payload) as [
        string,
        string,
        TagFilter,
      ]
      if (type !== "REQ") return
      const result = fetchResult(this.url, rawFilter)
      queueMicrotask(() => {
        if (this.readyState !== TestSocket.OPEN) return
        for (const event of result.events) {
          this.onmessage?.({
            data: JSON.stringify(["EVENT", subscriptionId, event]),
          } as MessageEvent<string>)
        }
        this.onmessage?.({
          data: JSON.stringify([
            result.complete === false ? "CLOSED" : "EOSE",
            subscriptionId,
          ]),
        } as MessageEvent<string>)
      })
    }

    close(): void {
      this.readyState = TestSocket.CLOSED
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TestSocket,
  })

  return {
    restore: () => {
      __resetNdkTestState()
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "WebSocket", originalDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, "WebSocket")
      }
    },
  }
}

async function resolveDeletionStarvationCase(
  tagName: "a" | "e",
  relayLimit: number
) {
  const request = productRevision("coffee", 100, true)
  const sibling = productRevision("sibling", 100, true)
  const siblingCoordinate = `${EVENT_KINDS.PRODUCT}:${MERCHANT}:sibling`
  const targetValue = tagName === "a" ? PRODUCT : request.id
  const siblingValue = tagName === "a" ? siblingCoordinate : sibling.id
  const siblingDeletions = Array.from({ length: 501 }, (_, index) =>
    sign(
      MERCHANT_SECRET,
      {
        kind: EVENT_KINDS.DELETION,
        content: `sibling-${index}`,
        tags: [[tagName, siblingValue]],
      },
      1_000 + index
    )
  )
  const targetDeletion = sign(
    MERCHANT_SECRET,
    {
      kind: EVENT_KINDS.DELETION,
      tags: [[tagName, targetValue]],
    },
    900
  )
  const deletionHistory = [...siblingDeletions, targetDeletion]
  const deletionFilters: TagFilter[] = []

  installReadHarness((filter) => {
    if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
    if (filter.kinds?.length === 1 && filter.kinds[0] === EVENT_KINDS.PRODUCT) {
      if (filter["#a"]?.includes(COLLECTION)) {
        return { events: [request, sibling] }
      }
      if (filter["#d"]) {
        return {
          events: [request, sibling].filter((event) =>
            event.tags.some(
              (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
            )
          ),
        }
      }
    }
    if (
      filter.kinds?.length === 1 &&
      filter.kinds[0] === EVENT_KINDS.DELETION
    ) {
      deletionFilters.push(filter)
      const values = filter[`#${tagName}`]
      if (!values) return { events: [] }
      return {
        events: deletionHistory
          .filter((event) =>
            event.tags.some(
              (tag) => tag[0] === tagName && values.includes(tag[1] ?? "")
            )
          )
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, Math.min(filter.limit ?? 500, relayLimit)),
      }
    }
    return { events: [] }
  })

  return {
    result: await getEventMarket({ reference: COLLECTION, nowMs: NOW_MS }),
    targetValue,
    deletionFilters,
  }
}

beforeEach(() => __resetRelayHealth())

afterEach(() => {
  __resetNdkTestState()
  __resetEventMarketTestOverrides()
  __resetRelayHealth()
})

describe("event-market exact product request frontiers", () => {
  it.each(["own-booth", "pickup"])(
    "resolves an organizer's own product as merchant handoff through %s",
    async (pickupDTag) => {
      const productCoordinate = `${EVENT_KINDS.PRODUCT}:${ORGANIZER}:own-product`
      const pickupCoordinate = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER}:${pickupDTag}`
      const product = sign(
        ORGANIZER_SECRET,
        {
          kind: EVENT_KINDS.PRODUCT,
          tags: [
            ["d", "own-product"],
            ["title", "Organizer coffee"],
            ["price", "10", "SATS"],
            ["a", COLLECTION],
            ["shipping_option", pickupCoordinate],
          ],
        },
        103
      )
      const booth = sign(
        ORGANIZER_SECRET,
        buildEventMarketPickupDraft({
          dTag: "own-booth",
          title: "My booth",
          price: 0,
          currency: "SATS",
          countries: ["US"],
          location: "Coffee table",
        }),
        104
      )
      const events = [...graph([productCoordinate]), product, booth]
      const requestedPickupDTags: string[] = []
      installReadHarness((filter) => {
        if (filter.kinds?.includes(EVENT_KINDS.SHIPPING_OPTION)) {
          requestedPickupDTags.push(...(filter["#d"] ?? []))
        }
        return {
          events: events.filter(
            (event) =>
              (!filter.kinds || filter.kinds.includes(event.kind)) &&
              (!filter.authors || filter.authors.includes(event.pubkey)) &&
              ["a", "d", "e"].every((tag) => {
                const values = filter[`#${tag}` as "#a" | "#d" | "#e"]
                return (
                  !values ||
                  event.tags.some(
                    (entry) => entry[0] === tag && values.includes(entry[1]!)
                  )
                )
              })
          ),
          relayBStatus: "failed",
        }
      })
      const market = await getEventMarket({
        reference: COLLECTION,
        nowMs: NOW_MS,
      })
      expect(market.acceptedProductEvidence).toHaveLength(1)
      expect(market.acceptedProductEvidence[0]).toMatchObject({
        productCoordinate,
        pickupCoordinate,
        handoffMode: "merchant_handoff",
        handoffPubkey: ORGANIZER,
      })
      expect(requestedPickupDTags).toContain(pickupDTag)
    }
  )

  it("projects preview data only from the exact current frontier revision", async () => {
    const discovered = productRevision("coffee", 100, true)
    const current = sign(
      MERCHANT_SECRET,
      {
        kind: EVENT_KINDS.PRODUCT,
        content: "Current signed description",
        tags: [
          ["d", "coffee"],
          ["title", "Current signed coffee"],
          ["price", "30", "EUR"],
          ["image", "https://example.com/current-coffee.jpg"],
          ["type", "simple", "physical"],
          ["a", COLLECTION],
          ["shipping_option", PICKUP],
        ],
      },
      200
    )
    installReadHarness((filter) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (filter["#a"]?.includes(COLLECTION)) return { events: [discovered] }
      if (filter["#d"]?.includes("coffee")) {
        return { events: [discovered, current] }
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(result.acceptedProductEvidence).toHaveLength(1)
    expect(result.acceptedProductEvidence[0]).toMatchObject({
      eventId: current.id,
      createdAt: current.created_at * 1_000,
      productPreview: {
        coordinate: PRODUCT,
        eventId: current.id,
        createdAt: current.created_at * 1_000,
        title: "Current signed coffee",
        summary: "Current signed description",
        images: [{ url: "https://example.com/current-coffee.jpg" }],
        priceStatus: "resolved",
        price: 30,
        currency: "EUR",
      },
    })
  })

  it.each([
    EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
    EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT + 1,
    EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT * 3,
  ])(
    "resolves a valid %i-product catalog",
    async (targetCount) => {
      const { dTags, pickupDTags, requests, pickups, organizerProducts } =
        buildCatalogFixture(targetCount)
      const exactProductTargets: string[][] = []
      const exactPickupTargets: string[][] = []
      installReadHarness((filter) => {
        if (filter.authors?.includes(ORGANIZER)) {
          return { events: graph(organizerProducts, false) }
        }
        if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT
        ) {
          if (filter["#a"]?.includes(COLLECTION)) return { events: requests }
          if (filter["#d"]) {
            exactProductTargets.push([...filter["#d"]])
            return {
              events: requests.filter((event) =>
                event.tags.some(
                  (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1]!)
                )
              ),
            }
          }
        }
        if (
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.SHIPPING_OPTION &&
          filter["#d"]
        ) {
          exactPickupTargets.push([...filter["#d"]])
          return {
            events: pickups.filter((event) =>
              event.tags.some(
                (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1]!)
              )
            ),
          }
        }
        return { events: [] }
      })

      const result = await getEventMarket({
        reference: COLLECTION,
        nowMs: NOW_MS,
      })

      expect(result.state).toBe("active")
      expect(result.participationBudget).toEqual({
        state: "within_budget",
        targetCount,
        targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
      })
      expect(result.pickupBudget).toEqual({
        state: "within_budget",
        targetCount,
        targetLimit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
      })
      expect(result.acceptedProductCoordinates).toEqual(
        [...organizerProducts].sort()
      )
      expect(result.organizerOnlyProductCoordinates).toEqual([])
      expect(
        result.acceptedProductEvidence.every(
          (evidence) => evidence.fulfillmentStatus === "resolved"
        )
      ).toBe(true)
      expect(exactProductTargets.flat().sort()).toEqual([...dTags].sort())
      expect(exactPickupTargets.flat().sort()).toEqual([...pickupDTags].sort())
    },
    15_000
  )

  it("keeps later product and pickup evidence across production relay-health batches", async () => {
    const targetCount = EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT + 1
    const {
      dTags,
      pickupDTags,
      pickupCoordinates,
      requests,
      pickups,
      organizerProducts,
    } = buildCatalogFixture(targetCount)
    const graphEvents = graph(organizerProducts, false)
    const laterProductDTag = dTags.at(-1)!
    const laterPickupDTag = pickupDTags.at(-1)!
    let partialProductReads = 0
    let partialPickupReads = 0
    let laterProductSawParkedRelay = false
    let laterPickupSawParkedRelay = false
    const matching = (
      events: readonly SignedPublicNostrEvent[],
      filter: TagFilter
    ): SignedPublicNostrEvent[] =>
      events.filter((event) => matchFilter(filter as Filter, event))
    const socket = installProductionReadHarness((relayUrl, filter) => {
      const relayB = relayUrl.startsWith(RELAY_B)
      if (filter.authors?.includes(ORGANIZER)) {
        return { events: relayB ? [] : matching(graphEvents, filter) }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT
      ) {
        if (filter["#a"]?.includes(COLLECTION)) {
          return { events: relayB ? [] : requests }
        }
        if (filter["#d"]) {
          const events = matching(requests, filter)
          if (!relayB) {
            return {
              events: filter["#d"].includes(laterProductDTag) ? [] : events,
            }
          }
          if (filter["#d"].includes(laterProductDTag)) {
            laterProductSawParkedRelay = isRelayInCooldown(RELAY_B)
            return { events }
          }
          partialProductReads += 1
          return { events: events.slice(0, 1), complete: false }
        }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.SHIPPING_OPTION &&
        filter["#d"]
      ) {
        const events = matching(pickups, filter)
        if (!relayB) {
          return {
            events: filter["#d"].includes(laterPickupDTag) ? [] : events,
          }
        }
        if (filter["#d"].includes(laterPickupDTag)) {
          laterPickupSawParkedRelay = isRelayInCooldown(RELAY_B)
          return { events }
        }
        partialPickupReads += 1
        return { events: events.slice(0, 1), complete: false }
      }
      return { events: [] }
    })

    let result: Awaited<ReturnType<typeof getEventMarket>>
    try {
      result = await getEventMarket({
        reference: COLLECTION,
        nowMs: NOW_MS,
      })
    } finally {
      socket.restore()
    }

    expect(result.state).toBe("partial")
    expect(result.coverage.partialRelayCount).toBe(1)
    expect(result.acceptedProductCoordinates).toHaveLength(targetCount)
    expect(result.acceptedProductEvidence.at(-1)).toMatchObject({
      productCoordinate: organizerProducts.at(-1),
      fulfillmentStatus: "resolved",
      pickupCoordinate: pickupCoordinates.at(-1),
    })
    expect(partialProductReads).toBe(2)
    expect(partialPickupReads).toBe(2)
    expect(laterProductSawParkedRelay).toBe(true)
    expect(laterPickupSawParkedRelay).toBe(true)
  }, 15_000)

  it("stops a large catalog before starting another 64-target batch after cancellation", async () => {
    const targetCount = EVENT_MARKET_PARTICIPATION_DELETION_TARGET_LIMIT + 1
    const dTags = Array.from(
      { length: targetCount },
      (_, index) => `cancel-${index.toString().padStart(3, "0")}`
    )
    const requests = dTags.map((dTag, index) =>
      productRevision(dTag, 100 + index, true)
    )
    const organizerProducts = dTags.map(
      (dTag) => `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${dTag}`
    )
    const exactProductTargets: string[] = []
    let current = true
    installReadHarness((filter) => {
      if (filter.authors?.includes(ORGANIZER)) {
        return { events: graph(organizerProducts) }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT
      ) {
        if (filter["#a"]?.includes(COLLECTION)) return { events: requests }
        if (filter["#d"]) {
          exactProductTargets.push(...filter["#d"])
          current = false
          return {
            events: requests.filter((event) =>
              event.tags.some(
                (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1]!)
              )
            ),
          }
        }
      }
      return { events: [] }
    })

    await expect(
      getEventMarket({
        reference: COLLECTION,
        nowMs: NOW_MS,
        shouldContinue: () => current,
      })
    ).rejects.toMatchObject({ name: "AbortError" })

    expect(exactProductTargets).toHaveLength(
      EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
    )
    expect(exactProductTargets).toEqual(
      dTags.slice(0, EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT)
    )
  }, 15_000)

  it("finds an exact withdrawal behind 500 unrelated merchant events", async () => {
    const request = productRevision("coffee", 100, true)
    const withdrawal = productRevision("coffee", 200, false)
    const unrelatedHistory = Array.from({ length: 500 }, (_, index) =>
      productRevision(`unrelated-${index}`, 300 + index, false)
    )
    const filters: TagFilter[] = []
    installReadHarness((filter) => {
      filters.push(filter)
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT
      ) {
        if (filter["#a"]?.includes(COLLECTION)) return { events: [request] }
        if (filter["#d"]?.includes("coffee")) return { events: [withdrawal] }
        return { events: unrelatedHistory }
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(
      filters.some(
        (filter) =>
          filter.kinds?.length === 1 &&
          filter.kinds[0] === EVENT_KINDS.PRODUCT &&
          filter.authors?.length === 1 &&
          filter.authors[0] === MERCHANT &&
          filter["#d"]?.length === 1 &&
          filter["#d"][0] === "coffee"
      )
    ).toBe(true)
    expect(
      filters.some(
        (filter) =>
          filter.authors?.includes(MERCHANT) &&
          filter.kinds?.includes(EVENT_KINDS.PRODUCT) &&
          filter.kinds?.includes(EVENT_KINDS.DELETION)
      )
    ).toBe(false)
    expect(result.acceptedProductCoordinates).toEqual([])
    expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])

    const merchantMarket = await resolveOrganizerEventMarket(
      COLLECTION,
      ORGANIZER
    )
    expect(merchantMarket.productCoordinates).toEqual([PRODUCT])
    expect(merchantMarket.participation).toEqual([
      { productCoordinate: PRODUCT, status: "organizer_only" },
    ])
  })

  it("routes exact participation reads to a merchant write relay disjoint from the organizer", async () => {
    const request = productRevision("coffee", 100, true)
    const withdrawal = productRevision("coffee", 200, false)
    const exactRelayPlans: string[][] = []
    installReadHarness((filter, relayUrls) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (filter["#a"]?.includes(COLLECTION)) return { events: [request] }
      if (filter["#d"]?.includes("coffee")) {
        exactRelayPlans.push([...relayUrls])
        return {
          events: relayUrls.includes(MERCHANT_RELAY) ? [withdrawal] : [request],
        }
      }
      return { events: [] }
    })
    __setEventMarketTestOverrides({
      getRelayLists: async (pubkeys) =>
        new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls:
                pubkey === MERCHANT ? [MERCHANT_RELAY] : [RELAY_A, RELAY_B],
              eventCreatedAt: 1,
              cachedAt: 1,
            },
          ])
        ),
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(exactRelayPlans).not.toHaveLength(0)
    expect(exactRelayPlans[0]?.[0]).toBe(MERCHANT_RELAY)
    expect(result.acceptedProductCoordinates).toEqual([])
    expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })

  it("resolves an accepted product through its collection relay hint", async () => {
    const request = productRevision("coffee", 100, true)
    const hintedGraph = graph().map((event) =>
      event.kind === EVENT_KINDS.PRODUCT_COLLECTION
        ? sign(
            ORGANIZER_SECRET,
            {
              kind: event.kind,
              content: event.content,
              tags: [
                ...event.tags.map((tag) =>
                  tag[0] === "a" && tag[1] === PRODUCT
                    ? [tag[0], tag[1], MERCHANT_RELAY]
                    : [...tag]
                ),
                ["a", PRODUCT, "ws://192.168.1.2:7777"],
              ],
            },
            event.created_at
          )
        : event
    )
    const exactRelayPlans: string[][] = []
    installReadHarness((filter, relayUrls) => {
      if (filter.authors?.includes(ORGANIZER)) {
        return { events: hintedGraph }
      }
      if (filter["#d"]?.includes("coffee")) {
        exactRelayPlans.push([...relayUrls])
        return {
          events: relayUrls.includes(MERCHANT_RELAY) ? [request] : [],
        }
      }
      return { events: [] }
    })
    __setEventMarketTestOverrides({
      getRelayLists: async () => new Map(),
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(exactRelayPlans).not.toHaveLength(0)
    expect(exactRelayPlans[0]).toContain(MERCHANT_RELAY)
    expect(exactRelayPlans[0]).toContain(RELAY_A)
    expect(exactRelayPlans[0]!.length).toBeLessThanOrEqual(8)
    expect(result.collection?.productRelayHintsByCoordinate).toEqual({
      [PRODUCT]: [MERCHANT_RELAY],
    })
    expect(result.acceptedProductCoordinates).toEqual([PRODUCT])
  })

  it("keeps distinct same-author collection hints reachable in bounded batches", async () => {
    const requests = Array.from({ length: 8 }, (_, index) =>
      productRevision(`hinted-${index}`, 100 + index, true)
    )
    const coordinates = requests.map((event) => {
      const dTag = event.tags.find((tag) => tag[0] === "d")![1]!
      return `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${dTag}`
    })
    const relayHints = coordinates.map(
      (_, index) => `wss://product-${index}.relay.dev`
    )
    const relayHintByCoordinate = new Map(
      coordinates.map((coordinate, index) => [coordinate, relayHints[index]!])
    )
    const relayHintByDTag = new Map(
      requests.map((event, index) => [
        event.tags.find((tag) => tag[0] === "d")![1]!,
        relayHints[index]!,
      ])
    )
    const hintedGraph = graph(coordinates).map((event) =>
      event.kind === EVENT_KINDS.PRODUCT_COLLECTION
        ? sign(
            ORGANIZER_SECRET,
            {
              kind: event.kind,
              content: event.content,
              tags: event.tags.map((tag) => {
                const relayHint = tag[1]
                  ? relayHintByCoordinate.get(tag[1])
                  : undefined
                return relayHint ? [tag[0]!, tag[1]!, relayHint] : [...tag]
              }),
            },
            event.created_at
          )
        : event
    )
    const exactRelayPlans: Array<{
      dTags: string[]
      relayUrls: string[]
      independentRelayUrls: readonly string[]
    }> = []
    installReadHarness((filter, relayUrls, options) => {
      if (filter.authors?.includes(ORGANIZER)) {
        return { events: hintedGraph }
      }
      if (filter["#a"]?.includes(COLLECTION)) return { events: requests }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#d"]
      ) {
        const attemptedRelayUrls = relayUrls.slice(
          0,
          options.maxRelayAttempts ?? relayUrls.length
        )
        exactRelayPlans.push({
          dTags: [...filter["#d"]],
          relayUrls: attemptedRelayUrls,
          independentRelayUrls: options.independentRelayUrls ?? [],
        })
        return {
          events: requests.filter((event) => {
            const dTag = event.tags.find((tag) => tag[0] === "d")![1]!
            return (
              filter["#d"]!.includes(dTag) &&
              attemptedRelayUrls.includes(relayHintByDTag.get(dTag)!)
            )
          }),
        }
      }
      return { events: [] }
    })
    __setEventMarketTestOverrides({
      getRelayLists: async () => new Map(),
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(exactRelayPlans).toHaveLength(2)
    for (const plan of exactRelayPlans) {
      expect(plan.relayUrls.length).toBeLessThanOrEqual(8)
      expect(plan.relayUrls).toContain("wss://conduit-congee.fly.dev")
      for (const dTag of plan.dTags) {
        const relayHint = relayHintByDTag.get(dTag)!
        expect(plan.relayUrls).toContain(relayHint)
        expect(plan.independentRelayUrls).toContain(relayHint)
      }
    }
    expect(result.acceptedProductCoordinates.slice().sort()).toEqual(
      coordinates.slice().sort()
    )
    expect(result.organizerOnlyProductCoordinates).toEqual([])
  })

  it("keeps a collection hint partial when final admission spends the budget elsewhere", async () => {
    const buyer = getPublicKey(generateSecretKey())
    const ownerRelays = Array.from(
      { length: 6 },
      (_, index) => `wss://owner-${index}.relay.dev`
    )
    const hintedGraph = graph().map((event) =>
      event.kind === EVENT_KINDS.PRODUCT_COLLECTION
        ? sign(
            ORGANIZER_SECRET,
            {
              kind: event.kind,
              content: event.content,
              tags: event.tags.map((tag) =>
                tag[0] === "a" && tag[1] === PRODUCT
                  ? [tag[0], tag[1], MERCHANT_RELAY]
                  : [...tag]
              ),
            },
            event.created_at
          )
        : event
    )
    let exactCandidateRelayUrls: readonly string[] = []
    let exactAdmittedRelayUrls: readonly string[] = []
    let exactOwnerSelectedRelayUrls: readonly string[] = []
    installReadHarness((filter, relayUrls, options) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: hintedGraph }
      if (filter["#d"]?.includes("coffee")) {
        exactCandidateRelayUrls = relayUrls
        exactOwnerSelectedRelayUrls = options.ownerSelectedRelayUrls ?? []
        exactAdmittedRelayUrls = relayUrls
          .filter((relayUrl) => relayUrl !== MERCHANT_RELAY)
          .slice(0, options.maxRelayAttempts ?? relayUrls.length)
        return { events: [], admittedRelayUrls: exactAdmittedRelayUrls }
      }
      return { events: [] }
    })
    __setEventMarketTestOverrides({
      getRelayLists: async () => new Map(),
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: {
          version: 1,
          updatedAt: 1,
          entries: ownerRelays.map((url) => ({
            url,
            readEnabled: true,
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
      }),
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
      authenticatedPubkey: buyer,
    })

    expect(exactCandidateRelayUrls).toContain(MERCHANT_RELAY)
    expect(exactOwnerSelectedRelayUrls).toEqual(
      expect.arrayContaining(ownerRelays)
    )
    expect(exactAdmittedRelayUrls).toHaveLength(8)
    expect(exactAdmittedRelayUrls).toContain(RELAY_A)
    expect(exactAdmittedRelayUrls).not.toContain(MERCHANT_RELAY)
    expect(result.state).toBe("partial")
    expect(result.acceptedProductCoordinates).toEqual([])
    expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })

  it("keeps an eighth retained hint partial when the share plan reserves fallback", async () => {
    const relayHints = Array.from(
      { length: 8 },
      (_, index) => `wss://product-source-${index}.relay.dev`
    )
    const hintedGraph = graph().map((event) =>
      event.kind === EVENT_KINDS.PRODUCT_COLLECTION
        ? sign(
            ORGANIZER_SECRET,
            {
              kind: event.kind,
              content: event.content,
              tags: event.tags.flatMap((tag) =>
                tag[0] === "a" && tag[1] === PRODUCT
                  ? relayHints.map((relayHint) => [tag[0]!, tag[1]!, relayHint])
                  : [[...tag]]
              ),
            },
            event.created_at
          )
        : event
    )
    let exactCandidateRelayUrls: readonly string[] = []
    installReadHarness((filter, relayUrls) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: hintedGraph }
      if (filter["#d"]?.includes("coffee")) {
        exactCandidateRelayUrls = relayUrls
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(result.collection?.productRelayHintsByCoordinate).toEqual({
      [PRODUCT]: relayHints,
    })
    expect(exactCandidateRelayUrls).toEqual(
      expect.arrayContaining(relayHints.slice(0, 7))
    )
    expect(exactCandidateRelayUrls).toContain(RELAY_A)
    expect(exactCandidateRelayUrls).not.toContain(relayHints[7]!)
    expect(result.state).toBe("partial")
    expect(result.acceptedProductCoordinates).toEqual([])
    expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })

  it("keeps event catalog deletion checks isolated by product and author", async () => {
    const merchants = [
      MERCHANT_SECRET,
      ...Array.from({ length: 7 }, () => generateSecretKey()),
    ]
    const requests = merchants.flatMap((secret, merchantIndex) =>
      Array.from({ length: 7 }, (_, productIndex) =>
        sign(
          secret,
          {
            kind: EVENT_KINDS.PRODUCT,
            tags: [
              ["d", `product-${merchantIndex}-${productIndex}`],
              ["title", "Product"],
              ["price", "25", "USD"],
              ["a", COLLECTION],
              ["shipping_option", PICKUP],
            ],
          },
          100
        )
      )
    )
    const coordinates = requests.map(
      (event) =>
        `${EVENT_KINDS.PRODUCT}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")![1]}`
    )
    const deletionFilters: TagFilter[] = []
    installReadHarness((filter) => {
      if (filter.authors?.includes(ORGANIZER))
        return { events: graph(coordinates) }
      if (filter.kinds?.[0] === EVENT_KINDS.PRODUCT) {
        if (filter["#a"]?.includes(COLLECTION)) return { events: requests }
        return {
          events: requests.filter(
            (event) =>
              filter.authors?.includes(event.pubkey) &&
              event.tags.some(
                (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1]!)
              )
          ),
        }
      }
      if (filter.kinds?.[0] === EVENT_KINDS.DELETION)
        deletionFilters.push(filter)
      return { events: [] }
    })
    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })
    expect(result.acceptedProductCoordinates.slice().sort()).toEqual(
      coordinates.slice().sort()
    )
    expect(deletionFilters).toHaveLength(112)
    for (const filter of deletionFilters) {
      expect(filter["#a"] ?? filter["#e"]).toHaveLength(1)
      expect(filter.authors).toHaveLength(1)
      const author = filter.authors![0]!
      for (const coordinate of filter["#a"] ?? []) {
        expect(coordinate.split(":")[1]).toBe(author)
      }
      for (const id of filter["#e"] ?? []) {
        expect(requests.find((event) => event.id === id)?.pubkey).toBe(author)
      }
    }
  })

  it("bounds exact deletion queries for 500 revisions of one coordinate", async () => {
    const revisions = Array.from({ length: 500 }, (_, index) =>
      productRevision("coffee", 100 + index, true)
    )
    const deletionFilters: TagFilter[] = []
    installReadHarness((filter) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT
      ) {
        if (filter["#a"]?.includes(COLLECTION)) return { events: revisions }
        if (filter["#d"]?.includes("coffee")) return { events: revisions }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.DELETION
      ) {
        deletionFilters.push(filter)
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })
    const eventDeletionFilters = deletionFilters.filter((filter) =>
      Boolean(filter["#e"])
    )

    expect(eventDeletionFilters).toHaveLength(
      EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT
    )
    expect(
      eventDeletionFilters.every((filter) => filter["#e"]?.length === 1)
    ).toBe(true)
    expect(deletionFilters).toHaveLength(
      EVENT_MARKET_PARTICIPATION_REVISIONS_PER_TARGET_LIMIT + 1
    )
    expect(deletionFilters.length).toBeLessThanOrEqual(
      EVENT_MARKET_PARTICIPATION_DELETION_TARGET_LIMIT
    )
    expect(result.acceptedProductCoordinates).toEqual([PRODUCT])
  }, 15_000)

  it("retires a failed relay after one exact-query wave", async () => {
    const secrets = [
      MERCHANT_SECRET,
      ...Array.from({ length: 4 }, () => generateSecretKey()),
    ]
    const requests = secrets.map((secret, index) =>
      sign(
        secret,
        {
          kind: EVENT_KINDS.PRODUCT,
          tags: [
            ["d", index === 0 ? "coffee" : `merchant-${index}`],
            ["title", `Merchant product ${index}`],
            ["price", "25", "USD"],
            ["a", COLLECTION],
            ["shipping_option", PICKUP],
          ],
        },
        100
      )
    )
    let productCallsWithFailedRelay = 0
    let deletionCallsWithFailedRelay = 0
    installReadHarness(async (filter, relayUrls) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#a"]?.includes(COLLECTION)
      ) {
        return { events: requests }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#d"]
      ) {
        const includesFailedRelay = relayUrls.includes(RELAY_B)
        if (includesFailedRelay) {
          productCallsWithFailedRelay += 1
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return {
          events: requests.filter((event) =>
            event.tags.some(
              (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
            )
          ),
          relayBStatus: includesFailedRelay ? "failed" : "success",
        }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.DELETION
      ) {
        if (relayUrls.includes(RELAY_B)) {
          deletionCallsWithFailedRelay += 1
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return { events: [] }
      }
      return { events: [] }
    })

    const startedAt = Date.now()
    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })
    const elapsedMs = Date.now() - startedAt

    expect(productCallsWithFailedRelay).toBe(4)
    expect(deletionCallsWithFailedRelay).toBe(0)
    expect(elapsedMs).toBeLessThan(450)
    expect(result.state).toBe("partial")
    expect(result.acceptedProductCoordinates).toEqual([PRODUCT])
  })

  it("keeps partial evidence but retires a no-EOSE relay before later waves and deletion queries", async () => {
    const secrets = [
      MERCHANT_SECRET,
      ...Array.from({ length: 4 }, () => generateSecretKey()),
    ]
    const requests = secrets.map((secret, index) =>
      sign(
        secret,
        {
          kind: EVENT_KINDS.PRODUCT,
          tags: [
            ["d", index === 0 ? "coffee" : `partial-${index}`],
            ["title", `Partial product ${index}`],
            ["price", "25", "USD"],
            ["a", COLLECTION],
            ["shipping_option", PICKUP],
          ],
        },
        100
      )
    )
    let productCallsWithPartialRelay = 0
    let deletionCallsWithPartialRelay = 0
    installReadHarness(async (filter, relayUrls) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#a"]?.includes(COLLECTION)
      ) {
        return { events: requests }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT &&
        filter["#d"]
      ) {
        const includesPartialRelay = relayUrls.includes(RELAY_B)
        if (includesPartialRelay) {
          productCallsWithPartialRelay += 1
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return {
          events: requests.filter((event) =>
            event.tags.some(
              (tag) => tag[0] === "d" && filter["#d"]?.includes(tag[1] ?? "")
            )
          ),
          relayBStatus: includesPartialRelay ? "partial" : "success",
        }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.DELETION
      ) {
        if (relayUrls.includes(RELAY_B)) deletionCallsWithPartialRelay += 1
        return { events: [] }
      }
      return { events: [] }
    })

    const startedAt = Date.now()
    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(productCallsWithPartialRelay).toBe(4)
    expect(deletionCallsWithPartialRelay).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(450)
    expect(result.state).toBe("partial")
    expect(result.acceptedProductCoordinates).toEqual([PRODUCT])
  })

  it("queries exact event deletions and removes a deleted current request", async () => {
    const request = productRevision("coffee", 100, true)
    const deletion = sign(
      MERCHANT_SECRET,
      { kind: EVENT_KINDS.DELETION, tags: [["e", request.id]] },
      200
    )
    let exactDeletionRead = false
    installReadHarness((filter) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (filter["#a"]?.includes(COLLECTION)) {
        return filter.kinds?.[0] === EVENT_KINDS.PRODUCT
          ? { events: [request] }
          : { events: [] }
      }
      if (filter["#d"]?.includes("coffee")) return { events: [request] }
      if (filter["#e"]?.includes(request.id)) {
        exactDeletionRead = true
        return { events: [deletion] }
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(exactDeletionRead).toBe(true)
    expect(result.acceptedProductCoordinates).toEqual([])
    expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])
  })

  it.each([500, 100])(
    "isolates an exact coordinate tombstone from sibling deletions with relay cap %i",
    async (relayLimit) => {
      const { result, targetValue, deletionFilters } =
        await resolveDeletionStarvationCase("a", relayLimit)

      expect(result.acceptedProductCoordinates).toEqual([])
      expect(
        deletionFilters.some(
          (filter) =>
            filter["#a"]?.length === 1 && filter["#a"][0] === targetValue
        )
      ).toBe(true)
      expect(
        deletionFilters.every(
          (filter) => !filter["#a"] || filter["#a"]?.length === 1
        )
      ).toBe(true)
      expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])
    },
    15_000
  )

  it.each([500, 100])(
    "isolates an exact event tombstone from sibling deletions with relay cap %i",
    async (relayLimit) => {
      const { result, targetValue, deletionFilters } =
        await resolveDeletionStarvationCase("e", relayLimit)

      expect(result.acceptedProductCoordinates).toEqual([])
      expect(
        deletionFilters.some(
          (filter) =>
            filter["#e"]?.length === 1 && filter["#e"][0] === targetValue
        )
      ).toBe(true)
      expect(
        deletionFilters.every(
          (filter) => !filter["#e"] || filter["#e"]?.length === 1
        )
      ).toBe(true)
      expect(result.organizerOnlyProductCoordinates).toEqual([PRODUCT])
    },
    15_000
  )

  it("merges a failed exact-deletion batch into partial relay coverage", async () => {
    const request = productRevision("coffee", 100, true)
    installReadHarness((filter) => {
      if (filter.authors?.includes(ORGANIZER)) return { events: graph() }
      if (filter["#a"]?.includes(COLLECTION)) {
        return filter.kinds?.[0] === EVENT_KINDS.PRODUCT
          ? { events: [request] }
          : { events: [] }
      }
      if (filter["#d"]?.includes("coffee")) return { events: [request] }
      if (filter["#e"]?.includes(request.id)) {
        return { events: [], relayBStatus: "failed" }
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(result.state).toBe("partial")
    expect(result.coverage).toMatchObject({
      attemptedRelayCount: 2,
      completeRelayCount: 1,
      partialRelayCount: 1,
      failedRelayCount: 0,
    })
    expect(result.acceptedProductCoordinates).toEqual([PRODUCT])
  })
})
