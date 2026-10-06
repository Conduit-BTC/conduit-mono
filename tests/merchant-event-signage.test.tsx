import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  pubkeyToNpub,
  type Profile,
  type ParsedEventMarketRoster,
  type ParsedEventMarketCalendar,
} from "@conduit/core"
import { EventQrPrintPages } from "../apps/merchant/src/components/EventQrPrintPreview"
import {
  EVENT_SIGN_QR_MAX_BYTES,
  buildFutureEventQrSignSheets,
  formatFutureEventSignSchedule,
  getEventSignEvidenceNotice,
  getEventSignPreviewEvidenceNotice,
  isEventSignQrValueWithinBudget,
} from "../apps/merchant/src/lib/event-signage"

const ORGANIZER = "1".repeat(64)
const MERCHANT_A = "a".repeat(64)
const MERCHANT_B = "b".repeat(64)
const MARKET = `30409:${ORGANIZER}:autumn-market`
const CALENDAR = `31922:${ORGANIZER}:autumn-market-date`
const MERCHANT_LOCATION = {
  hostname: "127.0.0.1",
  protocol: "http:",
  port: "7001",
}
function roster(merchants = [MERCHANT_A]): ParsedEventMarketRoster {
  return {
    coordinate: MARKET,
    eventId: "c".repeat(64),
    organizerPubkey: ORGANIZER,
    dTag: "autumn-market",
    calendarCoordinate: CALENDAR,
    status: "open",
    createdAt: 1,
    merchants: merchants.map((pubkey, index) => ({
      pubkey,
      mode: "merchant_handoff",
      assignment: `Booth ${index + 1}`,
    })),
  } as ParsedEventMarketRoster
}
function calendar(
  overrides: Partial<ParsedEventMarketCalendar> = {}
): ParsedEventMarketCalendar {
  return {
    coordinate: CALENDAR,
    eventId: "d".repeat(64),
    authorPubkey: ORGANIZER,
    dTag: "autumn-market-date",
    kind: 31922,
    title: "Autumn Makers Market",
    content: "",
    locations: ["Riverfront Hall"],
    start: Date.UTC(2026, 9, 17),
    end: Date.UTC(2026, 9, 18),
    startDate: "2026-10-17",
    endDate: "2026-10-18",
    createdAt: 1,
    ...overrides,
  } as ParsedEventMarketCalendar
}
function sheets(
  input: {
    merchants?: string[]
    calendar?: Partial<ParsedEventMarketCalendar>
    profiles?: Record<string, Profile>
    relayHints?: string[]
    occurrence?: string
  } = {}
) {
  return buildFutureEventQrSignSheets({
    market: roster(input.merchants),
    calendar: calendar(input.calendar),
    profiles: input.profiles,
    relayHints: input.relayHints,
    occurrenceCoordinate: input.occurrence,
    location: MERCHANT_LOCATION,
  })
}

describe("current event and merchant printable signs", () => {
  it("targets the exact Event Market and its merchant filter, preserving the selected date", () => {
    const [event, merchant] = sheets({ occurrence: CALENDAR })
    const expected = `http://127.0.0.1:7000/events/${encodeEventMarketNaddr(MARKET)}`
    expect(event!.url).toBe(
      `${expected}?occurrence=${encodeURIComponent(CALENDAR)}`
    )
    expect(event!.qrValue).toBe(event!.url)
    const url = new URL(merchant!.url)
    expect(url.pathname).toBe(new URL(expected).pathname)
    expect(url.searchParams.get("merchant")).toBe(pubkeyToNpub(MERCHANT_A))
    expect(url.searchParams.get("occurrence")).toBe(CALENDAR)
    expect(merchant!.qrValue).toBe(merchant!.url)
    expect(merchant!.location).toBe("Booth 1")
    expect(merchant!.url).not.toContain("/store/")
  })

  it("prints only organizer roster rows and does not require merchant profiles", () => {
    const result = sheets({
      profiles: {
        [MERCHANT_B]: { pubkey: MERCHANT_B, name: "Unlisted merchant" },
      },
    })
    expect(result).toHaveLength(2)
    expect(result[1]!.merchant?.pubkey).toBe(MERCHANT_A)
    expect(result[1]!.merchant?.name).toContain("npub1")
    expect(result[1]!.merchant?.imageUrl).toBeUndefined()
    expect(result.some((sheet) => sheet.merchant?.pubkey === MERCHANT_B)).toBe(
      false
    )
    expect(sheets({ merchants: [] }).map((sheet) => sheet.kind)).toEqual([
      "event",
    ])
  })

  it("binds friendly names and images to the exact merchant while retaining signed identity", () => {
    const result = sheets({
      profiles: {
        [MERCHANT_A]: {
          pubkey: MERCHANT_A,
          displayName: "Alice Bakery",
          picture: "https://cdn.conduit.market/alice.png",
          banner: "https://cdn.conduit.market/alice-banner.png",
        },
      },
      calendar: { image: "https://cdn.conduit.market/event.png" },
    })
    expect(result[0]!.bannerUrl).toBe("https://cdn.conduit.market/event.png")
    expect(result[1]!.bannerUrl).toBe(result[0]!.bannerUrl)
    expect(result[1]!.merchant).toMatchObject({
      pubkey: MERCHANT_A,
      name: "Alice Bakery",
      imageUrl: "https://cdn.conduit.market/alice.png",
      bannerUrl: "https://cdn.conduit.market/alice-banner.png",
    })
    const mismatched = sheets({
      profiles: {
        [MERCHANT_A]: {
          pubkey: MERCHANT_B,
          name: "Wrong seller",
          picture: "https://cdn.conduit.market/wrong.png",
        },
      },
    })
    expect(mismatched[1]!.merchant?.name).not.toBe("Wrong seller")
    expect(mismatched[1]!.merchant?.imageUrl).toBeUndefined()
  })

  it("orders the merchant batch by friendly name without duplicating a roster row", () => {
    const result = sheets({
      merchants: [MERCHANT_A, MERCHANT_B],
      profiles: {
        [MERCHANT_A]: { pubkey: MERCHANT_A, name: "Zulu Bakery" },
        [MERCHANT_B]: { pubkey: MERCHANT_B, name: "Amber Books" },
      },
    })
    expect(result[0]!.kind).toBe("event")
    expect(result.slice(1).map((sheet) => sheet.merchant?.name)).toEqual([
      "Amber Books",
      "Zulu Bakery",
    ])
    expect(new Set(result.map((sheet) => sheet.id)).size).toBe(result.length)
  })

  it("formats all-day calendar ends as exclusive", () => {
    expect(formatFutureEventSignSchedule(calendar(), "en-US")).toBe(
      "Oct 17, 2026"
    )
    const multi = calendar({
      end: Date.UTC(2026, 9, 20),
      endDate: "2026-10-20",
    })
    expect(formatFutureEventSignSchedule(multi, "en-US")).toBe(
      "Oct 17, 2026 – Oct 19, 2026"
    )
    expect(formatFutureEventSignSchedule(multi, "en-US")).not.toContain(
      "Oct 20"
    )
  })

  it("formats each timed boundary in its signed timezone across daylight saving", () => {
    const timed = calendar({
      kind: 31923,
      start: Date.UTC(2026, 2, 8, 6, 30),
      end: Date.UTC(2026, 2, 8, 7, 30),
      startTzid: "America/New_York",
      endTzid: "America/New_York",
    })
    const schedule = formatFutureEventSignSchedule(timed, "en-US")
    expect(schedule).toContain("1:30 AM")
    expect(schedule).toContain("3:30 AM")
    expect(sheets({ calendar: timed })[0]!.schedule).toBe(
      formatFutureEventSignSchedule(timed)
    )
  })

  it("keeps safe image and public location fallbacks without changing QR destinations", () => {
    const result = sheets({
      calendar: {
        image: "javascript:alert(1)",
        locations: [],
        geohash: undefined,
      },
      profiles: {
        [MERCHANT_A]: {
          pubkey: MERCHANT_A,
          name: "Alice Bakery",
          picture: "data:text/html,bad",
          banner: "javascript:alert(1)",
        },
      },
    })
    expect(result[0]!.bannerUrl).toBeUndefined()
    expect(result[1]!.merchant?.imageUrl).toBeUndefined()
    expect(result[1]!.merchant?.bannerUrl).toBeUndefined()
    const markup = renderToStaticMarkup(<EventQrPrintPages sheets={result} />)
    expect(
      markup.match(/data-testid="event-sign-image-fallback"/g)
    ).toHaveLength(4)
    expect(markup).toContain("See the event catalog for location details")
    expect(markup).toContain("Scan for current availability")
    expect(markup).toContain(
      `data-qr-value="${result[1]!.qrValue.replaceAll("&", "&amp;")}"`
    )
  })

  it("prints one US Letter page per selected event or merchant sheet", () => {
    const result = sheets({ merchants: [MERCHANT_A, MERCHANT_B] })
    const event = renderToStaticMarkup(
      <EventQrPrintPages sheets={[result[0]!]} />
    )
    const merchant = renderToStaticMarkup(
      <EventQrPrintPages sheets={[result[1]!]} />
    )
    const batch = renderToStaticMarkup(<EventQrPrintPages sheets={result} />)
    expect(event).toContain('data-event-sign-page-count="1"')
    expect(merchant).toContain('data-event-sign-page-count="1"')
    expect(batch).toContain('data-event-sign-page-count="3"')
    expect(batch.match(/data-testid="event-sign-sheet"/g)).toHaveLength(3)
    expect(batch).not.toContain("products available")
  })

  it("warns for partial, stale and unavailable batches including a single merchant page", () => {
    expect(getEventSignEvidenceNotice("current", true)).toBeNull()
    expect(
      getEventSignPreviewEvidenceNotice("partial", "merchant-batch")?.title
    ).toBe("Merchant list may be incomplete")
    expect(
      getEventSignPreviewEvidenceNotice("partial", "merchant-batch")?.message
    ).toContain("every approved merchant")
    expect(
      getEventSignPreviewEvidenceNotice("stale", "merchant-batch")?.message
    ).toContain("current approved merchants")
    expect(
      getEventSignPreviewEvidenceNotice("partial", "merchant")?.title
    ).toBe("Event evidence is incomplete")
    expect(
      getEventSignPreviewEvidenceNotice("unavailable", "event")?.title
    ).toBe("Event evidence needs attention")
  })
})

describe("current sign QR and PDF rendering", () => {
  it("bounds QR hints while preserving exact event, merchant and date destinations", () => {
    const relayHints = Array.from({ length: 7 }, (_, index) => {
      const prefix = `wss://relay-${index}.example/`
      return `${prefix}${String(index).repeat(255 - prefix.length)}`
    })
    const result = sheets({ relayHints, occurrence: CALENDAR })
    expect(new TextEncoder().encode(result[0]!.url).length).toBeGreaterThan(
      EVENT_SIGN_QR_MAX_BYTES
    )
    for (const sheet of result) {
      const full = new URL(sheet.url)
      const qr = new URL(sheet.qrValue)
      const fullRef = decodeEventMarketReference(
        full.pathname.split("/").at(-1)!,
        [30409]
      )!
      const qrRef = decodeEventMarketReference(
        qr.pathname.split("/").at(-1)!,
        [30409]
      )!
      expect(fullRef.coordinate).toBe(MARKET)
      expect(qrRef.coordinate).toBe(MARKET)
      expect(fullRef.relayHints).toHaveLength(relayHints.length)
      expect(qrRef.relayHints.length).toBeLessThan(relayHints.length)
      expect(isEventSignQrValueWithinBudget(sheet.qrValue)).toBe(true)
      expect(qr.searchParams.get("merchant")).toBe(
        full.searchParams.get("merchant")
      )
      expect(qr.searchParams.get("occurrence")).toBe(CALENDAR)
    }
    expect(() =>
      renderToStaticMarkup(<EventQrPrintPages sheets={result} />)
    ).not.toThrow()
  })

  it("uses a controlled QR fallback when the destination exceeds the byte budget", () => {
    const event = sheets()[0]!
    const markup = renderToStaticMarkup(
      <EventQrPrintPages
        sheets={[
          {
            ...event,
            qrValue: `https://conduit.market/events/${"x".repeat(EVENT_SIGN_QR_MAX_BYTES)}`,
          },
        ]}
      />
    )
    expect(markup).toContain('data-testid="event-sign-qr-fallback"')
    expect(markup).toContain("QR code unavailable")
  })

  it("keeps quiet zones, Letter print layout and native Save as PDF available", async () => {
    const component = await Bun.file(
      "apps/merchant/src/components/EventQrPrintPreview.tsx"
    ).text()
    expect(component).toContain("marginSize={4}")
    expect(component).toContain("@page { size: 8.5in 11in; margin: 0; }")
    expect(component).toContain("Print / Save as PDF")
    expect(component).toContain("window.print()")
    const styles = await Bun.file("apps/merchant/src/styles/index.css").text()
    expect(styles).toContain("break-after: page")
  })
})
