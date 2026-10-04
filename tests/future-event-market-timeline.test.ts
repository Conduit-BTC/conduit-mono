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
import { projectFutureMarketTimelineOccurrences } from "../apps/market/src/components/MarketEventsTimeline"
import {
  getFutureMerchantTimelineDateParts,
  matchesMerchantEventRelationship,
  merchantEventDatesUnavailable,
  projectFutureMerchantTimelineOccurrences,
} from "../apps/merchant/src/lib/merchant-event-timeline"

const secret = generateSecretKey()
const organizer = getPublicKey(secret)
const dates = [
  { dTag: "first", start: 1_790_000_000, end: 1_790_003_600, day: "20717" },
  { dTag: "second", start: 1_790_086_400, end: 1_790_090_000, day: "20718" },
].map(({ dTag, start, end, day }) => {
  const signed = finalizeEvent(
    {
      kind: 31923,
      tags: [
        ["d", dTag],
        ["title", `Fair ${dTag}`],
        ["start", String(start)],
        ["end", String(end)],
        ["D", day],
      ],
      content: "",
      created_at: 100,
    },
    secret
  )
  return { signed, parsed: parseEventMarketCalendarEvent(signed)! }
})
const seriesCoordinate = `31924:${organizer}:fair-dates`
const seriesSigned = finalizeEvent(
  {
    ...buildEventMarketSeriesDraft({
      dTag: "fair-dates",
      organizerPubkey: organizer,
      title: "Fair dates",
      memberCoordinates: dates.map(({ parsed }) => parsed.coordinate),
    }),
    created_at: 100,
  },
  secret
)
const series = parseEventMarketSeriesEvent(seriesSigned)!
const marketSigned = finalizeEvent(
  {
    ...buildEventMarketRosterDraft({
      dTag: "fair",
      organizerPubkey: organizer,
      calendarCoordinate: seriesCoordinate,
      state: "open",
      merchants: [],
    }),
    created_at: 100,
  },
  secret
)
const market = parseEventMarketRosterEvent(marketSigned)!
const seriesRead: EventMarketRosterReadResult = {
  coordinate: market.coordinate,
  resolution: { state: "current", market },
  coverage: "partial",
  retained: true,
  observedRelayUrls: [],
  calendar: dates[0]!.parsed,
  calendarCoverage: "complete",
  schedule: {
    kind: "series",
    coordinate: seriesCoordinate,
    series,
    occurrences: dates.map(({ signed, parsed }, index) => ({
      occurrence: parsed,
      occurrenceEvent: signed,
      coverage: index === 0 ? "complete" : "partial",
    })),
    unresolvedCoordinates: [`31923:${organizer}:unresolved`],
  },
  scheduleCoverage: "partial",
}

describe("future Event Market timeline rows", () => {
  it("includes owned events in All Events and separates organizing from signed selling membership", () => {
    expect(matchesMerchantEventRelationship(seriesRead, organizer, "all")).toBe(
      true
    )
    expect(
      matchesMerchantEventRelationship(seriesRead, organizer, "organizing")
    ).toBe(true)
    expect(
      matchesMerchantEventRelationship(seriesRead, organizer, "selling")
    ).toBe(false)
    const selling = {
      ...seriesRead,
      resolution: {
        state: "current" as const,
        market: {
          ...market,
          merchants: [
            {
              pubkey: organizer,
              mode: "merchant_present" as const,
              assignment: "Booth",
            },
          ],
        },
      },
    }
    expect(
      matchesMerchantEventRelationship(selling, organizer, "selling")
    ).toBe(true)
    expect(
      matchesMerchantEventRelationship(selling, "f".repeat(64), "organizing")
    ).toBe(false)
    expect(
      matchesMerchantEventRelationship(
        { ...seriesRead, resolution: { state: "missing" } },
        organizer,
        "all"
      )
    ).toBe(false)
  })

  it("distinguishes known missing single or series dates from an empty discovery", () => {
    expect(merchantEventDatesUnavailable(seriesRead)).toBe(true)
    expect(
      merchantEventDatesUnavailable({
        ...seriesRead,
        schedule: {
          ...seriesRead.schedule!,
          unresolvedCoordinates: [],
        } as typeof seriesRead.schedule,
        scheduleCoverage: "complete",
      })
    ).toBe(false)
    const single = {
      ...seriesRead,
      resolution: {
        state: "current" as const,
        market: { ...market, calendarCoordinate: dates[0]!.parsed.coordinate },
      },
      schedule: undefined,
      calendar: null,
    }
    expect(merchantEventDatesUnavailable(single)).toBe(true)
    expect(
      merchantEventDatesUnavailable({ ...single, calendar: dates[0]!.parsed })
    ).toBe(false)
    expect(
      merchantEventDatesUnavailable({
        ...single,
        resolution: { state: "missing" },
      })
    ).toBe(false)
  })

  it("keeps date-only dates and signed timezone day rollover distinct", () => {
    const dateOnly = getFutureMerchantTimelineDateParts({
      ...dates[0]!.parsed,
      kind: 31922,
      start: Date.UTC(2026, 10, 8),
      startDate: "2026-11-08",
    })
    expect(dateOnly).toMatchObject({
      day: "8",
      year: "2026",
      dateTime: "2026-11-08",
    })
    const timed = {
      ...dates[0]!.parsed,
      start: Date.UTC(2026, 10, 8, 3, 30),
      startTzid: "America/New_York",
    }
    const first = getFutureMerchantTimelineDateParts(timed)
    expect(first).toMatchObject({
      day: "7",
      year: "2026",
      dateTime: "2026-11-08T03:30:00.000Z",
    })
    expect(getFutureMerchantTimelineDateParts(timed)).toEqual(first)
    expect(
      getFutureMerchantTimelineDateParts({ ...timed, startTzid: "UTC" }).day
    ).toBe("8")
  })
  it("projects each verified series date in both apps without inventing an unresolved sibling", () => {
    for (const project of [
      projectFutureMarketTimelineOccurrences,
      projectFutureMerchantTimelineOccurrences,
    ]) {
      const rows = project(seriesRead)
      expect(rows.map((row) => row.coordinate)).toEqual(
        dates.map(({ parsed }) => parsed.coordinate)
      )
      expect(rows.map((row) => row.calendar.start)).toEqual(
        dates.map(({ parsed }) => parsed.start)
      )
      expect(rows.every((row) => row.series)).toBe(true)
      expect(rows).toHaveLength(2)
    }
  })

  it("keeps a single date as one row and hides an unresolved market", () => {
    const singleRead: EventMarketRosterReadResult = {
      ...seriesRead,
      schedule: {
        kind: "single",
        coordinate: dates[0]!.parsed.coordinate,
        occurrence: dates[0]!.parsed,
        occurrenceEvent: dates[0]!.signed,
      },
    }
    for (const project of [
      projectFutureMarketTimelineOccurrences,
      projectFutureMerchantTimelineOccurrences,
    ]) {
      expect(project(singleRead)).toMatchObject([
        { coordinate: dates[0]!.parsed.coordinate, series: false },
      ])
      expect(
        project({ ...seriesRead, resolution: { state: "missing" } })
      ).toEqual([])
    }
  })
})
