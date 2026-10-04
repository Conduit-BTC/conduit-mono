import { describe, expect, it } from "bun:test"
import {
  createEmptyOrganizerEventMarketForm,
  generateOrganizerRecurringDates,
  fromStoredOrganizerEventForm,
  toStoredOrganizerEventForm,
  getOrganizerEventEndMinimum,
  getOrganizerEventStartMinimum,
  getOrganizerEventTimezoneOptions,
  isOrganizerEventMarketFormDirty,
  localDateTimeToEpochSeconds,
  prepareOrganizerEventMarketDates,
  prepareOrganizerEventMarketForm,
  slugifyEventMarketTitle,
  validateOrganizerEventMarketForm,
} from "../apps/merchant/src/lib/event-market-form"

function validForm() {
  return {
    ...createEmptyOrganizerEventMarketForm(),
    title: "Community market",
    summary: "Local merchants and public event pickup.",
    imageUrl: "https://images.example/market.jpg",
    eventLocation: "Public Hall, Main Entrance",
    start: "2026-08-15T09:00",
    end: "2026-08-15T14:00",
    timezone: "America/New_York",
  }
}

function generateWeeklyDates(pattern: {
  firstDate: string
  throughDate: string
  weekdays: number[]
  startTime: string
  endTime: string
  timezone: string
}) {
  return generateOrganizerRecurringDates(
    {
      ...validForm(),
      start: `${pattern.firstDate}T${pattern.startTime}`,
      end: `${pattern.firstDate}T${pattern.endTime}`,
      timezone: pattern.timezone,
    },
    {
      frequency: "weekly",
      weekdays: pattern.weekdays,
      ends: "on_date",
      throughDate: pattern.throughDate,
      count: 4,
    }
  )
}

describe("merchant organizer event form", () => {
  it("accepts the same displayed start and end for a one-day all-day event", () => {
    const form = {
      ...validForm(),
      calendarType: "date" as const,
      start: "2026-10-22",
      end: "2026-10-22",
    }
    expect(validateOrganizerEventMarketForm(form).canPublish).toBe(true)
    expect(prepareOrganizerEventMarketForm(form).calendar).toMatchObject({
      start: "2026-10-22",
      end: "2026-10-23",
    })
    expect(
      prepareOrganizerEventMarketDates(form, [
        { id: "first", start: form.start, end: form.end },
      ])[0]?.calendar
    ).toMatchObject({ start: "2026-10-22", end: "2026-10-23" })
  })
  it.each([
    ["2028-02-29", "2028-03-01"],
    ["2030-12-31", "2031-01-01"],
    ["2030-04-30", "2030-05-01"],
  ])(
    "round-trips inclusive all-day dates across calendar boundaries %s",
    (start, end) => {
      const form = {
        ...validForm(),
        calendarType: "date" as const,
        start,
        end: start,
      }
      const stored = toStoredOrganizerEventForm(form)
      expect(stored.end).toBe(end)
      expect(fromStoredOrganizerEventForm(stored)).toEqual(form)
      expect(
        prepareOrganizerEventMarketForm(stored, { endDateIsExclusive: true })
          .calendar.end
      ).toBe(end)
    }
  )

  it("shows an omitted signed all-day end as one day without changing its stored form", () => {
    const stored = {
      ...validForm(),
      calendarType: "date" as const,
      start: "2030-06-01",
      end: "",
    }
    expect(fromStoredOrganizerEventForm(stored).end).toBe(stored.start)
    expect(
      prepareOrganizerEventMarketForm(stored, { endDateIsExclusive: true })
        .calendar.end
    ).toBeUndefined()
  })

  it("expands monthly all-day dates and skips months missing the chosen day", () => {
    const form = {
      ...validForm(),
      calendarType: "date" as const,
      start: "2030-01-31",
      end: "2030-02-01",
    }
    const rows = generateOrganizerRecurringDates(form, {
      frequency: "monthly",
      weekdays: [],
      ends: "after_count",
      count: 3,
      throughDate: "",
    })
    expect(rows.map(({ start, end }) => [start, end])).toEqual([
      ["2030-01-31", "2030-02-01"],
      ["2030-03-31", "2030-04-01"],
      ["2030-05-31", "2030-06-01"],
    ])
    expect(
      prepareOrganizerEventMarketDates(form, rows).map(
        ({ calendar }) => calendar.end
      )
    ).toEqual(["2030-02-02", "2030-04-02", "2030-06-02"])
  })

  it("generates weekly one-day all-day events with an inclusive repeat-until date", () => {
    const form = {
      ...validForm(),
      calendarType: "date" as const,
      start: "2030-06-01",
      end: "2030-06-01",
    }
    const rows = generateOrganizerRecurringDates(form, {
      frequency: "weekly",
      weekdays: [6],
      ends: "on_date",
      throughDate: "2030-06-08",
      count: 4,
    })
    expect(rows.map(({ start, end }) => [start, end])).toEqual([
      ["2030-06-01", "2030-06-01"],
      ["2030-06-08", "2030-06-08"],
    ])
    expect(
      prepareOrganizerEventMarketDates(form, rows).map(
        ({ calendar }) => calendar.end
      )
    ).toEqual(["2030-06-02", "2030-06-09"])
  })

  it("preserves overnight local hours and rejects empty or unbounded repeat choices", () => {
    const form = {
      ...validForm(),
      start: "2030-06-01T22:00",
      end: "2030-06-02T03:00",
    }
    const repeat = {
      frequency: "weekly" as const,
      weekdays: [6],
      ends: "after_count" as const,
      count: 2,
      throughDate: "",
    }
    expect(
      generateOrganizerRecurringDates(form, repeat).map(({ start, end }) => [
        start,
        end,
      ])
    ).toEqual([
      ["2030-06-01T22:00", "2030-06-02T03:00"],
      ["2030-06-08T22:00", "2030-06-09T03:00"],
    ])
    for (const count of [0, 33, 1.5])
      expect(() =>
        generateOrganizerRecurringDates(form, { ...repeat, count })
      ).toThrow("1 to 32")
    expect(() =>
      generateOrganizerRecurringDates(form, { ...repeat, weekdays: [] })
    ).toThrow("weekday")
    expect(() =>
      generateOrganizerRecurringDates(form, {
        ...repeat,
        ends: "on_date",
        throughDate: "2030-05-31",
      })
    ).toThrow("on or after")
  })

  it("allows an optional banner and validates a provided public image URL", () => {
    expect(
      validateOrganizerEventMarketForm({ ...validForm(), imageUrl: "" })
        .canPublish
    ).toBe(true)
    expect(
      validateOrganizerEventMarketForm({
        ...validForm(),
        imageUrl: "http://images.example/banner.jpg",
      }).errors.imageUrl
    ).toContain("https://")
  })

  it("prepares a public timed NIP-52 calendar without protocol-specific pickup fields", () => {
    const prepared = prepareOrganizerEventMarketForm(validForm())

    expect(prepared.calendar).toEqual({
      kind: 31923,
      title: "Community market",
      summary: "Local merchants and public event pickup.",
      imageUrl: "https://images.example/market.jpg",
      location: "Public Hall, Main Entrance",
      geohash: undefined,
      start: 1_786_798_800,
      end: 1_786_816_800,
      timezone: "America/New_York",
    })
    expect(Object.keys(prepared)).toEqual(["calendar"])
  })

  it("prepares all-day events with NIP-52 date values", () => {
    const form = {
      ...validForm(),
      calendarType: "date" as const,
      start: "2026-08-15",
      end: "2026-08-17",
    }

    expect(prepareOrganizerEventMarketForm(form).calendar).toMatchObject({
      kind: 31922,
      start: "2026-08-15",
      end: "2026-08-18",
      timezone: undefined,
    })
  })

  it("requires a public description and location without event pickup authoring", () => {
    const result = validateOrganizerEventMarketForm({
      ...validForm(),
      summary: "",
      eventLocation: "",
    })
    expect(result.canPublish).toBe(false)
    expect(result.errors.summary).toBeTruthy()
    expect(result.errors.eventLocation).toBeTruthy()
    expect(Object.keys(createEmptyOrganizerEventMarketForm())).not.toContain(
      "pickupLocation"
    )
  })

  it("rejects reversed schedules and nonexistent local DST times", () => {
    const reversed = validateOrganizerEventMarketForm({
      ...validForm(),
      end: "2026-08-15T08:00",
    })
    expect(reversed.errors.end).toContain("after the start")

    expect(() =>
      localDateTimeToEpochSeconds("2026-03-08T02:30", "America/New_York")
    ).toThrow("does not exist")
    expect(() =>
      localDateTimeToEpochSeconds("2026-11-01T01:30", "America/New_York")
    ).toThrow("occurs twice")
  })

  it("expands selected weekdays to editable concrete dates across a DST change", () => {
    const dates = generateWeeklyDates({
      firstDate: "2026-03-01",
      throughDate: "2026-03-15",
      weekdays: [0],
      startTime: "09:00",
      endTime: "14:00",
      timezone: "America/New_York",
    })
    expect(dates.map((date) => date.start)).toEqual([
      "2026-03-01T09:00",
      "2026-03-08T09:00",
      "2026-03-15T09:00",
    ])
    const prepared = prepareOrganizerEventMarketDates(validForm(), dates)
    expect(prepared.map((date) => date.calendar.start)).toEqual([
      1_772_373_600, 1_772_974_800, 1_773_579_600,
    ])
  })

  it("rejects a generated skipped or repeated local hour with its date", () => {
    const pattern = {
      firstDate: "2026-03-08",
      throughDate: "2026-03-08",
      weekdays: [0],
      startTime: "02:30",
      endTime: "03:30",
      timezone: "America/New_York",
    }
    expect(() => generateWeeklyDates(pattern)).toThrow(
      "2026-03-08: That local time does not exist"
    )
    expect(() =>
      generateWeeklyDates({
        ...pattern,
        firstDate: "2026-11-01",
        throughDate: "2026-11-01",
        startTime: "01:30",
        endTime: "02:30",
      })
    ).toThrow("2026-11-01: That local time occurs twice")
  })

  it("caps generated dates and rejects duplicate or invalid edited rows", () => {
    expect(() =>
      generateWeeklyDates({
        firstDate: "2026-01-01",
        throughDate: "2026-03-01",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startTime: "09:00",
        endTime: "17:00",
        timezone: "UTC",
      })
    ).toThrow("at most 32")
    const rows = [
      { id: "a", start: "2026-08-15T09:00", end: "2026-08-15T14:00" },
      { id: "b", start: "2026-08-15T09:00", end: "2026-08-15T15:00" },
    ]
    expect(() => prepareOrganizerEventMarketDates(validForm(), rows)).toThrow(
      "duplicates another start"
    )
    expect(() =>
      prepareOrganizerEventMarketDates(validForm(), [
        { id: "a", start: "2026-11-01T01:30", end: "2026-11-01T03:00" },
      ])
    ).toThrow("Date 1: That local time occurs twice")
  })

  it("requires future starts only for new-event validation", () => {
    const nowMs = Date.UTC(2026, 7, 15, 16, 0, 0)
    const past = {
      ...validForm(),
      start: "2026-08-15T11:00",
      end: "2026-08-15T12:00",
      timezone: "UTC",
    }

    expect(
      validateOrganizerEventMarketForm(past, {
        requireFutureStart: true,
        nowMs,
      }).errors.start
    ).toContain("future")
    expect(validateOrganizerEventMarketForm(past).errors.start).toBeUndefined()
  })

  it("provides create-form picker bounds for start and end", () => {
    const localNoon = new Date(2026, 7, 15, 12, 30, 20).getTime()
    expect(getOrganizerEventStartMinimum("date", localNoon)).toBe("2026-08-15")
    expect(getOrganizerEventStartMinimum("timed", localNoon)).toBe(
      "2026-08-15T12:31"
    )
    expect(
      getOrganizerEventEndMinimum("date", "2026-08-15", "2026-08-15")
    ).toBe("2026-08-15")
    expect(
      getOrganizerEventEndMinimum(
        "timed",
        "2026-08-15T12:31",
        "2026-08-15T12:31"
      )
    ).toBe("2026-08-15T12:32")
  })

  it("offers a bounded client timezone list that includes Chicago", () => {
    const options = getOrganizerEventTimezoneOptions(
      "Pacific/Auckland",
      "Not/A_Timezone"
    )

    expect(options[0]).toBe("Pacific/Auckland")
    expect(options).toContain("America/Chicago")
    expect(options).not.toContain("Not/A_Timezone")
    expect(new Set(options).size).toBe(options.length)
    expect(options.length).toBeLessThanOrEqual(16)
  })

  it("marks an update dirty only while a form value differs", () => {
    const initial = validForm()
    const changed = { ...initial, title: "Updated community market" }

    expect(isOrganizerEventMarketFormDirty(initial, initial)).toBe(false)
    expect(isOrganizerEventMarketFormDirty(changed, initial)).toBe(true)
    expect(
      isOrganizerEventMarketFormDirty(
        { ...changed, title: initial.title },
        initial
      )
    ).toBe(false)
  })

  it("generates stable public coordinate slugs without location coupling", () => {
    expect(slugifyEventMarketTitle("  Community Market — 2026! ")).toBe(
      "community-market-2026"
    )
  })
})
