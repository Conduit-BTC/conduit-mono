import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  buildEventMarketSeriesDraft,
  parseEventMarketCalendarEvent,
  parseEventMarketRosterEvent,
  parseEventMarketSeriesEvent,
  type EventMarketRosterReadResult,
} from "@conduit/core"
import {
  getMerchantProductMarketReferences,
  hydrateMerchantProductMarkets,
  mergeMerchantTimelineMarketReads,
} from "../apps/merchant/src/lib/merchant-event-relationship-hydration"
import { projectFutureMerchantTimelineOccurrences } from "../apps/merchant/src/lib/merchant-event-timeline"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = getPublicKey(generateSecretKey())
const coordinate = `30409:${organizer}:neighborhood-market`
const dateCoordinate = `31922:${organizer}:neighborhood-date`
const signedMarket = finalizeEvent(
  {
    ...buildEventMarketRosterDraft({
      dTag: "neighborhood-market",
      organizerPubkey: organizer,
      calendarCoordinate: dateCoordinate,
      state: "open",
      merchants: [
        {
          pubkey: merchant,
          mode: "merchant_present",
          assignment: "Booth 8",
        },
      ],
    }),
    created_at: 100,
  },
  organizerSecret
)
const market = parseEventMarketRosterEvent(signedMarket)!
const signedDate = finalizeEvent(
  {
    kind: 31922,
    tags: [
      ["d", "neighborhood-date"],
      ["title", "Neighborhood market"],
      ["start", "2030-04-13"],
      ["end", "2030-04-14"],
    ],
    content: "",
    created_at: 100,
  },
  organizerSecret
)
const date = parseEventMarketCalendarEvent(signedDate)!
const exactRead: EventMarketRosterReadResult = {
  coordinate,
  resolution: { state: "current", market },
  coverage: "complete",
  retained: true,
  observedRelayUrls: ["wss://example.test"],
  calendar: date,
  calendarCoverage: "complete",
  schedule: {
    kind: "single",
    coordinate: dateCoordinate,
    occurrence: date,
    occurrenceEvent: signedDate,
  },
}

describe("Merchant product Event Market relationships", () => {
  it("finds a signed Selling at market outside the perspective organizer graph", async () => {
    const references = getMerchantProductMarketReferences([
      { eventMarketRefs: [coordinate, coordinate] },
      { eventMarketRefs: [`30405:${organizer}:retired`, coordinate] },
      { eventMarketRefs: [] },
    ])
    expect(references).toEqual([coordinate])
    const exact = await hydrateMerchantProductMarkets({
      references,
      read: async (reference) => {
        expect(reference).toBe(coordinate)
        return exactRead
      },
    })
    expect(exact.failedCount).toBe(0)
    const merged = mergeMerchantTimelineMarketReads([], exact.markets)
    expect(merged).toHaveLength(1)
    expect(
      merged[0]?.resolution.state === "current" &&
        merged[0].resolution.market.merchants.some(
          (row) => row.pubkey === merchant
        )
    ).toBe(true)
    expect(projectFutureMerchantTimelineOccurrences(merged[0]!)).toHaveLength(1)
  })

  it("does not duplicate a perspective market or replace its stronger calendar read", () => {
    const partial = {
      ...exactRead,
      calendarCoverage: "partial" as const,
    }
    expect(mergeMerchantTimelineMarketReads([exactRead], [partial])).toEqual([
      exactRead,
    ])
    expect(mergeMerchantTimelineMarketReads([partial], [exactRead])).toEqual([
      exactRead,
    ])
  })

  it("prefers a newer signed schedule with fewer dates over a stale larger series", () => {
    const seriesCoordinate = `31924:${organizer}:neighborhood-series`
    const seriesMarketSigned = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "neighborhood-series-market",
          organizerPubkey: organizer,
          calendarCoordinate: seriesCoordinate,
          state: "open",
          merchants: [
            {
              pubkey: merchant,
              mode: "merchant_present",
              assignment: "Booth 8",
            },
          ],
        }),
        created_at: 100,
      },
      organizerSecret
    )
    const seriesMarket = parseEventMarketRosterEvent(seriesMarketSigned)!
    const dates = Array.from({ length: 6 }, (_, index) => {
      const event = finalizeEvent(
        {
          kind: 31922,
          tags: [
            ["d", `series-day-${index}`],
            ["title", `Series day ${index}`],
            ["start", `2030-04-${String(index + 10).padStart(2, "0")}`],
          ],
          content: "",
          created_at: 100,
        },
        organizerSecret
      )
      return { event, date: parseEventMarketCalendarEvent(event)! }
    })
    const schedule = (members: typeof dates, createdAt: number) => {
      const signed = finalizeEvent(
        {
          ...buildEventMarketSeriesDraft({
            dTag: "neighborhood-series",
            organizerPubkey: organizer,
            title: "Neighborhood series",
            memberCoordinates: members.map(({ date }) => date.coordinate),
          }),
          created_at: createdAt,
        },
        organizerSecret
      )
      return parseEventMarketSeriesEvent(signed)!
    }
    const oldSchedule = schedule(dates, 101)
    const newSchedule = schedule(dates.slice(0, 1), 102)
    const read = (
      series: typeof oldSchedule,
      members: typeof dates,
      coverage: "stale" | "complete"
    ): EventMarketRosterReadResult => ({
      coordinate: seriesMarket.coordinate,
      resolution: { state: "current", market: seriesMarket },
      coverage,
      retained: true,
      observedRelayUrls: [],
      calendar: members[0]!.date,
      calendarCoverage: coverage,
      schedule: {
        kind: "series",
        coordinate: seriesCoordinate,
        series,
        occurrences: members.map(({ event, date }) => ({
          occurrence: date,
          occurrenceEvent: event,
          coverage,
        })),
        unresolvedCoordinates: [],
      },
      scheduleCoverage: coverage,
    })
    const staleMany = read(oldSchedule, dates, "stale")
    const currentFew = read(newSchedule, dates.slice(0, 1), "complete")
    expect(mergeMerchantTimelineMarketReads([staleMany], [currentFew])).toEqual(
      [currentFew]
    )
    expect(mergeMerchantTimelineMarketReads([currentFew], [staleMany])).toEqual(
      [currentFew]
    )
  })

  it("preserves a newer signed single date even when its read is partial", () => {
    const newerSignedDate = finalizeEvent(
      {
        kind: 31922,
        tags: [
          ["d", "neighborhood-date"],
          ["title", "Updated neighborhood market"],
          ["start", "2030-04-13"],
          ["end", "2030-04-14"],
        ],
        content: "",
        created_at: 200,
      },
      organizerSecret
    )
    const newerDate = parseEventMarketCalendarEvent(newerSignedDate)!
    const partialNewer: EventMarketRosterReadResult = {
      ...exactRead,
      calendar: newerDate,
      calendarCoverage: "partial",
      schedule: {
        kind: "single",
        coordinate: dateCoordinate,
        occurrence: newerDate,
        occurrenceEvent: newerSignedDate,
      },
    }
    expect(
      mergeMerchantTimelineMarketReads([exactRead], [partialNewer])
    ).toEqual([partialNewer])
    expect(
      mergeMerchantTimelineMarketReads([partialNewer], [exactRead])
    ).toEqual([partialNewer])
  })

  it("keeps known negative signed evidence from painting an admitted row", () => {
    const negative: EventMarketRosterReadResult = {
      ...exactRead,
      resolution: { state: "deleted", eventId: signedMarket.id },
    }
    const merged = mergeMerchantTimelineMarketReads([exactRead], [negative])
    expect(merged[0]?.resolution.state).toBe("deleted")
    expect(projectFutureMerchantTimelineOccurrences(merged[0]!)).toEqual([])
  })

  it("bounds held exact reads and reports unresolved references", async () => {
    const result = await hydrateMerchantProductMarkets({
      references: [coordinate, `30409:${organizer}:held`],
      concurrency: 2,
      deadlineMs: 5,
      read: async (reference) =>
        reference === coordinate
          ? exactRead
          : new Promise<EventMarketRosterReadResult>(() => undefined),
    })
    expect(result.markets).toEqual([exactRead])
    expect(result.failedCount).toBe(1)
  })
})
