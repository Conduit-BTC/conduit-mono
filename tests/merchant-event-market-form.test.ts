import { describe, expect, it } from "bun:test"
import {
  createEmptyOrganizerEventMarketForm,
  generateOrganizerWeeklyDates,
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
    organizerHandoffEnabled: true,
    pickupLocation: "Public Hall, Main Entrance",
  }
}

describe("merchant organizer event form", () => {
  it("prepares a timed NIP-52 event and public pickup without private fields", () => {
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
    expect(prepared.pickup).toEqual({
      title: "Event pickup",
      location: "Public Hall, Main Entrance",
      geohash: undefined,
      country: "US",
      price: "0",
      currency: "SAT",
    })
    expect(Object.keys(prepared.pickup)).not.toContain("instructions")
    expect(Object.keys(prepared.pickup)).not.toContain("note")
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
      end: "2026-08-17",
      timezone: undefined,
    })
  })

  it("allows an event and catalog without an organizer handoff program", () => {
    const form = {
      ...validForm(),
      organizerHandoffEnabled: false,
      pickupTitle: "",
      pickupLocation: "",
      pickupGeohash: "",
      pickupCountry: "",
      pickupPrice: "",
      pickupCurrency: "",
    }

    const validation = validateOrganizerEventMarketForm(form)
    const prepared = prepareOrganizerEventMarketForm(form)

    expect(validation.canPublish).toBe(true)
    expect(prepared.pickup).toBeUndefined()
    expect(prepared.collection.title).toBe("Community market")
  })

  it("derives zero-cost organizer pickup from the event venue", () => {
    const form = {
      ...validForm(),
      imageUrl: "http://images.example/market.jpg",
      eventLocation: "",
      pickupLocation: "",
      pickupGeohash: "",
      pickupCountry: "USA",
      pickupPrice: "-1",
      pickupCurrency: "USD",
    }
    const result = validateOrganizerEventMarketForm(form)

    expect(result.canPublish).toBe(false)
    expect(result.errors.imageUrl).toContain("https://")
    expect(result.errors.eventLocation).toContain("public event location")
    expect(result.errors.pickupCountry).toContain("two-letter")
    expect(result.errors.pickupLocation).toBeUndefined()

    const derived = prepareOrganizerEventMarketForm({
      ...validForm(),
      pickupLocation: "",
      pickupGeohash: "",
      pickupPrice: "999",
      pickupCurrency: "USD",
    }).pickup
    expect(derived).toMatchObject({
      title: "Event pickup",
      location: "Public Hall, Main Entrance",
      price: "0",
      currency: "SAT",
    })
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
    const dates = generateOrganizerWeeklyDates({
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
    expect(() => generateOrganizerWeeklyDates(pattern)).toThrow(
      "2026-03-08: That local time does not exist"
    )
    expect(() =>
      generateOrganizerWeeklyDates({
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
      generateOrganizerWeeklyDates({
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
    ).toBe("2026-08-16")
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
