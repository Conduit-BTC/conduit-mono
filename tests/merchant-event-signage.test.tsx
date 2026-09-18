import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  pubkeyToNpub,
  type Profile,
} from "@conduit/core"
import { EventQrPrintPages } from "../apps/merchant/src/components/EventQrPrintPreview"
import type {
  MerchantOrganizerEventMarket,
  MerchantOrganizerParticipation,
} from "../apps/merchant/src/lib/event-market"
import {
  EVENT_SIGN_QR_MAX_BYTES,
  buildEventQrSignSheet,
  buildMerchantEventQrSignSheet,
  buildMerchantEventQrSignSheets,
  formatEventSignSchedule,
  getEligibleEventSignMerchants,
  getEventSignEvidenceNotice,
  getEventSignPreviewEvidenceNotice,
  isEventSignQrValueWithinBudget,
  isMerchantEligibleForEventSign,
} from "../apps/merchant/src/lib/event-signage"

const ORGANIZER = "1".repeat(64)
const MERCHANT_A = "a".repeat(64)
const MERCHANT_B = "b".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:autumn-market`
const EVENT_NADDR = encodeEventMarketNaddr(COLLECTION)
const MERCHANT_LOCATION = {
  hostname: "127.0.0.1",
  protocol: "http:",
  port: "7001",
}

function participation(
  merchantPubkey: string,
  suffix: string,
  status: MerchantOrganizerParticipation["status"] = "accepted",
  verified = true
): MerchantOrganizerParticipation {
  const productCoordinate = `30402:${merchantPubkey}:${suffix}`
  const eventId = suffix.padEnd(64, "0").slice(0, 64)
  const createdAt = 1_000 + suffix.length
  return {
    productCoordinate,
    merchantPubkey,
    eventId,
    createdAt,
    status,
    ...(verified
      ? {
          productPreview: {
            coordinate: productCoordinate,
            eventId,
            createdAt,
            priceStatus: "resolved" as const,
            title: `Product ${suffix}`,
            price: 21,
            currency: "SAT",
          },
        }
      : {}),
  }
}

function market(
  participationItems: MerchantOrganizerParticipation[],
  overrides: Partial<MerchantOrganizerEventMarket> = {}
): MerchantOrganizerEventMarket {
  return {
    state: "active",
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: `31922:${ORGANIZER}:autumn-market`,
    pickupCoordinates: [],
    naddr: EVENT_NADDR,
    title: "Autumn Makers Market",
    calendarKind: 31922,
    start: "2026-10-17",
    end: "2026-10-18",
    eventLocation: "Riverfront Hall",
    productCoordinates: participationItems.map(
      (item) => item.productCoordinate
    ),
    participation: participationItems,
    source: {
      state: "active",
      reference: COLLECTION,
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
      calendarCoordinate: `31922:${ORGANIZER}:autumn-market`,
      organizerProductCoordinates: [],
      acceptedProductCoordinates: participationItems
        .filter((item) => item.status === "accepted")
        .map((item) => item.productCoordinate),
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [],
      participationRequests: [],
      pickups: [],
      participationBudget: {
        state: "within_budget",
        targetCount: participationItems.length,
        targetLimit: 64,
      },
      pickupBudget: {
        state: "within_budget",
        targetCount: 0,
        targetLimit: 64,
      },
      coverage: {
        attemptedRelayCount: 1,
        completeRelayCount: 1,
        partialRelayCount: 0,
        failedRelayCount: 0,
      },
    },
    ...overrides,
  } as MerchantOrganizerEventMarket
}

describe("merchant event sign eligibility", () => {
  it("requires positive accepted verified evidence and deduplicates merchants", () => {
    const current = market([
      participation(MERCHANT_A, "bread"),
      participation(MERCHANT_A.toUpperCase(), "coffee"),
      participation(MERCHANT_B, "pending", "pending"),
      participation(MERCHANT_B, "organizer", "organizer_only"),
      participation(MERCHANT_B, "unverified", "accepted", false),
    ])

    expect(getEligibleEventSignMerchants(current)).toEqual([
      { pubkey: MERCHANT_A, productCount: 2 },
    ])
    expect(isMerchantEligibleForEventSign(current, MERCHANT_A)).toBe(true)
    expect(isMerchantEligibleForEventSign(current, MERCHANT_B)).toBe(false)
  })

  it("does not use profile availability as an eligibility gate", () => {
    const current = market([participation(MERCHANT_A, "bread")])
    const sheet = buildMerchantEventQrSignSheet(
      current,
      MERCHANT_A,
      undefined,
      MERCHANT_LOCATION
    )

    expect(sheet?.merchant?.name).toContain("npub1")
    expect(sheet?.merchant?.imageUrl).toBeUndefined()
    expect(sheet?.qrValue).toBe(
      `http://127.0.0.1:7000/events/${EVENT_NADDR}?merchant=${pubkeyToNpub(MERCHANT_A)}`
    )
  })
})

describe("event sign composition", () => {
  it("treats date-based calendar ends as exclusive", () => {
    const singleDay = market([], {
      start: "2026-10-17",
      end: "2026-10-18",
    })
    const multiDay = market([], {
      start: "2026-10-17",
      end: "2026-10-20",
    })

    const singleDaySchedule = formatEventSignSchedule(singleDay, "en-US")
    const multiDaySchedule = formatEventSignSchedule(multiDay, "en-US")

    expect(singleDaySchedule).toBe("Oct 17, 2026")
    expect(multiDaySchedule).toBe("Oct 17, 2026 – Oct 19, 2026")
    expect(multiDaySchedule).not.toContain("Oct 20")
  })

  it("targets the canonical event route and the durable merchant filter", () => {
    const current = market([participation(MERCHANT_A, "bread")], {
      imageUrl: "https://cdn.conduit.market/autumn-market-banner.png",
    })
    const eventSheet = buildEventQrSignSheet(current, MERCHANT_LOCATION)
    const merchantSheet = buildMerchantEventQrSignSheet(
      current,
      MERCHANT_A,
      {
        pubkey: MERCHANT_A,
        displayName: "Alice Bakery",
        picture: "https://cdn.conduit.market/alice.png",
        banner: "https://cdn.conduit.market/alice-banner.png",
      } as Profile,
      MERCHANT_LOCATION
    )

    expect(eventSheet.qrValue).toBe(
      `http://127.0.0.1:7000/events/${EVENT_NADDR}`
    )
    expect(merchantSheet?.qrValue).toBe(
      `http://127.0.0.1:7000/events/${EVENT_NADDR}?merchant=${pubkeyToNpub(MERCHANT_A)}`
    )
    expect(merchantSheet?.qrValue).not.toContain("/store/")
    expect(eventSheet.bannerUrl).toBe(
      "https://cdn.conduit.market/autumn-market-banner.png"
    )
    expect(merchantSheet?.bannerUrl).toBe(
      "https://cdn.conduit.market/autumn-market-banner.png"
    )
    expect(merchantSheet?.merchant?.name).toBe("Alice Bakery")
    expect(merchantSheet?.merchant?.bannerUrl).toBe(
      "https://cdn.conduit.market/alice-banner.png"
    )
  })

  it("orders one sheet per unique merchant by display name", () => {
    const current = market([
      participation(MERCHANT_A, "bread"),
      participation(MERCHANT_A, "coffee"),
      participation(MERCHANT_B, "books"),
    ])
    const profiles: Record<string, Profile> = {
      [MERCHANT_A]: {
        pubkey: MERCHANT_A,
        displayName: "Zulu Bakery",
      } as Profile,
      [MERCHANT_B]: {
        pubkey: MERCHANT_B,
        displayName: "Amber Books",
      } as Profile,
    }

    const sheets = buildMerchantEventQrSignSheets(
      current,
      (pubkey) => profiles[pubkey],
      MERCHANT_LOCATION
    )

    expect(sheets).toHaveLength(2)
    expect(sheets.map((sheet) => sheet.merchant?.name)).toEqual([
      "Amber Books",
      "Zulu Bakery",
    ])
  })

  it("renders deterministic image and location fallbacks without changing QR copy", () => {
    const current = market([participation(MERCHANT_A, "bread")], {
      imageUrl: "javascript:alert(1)",
      eventLocation: undefined,
      eventGeohash: undefined,
    })
    const eventSheet = buildEventQrSignSheet(current, MERCHANT_LOCATION)
    const merchantSheet = buildMerchantEventQrSignSheet(
      current,
      MERCHANT_A,
      {
        pubkey: MERCHANT_A,
        displayName: "Alice Bakery",
        picture: "data:text/html,bad",
        banner: "javascript:alert(1)",
      } as Profile,
      MERCHANT_LOCATION
    )!
    const markup = renderToStaticMarkup(
      <EventQrPrintPages sheets={[eventSheet, merchantSheet]} />
    )

    expect(eventSheet.bannerUrl).toBeUndefined()
    expect(merchantSheet.bannerUrl).toBeUndefined()
    expect(merchantSheet.merchant?.imageUrl).toBeUndefined()
    expect(merchantSheet.merchant?.bannerUrl).toBeUndefined()
    expect(
      markup.match(/data-testid="event-sign-image-fallback"/g)
    ).toHaveLength(4)
    expect(markup).toContain("See the event catalog for location details")
    expect(markup).toContain("Scan for current availability")
    expect(markup).not.toContain("Listings and event participation can change")
    expect(markup).not.toContain(">Shop the event<")
    expect(markup).not.toContain(">At the event<")
    expect(markup).not.toContain(">Shop this merchant<")
    expect(markup).toContain("https://conduit.market")
    expect(markup).toContain(
      `data-qr-value="${merchantSheet.qrValue.replaceAll("&", "&amp;")}"`
    )
  })

  it("composes one screen-preview sheet or one printed page per batch item", () => {
    const current = market([
      participation(MERCHANT_A, "bread"),
      participation(MERCHANT_B, "books"),
    ])
    const sheets = buildMerchantEventQrSignSheets(
      current,
      () => undefined,
      MERCHANT_LOCATION
    )
    const single = renderToStaticMarkup(
      <EventQrPrintPages sheets={[sheets[0]!]} />
    )
    const batch = renderToStaticMarkup(<EventQrPrintPages sheets={sheets} />)

    expect(single).toContain('data-event-sign-page-count="1"')
    expect(single.match(/data-testid="event-sign-sheet"/g)).toHaveLength(1)
    expect(batch).toContain('data-event-sign-page-count="2"')
    expect(batch.match(/data-testid="event-sign-sheet"/g)).toHaveLength(2)
    expect(batch).not.toContain("products available")
  })

  it("warns honestly for partial and stale merchant batches", () => {
    expect(getEventSignEvidenceNotice("active", true)).toBeNull()
    expect(getEventSignEvidenceNotice("partial", true)).toEqual({
      title: "Merchant list may be incomplete",
      message:
        "Some planned relay reads did not complete, so this batch may not include every accepted merchant. Refresh event evidence before printing.",
    })
    expect(getEventSignEvidenceNotice("stale", true)?.message).toContain(
      "may not reflect current accepted merchants"
    )
  })

  it("preserves merchant-batch evidence mode when the batch has one sheet", () => {
    const current = market([participation(MERCHANT_A, "bread")])
    const sheets = buildMerchantEventQrSignSheets(
      current,
      () => undefined,
      MERCHANT_LOCATION
    )

    expect(sheets).toHaveLength(1)
    expect(
      renderToStaticMarkup(<EventQrPrintPages sheets={sheets} />)
    ).toContain('data-event-sign-page-count="1"')
    expect(
      getEventSignPreviewEvidenceNotice("partial", "merchant-batch")
    ).toEqual({
      title: "Merchant list may be incomplete",
      message:
        "Some planned relay reads did not complete, so this batch may not include every accepted merchant. Refresh event evidence before printing.",
    })
    expect(
      getEventSignPreviewEvidenceNotice("stale", "merchant-batch")?.message
    ).toContain("may not reflect current accepted merchants")
    expect(
      getEventSignPreviewEvidenceNotice("partial", "merchant")?.title
    ).toBe("Event evidence is incomplete")
  })
})

describe("event sign QR rendering", () => {
  it("keeps maximum-bound references QR-safe without changing event identity or merchant targeting", () => {
    const relayHints = Array.from({ length: 7 }, (_, index) => {
      const prefix = `wss://relay-${index}.example/`
      return `${prefix}${String(index).repeat(255 - prefix.length)}`
    })
    expect(relayHints.every((relayHint) => relayHint.length === 255)).toBe(true)
    const hintedReference = encodeEventMarketNaddr(COLLECTION, relayHints)
    expect(
      new TextEncoder().encode(
        `http://127.0.0.1:7000/events/${hintedReference}`
      ).length
    ).toBeGreaterThan(EVENT_SIGN_QR_MAX_BYTES)

    const current = market([participation(MERCHANT_A, "bread")], {
      naddr: hintedReference,
    })
    const sheets = [
      buildEventQrSignSheet(current, MERCHANT_LOCATION),
      buildMerchantEventQrSignSheet(
        current,
        MERCHANT_A,
        undefined,
        MERCHANT_LOCATION
      )!,
    ]

    for (const sheet of sheets) {
      const url = new URL(sheet.qrValue)
      const reference = url.pathname.slice("/events/".length)
      const decoded = decodeEventMarketReference(reference, [30405])

      expect(isEventSignQrValueWithinBudget(sheet.qrValue)).toBe(true)
      expect(decoded?.coordinate).toBe(COLLECTION)
      expect(decoded?.relayHints.length).toBeLessThan(relayHints.length)
    }
    expect(new URL(sheets[0]!.qrValue).searchParams.has("merchant")).toBe(false)
    expect(new URL(sheets[1]!.qrValue).searchParams.get("merchant")).toBe(
      pubkeyToNpub(MERCHANT_A)
    )
    expect(() =>
      renderToStaticMarkup(<EventQrPrintPages sheets={sheets} />)
    ).not.toThrow()
  })

  it("renders a controlled fallback for an over-budget QR value", () => {
    const sheet = buildEventQrSignSheet(market([]), MERCHANT_LOCATION)
    const markup = renderToStaticMarkup(
      <EventQrPrintPages
        sheets={[
          {
            ...sheet,
            qrValue: `https://shop.conduit.market/events/${"x".repeat(EVENT_SIGN_QR_MAX_BYTES)}`,
          },
        ]}
      />
    )

    expect(markup).toContain('data-testid="event-sign-qr-fallback"')
    expect(markup).toContain("QR code unavailable")
  })

  it("keeps an explicit quiet zone around printable QRs", async () => {
    const component = await Bun.file(
      "apps/merchant/src/components/EventQrPrintPreview.tsx"
    ).text()

    expect(component).toContain("marginSize={4}")
  })
})
