import { describe, expect, it, spyOn } from "bun:test"
import * as core from "@conduit/core"
import {
  getMerchantPickupAuthorizationMessage,
  readVerifiedFutureEventMarketOrderEvidence,
  verifyFutureEventMarketOrderAuthorization,
} from "../apps/merchant/src/lib/order-pickup-authorization"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

describe("Merchant created Event Market order authorization", () => {
  it("uses embedded exact signed terms without depending on current roster or relay availability", async () => {
    const fixture = createEventMarketOrderFixture()
    const read = spyOn(
      core,
      "readEventMarketOrderEvidenceByIds"
    ).mockRejectedValue(new Error("optional relay unavailable"))
    try {
      const result = await readVerifiedFutureEventMarketOrderEvidence({
        order: fixture.order,
        merchantPubkey: fixture.merchant,
        authenticatedPubkey: fixture.merchant,
      })
      expect(result.result.status).toBe("verified")
      expect(result.events).toEqual([])
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
  })
  it("rejects another merchant's order before network reads", async () => {
    const fixture = createEventMarketOrderFixture()
    expect(
      await verifyFutureEventMarketOrderAuthorization({
        order: fixture.order,
        merchantPubkey: "d".repeat(64),
      })
    ).toEqual({ status: "invalid", reason: "order" })
  })
  it("does not reinterpret ordinary shipping as an Event Market pickup", async () => {
    const fixture = createEventMarketOrderFixture()
    const order = structuredClone(fixture.order)
    order.items[0]!.fulfillment = { type: "shipping" }
    expect(
      await verifyFutureEventMarketOrderAuthorization({
        order,
        merchantPubkey: fixture.merchant,
      })
    ).toEqual({ status: "invalid", reason: "order" })
  })
  it("rejects cancelled authorization even on the embedded evidence fast path", async () => {
    const fixture = createEventMarketOrderFixture()
    await expect(
      verifyFutureEventMarketOrderAuthorization({
        order: fixture.order,
        merchantPubkey: fixture.merchant,
        shouldContinue: () => false,
      })
    ).rejects.toThrow("cancelled")
  })
  it("rejects tampered saved terms without exposing arbitrary transport errors", async () => {
    const fixture = createEventMarketOrderFixture()
    const order = structuredClone(fixture.order)
    order.items[0]!.fulfillment = {
      ...fixture.fulfillment,
      assignment: "Unsigned replacement booth",
    }
    const read = spyOn(
      core,
      "readEventMarketOrderEvidenceByIds"
    ).mockResolvedValue({
      events: fixture.events,
      coverage: {
        attemptedRelayCount: 1,
        completeRelayCount: 1,
        partialRelayCount: 0,
        failedRelayCount: 0,
      },
    } as never)
    try {
      const result = await verifyFutureEventMarketOrderAuthorization({
        order,
        merchantPubkey: fixture.merchant,
      })
      expect(result.status).not.toBe("verified")
      expect(getMerchantPickupAuthorizationMessage(result)).toContain(
        "does not match"
      )
    } finally {
      read.mockRestore()
    }
  })
})
