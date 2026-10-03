import type { EventMarketOrganizerInboxResolution } from "@conduit/core"
import {
  assertCartPickupHandlerReady,
  getOrganizerInboxBlockingMessage,
  getFuturePickupHandoffSummary,
} from "../apps/market/src/lib/pickup-handoff"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
const fixture = createEventMarketOrderFixture()
const ORGANIZER = fixture.organizer
const MERCHANT = fixture.merchant
function pickupFulfillment(
  mode: "merchant_present" | "organizer_handoff" = "organizer_handoff"
) {
  return createEventMarketOrderFixture({ mode }).fulfillment
}
describe("Market pickup handoff", () => {
  it("uses only the exact signed merchant or organizer handoff mode", () => {
    expect(
      getFuturePickupHandoffSummary(pickupFulfillment("merchant_present"))
    ).toEqual({
      mode: "merchant_handoff",
      handlerPubkey: MERCHANT,
      label: "Pickup from merchant booth",
    })
    expect(getFuturePickupHandoffSummary(pickupFulfillment())).toEqual({
      mode: "organizer_handoff",
      handlerPubkey: ORGANIZER,
      label: "Pickup from event organizer",
    })
  })
  it("does not require an organizer inbox for merchant handoff", async () => {
    let inboxLookups = 0
    await assertCartPickupHandlerReady(
      [{ fulfillment: pickupFulfillment("merchant_present") }],
      async () => {
        inboxLookups += 1
        return {
          state: "blocked",
          organizerPubkey: ORGANIZER,
          reason: "not_observed",
        }
      }
    )

    expect(inboxLookups).toBe(0)
  })

  it("blocks organizer handoff before downstream order or payment work", async () => {
    let orderSigningAttempts = 0
    let paymentAttempts = 0
    const blocked: EventMarketOrganizerInboxResolution = {
      state: "blocked",
      organizerPubkey: ORGANIZER,
      reason: "not_observed",
    }

    await expect(
      (async () => {
        await assertCartPickupHandlerReady(
          [{ fulfillment: pickupFulfillment("organizer_handoff") }],
          async () => blocked
        )
        orderSigningAttempts += 1
        paymentAttempts += 1
      })()
    ).rejects.toThrow(
      "no usable private inbox declaration was found for the event organizer on the relays checked"
    )
    expect(orderSigningAttempts).toBe(0)
    expect(paymentAttempts).toBe(0)
  })

  it("accepts only a current usable organizer inbox", async () => {
    let lookedUpPubkey = ""
    let lookupContext:
      | {
          requestingAccountPubkey?: string | null
          authenticatedPubkey?: string | null
          shouldContinue?: () => boolean
        }
      | undefined
    const shouldContinue = () => true
    await expect(
      assertCartPickupHandlerReady(
        [{ fulfillment: pickupFulfillment("organizer_handoff") }],
        async (organizerPubkey, options) => {
          lookedUpPubkey = organizerPubkey
          lookupContext = options
          return {
            state: "ready",
            organizerPubkey,
            relayUrls: ["wss://inbox.example"],
          }
        },
        {
          requestingAccountPubkey: MERCHANT,
          authenticatedPubkey: MERCHANT,
          shouldContinue,
        }
      )
    ).resolves.toBeUndefined()
    expect(lookedUpPubkey).toBe(ORGANIZER)
    expect(lookupContext).toEqual({
      requestingAccountPubkey: MERCHANT,
      authenticatedPubkey: MERCHANT,
      shouldContinue,
    })

    await expect(
      assertCartPickupHandlerReady(
        [{ fulfillment: pickupFulfillment("organizer_handoff") }],
        async () => ({
          state: "blocked",
          organizerPubkey: ORGANIZER,
          reason: "stale",
        })
      )
    ).rejects.toThrow("Only stale organizer inbox evidence")
  })

  it("keeps staged and signed-empty inbox blockers distinct", () => {
    expect(
      getOrganizerInboxBlockingMessage({
        state: "blocked",
        organizerPubkey: ORGANIZER,
        reason: "distribution_pending",
      })
    ).toContain("still being distributed")
    expect(
      getOrganizerInboxBlockingMessage({
        state: "blocked",
        organizerPubkey: ORGANIZER,
        reason: "signed_empty",
      })
    ).toContain("has no relay targets")
  })
})
