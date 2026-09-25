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
import { projectFutureMerchantTimelineOccurrences } from "../apps/merchant/src/components/MerchantEventsTimeline"

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
