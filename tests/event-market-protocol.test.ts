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
  buildProductListingEventDraft,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  encodeEventMarketShareLink,
  EVENT_KINDS,
  parseAddressableCoordinate,
  parseEventMarketCalendarEvent,
  parseEventMarketCollectionEvent,
  parseEventMarketPickupEvent,
  parseProductEvent,
  type EventMarketEventDraft,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER_PUBKEY = getPublicKey(ORGANIZER_SECRET)
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)

function signDraft(
  secret: Uint8Array,
  draft: EventMarketEventDraft,
  createdAt = 1_800_000_000
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
      created_at: input.createdAt ?? 1_800_000_000,
      tags: input.tags,
      content: input.content ?? "",
    },
    input.secret ?? ORGANIZER_SECRET
  )
}

describe("event-market coordinates and naddr references", () => {
  it("round-trips a strict collection coordinate through naddr and a share link", () => {
    const coordinate = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY.toUpperCase()}:summer:market`
    const parsed = parseAddressableCoordinate(coordinate, [
      EVENT_KINDS.PRODUCT_COLLECTION,
    ])

    expect(parsed).toEqual({
      kind: EVENT_KINDS.PRODUCT_COLLECTION,
      authorPubkey: ORGANIZER_PUBKEY,
      dTag: "summer:market",
      coordinate: `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:summer:market`,
    })

    const naddr = encodeEventMarketNaddr(parsed!, [
      "wss://Relay.Example/",
      "wss://relay.example",
      "ws://insecure.example",
    ])
    expect(
      decodeEventMarketReference(naddr, [EVENT_KINDS.PRODUCT_COLLECTION])
    ).toEqual({
      ...parsed,
      relayHints: ["wss://relay.example"],
    })

    const shareLink = encodeEventMarketShareLink(parsed!, {
      origin: "https://market.example/base",
      relayUrls: ["wss://relay.example/"],
    })
    expect(shareLink).toStartWith("https://market.example/events/naddr1")
    expect(
      decodeEventMarketReference(shareLink, [EVENT_KINDS.PRODUCT_COLLECTION])
    ).toMatchObject(parsed!)
  })

  it("fails closed on malformed, non-addressable, and unsupported coordinates", () => {
    const tooLong = "x".repeat(129)
    expect(parseAddressableCoordinate(`1:${ORGANIZER_PUBKEY}:event`)).toBeNull()
    expect(
      parseAddressableCoordinate(
        `${EVENT_KINDS.PRODUCT_COLLECTION}:${"f".repeat(63)}:event`
      )
    ).toBeNull()
    expect(
      parseAddressableCoordinate(
        `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:`
      )
    ).toBeNull()
    expect(
      parseAddressableCoordinate(
        `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:${tooLong}`
      )
    ).toBeNull()
    expect(
      decodeEventMarketReference(
        `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`,
        [EVENT_KINDS.PRODUCT_COLLECTION]
      )
    ).toBeNull()
    expect(decodeEventMarketReference("naddr1not-valid")).toBeNull()
  })
})

describe("event-market protocol fixtures", () => {
  it("builds and parses NIP-52 date and timed calendar events", () => {
    const dateDraft = buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_DATE,
      dTag: "market-day",
      title: "Market Day",
      start: "2027-06-01",
      end: "2027-06-02",
      locations: ["Public Square"],
    })
    const date = parseEventMarketCalendarEvent(
      signDraft(ORGANIZER_SECRET, dateDraft)
    )

    expect(date).toMatchObject({
      coordinate: `${EVENT_KINDS.CALENDAR_DATE}:${ORGANIZER_PUBKEY}:market-day`,
      kind: EVENT_KINDS.CALENDAR_DATE,
      title: "Market Day",
      startDate: "2027-06-01",
      endDate: "2027-06-02",
      locations: ["Public Square"],
    })

    const start = 1_812_000_000
    const timedDraft = buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_TIME,
      dTag: "night-market",
      title: "Night Market",
      start,
      end: start + 7_200,
      startTzid: "America/New_York",
      endTzid: "America/New_York",
      geohash: "dr5reg",
    })
    expect(timedDraft.tags.filter((tag) => tag[0] === "D")).toEqual([
      ["D", String(Math.floor(start / 86_400))],
    ])

    const timed = parseEventMarketCalendarEvent(
      signDraft(ORGANIZER_SECRET, timedDraft)
    )
    expect(timed).toMatchObject({
      coordinate: `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:night-market`,
      start: start * 1_000,
      end: (start + 7_200) * 1_000,
      startTzid: "America/New_York",
      endTzid: "America/New_York",
      geohash: "dr5reg",
    })
  })

  it("parses the bounded timed-calendar day frontier without throwing past it", () => {
    const firstDay = 25_000
    const start = firstDay * 86_400
    const boundaryEnd = start + 370 * 86_400
    const boundary = signRaw({
      kind: EVENT_KINDS.CALENDAR_TIME,
      tags: [
        ["d", "bounded-calendar"],
        ["title", "Bounded calendar"],
        ["start", String(start)],
        ["end", String(boundaryEnd)],
        ...Array.from({ length: 370 }, (_, index) => [
          "D",
          String(firstDay + index),
        ]),
      ],
    })
    expect(parseEventMarketCalendarEvent(boundary)).not.toBeNull()

    const oversized = signRaw({
      kind: EVENT_KINDS.CALENDAR_TIME,
      tags: [
        ["d", "oversized-calendar"],
        ["title", "Oversized calendar"],
        ["start", String(start)],
        ["end", String(start + 371 * 86_400)],
        ...Array.from({ length: 371 }, (_, index) => [
          "D",
          String(firstDay + index),
        ]),
      ],
    })

    expect(() => parseEventMarketCalendarEvent(oversized)).not.toThrow()
    expect(parseEventMarketCalendarEvent(oversized)).toBeNull()
  })

  it("rejects timed-calendar instants outside the JavaScript Date range", () => {
    const unsupportedStart = 8_640_000_000_001
    expect(() =>
      buildEventMarketCalendarDraft({
        kind: EVENT_KINDS.CALENDAR_TIME,
        dTag: "unsupported-time",
        title: "Unsupported time",
        start: unsupportedStart,
      })
    ).toThrow("Calendar timestamp range is invalid")

    const unsupported = signRaw({
      kind: EVENT_KINDS.CALENDAR_TIME,
      tags: [
        ["d", "unsupported-time"],
        ["title", "Unsupported time"],
        ["start", String(unsupportedStart)],
        ["D", String(Math.floor(unsupportedStart / 86_400))],
      ],
    })

    expect(() => parseEventMarketCalendarEvent(unsupported)).not.toThrow()
    expect(parseEventMarketCalendarEvent(unsupported)).toBeNull()
  })

  it("builds a Gamma pickup without destination tags and rejects unsafe pickup fixtures", () => {
    const pickupDraft = buildEventMarketPickupDraft({
      dTag: "front-desk",
      title: "Front desk pickup",
      price: 250,
      currency: "sats",
      countries: ["us"],
      location: "Convention Center lobby",
    })
    expect(pickupDraft.tags).toContainEqual(["service", "pickup"])
    expect(pickupDraft.tags).toContainEqual(["country", "US"])
    expect(
      pickupDraft.tags.some(
        (tag) => tag[0] === "destination" || tag[0] === "destination_schema"
      )
    ).toBe(false)
    expect(
      parseEventMarketPickupEvent(signDraft(ORGANIZER_SECRET, pickupDraft))
    ).toMatchObject({
      coordinate: `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:front-desk`,
      price: 250,
      currency: "SATS",
      countries: ["US"],
      location: "Convention Center lobby",
    })

    expect(() =>
      buildEventMarketPickupDraft({
        dTag: "hidden",
        title: "Hidden pickup",
        price: 0,
        currency: "USD",
        countries: ["US"],
      })
    ).toThrow("public location or geohash")

    const proposedDestination = signRaw({
      kind: EVENT_KINDS.SHIPPING_OPTION,
      tags: [
        ["d", "proposal-dependent"],
        ["title", "Proposal-dependent pickup"],
        ["price", "0", "USD"],
        ["country", "US"],
        ["service", "pickup"],
        ["location", "Public Square"],
        ["destination_schema", "postal"],
      ],
    })
    expect(parseEventMarketPickupEvent(proposedDestination)).toBeNull()

    const pickupTags = [
      ["d", "malformed-price"],
      ["title", "Malformed price pickup"],
      ["country", "US"],
      ["service", "pickup"],
      ["location", "Public Square"],
    ]
    for (const amount of ["", "-1", "Infinity", "1e3", "0x10"]) {
      expect(
        parseEventMarketPickupEvent(
          signRaw({
            kind: EVENT_KINDS.SHIPPING_OPTION,
            tags: [...pickupTags, ["price", amount, "USD"]],
          })
        )
      ).toBeNull()
    }
    expect(
      parseEventMarketPickupEvent(
        signRaw({ kind: EVENT_KINDS.SHIPPING_OPTION, tags: pickupTags })
      )
    ).toBeNull()
    expect(
      parseEventMarketPickupEvent(
        signRaw({
          kind: EVENT_KINDS.SHIPPING_OPTION,
          tags: [...pickupTags, ["price", "0", "USD"]],
        })
      )?.price
    ).toBe(0)

    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildEventMarketPickupDraft({
          dTag: "invalid-price",
          title: "Invalid price pickup",
          price,
          currency: "USD",
          countries: ["US"],
          location: "Public Square",
        })
      ).toThrow("Pickup price is invalid")
    }
  })

  it("builds and parses an empty authoritative collection", () => {
    const calendarCoordinate = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:calendar`
    const pickupCoordinate = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
    const collectionDraft = buildEventMarketCollectionDraft({
      dTag: "market",
      title: "Organizer Market",
      eventCoordinate: calendarCoordinate,
      pickupCoordinate,
      productCoordinates: [],
      location: "Public Square",
    })
    const collection = parseEventMarketCollectionEvent(
      signDraft(ORGANIZER_SECRET, collectionDraft)
    )

    expect(collection).toMatchObject({
      coordinate: `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:market`,
      eventCoordinates: [calendarCoordinate],
      pickupCoordinates: [pickupCoordinate],
      productCoordinates: [],
      unsupportedReferences: [],
    })
  })

  it("limits collection pickup authority to one organizer-authored option", () => {
    const calendarCoordinate = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:calendar`
    const organizerPickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
    const secondOrganizerPickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:other`
    const merchantPickup = `${EVENT_KINDS.SHIPPING_OPTION}:${MERCHANT_PUBKEY}:booth`

    expect(() =>
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Organizer Market",
        eventCoordinate: calendarCoordinate,
        pickupCoordinates: [organizerPickup, secondOrganizerPickup],
      })
    ).toThrow("one organizer-authored pickup")
    expect(() =>
      buildEventMarketCollectionDraft({
        dTag: "market",
        title: "Organizer Market",
        eventCoordinate: calendarCoordinate,
        pickupCoordinate: merchantPickup,
      })
    ).toThrow("one organizer-authored pickup")

    const parsed = parseEventMarketCollectionEvent(
      signRaw({
        kind: EVENT_KINDS.PRODUCT_COLLECTION,
        tags: [
          ["d", "market"],
          ["title", "Organizer Market"],
          ["a", calendarCoordinate],
          ["shipping_option", merchantPickup],
        ],
      })
    )
    expect(parsed?.pickupCoordinates).toEqual([])
    expect(parsed?.unsupportedReferences).toEqual([merchantPickup])
  })

  it("preserves and re-emits repeated collection and shipping references", () => {
    const pickupOne = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup-one`
    const pickupTwo = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup-two`
    const collectionOne = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:market-one`
    const collectionTwo = `${EVENT_KINDS.PRODUCT_COLLECTION}:${ORGANIZER_PUBKEY}:market-two`
    const parsed = parseProductEvent({
      id: "external-product-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_800_000_000,
      content: "Merchant product",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", pickupOne, "5"],
        ["shipping_option", pickupTwo, "0"],
        ["a", collectionOne],
        ["a", collectionTwo],
      ],
    })

    expect(parsed.shippingOptionId).toBe(pickupOne)
    expect(parsed.shippingOptionRefs).toEqual([
      {
        coordinate: pickupOne,
        dTag: "pickup-one",
        extraCost: { amount: 5, currency: "USD", normalizedCurrency: "USD" },
      },
      {
        coordinate: pickupTwo,
        dTag: "pickup-two",
        extraCost: { amount: 0, currency: "USD", normalizedCurrency: "USD" },
      },
    ])
    expect(parsed.collectionRefs).toEqual([collectionOne, collectionTwo])

    const emitted = buildProductListingEventDraft({
      product: parsed,
      dTag: "coffee",
    })
    expect(emitted.tags.filter((tag) => tag[0] === "shipping_option")).toEqual([
      ["shipping_option", pickupOne, "5"],
      ["shipping_option", pickupTwo, "0"],
    ])
    expect(emitted.tags.filter((tag) => tag[0] === "a")).toEqual([
      ["a", collectionOne],
      ["a", collectionTwo],
    ])
  })

  it("preserves repeated raw shipping-option tags for fail-closed classification", () => {
    const pickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
    const parsed = parseProductEvent({
      id: "external-product-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_800_000_000,
      content: "Merchant product",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", pickup, "5"],
        ["shipping_option", pickup, "7"],
      ],
    })

    expect(parsed.shippingOptionId).toBe(pickup)
    expect(parsed.shippingOptionRefs).toEqual([
      {
        coordinate: pickup,
        dTag: "pickup",
        extraCost: { amount: 5, currency: "USD", normalizedCurrency: "USD" },
      },
      {
        coordinate: pickup,
        dTag: "pickup",
        extraCost: { amount: 7, currency: "USD", normalizedCurrency: "USD" },
      },
    ])
    expect(() =>
      buildProductListingEventDraft({ product: parsed, dTag: "coffee" })
    ).toThrow("Product shipping option has conflicting repeated extra costs")

    const identical = parseProductEvent({
      id: "identical-duplicate-shipping-tags",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_800_000_000,
      content: "Merchant product",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", pickup, "5"],
        ["shipping_option", pickup, "5"],
      ],
    })
    expect(identical.shippingOptionRefs).toHaveLength(2)
    expect(
      buildProductListingEventDraft({ product: identical, dTag: "coffee" }).tags
    ).toContainEqual(["shipping_option", pickup, "5"])
  })

  it("distinguishes malformed shipping-option extra costs from an absent extra", () => {
    const pickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
    const malformedValues = ["", "-1", "1e3", "Infinity", "not-a-price"]

    for (const malformedValue of malformedValues) {
      const parsed = parseProductEvent({
        id: `malformed-extra-${malformedValue}`,
        pubkey: MERCHANT_PUBKEY,
        created_at: 1_800_000_000,
        content: "Merchant product",
        tags: [
          ["d", "coffee"],
          ["title", "Coffee"],
          ["price", "25", "USD"],
          ["type", "simple", "physical"],
          ["shipping_option", pickup, malformedValue],
        ],
      })

      expect(parsed.shippingOptionRefs).toEqual([
        {
          coordinate: pickup,
          dTag: "pickup",
          extraCostMalformed: true,
        },
      ])
      expect(() =>
        buildProductListingEventDraft({ product: parsed, dTag: "coffee" })
      ).toThrow("Product shipping option extra cost is malformed")
    }

    const absent = parseProductEvent({
      id: "absent-extra",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_800_000_000,
      content: "Merchant product",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["type", "simple", "physical"],
        ["shipping_option", pickup],
      ],
    })
    expect(absent.shippingOptionRefs).toEqual([
      { coordinate: pickup, dTag: "pickup" },
    ])
  })

  it("retains malformed required product-price evidence without inventing purchase readiness", () => {
    const malformedPriceTags = [
      undefined,
      ["price", "", "USD"],
      ["price", "-1", "USD"],
      ["price", "1e3", "USD"],
      ["price", "1", ""],
    ] as const

    for (const priceTag of malformedPriceTags) {
      const parsed = parseProductEvent({
        id: `malformed-price-${priceTag?.[1] ?? "missing"}`,
        pubkey: MERCHANT_PUBKEY,
        created_at: 1_800_000_000,
        content: JSON.stringify({
          title: "Legacy display product",
          price: 99,
          currency: "USD",
        }),
        tags: [
          ["d", "coffee"],
          ["title", "Coffee"],
          ["type", "simple", "physical"],
          ...(priceTag ? [[...priceTag]] : []),
        ],
      })

      expect(parsed.price).toBe(99)
      expect(parsed.priceEvidenceMalformed).toBe(true)
      expect(() =>
        buildProductListingEventDraft({ product: parsed, dTag: "coffee" })
      ).toThrow("Product price evidence is malformed")
    }

    const validZero = parseProductEvent({
      id: "valid-zero-price",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_800_000_000,
      content: "Free sample",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "0", "USD"],
        ["type", "simple", "physical"],
      ],
    })
    expect(validZero.price).toBe(0)
    expect(validZero.priceEvidenceMalformed).toBeUndefined()
  })

  it("refuses to publish malformed repeated event-market coordinates", () => {
    const product = parseProductEvent({
      id: "external-product-event",
      pubkey: MERCHANT_PUBKEY,
      created_at: 1_800_000_000,
      content: "Merchant product",
      tags: [
        ["d", "coffee"],
        ["title", "Coffee"],
        ["price", "25", "USD"],
        ["type", "simple", "physical"],
      ],
    })

    expect(() =>
      buildProductListingEventDraft({
        product: {
          ...product,
          collectionRefs: ["30405:not-a-pubkey:market"],
        },
        dTag: "coffee",
      })
    ).toThrow("collection coordinate")
    expect(() =>
      buildProductListingEventDraft({
        product: {
          ...product,
          shippingOptionRefs: [{ coordinate: "30406:not-a-pubkey:pickup" }],
        },
        dTag: "coffee",
      })
    ).toThrow("shipping option coordinate")
  })
})
