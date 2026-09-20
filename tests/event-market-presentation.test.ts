import { describe, expect, it } from "bun:test"
import {
  formatEventRelayReadCoverage,
  getEventActionabilityPresentation,
} from "@conduit/ui"

describe("event actionability presentation", () => {
  it("keeps exact accepted products actionable during a partial read", () => {
    expect(
      getEventActionabilityPresentation({
        state: "partial",
        availableProductCount: 2,
      })
    ).toEqual({
      actionability: "actionable",
      label: "Event loaded",
      message: "2 products available.",
      tone: "success",
      visibility: "silent",
    })
  })

  it("names unresolved products without hiding actionable products", () => {
    expect(
      getEventActionabilityPresentation({
        state: "partial",
        availableProductCount: 2,
        unresolvedProductCount: 1,
      }).message
    ).toBe(
      "2 products available. 1 product remains unresolved and unavailable."
    )
  })

  it("makes an unresolved required event record prominent without hiding exact products", () => {
    const presentation = getEventActionabilityPresentation({
      state: "partial",
      availableProductCount: 1,
      unresolvedProductCount: 1,
      requiredEventRecordsResolved: false,
    })
    expect(presentation).toMatchObject({
      actionability: "limited",
      label: "Event records unresolved",
      role: "alert",
      tone: "warning",
      visibility: "prominent",
    })
    expect(presentation.message).toBe(
      "A required signed event record is unresolved. 1 product available. 1 product remains unresolved and unavailable. Exact current product and pickup evidence still determines which product actions are available."
    )
  })

  it("presents a complete event as loaded", () => {
    expect(
      getEventActionabilityPresentation({
        state: "active",
        availableProductCount: 3,
      })
    ).toMatchObject({
      actionability: "actionable",
      label: "Event loaded",
      visibility: "silent",
    })
  })

  it("presents ended events as read-only without an alert", () => {
    expect(
      getEventActionabilityPresentation({
        state: "ended",
        availableProductCount: 2,
      })
    ).toMatchObject({
      actionability: "read_only",
      label: "Event ended",
      message: "2 products available. Checkout is closed.",
      visibility: "inline",
    })
  })

  it.each([
    ["stale", "Event evidence is stale", "warning"],
    ["unavailable", "Event unavailable", "warning"],
    ["conflicting", "Event records conflict", "destructive"],
    ["malformed", "Event reference or records are malformed", "destructive"],
    ["deleted", "Event deleted", "destructive"],
  ] as const)(
    "uses a prominent screen-reader alert for %s evidence",
    (state, label, tone) => {
      expect(
        getEventActionabilityPresentation({
          state,
          availableProductCount: 0,
        })
      ).toMatchObject({
        actionability: "blocked",
        label,
        role: "alert",
        tone,
        visibility: "prominent",
      })
    }
  )
})

describe("relay read coverage presentation", () => {
  it("describes the real planned set independently from actionability", () => {
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 4,
        completeRelayCount: 3,
        partialRelayCount: 1,
        failedRelayCount: 0,
      })
    ).toBe("3 of 4 planned relay reads completed; 1 was incomplete.")
  })

  it("reports a complete planned read", () => {
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 4,
        completeRelayCount: 4,
        partialRelayCount: 0,
        failedRelayCount: 0,
      })
    ).toBe("4 of 4 planned relay reads completed.")
  })
})

it("distinguishes organizer closure from a passed schedule without canceling existing orders", () => {
  expect(
    getEventActionabilityPresentation({
      state: "ended",
      orderAcceptance: "closed",
      availableProductCount: 1,
    })
  ).toMatchObject({
    actionability: "read_only",
    label: "Event closed",
    message:
      "The organizer has closed this event to new orders. Existing orders and pickup remain available.",
    visibility: "inline",
  })
})
