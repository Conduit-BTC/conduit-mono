import { expect, test } from "bun:test"
import { getEventMarketProductPreview } from "../apps/market/src/lib/event-market-product-preview"

function displayEvidence(): Parameters<typeof getEventMarketProductPreview>[0] {
  const calendar = {
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
