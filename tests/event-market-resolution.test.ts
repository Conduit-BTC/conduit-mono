import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  buildEventMarketCalendarDraft,
  buildEventMarketCollectionDraft,
  buildEventMarketPickupDraft,
  EVENT_KINDS,
  getEventMarketPickupSourceCost,
  resolveEventMarketEvidence,
  resolveEventMarketProductFulfillment,
  resolveEventMarketProductParticipation,
  type EventMarketEventDraft,
  type EventMarketRelayCoverage,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER_PUBKEY = getPublicKey(ORGANIZER_SECRET)
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const ATTACKER_SECRET = generateSecretKey()
const ATTACKER_PUBKEY = getPublicKey(ATTACKER_SECRET)

const START_SECONDS = 2_000_000_000
const END_SECONDS = START_SECONDS + 3_600
const ACTIVE_NOW_MS = (START_SECONDS + 60) * 1_000
const CALENDAR_COORDINATE = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:calendar`
const PICKUP_COORDINATE = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
const MERCHANT_PICKUP_COORDINATE = `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:booth`
const COLLECTION_COORDINATE = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:market`
const PRODUCT_COORDINATE = `${EVENT_KINDS.PRODUCT}:${MERCHANT_PUBKEY}:coffee`

const PARTIAL_COVERAGE: EventMarketRelayCoverage = {
  attemptedRelayCount: 2,
  completeRelayCount: 1,
  partialRelayCount: 0,
  failedRelayCount: 1,
}
const UNAVAILABLE_COVERAGE: EventMarketRelayCoverage = {
  attemptedRelayCount: 2,
  completeRelayCount: 0,
  partialRelayCount: 0,
  failedRelayCount: 2,
}

function signDraft(
  secret: Uint8Array,
  draft: EventMarketEventDraft,
  createdAt = 100
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: draft.kind,
      created_at: createdAt,
      tags: draft.tags,
      content: draft.content,
    },
    secret
  )
}

function signRaw(input: {
  secret?: Uint8Array
  kind: number
  tags: string[][]
  content?: string
  createdAt?: number
}): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt ?? 100,
      tags: input.tags,
      content: input.content ?? "",
    },
    input.secret ?? ORGANIZER_SECRET
  )
}

function calendarEvent(
  input: {
    secret?: Uint8Array
    dTag?: string
    title?: string
    omitTitleTag?: boolean
    extraTitleTags?: string[][]
    createdAt?: number
  } = {}
): SignedPublicNostrEvent {
  return signDraft(
    input.secret ?? ORGANIZER_SECRET,
    buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_TIME,
      dTag: input.dTag ?? "calendar",
      title: input.title ?? "Organizer Market",
      start: START_SECONDS,
      end: END_SECONDS,
      locations: ["Public Square"],
    }),
    input.createdAt
  )
}

function pickupEvent(
  input: {
    secret?: Uint8Array
    dTag?: string
    title?: string
    createdAt?: number
  } = {}
): SignedPublicNostrEvent {
  return signDraft(
    input.secret ?? ORGANIZER_SECRET,
    buildEventMarketPickupDraft({
      dTag: input.dTag ?? "pickup",
      title: input.title ?? "Main entrance pickup",
      price: 0,
      currency: "USD",
      countries: ["US"],
      location: "Public Square, main entrance",
    }),
    input.createdAt
  )
}

function collectionEvent(
  input: {
    eventCoordinate?: string
    pickupCoordinate?: string | null
    pickupCoordinates?: string[]
    productCoordinates?: string[]
    createdAt?: number
  } = {}
): SignedPublicNostrEvent {
  return signDraft(
    ORGANIZER_SECRET,
    buildEventMarketCollectionDraft({
      dTag: "market",
      title: "Organizer Market",
      eventCoordinate: input.eventCoordinate ?? CALENDAR_COORDINATE,
      pickupCoordinate:
        input.pickupCoordinate === null
          ? undefined
          : (input.pickupCoordinate ?? PICKUP_COORDINATE),
      pickupCoordinates: input.pickupCoordinates,
      productCoordinates: input.productCoordinates ?? [],
    }),
    input.createdAt
  )
}

function productRequest(
  input: {
    secret?: Uint8Array
    dTag?: string
    title?: string
    summary?: string
    imageUrls?: string[]
    type?: "simple" | "variable" | "variation"
    format?: "physical" | "digital"
    typeTags?: string[][]
    stock?: number
    collectionCoordinate?: string
    pickupCoordinate?: string
    priceTag?: string[] | null
    shippingOptionTags?: string[][]
    content?: string
    createdAt?: number
  } = {}
): SignedPublicNostrEvent {
  return signRaw({
    secret: input.secret ?? MERCHANT_SECRET,
    kind: EVENT_KINDS.PRODUCT,
    createdAt: input.createdAt,
    content: input.content,
    tags: [
      ["d", input.dTag ?? "coffee"],
      ...(input.omitTitleTag ? [] : [["title", input.title ?? "Coffee"]]),
      ...(input.extraTitleTags ?? []),
      ...(input.summary ? [["summary", input.summary]] : []),
      ...(input.imageUrls ?? []).map((url) => ["image", url]),
      ...(input.typeTags ?? [
        ["type", input.type ?? "simple", input.format ?? "physical"],
      ]),
      ...(input.stock === undefined ? [] : [["stock", String(input.stock)]]),
      ...(input.priceTag === null
        ? []
        : [input.priceTag ?? ["price", "25", "USD"]]),
      ["a", input.collectionCoordinate ?? COLLECTION_COORDINATE],
      ...(input.shippingOptionTags ?? [
        ["shipping_option", input.pickupCoordinate ?? PICKUP_COORDINATE],
      ]),
    ],
  })
}

function activeGraph(
  collection = collectionEvent(),
  extras: readonly SignedPublicNostrEvent[] = []
): SignedPublicNostrEvent[] {
  return [collection, calendarEvent(), pickupEvent(), ...extras]
}

function acceptedActiveMarket() {
  return resolveEventMarketEvidence({
    reference: COLLECTION_COORDINATE,
    events: activeGraph(
      collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
    ),
    productRequestEvents: [productRequest()],
    nowMs: ACTIVE_NOW_MS,
  })
}

describe("event-market product fulfillment resolution", () => {
  it("derives merchant handoff from the product's exact direct booth pickup", () => {
    const merchantPickup = pickupEvent({
      secret: MERCHANT_SECRET,
      dTag: "booth",
      title: "Merchant booth",
    })
    const market = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [
        collectionEvent({
          pickupCoordinate: null,
          productCoordinates: [PRODUCT_COORDINATE],
        }),
        calendarEvent(),
        merchantPickup,
      ],
      productRequestEvents: [
        productRequest({ pickupCoordinate: MERCHANT_PICKUP_COORDINATE }),
      ],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(market.state).toBe("active")
    expect(market.collection?.pickupCoordinates).toEqual([])
    expect(market.pickups.map((pickup) => pickup.coordinate)).toEqual([
      MERCHANT_PICKUP_COORDINATE,
    ])
    expect(
      resolveEventMarketProductFulfillment(
        {
          id: PRODUCT_COORDINATE,
          shippingOptionRefs: [{ coordinate: MERCHANT_PICKUP_COORDINATE }],
        },
        market
      )
    ).toMatchObject({
      status: "resolved",
      pickupAuthorPubkey: MERCHANT_PUBKEY,
      handoffMode: "merchant_handoff",
      handoffPubkey: MERCHANT_PUBKEY,
    })
  })

  it("keeps an organizer offer singular while resolving a direct merchant booth", () => {
    const market = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [
        collectionEvent({
          pickupCoordinate: PICKUP_COORDINATE,
          productCoordinates: [PRODUCT_COORDINATE],
        }),
        calendarEvent(),
        pickupEvent(),
        pickupEvent({ secret: MERCHANT_SECRET, dTag: "booth" }),
      ],
      productRequestEvents: [
        productRequest({ pickupCoordinate: MERCHANT_PICKUP_COORDINATE }),
      ],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(market.pickups).toHaveLength(2)
    expect(market.pickupCoordinate).toBe(PICKUP_COORDINATE)
    expect(market.pickup?.coordinate).toBe(PICKUP_COORDINATE)
    expect(
      resolveEventMarketProductFulfillment(
        {
          id: PRODUCT_COORDINATE,
          shippingOptionRefs: [{ coordinate: MERCHANT_PICKUP_COORDINATE }],
        },
        market
      )
    ).toMatchObject({
      status: "resolved",
      handoffMode: "merchant_handoff",
      handoffPubkey: MERCHANT_PUBKEY,
    })
  })

  it("resolves identical collection and pickup aliases independently of tag order", () => {
    const market = acceptedActiveMarket()
    const collectionReference = {
      coordinate: COLLECTION_COORDINATE,
      extraCost: {
        amount: 5,
        currency: "usd",
        normalizedCurrency: "USD",
      },
    }
    const pickupReference = {
      coordinate: PICKUP_COORDINATE,
      extraCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "usd",
      },
    }

    const collectionFirst = resolveEventMarketProductFulfillment(
      { shippingOptionRefs: [collectionReference, pickupReference] },
      market
    )
    const pickupFirst = resolveEventMarketProductFulfillment(
      { shippingOptionRefs: [pickupReference, collectionReference] },
      market
    )

    expect(collectionFirst).toEqual(pickupFirst)
    expect(collectionFirst).toMatchObject({
      status: "resolved",
      pickupReferenced: true,
      collectionReferencedForFulfillment: true,
      pickupAuthorPubkey: ORGANIZER_PUBKEY,
      handoffMode: "organizer_handoff",
      handoffPubkey: ORGANIZER_PUBKEY,
      sourceCost: {
        amount: 5,
        currency: "USD",
        normalizedCurrency: "USD",
      },
    })
    expect(
      getEventMarketPickupSourceCost(
        { shippingOptionRefs: [pickupReference, collectionReference] },
        market
      )
    ).toEqual(collectionFirst.sourceCost)
  })

  it("fails closed on conflicting repeated event extra costs", () => {
    const market = acceptedActiveMarket()
    const shippingOptionRefs = [
      {
        coordinate: COLLECTION_COORDINATE,
        extraCost: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
      {
        coordinate: PICKUP_COORDINATE,
        extraCost: {
          amount: 2,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
    ]

    const decision = resolveEventMarketProductFulfillment(
      { shippingOptionRefs },
      market
    )
    expect(
      resolveEventMarketProductFulfillment(
        { shippingOptionRefs: [...shippingOptionRefs].reverse() },
        market
      )
    ).toEqual(decision)
    expect(decision).toEqual({
      status: "ambiguous",
      reason: "conflicting_event_extra_costs",
      pickupReferenced: true,
      collectionReferencedForFulfillment: true,
      sourceCost: null,
    })
    expect(
      getEventMarketPickupSourceCost({ shippingOptionRefs }, market)
    ).toBeNull()
    expect(
      resolveEventMarketProductParticipation(
        {
          id: PRODUCT_COORDINATE,
          collectionRefs: [COLLECTION_COORDINATE],
          shippingOptionRefs,
        },
        market
      ).purchaseReady
    ).toBe(false)
  })

  it("fails closed when a present event extra-cost field was malformed", () => {
    const market = acceptedActiveMarket()

    expect(
      resolveEventMarketProductFulfillment(
        {
          shippingOptionRefs: [
            {
              coordinate: PICKUP_COORDINATE,
              extraCostMalformed: true,
            },
          ],
        },
        market
      )
    ).toEqual({
      status: "ambiguous",
      reason: "unsupported_event_extra_cost",
      pickupReferenced: true,
      collectionReferencedForFulfillment: false,
      sourceCost: null,
    })
  })

  it("does not make malformed signed product price evidence purchase-ready", () => {
    const market = acceptedActiveMarket()
    const product = {
      id: PRODUCT_COORDINATE,
      collectionRefs: [COLLECTION_COORDINATE],
      shippingOptionRefs: [{ coordinate: PICKUP_COORDINATE }],
      priceEvidenceMalformed: true as const,
    }

    expect(resolveEventMarketProductFulfillment(product, market)).toEqual({
      status: "ambiguous",
      reason: "invalid_product_price",
      pickupReferenced: true,
      collectionReferencedForFulfillment: false,
      sourceCost: null,
    })
    expect(
      resolveEventMarketProductParticipation(product, market).purchaseReady
    ).toBe(false)
  })
})

describe("event-market participation resolution", () => {
  it("preserves signed duplicate and malformed shipping evidence before acceptance", () => {
    const resolveRequest = (request: SignedPublicNostrEvent) =>
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        productRequestEvents: [request],
        nowMs: ACTIVE_NOW_MS,
      }).participationRequests[0]

    expect(
      resolveRequest(
        productRequest({
          shippingOptionTags: [
            ["shipping_option", PICKUP_COORDINATE, "1"],
            ["shipping_option", PICKUP_COORDINATE, "2"],
          ],
        })
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "conflicting_event_extra_costs",
    })
    expect(
      resolveRequest(
        productRequest({
          shippingOptionTags: [
            ["shipping_option", PICKUP_COORDINATE, "not-a-number"],
          ],
        })
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "unsupported_event_extra_cost",
    })
    expect(
      resolveRequest(
        productRequest({
          shippingOptionTags: [
            ["shipping_option", PICKUP_COORDINATE, "1"],
            ["shipping_option", PICKUP_COORDINATE, "1"],
          ],
        })
      )
    ).toMatchObject({
      fulfillmentStatus: "resolved",
      pickupCoordinate: PICKUP_COORDINATE,
    })
    expect(
      resolveRequest(
        productRequest({
          shippingOptionTags: [
            ["shipping_option", PICKUP_COORDINATE],
            ["shipping_option", ""],
          ],
        })
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "unsupported_shipping_options",
    })
    expect(
      resolveRequest(
        productRequest({
          shippingOptionTags: [
            ["shipping_option", PICKUP_COORDINATE],
            ["shipping_option", PICKUP_COORDINATE, "1", "unexpected"],
          ],
        })
      )
    ).toMatchObject({
      fulfillmentStatus: "ambiguous",
      fulfillmentReason: "unsupported_event_extra_cost",
    })
  })

  it("requires one valid signed product price before acceptance or ACK", () => {
    for (const request of [
      productRequest({ priceTag: null }),
      productRequest({ priceTag: ["price", "invalid", "USD"] }),
      productRequest({
        priceTag: ["price", "25", "USD"],
        shippingOptionTags: [["shipping_option", PICKUP_COORDINATE]],
      }),
    ]) {
      const market = resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        productRequestEvents: [request],
        nowMs: ACTIVE_NOW_MS,
      })
      const projection = market.participationRequests[0]!
      if (request.tags.some((tag) => tag[0] === "price" && tag[1] === "25")) {
        expect(projection.fulfillmentStatus).toBe("resolved")
      } else {
        expect(projection).toMatchObject({
          fulfillmentStatus: "ambiguous",
          fulfillmentReason: "invalid_product_price",
          productPreview: {
            priceStatus: "malformed",
          },
        })
      }
    }
  })

  it("rejects conflicting or malformed signed JSON price projections", () => {
    const conflictingJson = [
      { price: 26, currency: "USD" },
      { price: 25 },
      { currency: "USD" },
      {
        sourcePrice: {
          amount: 26,
          currency: "USD",
          normalizedCurrency: "USD",
        },
      },
      { sourcePrice: "25 USD" },
      { priceSats: 25 },
    ]
    for (const content of conflictingJson) {
      const market = resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        productRequestEvents: [
          productRequest({ content: JSON.stringify(content) }),
        ],
        nowMs: ACTIVE_NOW_MS,
      })
      expect(market.participationRequests[0]).toMatchObject({
        fulfillmentStatus: "ambiguous",
        fulfillmentReason: "invalid_product_price",
      })
    }

    const matching = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(),
      productRequestEvents: [
        productRequest({
          content: JSON.stringify({ price: 25, currency: "USD" }),
        }),
      ],
      nowMs: ACTIVE_NOW_MS,
    })
    expect(matching.participationRequests[0]).toMatchObject({
      fulfillmentStatus: "resolved",
      pickupCoordinate: PICKUP_COORDINATE,
    })
  })

  it("separates pending merchant requests from organizer-accepted products", () => {
    const request = productRequest()
    const pending = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(),
      productRequestEvents: [request],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(pending.state).toBe("active")
    expect(pending.acceptedProductCoordinates).toEqual([])
    expect(pending.participationRequests).toEqual([
      expect.objectContaining({
        productCoordinate: PRODUCT_COORDINATE,
        merchantPubkey: MERCHANT_PUBKEY,
        eventId: request.id,
        createdAt: request.created_at * 1_000,
        title: "Coffee",
        shippingOptionCoordinates: [PICKUP_COORDINATE],
        fulfillmentStatus: "resolved",
        pickupCoordinate: PICKUP_COORDINATE,
        pickupAuthorPubkey: ORGANIZER_PUBKEY,
        handoffMode: "organizer_handoff",
        handoffPubkey: ORGANIZER_PUBKEY,
        productPreview: {
          coordinate: PRODUCT_COORDINATE,
          eventId: request.id,
          createdAt: request.created_at * 1_000,
          title: "Coffee",
          images: [],
          type: "simple",
          format: "physical",
          priceStatus: "resolved",
          price: 25,
          currency: "USD",
          sourcePrice: {
            amount: 25,
            currency: "USD",
            normalizedCurrency: "USD",
          },
        },
      }),
    ])

    const accepted = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(
        collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
      ),
      productRequestEvents: [productRequest()],
      nowMs: ACTIVE_NOW_MS,
    })
    expect(accepted.state).toBe("active")
    expect(accepted.acceptedProductCoordinates).toEqual([PRODUCT_COORDINATE])
    expect(accepted.participationRequests).toEqual([])
    expect(accepted.acceptedProductEvidence).toEqual([
      expect.objectContaining({
        productCoordinate: PRODUCT_COORDINATE,
        merchantPubkey: MERCHANT_PUBKEY,
        title: "Coffee",
        pickupCoordinate: PICKUP_COORDINATE,
        handoffMode: "organizer_handoff",
        handoffPubkey: ORGANIZER_PUBKEY,
      }),
    ])

    expect(
      resolveEventMarketProductParticipation(
        {
          id: PRODUCT_COORDINATE,
          collectionRefs: [COLLECTION_COORDINATE],
          shippingOptionRefs: [{ coordinate: PICKUP_COORDINATE }],
        },
        accepted
      )
    ).toEqual({
      status: "accepted",
      requested: true,
      accepted: true,
      pickupReferenced: true,
      collectionReferencedForFulfillment: false,
      purchaseReady: true,
    })
  })

  it("binds organizer previews to the exact current signed product revision", () => {
    const older = productRequest({
      createdAt: 100,
      title: "Older coffee",
      summary: "Old description",
      imageUrls: ["https://example.com/old.jpg"],
      priceTag: ["price", "20", "USD"],
    })
    const current = productRequest({
      createdAt: 200,
      title: "Current coffee",
      summary: "Current description",
      imageUrls: [
        "https://example.com/current.jpg",
        ...Array.from(
          { length: 12 },
          (_, index) => `https://example.com/extra-${index}.jpg`
        ),
      ],
      type: "variable",
      stock: 4,
      priceTag: ["price", "30", "EUR"],
    })

    const market = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(),
      productRequestEvents: [older, current],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(market.participationRequests).toHaveLength(1)
    expect(market.participationRequests[0]).toMatchObject({
      eventId: current.id,
      createdAt: current.created_at * 1_000,
      productPreview: {
        coordinate: PRODUCT_COORDINATE,
        eventId: current.id,
        createdAt: current.created_at * 1_000,
        title: "Current coffee",
        summary: "Current description",
        type: "variable",
        format: "physical",
        stock: 4,
        priceStatus: "resolved",
        price: 30,
        currency: "EUR",
        sourcePrice: {
          amount: 30,
          currency: "EUR",
          normalizedCurrency: "EUR",
        },
      },
    })
    expect(
      market.participationRequests[0]?.productPreview.images.map(
        (image) => image.url
      )
    ).toEqual([
      "https://example.com/current.jpg",
      ...Array.from(
        { length: 7 },
        (_, index) => `https://example.com/extra-${index}.jpg`
      ),
    ])
  })

  it("supports signed legacy display metadata but omits ambiguous previews", () => {
    const legacy = productRequest({
      omitTitleTag: true,
      typeTags: [],
      content: JSON.stringify({
        title: "Legacy signed coffee",
        summary: "Legacy signed description",
        type: "variable",
        format: "physical",
        stock: 5,
        images: [
          {
            url: "https://example.com/legacy.jpg",
            alt: "Legacy product",
          },
        ],
      }),
    })
    const legacyMarket = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(),
      productRequestEvents: [legacy],
      nowMs: ACTIVE_NOW_MS,
    })
    expect(legacyMarket.participationRequests[0]?.productPreview).toMatchObject(
      {
        eventId: legacy.id,
        title: "Legacy signed coffee",
        summary: "Legacy signed description",
        images: [
          { url: "https://example.com/legacy.jpg", alt: "Legacy product" },
        ],
        type: "variable",
        format: "physical",
        stock: 5,
        priceStatus: "resolved",
      }
    )

    for (const ambiguous of [
      productRequest({ extraTitleTags: [["title", "Conflicting title"]] }),
      productRequest({ title: "x".repeat(201) }),
      productRequest({
        typeTags: [
          ["type", "simple", "physical"],
          ["type", "variable", "physical"],
        ],
      }),
      productRequest({ typeTags: [["type", "unsupported", "physical"]] }),
      productRequest({ typeTags: [["type", "simple", "unsupported"]] }),
    ]) {
      const market = resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        productRequestEvents: [ambiguous],
        nowMs: ACTIVE_NOW_MS,
      })
      expect(market.participationRequests[0]?.eventId).toBe(ambiguous.id)
      expect(market.participationRequests[0]?.productPreview).toBeUndefined()
    }
  })

  it("keeps a current preview visible without upgrading degraded evidence", () => {
    const request = productRequest({
      createdAt: 200,
      title: "Relay-bound coffee",
    })
    const partial = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      coverage: PARTIAL_COVERAGE,
      events: activeGraph(),
      productRequestEvents: [request],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(partial.state).toBe("partial")
    expect(partial.participationRequests[0]).toMatchObject({
      eventId: request.id,
      productPreview: {
        eventId: request.id,
        title: "Relay-bound coffee",
        priceStatus: "resolved",
      },
    })

    const stale = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      coverage: UNAVAILABLE_COVERAGE,
      events: activeGraph(),
      productRequestEvents: [request],
      evidenceObservedAt: ACTIVE_NOW_MS - 1,
      nowMs: ACTIVE_NOW_MS,
    })
    expect(stale.state).toBe("stale")
    expect(stale.participationRequests[0]?.productPreview.eventId).toBe(
      request.id
    )
  })

  it("renders accepted membership but fails purchase readiness without exact fulfillment linkage", () => {
    const market = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(
        collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
      ),
      productRequestEvents: [productRequest()],
      nowMs: ACTIVE_NOW_MS,
    })

    const participation = resolveEventMarketProductParticipation(
      {
        id: PRODUCT_COORDINATE,
        collectionRefs: [COLLECTION_COORDINATE],
        shippingOptionRefs: [
          {
            coordinate: `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:other-pickup`,
          },
        ],
      },
      market
    )

    expect(participation.status).toBe("accepted")
    expect(participation.pickupReferenced).toBe(false)
    expect(participation.collectionReferencedForFulfillment).toBe(false)
    expect(participation.purchaseReady).toBe(false)
  })

  it("does not accept organizer-only membership without the merchant request", () => {
    const market = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: activeGraph(
        collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
      ),
      nowMs: ACTIVE_NOW_MS,
    })

    expect(market.acceptedProductCoordinates).toEqual([])
    expect(market.organizerOnlyProductCoordinates).toEqual([PRODUCT_COORDINATE])

    const participation = resolveEventMarketProductParticipation(
      {
        id: PRODUCT_COORDINATE,
        collectionRefs: [],
        shippingOptionRefs: [{ coordinate: PICKUP_COORDINATE }],
      },
      market
    )

    expect(participation).toMatchObject({
      status: "none",
      requested: false,
      accepted: false,
      pickupReferenced: true,
      purchaseReady: false,
    })
  })

  it("accepts an exact collection shipping reference without treating membership as fulfillment", () => {
    const market = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      coverage: PARTIAL_COVERAGE,
      events: activeGraph(
        collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
      ),
      productRequestEvents: [productRequest()],
      nowMs: ACTIVE_NOW_MS,
    })
    const participation = resolveEventMarketProductParticipation(
      {
        id: PRODUCT_COORDINATE,
        collectionRefs: [COLLECTION_COORDINATE],
        shippingOptionRefs: [{ coordinate: COLLECTION_COORDINATE }],
      },
      market
    )

    expect(market.state).toBe("partial")
    expect(participation).toMatchObject({
      accepted: true,
      pickupReferenced: false,
      collectionReferencedForFulfillment: true,
      purchaseReady: true,
    })
  })

  it("removes withdrawn and deleted merchant requests from the current frontier", () => {
    const request = productRequest({ createdAt: 100 })
    const withdrawn = signRaw({
      secret: MERCHANT_SECRET,
      kind: EVENT_KINDS.PRODUCT,
      createdAt: 200,
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["shipping_option", PICKUP_COORDINATE],
      ],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(
          collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
        ),
        productRequestEvents: [request, withdrawn],
        nowMs: ACTIVE_NOW_MS,
      })
    ).toMatchObject({
      acceptedProductCoordinates: [],
      organizerOnlyProductCoordinates: [PRODUCT_COORDINATE],
      participationRequests: [],
    })

    const deletion = signRaw({
      secret: MERCHANT_SECRET,
      kind: EVENT_KINDS.DELETION,
      createdAt: 200,
      tags: [["e", request.id]],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(
          collectionEvent({ productCoordinates: [PRODUCT_COORDINATE] })
        ),
        productRequestEvents: [request, deletion],
        nowMs: ACTIVE_NOW_MS,
      })
    ).toMatchObject({
      acceptedProductCoordinates: [],
      organizerOnlyProductCoordinates: [PRODUCT_COORDINATE],
      participationRequests: [],
    })
  })
})

describe("event-market authorization and graph failures", () => {
  it("rejects attacker-owned calendars and never grants attacker pickup handoff", () => {
    const attackerCalendar = `${EVENT_KINDS.CALENDAR_TIME}:${ATTACKER_PUBKEY}:calendar`
    const forgedCalendar = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [
        signRaw({
          kind: EVENT_KINDS.PRODUCT_COLLECTION,
          tags: [
            ["d", "market"],
            ["title", "Forged calendar market"],
            ["a", attackerCalendar],
            ["shipping_option", PICKUP_COORDINATE],
          ],
        }),
        calendarEvent({ secret: ATTACKER_SECRET }),
        pickupEvent(),
      ],
      nowMs: ACTIVE_NOW_MS,
    })
    expect(forgedCalendar.state).toBe("unsupported")

    const attackerPickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ATTACKER_PUBKEY}:pickup`
    const forgedPickup = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [
        signRaw({
          kind: EVENT_KINDS.PRODUCT_COLLECTION,
          tags: [
            ["d", "market"],
            ["title", "Forged pickup market"],
            ["a", CALENDAR_COORDINATE],
            ["shipping_option", attackerPickup],
          ],
        }),
        calendarEvent(),
        pickupEvent({ secret: ATTACKER_SECRET }),
      ],
      nowMs: ACTIVE_NOW_MS,
    })
    expect(forgedPickup.state).toBe("unsupported")
    expect(
      resolveEventMarketProductFulfillment(
        {
          id: PRODUCT_COORDINATE,
          shippingOptionRefs: [{ coordinate: attackerPickup }],
        },
        forgedPickup
      )
    ).toMatchObject({
      status: "ambiguous",
      reason: "unsupported_handoff_author",
    })
  })

  it("fails closed on malformed, conflicting, and unsupported collection graphs", () => {
    const malformedCollection = signRaw({
      kind: EVENT_KINDS.PRODUCT_COLLECTION,
      tags: [
        ["d", "market"],
        ["title", "Missing pickup"],
        ["a", CALENDAR_COORDINATE],
      ],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: [malformedCollection, calendarEvent()],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("active")

    const conflictingCollection = signRaw({
      kind: EVENT_KINDS.PRODUCT_COLLECTION,
      tags: [
        ["d", "market"],
        ["title", "Conflicting calendars"],
        ["a", CALENDAR_COORDINATE],
        [
          "a",
          `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:other-calendar`,
        ],
        ["shipping_option", PICKUP_COORDINATE],
      ],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: [conflictingCollection],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("conflicting")

    const unsupportedCollection = signRaw({
      kind: EVENT_KINDS.PRODUCT_COLLECTION,
      tags: [
        ["d", "market"],
        ["title", "Unsupported reference"],
        ["a", CALENDAR_COORDINATE],
        ["shipping_option", PICKUP_COORDINATE],
        ["a", `30404:${ORGANIZER_PUBKEY}:unknown`],
      ],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: [unsupportedCollection, calendarEvent(), pickupEvent()],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("unsupported")
  })

  it("classifies an oversized timed calendar as malformed without throwing", () => {
    const firstDay = 25_000
    const start = firstDay * 86_400
    const oversizedCalendar = signRaw({
      kind: EVENT_KINDS.CALENDAR_TIME,
      tags: [
        ["d", "calendar"],
        ["title", "Oversized calendar"],
        ["start", String(start)],
        ["end", String(start + 371 * 86_400)],
        ...Array.from({ length: 371 }, (_, index) => [
          "D",
          String(firstDay + index),
        ]),
      ],
    })
    const resolve = () =>
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: [collectionEvent(), oversizedCalendar, pickupEvent()],
        nowMs: ACTIVE_NOW_MS,
      })

    expect(resolve).not.toThrow()
    expect(resolve().state).toBe("malformed")
  })

  it("classifies a timed calendar outside the JavaScript Date range as malformed", () => {
    const unsupportedStart = 8_640_000_000_001
    const unsupportedCalendar = signRaw({
      kind: EVENT_KINDS.CALENDAR_TIME,
      tags: [
        ["d", "calendar"],
        ["title", "Unsupported time"],
        ["start", String(unsupportedStart)],
        ["D", String(Math.floor(unsupportedStart / 86_400))],
      ],
    })

    const resolution = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [collectionEvent(), unsupportedCalendar, pickupEvent()],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(resolution.state).toBe("malformed")
  })
})

describe("event-market freshness and relay coverage", () => {
  it("distinguishes partial and unavailable evidence coverage", () => {
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        coverage: PARTIAL_COVERAGE,
        events: [],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("partial")
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        coverage: UNAVAILABLE_COVERAGE,
        events: [],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("unavailable")
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        coverage: PARTIAL_COVERAGE,
        events: activeGraph(),
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("partial")
  })

  it("does not report linked-record absence when relay coverage is incomplete", () => {
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        coverage: PARTIAL_COVERAGE,
        events: [collectionEvent(), pickupEvent()],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("partial")

    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        coverage: UNAVAILABLE_COVERAGE,
        events: [collectionEvent(), calendarEvent()],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("unavailable")
  })

  it("reports stale retained evidence and ended calendar windows", () => {
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        evidenceObservedAt: ACTIVE_NOW_MS - 60_001,
        maxEvidenceAgeMs: 60_000,
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("stale")
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        nowMs: END_SECONDS * 1_000,
      }).state
    ).toBe("ended")
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: activeGraph(),
        coverage: PARTIAL_COVERAGE,
        nowMs: END_SECONDS * 1_000,
      }).state
    ).toBe("ended")
  })
})

describe("event-market revisions and deletions", () => {
  it("honors same-author exact deletion and ignores cross-author deletion", () => {
    const calendar = calendarEvent({ createdAt: 200 })
    const sameAuthorDeletion = signRaw({
      kind: EVENT_KINDS.DELETION,
      createdAt: 100,
      tags: [["e", calendar.id]],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: [collectionEvent(), calendar, pickupEvent()],
        deletionEvents: [sameAuthorDeletion],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("deleted")

    const crossAuthorDeletion = signRaw({
      secret: ATTACKER_SECRET,
      kind: EVENT_KINDS.DELETION,
      createdAt: 300,
      tags: [["e", calendar.id]],
    })
    expect(
      resolveEventMarketEvidence({
        reference: COLLECTION_COORDINATE,
        events: [collectionEvent(), calendar, pickupEvent()],
        deletionEvents: [crossAuthorDeletion],
        nowMs: ACTIVE_NOW_MS,
      }).state
    ).toBe("active")
  })

  it("falls back to the prior live revision after an exact deletion", () => {
    const oldPickup = pickupEvent({ title: "Old pickup", createdAt: 100 })
    const newPickup = pickupEvent({ title: "New pickup", createdAt: 200 })
    const exactDeletion = signRaw({
      kind: EVENT_KINDS.DELETION,
      createdAt: 300,
      tags: [["e", newPickup.id]],
    })

    const result = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [collectionEvent(), calendarEvent(), oldPickup, newPickup],
      deletionEvents: [exactDeletion],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(result.state).toBe("active")
    expect(result.pickup?.eventId).toBe(oldPickup.id)
    expect(result.pickup?.title).toBe("Old pickup")
  })

  it("lets a newer signed revision supersede an older coordinate tombstone", () => {
    const oldPickup = pickupEvent({ title: "Old pickup", createdAt: 100 })
    const tombstone = signRaw({
      kind: EVENT_KINDS.DELETION,
      createdAt: 150,
      tags: [["a", PICKUP_COORDINATE]],
    })
    const newPickup = pickupEvent({ title: "New pickup", createdAt: 200 })

    const result = resolveEventMarketEvidence({
      reference: COLLECTION_COORDINATE,
      events: [collectionEvent(), calendarEvent(), oldPickup, newPickup],
      deletionEvents: [tombstone],
      nowMs: ACTIVE_NOW_MS,
    })

    expect(result.state).toBe("active")
    expect(result.pickup?.title).toBe("New pickup")
    expect(result.pickup?.eventId).toBe(newPickup.id)
  })
})
