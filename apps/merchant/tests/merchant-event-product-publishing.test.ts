import { describe, expect, it } from "bun:test"
import {
  assertEventProductMarketPublishable,
  getMerchantEventPublishPresentation,
} from "../src/lib/event-product-publishing"
import type { MerchantOrganizerEventMarket } from "../src/lib/event-market"

function publishMarket(
  overrides: Partial<
    Pick<MerchantOrganizerEventMarket, "orderAcceptance" | "state">
  > = {},
  requiredRecordsResolved = true
): Pick<MerchantOrganizerEventMarket, "orderAcceptance" | "source" | "state"> {
  return {
    orderAcceptance: "open",
    state: "active",
    ...overrides,
    source: {
      collection: requiredRecordsResolved ? ({} as never) : undefined,
      calendar: requiredRecordsResolved ? ({} as never) : undefined,
      pickupCoordinate: undefined,
    } as MerchantOrganizerEventMarket["source"],
  }
}

describe("merchant event product publishing", () => {
  it("never exposes publishing when the current organizer collection is closed", () => {
    expect(
      getMerchantEventPublishPresentation({
        actionReady: true,
        orderAcceptance: "closed",
        refreshing: false,
        requiredRecordsResolved: true,
        state: "active",
      })
    ).toEqual({
      message: "This event is closed. New products can't be published.",
      publishable: false,
      retryLabel: null,
      state: "closed",
    })
  })

  it("rejects a newly closed event before any publish preparation can begin", () => {
    expect(() =>
      assertEventProductMarketPublishable(
        publishMarket({ orderAcceptance: "closed" })
      )
    ).toThrow("This event is closed")
  })

  it("requires the current organizer-authored event graph", () => {
    expect(() =>
      assertEventProductMarketPublishable(publishMarket({}, false))
    ).toThrow("Current event details couldn't be confirmed")
    expect(() =>
      assertEventProductMarketPublishable(publishMarket())
    ).not.toThrow()
  })
})
