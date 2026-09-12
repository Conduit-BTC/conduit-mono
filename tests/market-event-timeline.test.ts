import { describe, expect, it } from "bun:test"
import {
  filterAndSortEventMarkets,
  formatEventTimelineSchedule,
  getEventTimelineFacets,
  getEventTimelinePresentationPerspective,
  getEventTimelineStatus,
} from "../apps/market/src/lib/eventTimeline"
import type { EventMarketResolution } from "@conduit/core"
import { getOrganizerDiscoveryPresentation } from "@conduit/ui"

const NOW = Date.UTC(2027, 5, 1, 12)

describe("event timeline perspective presentation", () => {
  const conduitPerspective = {
    source: "conduit" as const,
    coverage: "complete" as const,
    eventObserved: false,
    snapshotState: "curated" as const,
    truncated: false,
    authorCount: 4,
  }

  it("qualifies verified cards when the Conduit perspective refresh is stale", () => {
    const perspective = getEventTimelinePresentationPerspective(
      conduitPerspective,
      true
    )

    expect(perspective).toEqual({
      ...conduitPerspective,
      coverage: "limited",
    })
    expect(
      getOrganizerDiscoveryPresentation({
        state: "complete",
        eventCount: 2,
        perspective,
        candidateScanCoverage: {
          plannedReadCount: 4,
          completeReadCount: 4,
        },
        searchedOrganizerCount: 2,
        incompleteOrganizerCount: 0,
      }).message
    ).toBe(
      "Showing 2 events. Completed 4 of 4 planned bounded relay collection reads. The available Conduit perspective snapshot may be incomplete."
    )
  })

  it("preserves current and already-incomplete perspective coverage", () => {
    expect(
      getEventTimelinePresentationPerspective(conduitPerspective, false)
    ).toBe(conduitPerspective)

    const unavailablePerspective = {
      ...conduitPerspective,
      coverage: "unavailable" as const,
    }
    expect(
      getEventTimelinePresentationPerspective(unavailablePerspective, true)
    ).toBe(unavailablePerspective)
  })

  it("limits stale Following and Combined presentation coverage", () => {
    for (const source of ["following", "combined"] as const) {
      const perspective = { ...conduitPerspective, source }
      expect(
        getEventTimelinePresentationPerspective(perspective, true)
      ).toEqual({ ...perspective, coverage: "limited" })
    }
  })
})

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

function dateMarket(input: {
  suffix: string
  startDate: string
  endDate?: string
}): EventMarketResolution {
  const start = Date.parse(`${input.startDate}T00:00:00Z`)
  const end = input.endDate
    ? Date.parse(`${input.endDate}T00:00:00Z`)
    : start + 86_400_000
  const result = market({ suffix: input.suffix, start, end })
  const calendarCoordinate = result.calendarCoordinate!.replace(
    "31923:",
    "31922:"
  )
  return {
    ...result,
    calendarCoordinate,
    calendar: {
      ...result.calendar!,
      coordinate: calendarCoordinate,
      kind: 31922,
      start,
      end,
      startDate: input.startDate,
      ...(input.endDate ? { endDate: input.endDate } : {}),
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

  it("keeps a no-end date event upcoming through its start date and displays explicit ends exclusively", () => {
    const singleDay = dateMarket({
      suffix: "single-day",
      startDate: "2027-06-01",
    })
    const explicitSingleDay = dateMarket({
      suffix: "explicit-single-day",
      startDate: "2027-06-01",
      endDate: "2027-06-02",
    })
    const multiDay = dateMarket({
      suffix: "multi-day",
      startDate: "2027-06-01",
      endDate: "2027-06-03",
    })

    expect(filterAndSortEventMarkets([singleDay], {}, NOW)).toHaveLength(1)
    expect(
      filterAndSortEventMarkets(
        [explicitSingleDay],
        { window: "past" },
        Date.UTC(2027, 5, 2)
      )
    ).toHaveLength(1)
    const explicitSingleDaySchedule = formatEventTimelineSchedule(
      explicitSingleDay.calendar!,
      "en-US"
    )
    expect(explicitSingleDaySchedule).toBe("2027-06-01")
    expect(explicitSingleDaySchedule).not.toContain("2027-06-02")
    expect(formatEventTimelineSchedule(multiDay.calendar!, "en-US")).toBe(
      "2027-06-01 to 2027-06-02"
    )
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
