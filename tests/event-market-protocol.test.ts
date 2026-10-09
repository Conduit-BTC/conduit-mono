import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  buildEventMarketCalendarDraft,
  buildProductListingEventDraft,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  encodeEventMarketShareLink,
  EVENT_KINDS,
  parseAddressableCoordinate,
  parseEventMarketCalendarEvent,
  parseProductEvent,
  type EventMarketEventDraft,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  admitPublicEvent,
  type VerifiedNostrEvent,
} from "@conduit/core/protocol/verified-public-event"

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

async function admitted(
  event: SignedPublicNostrEvent
): Promise<VerifiedNostrEvent> {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error("Signed test fixture was rejected.")
  return result.event
}

async function parsedMerchantProduct(input: {
  tags: string[][]
  content: string
  [key: string]: unknown
}) {
  return parseProductEvent(
    await admitted(
      signRaw({
        secret: MERCHANT_SECRET,
        kind: EVENT_KINDS.PRODUCT,
        tags: input.tags,
        content: input.content,
      })
    )
  )
}

describe("event-market coordinates and naddr references", () => {
  it("round-trips a strict current market coordinate through naddr and a share link", () => {
    const coordinate = `${EVENT_KINDS.EVENT_MARKET}:${ORGANIZER_PUBKEY.toUpperCase()}:summer:market`
    const parsed = parseAddressableCoordinate(coordinate, [
      EVENT_KINDS.EVENT_MARKET,
    ])

    expect(parsed).toEqual({
      kind: EVENT_KINDS.EVENT_MARKET,
      authorPubkey: ORGANIZER_PUBKEY,
      dTag: "summer:market",
      coordinate: `${EVENT_KINDS.EVENT_MARKET}:${ORGANIZER_PUBKEY}:summer:market`,
    })

    const naddr = encodeEventMarketNaddr(parsed!, [
      "wss://Relay.Example/",
      "wss://relay.example",
      "ws://insecure.example",
      "ws://127.0.0.1:4789",
    ])
    expect(
      decodeEventMarketReference(naddr, [EVENT_KINDS.EVENT_MARKET])
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
      decodeEventMarketReference(shareLink, [EVENT_KINDS.EVENT_MARKET])
    ).toMatchObject(parsed!)
  })

  it("fails closed on malformed, non-addressable, and unsupported coordinates", () => {
    const tooLong = "x".repeat(129)
    expect(parseAddressableCoordinate(`1:${ORGANIZER_PUBKEY}:event`)).toBeNull()
    expect(
      parseAddressableCoordinate(
        `${EVENT_KINDS.EVENT_MARKET}:${"f".repeat(63)}:event`
      )
    ).toBeNull()
    expect(
      parseAddressableCoordinate(
        `${EVENT_KINDS.EVENT_MARKET}:${ORGANIZER_PUBKEY}:`
      )
    ).toBeNull()
    expect(
      parseAddressableCoordinate(
        `${EVENT_KINDS.EVENT_MARKET}:${ORGANIZER_PUBKEY}:${tooLong}`
      )
    ).toBeNull()
    expect(
      decodeEventMarketReference(
        `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`,
        [EVENT_KINDS.EVENT_MARKET]
      )
    ).toBeNull()
    expect(decodeEventMarketReference("naddr1not-valid")).toBeNull()
  })
})

describe("event-market protocol fixtures", () => {
  it("requires every UTC day for a signed calendar crossing midnight", async () => {
    const now = Date.UTC(2026, 8, 30, 22, 30) / 1_000
    for (const offset of [3_600, -60]) {
      const draft = buildEventMarketCalendarDraft({
        kind: EVENT_KINDS.CALENDAR_TIME,
        dTag: "midnight-market",
        title: "Midnight market",
        start: now + offset,
        end: now + 7_200,
      })
      const dayTags = draft.tags.filter((tag) => tag[0] === "D")
      expect(dayTags).toHaveLength(2)
      expect(
        parseEventMarketCalendarEvent(
          await admitted(signDraft(ORGANIZER_SECRET, draft, now))
        )
      ).not.toBeNull()
      const incomplete = {
        ...draft,
        tags: draft.tags.filter((tag) => tag !== dayTags[1]),
      }
      expect(
        parseEventMarketCalendarEvent(
          await admitted(signDraft(ORGANIZER_SECRET, incomplete, now))
        )
      ).toBeNull()
    }
  })

  it("builds and parses NIP-52 date and timed calendar events", async () => {
    const dateDraft = buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_DATE,
      dTag: "market-day",
      title: "Market Day",
      start: "2027-06-01",
      end: "2027-06-02",
      locations: ["Public Square"],
    })
    const date = parseEventMarketCalendarEvent(
      await admitted(signDraft(ORGANIZER_SECRET, dateDraft))
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
      await admitted(
        signRaw({
          kind: timedDraft.kind,
          tags: [
            ...timedDraft.tags,
            ["t", "V4V"],
            ["t", " Chicago "],
            ["t", "V4V"],
          ],
          content: timedDraft.content,
        })
      )
    )
    expect(timed).toMatchObject({
      coordinate: `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:night-market`,
      start: start * 1_000,
      end: (start + 7_200) * 1_000,
      startTzid: "America/New_York",
      endTzid: "America/New_York",
      geohash: "dr5reg",
      topics: ["V4V", "Chicago"],
    })
  })

  it("publishes calendar summaries as interoperable NIP-52 content", async () => {
    const dateDraft = buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_DATE,
      dTag: "summary-date",
      title: "Summary date",
      summary: "An all-day public description.",
      content: "",
      start: "2027-06-01",
    })
    const timedDraft = buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_TIME,
      dTag: "summary-time",
      title: "Summary time",
      summary: "A timed public description.",
      content: "",
      start: 1_812_000_000,
    })

    expect(dateDraft.content).toBe("An all-day public description.")
    expect(dateDraft.tags).toContainEqual([
      "summary",
      "An all-day public description.",
    ])
    expect(timedDraft.content).toBe("A timed public description.")
    expect(timedDraft.tags).toContainEqual([
      "summary",
      "A timed public description.",
    ])
    expect(
      parseEventMarketCalendarEvent(
        await admitted(signDraft(ORGANIZER_SECRET, dateDraft))
      )
    ).toMatchObject({
      content: "An all-day public description.",
      summary: "An all-day public description.",
    })
    expect(
      parseEventMarketCalendarEvent(
        await admitted(signDraft(ORGANIZER_SECRET, timedDraft))
      )
    ).toMatchObject({
      content: "A timed public description.",
      summary: "A timed public description.",
    })
  })

  it("preserves an explicit detailed NIP-52 calendar description", () => {
    const draft = buildEventMarketCalendarDraft({
      kind: EVENT_KINDS.CALENDAR_TIME,
      dTag: "detailed-description",
      title: "Detailed description",
      summary: "Brief public summary.",
      content: "Full public event description.",
      start: 1_812_000_000,
    })

    expect(draft.content).toBe("Full public event description.")
    expect(draft.tags).toContainEqual(["summary", "Brief public summary."])
  })

  it("parses the bounded timed-calendar day frontier without throwing past it", async () => {
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
    expect(
      parseEventMarketCalendarEvent(await admitted(boundary))
    ).not.toBeNull()

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

    const admittedOversized = await admitted(oversized)
    expect(() => parseEventMarketCalendarEvent(admittedOversized)).not.toThrow()
    expect(parseEventMarketCalendarEvent(admittedOversized)).toBeNull()
  })

  it("rejects timed-calendar instants outside the JavaScript Date range", async () => {
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

    const admittedUnsupported = await admitted(unsupported)
    expect(() =>
      parseEventMarketCalendarEvent(admittedUnsupported)
    ).not.toThrow()
    expect(parseEventMarketCalendarEvent(admittedUnsupported)).toBeNull()
  })

  it("preserves repeated raw shipping-option tags for fail-closed classification", async () => {
    const pickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
    const parsed = await parsedMerchantProduct({
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

    const identical = await parsedMerchantProduct({
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

  it("distinguishes malformed shipping-option extra costs from an absent extra", async () => {
    const pickup = `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`
    const malformedValues = ["", "-1", "1e3", "Infinity", "not-a-price"]

    for (const malformedValue of malformedValues) {
      const parsed = await parsedMerchantProduct({
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

    const absent = await parsedMerchantProduct({
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

  it("retains malformed required product-price evidence without inventing purchase readiness", async () => {
    const malformedPriceTags = [
      undefined,
      ["price", "", "USD"],
      ["price", "-1", "USD"],
      ["price", "1e3", "USD"],
      ["price", "1", ""],
    ] as const

    for (const priceTag of malformedPriceTags) {
      const parsed = await parsedMerchantProduct({
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

    const validZero = await parsedMerchantProduct({
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

  it("refuses to publish malformed repeated event-market coordinates", async () => {
    const product = await parsedMerchantProduct({
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
