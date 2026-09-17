import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
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
  buildEventQrSignSheet,
  buildMerchantEventQrSignSheet,
  buildMerchantEventQrSignSheets,
  getEligibleEventSignMerchants,
  getEventSignEvidenceNotice,
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
  it("targets the canonical event route and the durable merchant filter", () => {
    const current = market([participation(MERCHANT_A, "bread")])
    const eventSheet = buildEventQrSignSheet(current, MERCHANT_LOCATION)
    const merchantSheet = buildMerchantEventQrSignSheet(
      current,
      MERCHANT_A,
      {
        pubkey: MERCHANT_A,
        displayName: "Alice Bakery",
        picture: "https://cdn.conduit.market/alice.png",
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
    expect(merchantSheet?.merchant?.name).toBe("Alice Bakery")
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
      } as Profile,
      MERCHANT_LOCATION
    )!
    const markup = renderToStaticMarkup(
      <EventQrPrintPages sheets={[eventSheet, merchantSheet]} />
    )

    expect(eventSheet.bannerUrl).toBeUndefined()
    expect(merchantSheet.bannerUrl).toBeUndefined()
    expect(merchantSheet.merchant?.imageUrl).toBeUndefined()
    expect(
      markup.match(/data-testid="event-sign-image-fallback"/g)
    ).toHaveLength(3)
    expect(markup).toContain("See the event catalog for location details")
    expect(markup).toContain("Scan for current availability")
    expect(markup).toContain("conduit.market")
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
})

describe("event sign print media", () => {
  it("uses native print with explicit Letter pages and exact colors", async () => {
    const [component, styles] = await Promise.all([
      Bun.file("apps/merchant/src/components/EventQrPrintPreview.tsx").text(),
      Bun.file("apps/merchant/src/styles/index.css").text(),
    ])

    expect(component).toContain("window.print()")
    expect(component).toContain("marginSize={4}")
    expect(styles).toContain("@media print")
    expect(styles).toContain("@page")
    expect(styles).toContain("size: letter portrait")
    expect(styles).toContain("html:has(body.event-sign-print-preview-open)")
    expect(styles).toContain("width: 8.5in")
    expect(styles).toContain("height: 11in")
    expect(styles).toContain("break-after: page")
    expect(styles).toContain("page-break-after: always")
    expect(styles).toContain("print-color-adjust: exact")
    expect(styles).toContain(".event-sign-print-controls")
  })
})
