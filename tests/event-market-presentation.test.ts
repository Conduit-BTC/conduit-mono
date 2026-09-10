import { describe, expect, it } from "bun:test"
import {
  formatEventRelayReadCoverage,
  getEventActionabilityPresentation,
  getOrganizerDiscoveryPresentation,
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
      role: "status",
      tone: "success",
      prominent: false,
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
      prominent: true,
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
      role: "status",
      prominent: false,
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
      role: "status",
      prominent: false,
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
        prominent: true,
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

describe("followed-organizer discovery presentation", () => {
  it("leads with found events and organizer-level partial facts", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "partial",
        eventCount: 2,
        followedOrganizerCount: 5,
        searchedOrganizerCount: 4,
        incompleteOrganizerCount: 1,
        followListCoverage: "complete",
      })
    ).toEqual({
      message:
        "Showing 2 events found so far. Checked 4 of 5 followed organizers; 1 check was incomplete.",
      role: "status",
      prominent: false,
    })
  })

  it("distinguishes partial and complete-empty discovery", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "partial",
        eventCount: 0,
        followedOrganizerCount: 5,
        searchedOrganizerCount: 4,
        incompleteOrganizerCount: 1,
        followListCoverage: "complete",
      }).message
    ).toBe(
      "No events found so far. Checked 4 of 5 followed organizers; 1 check was incomplete."
    )
    expect(
      getOrganizerDiscoveryPresentation({
        state: "complete_empty",
        eventCount: 0,
        followedOrganizerCount: 5,
        searchedOrganizerCount: 5,
        incompleteOrganizerCount: 0,
        followListCoverage: "complete",
      }).message
    ).toBe(
      "No events were found in the completed checks. Checked all 5 followed organizers."
    )
  })

  it("qualifies counts taken from an incomplete followed-organizer snapshot", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "partial",
        eventCount: 2,
        followedOrganizerCount: 5,
        searchedOrganizerCount: 5,
        incompleteOrganizerCount: 0,
        followListCoverage: "limited",
      }).message
    ).toBe(
      "Showing 2 events found so far. Available followed-organizer snapshot listed 5 organizers; checked 5."
    )
  })

  it("reserves alert semantics for unavailable discovery", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "unavailable",
        eventCount: 0,
        followedOrganizerCount: 5,
        searchedOrganizerCount: 4,
        incompleteOrganizerCount: 4,
        followListCoverage: "unavailable",
      })
    ).toMatchObject({ role: "alert", prominent: true })
  })
})
