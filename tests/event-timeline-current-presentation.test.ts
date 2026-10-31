import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  parseEventMarketCalendarEvent,
  type EventMarketCalendarDraftInput,
} from "@conduit/core"
import { paginateEventTimeline, subscribeToTimeBoundaries } from "@conduit/ui"
import {
  formatEventTimelineSchedule,
  getEventTimelineDateParts,
  getNextEventTimelineLimit,
} from "../apps/market/src/lib/eventTimeline"
import { createFakeTimeBoundaryClock } from "./helpers/fake-time-boundary-clock"
import { admitPublicEvent } from "@conduit/core/protocol/verified-public-event"

async function calendar(input: EventMarketCalendarDraftInput) {
  const signed = finalizeEvent(
    { ...buildEventMarketCalendarDraft(input), created_at: 100 },
    generateSecretKey()
  )
  const admission = await admitPublicEvent(signed)
  expect(admission.status).toBe("verified")
  if (admission.status !== "verified")
    throw new Error("Fixture admission failed")
  const parsed = parseEventMarketCalendarEvent(admission.event)
  expect(parsed).not.toBeNull()
  return parsed!
}

describe("current Event Market calendar presentation", () => {
  it("keeps a date-only event active through its whole day and excludes the signed end date", async () => {
    const day = await calendar({
      kind: 31922,
      dTag: "one-day",
      title: "One day",
      start: "2030-06-01",
    })
    expect(day.end - day.start).toBe(86_400_000)
    const row = { key: day.coordinate, start: day.start, end: day.end }
    expect(
      paginateEventTimeline([row], { earlier: 12, later: 12 }, day.end - 1)
        .currentAndFuture
    ).toHaveLength(1)
    expect(
      paginateEventTimeline([row], { earlier: 12, later: 12 }, day.end).past
    ).toHaveLength(1)
    expect(formatEventTimelineSchedule(day, "en-US")).toBe("2030-06-01")
    const range = await calendar({
      kind: 31922,
      dTag: "range",
      title: "Weekend",
      start: "2030-06-01",
      end: "2030-06-04",
    })
    expect(formatEventTimelineSchedule(range, "en-US")).toBe(
      "2030-06-01 to 2030-06-03"
    )
    expect(getEventTimelineDateParts(range, "en-US")).toEqual({
      dateTime: "2030-06-01",
      day: "1",
      month: "Jun",
      year: "2030",
    })
  })
  it("formats the signed time zone across a daylight-saving boundary", async () => {
    const date = await calendar({
      kind: 31923,
      dTag: "clock-change",
      title: "Sunday event",
      start: Date.parse("2030-03-10T07:30:00Z") / 1000,
      end: Date.parse("2030-03-10T08:30:00Z") / 1000,
      startTzid: "America/Chicago",
      endTzid: "America/Chicago",
    })
    const label = formatEventTimelineSchedule(date, "en-US")
    expect(label).toContain("1:30")
    expect(label).toContain("3:30")
    expect(label).toContain("America/Chicago")
    expect(getEventTimelineDateParts(date, "en-US").day).toBe("10")
  })
  it("keeps twelve rows on each side and reveals the next chronological page without duplicates", () => {
    const rows = Array.from({ length: 28 }, (_, index) => ({
      key: String(index),
      start: index * 100,
      end: index * 100 + 50,
    })).reverse()
    const now = 1350
    const first = paginateEventTimeline(rows, { earlier: 12, later: 12 }, now)
    expect(first.past.map((row) => row.key)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 2))
    )
    expect(first.currentAndFuture.map((row) => row.key)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 14))
    )
    expect(first.hiddenEarlierCount).toBe(2)
    expect(first.hiddenLaterCount).toBe(2)
    const limit = getNextEventTimelineLimit(12, 14)
    const next = paginateEventTimeline(
      rows,
      { earlier: limit, later: limit },
      now
    )
    expect(next.past.concat(next.currentAndFuture)).toHaveLength(28)
    expect(
      new Set(next.past.concat(next.currentAndFuture).map((row) => row.key))
        .size
    ).toBe(28)
    expect(next.hiddenEarlierCount + next.hiddenLaterCount).toBe(0)
    expect(rows[0]?.key).toBe("27")
    expect(
      paginateEventTimeline(rows, { earlier: 0, later: 0 }, now).past
    ).toEqual([])
  })
  it("moves an occurrence into past at its exact end using the mounted boundary clock", () => {
    const rows = [{ key: "one", start: 1000, end: 2000 }]
    const clock = createFakeTimeBoundaryClock(999)
    let now = clock.now()
    const stop = subscribeToTimeBoundaries({
      boundaries: [1000, 2000],
      currentNowMs: now,
      onBoundary: (time) => {
        now = time
      },
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    })
    clock.advanceTo(1000)
    expect(
      paginateEventTimeline(rows, { earlier: 12, later: 12 }, now)
        .currentAndFuture
    ).toHaveLength(1)
    clock.advanceTo(2000)
    expect(
      paginateEventTimeline(rows, { earlier: 12, later: 12 }, now).past
    ).toHaveLength(1)
    expect(
      paginateEventTimeline(rows, { earlier: 12, later: 12 }, now)
        .currentAndFuture
    ).toEqual([])
    stop()
    expect(clock.pendingTimerCount()).toBe(0)
  })

  it("starts with current/upcoming only and reveals history without misclassifying older-start ongoing dates", async () => {
    const ongoing = await calendar({
      kind: 31922,
      dTag: "multi-day-active",
      title: "Long fair",
      start: "2030-06-01",
      end: "2030-06-05",
    })
    const ended = await calendar({
      kind: 31922,
      dTag: "later-start-ended",
      title: "Past fair",
      start: "2030-06-03",
    })
    const zoned = await calendar({
      kind: 31923,
      dTag: "local-evening-active",
      title: "Evening fair",
      start: Date.parse("2030-06-03T23:00:00Z") / 1_000,
      end: Date.parse("2030-06-04T02:00:00Z") / 1_000,
      startTzid: "America/Chicago",
      endTzid: "America/Chicago",
    })
    const upcoming = await calendar({
      kind: 31922,
      dTag: "future-day",
      title: "Future fair",
      start: "2030-06-05",
    })
    const dates = [upcoming, ended, zoned, ongoing]
    const rows = dates.map((date) => ({
      key: date.coordinate,
      start: date.start,
      end: date.end,
    }))
    const snapshot = structuredClone(rows)
    const now = Date.parse("2030-06-04T00:30:00Z")
    const current = paginateEventTimeline(rows, { earlier: 0, later: 12 }, now)
    expect(current.past).toEqual([])
    expect(current.hiddenEarlierCount).toBe(1)
    expect(current.currentAndFuture.map((row) => row.key)).toEqual([
      ongoing.coordinate,
      zoned.coordinate,
      upcoming.coordinate,
    ])
    const history = paginateEventTimeline(
      rows,
      {
        earlier: getNextEventTimelineLimit(0, current.hiddenEarlierCount),
        later: 12,
      },
      now
    )
    expect(history.past.map((row) => row.key)).toEqual([ended.coordinate])
    expect(history.currentAndFuture).toEqual(current.currentAndFuture)
    expect(rows).toEqual(snapshot)
    expect(
      paginateEventTimeline(
        rows,
        { earlier: 0, later: 12 },
        ongoing.end
      ).currentAndFuture.map((row) => row.key)
    ).toEqual([upcoming.coordinate])
  })
})
