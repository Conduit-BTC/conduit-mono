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

describe("event-market discovery presentation", () => {
  it("leads with found events and bounded relay-read facts", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "partial",
        eventCount: 2,
        perspective: {
          source: "following",
          authorCount: 5,
          coverage: "complete",
        },
        candidateScanCoverage: {
          plannedReadCount: 4,
          completeReadCount: 3,
        },
        searchedOrganizerCount: 2,
        incompleteOrganizerCount: 1,
      })
    ).toEqual({
      message:
        "Showing 2 events found so far. Completed 3 of 4 planned bounded relay collection reads. 1 discovered organizer check was incomplete.",
      role: "status",
      prominent: false,
    })
  })

  it("distinguishes partial and complete-empty discovery", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "partial",
        eventCount: 0,
        perspective: {
          source: "following",
          authorCount: 5,
          coverage: "complete",
        },
        candidateScanCoverage: {
          plannedReadCount: 4,
          completeReadCount: 3,
        },
        searchedOrganizerCount: 2,
        incompleteOrganizerCount: 1,
      }).message
    ).toBe(
      "No events found so far in the Following perspective; more may appear. Completed 3 of 4 planned bounded relay collection reads. 1 discovered organizer check was incomplete."
    )
    expect(
      getOrganizerDiscoveryPresentation({
        state: "complete_empty",
        eventCount: 0,
        perspective: {
          source: "following",
          authorCount: 5,
          coverage: "complete",
        },
        candidateScanCoverage: {
          plannedReadCount: 4,
          completeReadCount: 4,
        },
        searchedOrganizerCount: 0,
        incompleteOrganizerCount: 0,
      }).message
    ).toBe(
      "No events were found in the completed bounded relay reads for the Following perspective. Completed 4 of 4 planned bounded relay collection reads."
    )
  })

  it("qualifies an incomplete perspective snapshot", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "partial",
        eventCount: 2,
        perspective: {
          source: "following",
          authorCount: 5,
          coverage: "limited",
        },
        candidateScanCoverage: {
          plannedReadCount: 5,
          completeReadCount: 5,
        },
        searchedOrganizerCount: 2,
        incompleteOrganizerCount: 0,
      }).message
    ).toBe(
      "Showing 2 events found so far. Completed 5 of 5 planned bounded relay collection reads. The available Following perspective snapshot may be incomplete."
    )
  })

  it("reserves alert semantics for unavailable discovery", () => {
    expect(
      getOrganizerDiscoveryPresentation({
        state: "unavailable",
        eventCount: 0,
        perspective: {
          source: "following",
          authorCount: 5,
          coverage: "unavailable",
        },
        candidateScanCoverage: {
          plannedReadCount: 4,
          completeReadCount: 0,
        },
        searchedOrganizerCount: 2,
        incompleteOrganizerCount: 4,
      })
    ).toMatchObject({ role: "alert", prominent: true })
  })
})
