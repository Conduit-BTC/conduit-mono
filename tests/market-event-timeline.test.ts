import { describe, expect, it } from "bun:test"
import {
  filterAndSortEventMarkets,
  formatEventTimelineSchedule,
  getEventTimelineFacets,
  getEventTimelineStatus,
} from "../apps/market/src/lib/eventTimeline"
import type { EventMarketResolution } from "@conduit/core"

const NOW = Date.UTC(2027, 5, 1, 12)

function market(input: {
  suffix: string
  organizer?: string
  start: number
  end: number
  state?: EventMarketResolution["state"]
  location?: string
  topics?: string[]
}): EventMarketResolution {
  const organizer = input.organizer ?? "a".repeat(64)
  const reference = `30405:${organizer}:${input.suffix}`
  return {
    state: input.state ?? "active",
    reference,
    organizerPubkey: organizer,
    collectionCoordinate: reference,
    calendarCoordinate: `31923:${organizer}:${input.suffix}`,
    collection: {
      coordinate: reference,
      eventId: "1".repeat(64),
      authorPubkey: organizer,
      dTag: input.suffix,
      title: input.suffix,
      content: "",
      eventCoordinates: [`31923:${organizer}:${input.suffix}`],
      pickupCoordinates: [],
      productCoordinates: [],
      unsupportedReferences: [],
      createdAt: NOW,
    },
    calendar: {
      coordinate: `31923:${organizer}:${input.suffix}`,
      eventId: "2".repeat(64),
      authorPubkey: organizer,
      dTag: input.suffix,
      kind: 31923,
      title: input.suffix,
      content: "",
      locations: input.location ? [input.location] : [],
      ...(input.topics ? { topics: input.topics } : {}),
      start: input.start,
      end: input.end,
      createdAt: NOW,
    },
    pickups: [],
    organizerProductCoordinates: [],
    acceptedProductCoordinates: [],
    acceptedProductEvidence: [],
    organizerOnlyProductCoordinates: [],
    participationRequests: [],
    participationBudget: {
      state: "within_budget",
      targetCount: 0,
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
  }
}

describe("Market event timeline", () => {
  const past = market({
    suffix: "past",
    start: NOW - 86_400_000,
    end: NOW - 3_600_000,
    state: "ended",
    location: "Chicago",
    topics: ["V4V"],
  })
  const soon = market({
    suffix: "soon",
    start: NOW + 3_600_000,
    end: NOW + 7_200_000,
    state: "partial",
    location: "Chicago",
    topics: ["Bitcoin"],
  })
  const later = market({
    suffix: "later",
    organizer: "b".repeat(64),
    start: NOW + 10 * 86_400_000,
    end: NOW + 10 * 86_400_000 + 3_600_000,
    location: "Detroit",
    topics: ["V4V"],
  })

  it("shows upcoming events soonest-first and keeps past events explicit", () => {
    expect(
      filterAndSortEventMarkets([later, past, soon], {}, NOW).map(
        (item) => item.reference
      )
    ).toEqual([soon.reference, later.reference])
    expect(
      filterAndSortEventMarkets(
        [later, past, soon],
        { window: "all" },
        NOW
      ).map((item) => item.reference)
    ).toEqual([soon.reference, later.reference, past.reference])
  })

  it("filters locally by date, organizer, location, and signed topic", () => {
    expect(
      filterAndSortEventMarkets(
        [later, past, soon],
        { window: "7d", location: "chicago", topic: "bitcoin" },
        NOW
      ).map((item) => item.reference)
    ).toEqual([soon.reference])
    expect(
      filterAndSortEventMarkets(
        [later, past, soon],
        { window: "all", organizer: "b".repeat(64) },
        NOW
      ).map((item) => item.reference)
    ).toEqual([later.reference])
  })

  it("derives stable facets and honest relay-aware statuses", () => {
    expect(getEventTimelineFacets([later, past, soon])).toEqual({
      organizers: ["a".repeat(64), "b".repeat(64)],
      locations: ["Chicago", "Detroit"],
      topics: ["Bitcoin", "V4V"],
    })
    const [typedSoon] = filterAndSortEventMarkets([soon], {}, NOW)
    const [typedPast] = filterAndSortEventMarkets(
      [past],
      { window: "past" },
      NOW
    )
    expect(getEventTimelineStatus(typedSoon!, NOW)).toEqual({
      label: "Partial relay view",
      tone: "warning",
    })
    expect(getEventTimelineStatus(typedPast!, NOW)).toEqual({
      label: "Past event",
      tone: "secondary",
    })
  })

  it("formats timed schedules in their signed timezone", () => {
    expect(
      formatEventTimelineSchedule(
        {
          ...(soon.calendar as NonNullable<typeof soon.calendar>),
          startTzid: "America/New_York",
        },
        "en-US"
      )
    ).toContain("9:00 AM")
  })
})
