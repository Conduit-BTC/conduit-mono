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
  resolveEventMarketRoster,
  type EventMarketRosterReadResult,
} from "@conduit/core"
import {
  getMerchantProductMarketReferences,
  hydrateMerchantProductMarkets,
  mergeMerchantTimelineMarketReads,
} from "../apps/merchant/src/lib/merchant-event-relationship-hydration"
import { projectFutureMerchantTimelineOccurrences } from "../apps/merchant/src/lib/merchant-event-timeline"
import { admitPublicEvent } from "@conduit/core/protocol/verified-public-event"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

async function admitted(event: SignedPublicNostrEvent) {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error(`Fixture admission failed: ${result.status}`)
  return result.event
}

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
const verifiedMarket = await admitted(signedMarket)
const market = parseEventMarketRosterEvent(verifiedMarket)!
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
const verifiedDate = await admitted(signedDate)
const date = parseEventMarketCalendarEvent(verifiedDate)!
const exactRead: EventMarketRosterReadResult = {
  coordinate,
  resolution: { state: "current", market },
  coverage: "complete",
  retained: true,
  observedRelayUrls: ["wss://example.test"],
  observedEvidence: [verifiedMarket],
  calendar: date,
  calendarCoverage: "complete",
  schedule: {
    kind: "single",
    coordinate: dateCoordinate,
    occurrence: date,
    occurrenceEvent: verifiedDate,
  },
}
const newerSignedMarket = finalizeEvent(
  {
    ...signedMarket,
    tags: [...signedMarket.tags, ["prev", signedMarket.id]],
    created_at: 200,
  },
  organizerSecret
)
const verifiedNewerMarket = await admitted(newerSignedMarket)
const newerRead: EventMarketRosterReadResult = {
  ...exactRead,
  resolution: {
    state: "current",
    market: parseEventMarketRosterEvent(verifiedNewerMarket)!,
  },
  observedEvidence: [verifiedMarket, verifiedNewerMarket],
}
async function negativeRead(
  events: SignedPublicNostrEvent[]
): Promise<EventMarketRosterReadResult> {
  const verifiedEvents = await Promise.all(events.map(admitted))
  return {
    ...exactRead,
    resolution: resolveEventMarketRoster({
      coordinate,
      revisions: verifiedEvents.filter((event) => event.kind === 30409),
      deletions: verifiedEvents.filter((event) => event.kind === 5),
    }),
    observedEvidence: verifiedEvents,
  }
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

  it("prefers a newer signed schedule with fewer dates over a stale larger series", async () => {
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
    const verifiedSeriesMarket = await admitted(seriesMarketSigned)
    const seriesMarket = parseEventMarketRosterEvent(verifiedSeriesMarket)!
    const dates = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
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
        const verifiedEvent = await admitted(event)
        return {
          event: verifiedEvent,
          date: parseEventMarketCalendarEvent(verifiedEvent)!,
        }
      })
    )
    const schedule = async (members: typeof dates, createdAt: number) => {
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
      return parseEventMarketSeriesEvent(await admitted(signed))!
    }
    const oldSchedule = await schedule(dates, 101)
    const newSchedule = await schedule(dates.slice(0, 1), 102)
    const read = (
      series: typeof oldSchedule,
      members: typeof dates,
      coverage: "stale" | "complete"
    ): EventMarketRosterReadResult => ({
      coordinate: seriesMarket.coordinate,
      resolution: { state: "current", market: seriesMarket },
      observedEvidence: [verifiedSeriesMarket],
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

  it("preserves a newer signed single date even when its read is partial", async () => {
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
    const admittedNewerDate = await admitted(newerSignedDate)
    const newerDate = parseEventMarketCalendarEvent(admittedNewerDate)!
    const partialNewer: EventMarketRosterReadResult = {
      ...exactRead,
      calendar: newerDate,
      calendarCoverage: "partial",
      schedule: {
        kind: "single",
        coordinate: dateCoordinate,
        occurrence: newerDate,
        occurrenceEvent: admittedNewerDate,
      },
    }
    expect(
      mergeMerchantTimelineMarketReads([exactRead], [partialNewer])
    ).toEqual([partialNewer])
    expect(
      mergeMerchantTimelineMarketReads([partialNewer], [exactRead])
    ).toEqual([partialNewer])
  })

  for (const target of ["coordinate", "old-id"] as const) {
    it(`keeps a newer roster over a non-covering ${target} deletion in either merge order`, async () => {
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: target === "coordinate" ? 150 : 300,
          tags: [
            target === "coordinate"
              ? ["a", coordinate]
              : ["e", signedMarket.id],
          ],
          content: "",
        },
        organizerSecret
      )
      const older = await negativeRead([signedMarket, deletion])
      expect(older.resolution.state).toBe("deleted")
      for (const [left, right] of [
        [older, newerRead],
        [newerRead, older],
      ]) {
        const merged = mergeMerchantTimelineMarketReads([left!], [right!])[0]!
        expect(merged.resolution).toEqual(newerRead.resolution)
        expect(
          merged.observedEvidence?.some((event) => event.id === deletion.id)
        ).toBe(true)
        expect(projectFutureMerchantTimelineOccurrences(merged)).toHaveLength(1)
      }
    })
  }

  it("allows a signed repair of an older malformed roster in either merge order", async () => {
    const malformed = finalizeEvent(
      {
        ...signedMarket,
        created_at: 150,
        tags: signedMarket.tags.filter((tag) => tag[0] !== "event_market"),
      },
      organizerSecret
    )
    const repaired = finalizeEvent(
      {
        ...signedMarket,
        created_at: 200,
        tags: [...signedMarket.tags, ["prev", malformed.id]],
      },
      organizerSecret
    )
    const repairedRead: EventMarketRosterReadResult = {
      ...exactRead,
      resolution: {
        state: "current",
        market: parseEventMarketRosterEvent(await admitted(repaired))!,
      },
      observedEvidence: [
        verifiedMarket,
        await admitted(malformed),
        await admitted(repaired),
      ],
    }
    const older = await negativeRead([signedMarket, malformed])
    expect(older.resolution.state).toBe("malformed")
    for (const [left, right] of [
      [older, repairedRead],
      [repairedRead, older],
    ]) {
      const merged = mergeMerchantTimelineMarketReads([left!], [right!])[0]!
      expect(merged.resolution).toEqual(repairedRead.resolution)
    }
  })

  it("keeps a covering deletion after merging a later current read and stale observations", async () => {
    const deletion = finalizeEvent(
      { kind: 5, created_at: 250, tags: [["a", coordinate]], content: "" },
      organizerSecret
    )
    const older = await negativeRead([signedMarket, deletion])
    for (const [left, right] of [
      [older, newerRead],
      [newerRead, older],
    ]) {
      const merged = mergeMerchantTimelineMarketReads([left!], [right!])
      expect(merged[0]!.resolution.state).toBe("deleted")
      expect(
        mergeMerchantTimelineMarketReads(merged, [exactRead])[0]!.resolution
          .state
      ).toBe("deleted")
      expect(projectFutureMerchantTimelineOccurrences(merged[0]!)).toEqual([])
    }
  })

  it("preserves conflicts exposed only by the union of separately current reads", async () => {
    const fork = finalizeEvent(
      {
        ...newerSignedMarket,
        created_at: 201,
        content: "Independent sibling edit",
      },
      organizerSecret
    )
    const forkRead: EventMarketRosterReadResult = {
      ...exactRead,
      resolution: {
        state: "current",
        market: parseEventMarketRosterEvent(await admitted(fork))!,
      },
      observedEvidence: [verifiedMarket, await admitted(fork)],
    }
    for (const [left, right] of [
      [forkRead, newerRead],
      [newerRead, forkRead],
    ]) {
      expect(
        mergeMerchantTimelineMarketReads([left!], [right!])[0]!.resolution.state
      ).toBe("conflicting")
    }
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
