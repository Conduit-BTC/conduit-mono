import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  __resetEventMarketTestOverrides,
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
const RELAY_A = "wss://relay.conduit.market"
const RELAY_B = "wss://nos.lol"
const MERCHANT_RELAY = "wss://merchant-write.relay.dev"
const NOW_MS = 1_800_000_100_000

type TagFilter = NDKFilter & {
  "#a"?: string[]
  "#d"?: string[]
  "#e"?: string[]
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
    relayUrls: readonly string[]
  ) =>
    | {
        events: SignedPublicNostrEvent[]
        relayBStatus?: "success" | "partial" | "failed"
      }
    | Promise<{
        events: SignedPublicNostrEvent[]
        relayBStatus?: "success" | "partial" | "failed"
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
      const result = await fetchResult(filter as TagFilter, relayUrls)
      return {
        events: wrapped(result.events),
        relays: relayStatuses(
          result.events.length,
          result.relayBStatus,
          relayUrls
        ),
        eventsVerified: true,
      }
    },
    loadCachedEvidence: async () => [],
    persistCachedEvidence: async () => undefined,
  })
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

  it("keeps resolving later products when an earlier participation batch is unresolved", async () => {
    const targetCount = EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT + 1
    const dTags = Array.from(
      { length: targetCount },
      (_, index) => `catalog-${index.toString().padStart(3, "0")}`
    )
    const unresolvedDTag = dTags[0]!
    const laterDTag = dTags.at(-1)!
    const requests = dTags.map((dTag, index) =>
      productRevision(dTag, 100 + index, true)
    )
    const organizerProducts = dTags.map(
      (dTag) => `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${dTag}`
    )
    const unresolvedProduct = organizerProducts[0]!
    const laterRelayPlans: string[][] = []
    installReadHarness((filter, relayUrls) => {
      if (filter.authors?.includes(ORGANIZER)) {
        return { events: graph(organizerProducts) }
      }
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === EVENT_KINDS.PRODUCT
      ) {
        if (filter["#a"]?.includes(COLLECTION)) return { events: requests }
        if (filter["#d"]) {
          if (filter["#d"].includes(laterDTag)) {
            laterRelayPlans.push([...relayUrls])
          }
          const unresolved = filter["#d"].includes(unresolvedDTag)
          return {
            events: requests.filter((event) =>
              event.tags.some(
                (tag) =>
                  tag[0] === "d" &&
                  tag[1] !== unresolvedDTag &&
                  filter["#d"]?.includes(tag[1]!)
              )
            ),
            relayBStatus: unresolved ? "failed" : "success",
          }
        }
      }
      return { events: [] }
    })

    const result = await getEventMarket({
      reference: COLLECTION,
      nowMs: NOW_MS,
    })

    expect(result.state).toBe("partial")
    expect(result.coverage.partialRelayCount).toBe(1)
    expect(result.acceptedProductCoordinates).toHaveLength(
      EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
    )
    expect(result.acceptedProductCoordinates).toContain(
      organizerProducts.at(-1)!
    )
    expect(result.acceptedProductCoordinates).not.toContain(unresolvedProduct)
    expect(result.organizerOnlyProductCoordinates).toEqual([unresolvedProduct])
    expect(laterRelayPlans).toHaveLength(1)
    expect(laterRelayPlans[0]).toContain(RELAY_A)
    expect(laterRelayPlans[0]).not.toContain(RELAY_B)
  })

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
      attemptedRelayCount: 5,
      completeRelayCount: 4,
      partialRelayCount: 1,
      failedRelayCount: 0,
    })
    expect(result.acceptedProductCoordinates).toEqual([PRODUCT])
  })
})
