import { describe, expect, it } from "bun:test"
import {
  createEmptyOrganizerEventMarketForm,
  localDateTimeToEpochSeconds,
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

  it("requires public event and pickup evidence and rejects invalid amounts", () => {
    const form = {
      ...validForm(),
      imageUrl: "http://images.example/market.jpg",
      eventLocation: "",
      pickupLocation: "",
      pickupGeohash: "",
      pickupPrice: "-1",
    }
    const result = validateOrganizerEventMarketForm(form)

    expect(result.canPublish).toBe(false)
    expect(result.errors.imageUrl).toContain("https://")
    expect(result.errors.eventLocation).toContain("public event location")
    expect(result.errors.pickupLocation).toContain("location or geohash")
    expect(result.errors.pickupPrice).toContain("zero or greater")
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
  })

  it("generates stable public coordinate slugs without location coupling", () => {
    expect(slugifyEventMarketTitle("  Community Market — 2026! ")).toBe(
      "community-market-2026"
    )
  })
})
