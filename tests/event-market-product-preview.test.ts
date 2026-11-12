import { expect, test } from "bun:test"
import { getEventMarketProductPreview } from "../apps/market/src/lib/event-market-product-preview"

function displayEvidence(): Parameters<typeof getEventMarketProductPreview>[0] {
  const calendar = {
    kind: 31922,
    coordinate: "31922:organizer:date",
    start: Date.now() + 3_600_000,
    end: Date.now() + 7_200_000,
    signedEvent: {
      tags: [
        ["location", "Market hall"],
        ["g", "abc"],
      ],
    },
  }
  // The preview consumes already verified reader results, not wire events.
  return {
    selectedOccurrenceCoordinate: calendar.coordinate,
    marketRead: {
      readScope: "public_feed",
      resolution: {
        state: "current",
        market: {
          coordinate: "30409:organizer:market",
          organizerPubkey: "organizer",
          state: "open",
        },
      },
      calendar,
    },
    productRead: {
      productCoordinate: "30402:merchant:item",
      readScope: "public_feed",
      actionable: false,
      resolution: {
        state: "eligible",
        merchant: {
          pubkey: "merchant",
          mode: "organizer_handoff",
          assignment: "Booth A",
        },
        product: { id: "30402:merchant:item", price: 5 },
        revision: { id: "revision" },
        assignment: { occurrenceCoordinate: calendar.coordinate },
      },
      authorization: {
        resolution: { state: "active", tip: { eventId: "grant" } },
        observedEvidence: [],
      },
    },
  } as unknown as Parameters<typeof getEventMarketProductPreview>[0]
}

test("feed eligibility displays pickup terms without producing a committable snapshot", () => {
  const input = displayEvidence()
  const preview = getEventMarketProductPreview(input)
  expect(preview?.handoff).toEqual({
    mode: "organizer_handoff",
    handlerPubkey: "organizer",
    label: "Pickup from event organizer",
  })
  expect(preview).not.toHaveProperty("grant")
  expect(preview).not.toHaveProperty("type")
  const authority = structuredClone(input)
  authority.marketRead.readScope = undefined
  authority.productRead.readScope = undefined
  authority.productRead.actionable = true
  expect(getEventMarketProductPreview(authority)?.termsKey).toBe(
    preview?.termsKey
  )
})

test("pickup preview rejects a mismatched coordinate, self-organizer handoff, and unbounded time event", () => {
  const mismatched = displayEvidence()
  mismatched.productRead.productCoordinate = "30402:merchant:other"
  expect(getEventMarketProductPreview(mismatched)).toBeNull()
  const ownHandoff = displayEvidence()
  if (ownHandoff.productRead.resolution.state !== "eligible")
    throw new Error("fixture")
  ownHandoff.productRead.resolution.merchant.pubkey = "organizer"
  expect(getEventMarketProductPreview(ownHandoff)).toBeNull()
  const timeEvent = displayEvidence()
  timeEvent.marketRead.calendar!.kind = 31923
  expect(getEventMarketProductPreview(timeEvent)).toBeNull()
})

test("series preview requires current signed occurrence and master coverage", () => {
  const input = displayEvidence()
  const occurrence = input.marketRead.calendar!
  input.marketRead.calendarCoverage = "complete"
  input.marketRead.schedule = {
    kind: "series",
    coordinate: "31924:organizer:series",
    series: { signedEvent: { tags: [["a", occurrence.coordinate]] } },
    occurrences: [{ occurrence, coverage: "stale" }],
  } as unknown as NonNullable<typeof input.marketRead.schedule>
  expect(getEventMarketProductPreview(input)).toBeNull()
  if (input.marketRead.schedule.kind !== "series") throw new Error("fixture")
  input.marketRead.schedule.occurrences[0]!.coverage = "partial"
  input.marketRead.calendarCoverage = "unavailable"
  expect(getEventMarketProductPreview(input)).toBeNull()
  input.marketRead.calendarCoverage = "partial"
  expect(getEventMarketProductPreview(input)).not.toBeNull()
})

test("a fresh grant or pickup-term change requires reviewing the display again", () => {
  const input = displayEvidence()
  const displayed = getEventMarketProductPreview(input)!
  const changed = structuredClone(input)
  if (changed.productRead.authorization?.resolution.state !== "active")
    throw new Error("fixture")
  changed.productRead.authorization.resolution.tip.eventId = "new-grant"
  expect(getEventMarketProductPreview(changed)?.termsKey).not.toBe(
    displayed.termsKey
  )
  const moved = structuredClone(input)
  moved.marketRead.calendar!.signedEvent!.tags = [["location", "Another hall"]]
  expect(getEventMarketProductPreview(moved)?.termsKey).not.toBe(
    displayed.termsKey
  )
})

test("closed markets and withdrawn product eligibility cannot show pickup readiness", () => {
  const input = displayEvidence()
  if (input.marketRead.resolution.state !== "current")
    throw new Error("fixture")
  input.marketRead.resolution.market.state = "closed"
  expect(getEventMarketProductPreview(input)).toBeNull()
  const withdrawn = displayEvidence()
  withdrawn.productRead.resolution = { state: "market_unavailable" }
  expect(getEventMarketProductPreview(withdrawn)).toBeNull()
})
