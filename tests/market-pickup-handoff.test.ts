import { describe, expect, it } from "bun:test"
import {
  formatEventMarketPickupClaimCode,
  getEventMarketPickupClaimRef,
  type EventMarketOrganizerInboxResolution,
} from "@conduit/core"
import type { CartPickupFulfillment } from "../apps/market/src/lib/cart-model"
import {
  ORGANIZER_HANDOFF_DISCLOSURE,
  assertCartPickupHandlerReady,
  getOrganizerInboxBlockingMessage,
  getOrganizerPickupClaimCode,
  getPickupHandoffPrivacyCopy,
  getPickupHandoffSummary,
} from "../apps/market/src/lib/pickup-handoff"

const ORGANIZER = "a".repeat(64)
const MERCHANT = "b".repeat(64)

function pickupFulfillment(
  mode: "merchant_handoff" | "organizer_handoff" = "organizer_handoff"
): CartPickupFulfillment {
  const handlerPubkey = mode === "organizer_handoff" ? ORGANIZER : MERCHANT
  return {
    type: "pickup",
    organizerPubkey: ORGANIZER,
    product: {
      coordinate: `30402:${MERCHANT}:coffee`,
      merchantPubkey: MERCHANT,
      eventId: "1".repeat(64),
      createdAt: 100,
    },
    calendar: {
      coordinate: `31923:${ORGANIZER}:market-day`,
      eventId: "2".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: `30405:${ORGANIZER}:market-day`,
      eventId: "3".repeat(64),
      createdAt: 102,
    },
    option: {
      coordinate: `30406:${handlerPubkey}:pickup`,
      eventId: "4".repeat(64),
      createdAt: 103,
      title:
        mode === "organizer_handoff" ? "Organizer table" : "Merchant booth",
      location: "Public hall",
    },
    handoffMode: mode,
    handlerPubkey,
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SATS",
      normalizedCurrency: "SATS",
    },
  }
}

describe("Market pickup handoff", () => {
  it("keeps a legacy organizer-authored snapshot merchant-only", () => {
    const legacy = pickupFulfillment("organizer_handoff")
    delete legacy.handoffMode
    delete legacy.handlerPubkey

    expect(getPickupHandoffSummary(legacy)).toEqual({
      mode: "merchant_handoff",
      handlerPubkey: MERCHANT,
      legacySafeDefault: true,
      label: "Pickup from merchant booth",
    })
    expect(getPickupHandoffPrivacyCopy(getPickupHandoffSummary(legacy))).toBe(
      "Your private order and payment updates go only to the merchant; no organizer receipt is sent."
    )
  })

  it("keeps historical organizer-owned product snapshots merchant-only", async () => {
    const historical = pickupFulfillment("organizer_handoff")
    historical.product = {
      ...historical.product,
      coordinate: `30402:${ORGANIZER}:own-coffee`,
      merchantPubkey: ORGANIZER,
    }

    expect(getPickupHandoffSummary(historical)).toEqual({
      mode: "merchant_handoff",
      handlerPubkey: ORGANIZER,
      legacySafeDefault: false,
      label: "Pickup from merchant booth",
    })
    expect(
      getOrganizerPickupClaimCode("private-order-id", historical)
    ).toBeNull()

    let inboxLookups = 0
    await assertCartPickupHandlerReady(
      [{ fulfillment: historical }],
      async () => {
        inboxLookups += 1
        return {
          state: "blocked",
          organizerPubkey: ORGANIZER,
          reason: "not_declared",
        }
      }
    )
    expect(inboxLookups).toBe(0)
  })

  it("discloses the bounded organizer receipt without sensitive fields", () => {
    const summary = getPickupHandoffSummary(
      pickupFulfillment("organizer_handoff")
    )
    const disclosure = getPickupHandoffPrivacyCopy(summary)

    expect(summary).toMatchObject({
      mode: "organizer_handoff",
      handlerPubkey: ORGANIZER,
      legacySafeDefault: false,
      label: "Pickup from event organizer",
    })
    expect(disclosure).toBe(ORGANIZER_HANDOFF_DISCLOSURE)
    expect(disclosure).toContain("After the merchant confirms payment")
    expect(disclosure).toContain("item references")
    expect(disclosure).toContain("quantities")
    expect(disclosure).toContain("Pickup is not ready")
    expect(disclosure).toContain("are not shared")
    expect(disclosure).not.toContain("alice@example.com")
    expect(disclosure).not.toContain("+15551234567")
    expect(disclosure).not.toContain("1 Private Road")
    expect(disclosure).not.toContain("lnbc")
  })

  it("derives the same organizer pickup code without exposing order identity", () => {
    const fulfillment = pickupFulfillment("organizer_handoff")
    const orderId = "private-order-id"
    const claim = getEventMarketPickupClaimRef({
      orderId,
      merchantPubkey: MERCHANT,
      organizerPubkey: ORGANIZER,
      collectionCoordinate: fulfillment.collection.coordinate,
    })

    expect(getOrganizerPickupClaimCode(orderId, fulfillment)).toBe(
      formatEventMarketPickupClaimCode(claim)
    )
    expect(getOrganizerPickupClaimCode(orderId, fulfillment)).not.toContain(
      orderId
    )
    expect(
      getOrganizerPickupClaimCode(
        orderId,
        pickupFulfillment("merchant_handoff")
      )
    ).toBeNull()

    const legacy = pickupFulfillment("organizer_handoff")
    delete legacy.handoffMode
    delete legacy.handlerPubkey
    expect(getOrganizerPickupClaimCode(orderId, legacy)).toBeNull()

    const malformed = pickupFulfillment("organizer_handoff")
    malformed.collection.coordinate = "not-a-collection"
    expect(getOrganizerPickupClaimCode(orderId, malformed)).toBeNull()
  })

  it("does not require an organizer inbox for merchant handoff", async () => {
    let inboxLookups = 0
    await assertCartPickupHandlerReady(
      [{ fulfillment: pickupFulfillment("merchant_handoff") }],
      async () => {
        inboxLookups += 1
        return {
          state: "blocked",
          organizerPubkey: ORGANIZER,
          reason: "not_declared",
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
      reason: "not_declared",
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
    ).rejects.toThrow("has not declared a usable private inbox")
    expect(orderSigningAttempts).toBe(0)
    expect(paymentAttempts).toBe(0)
  })

  it("accepts only a current usable organizer inbox", async () => {
    let lookedUpPubkey = ""
    await expect(
      assertCartPickupHandlerReady(
        [{ fulfillment: pickupFulfillment("organizer_handoff") }],
        async (organizerPubkey) => {
          lookedUpPubkey = organizerPubkey
          return {
            state: "ready",
            organizerPubkey,
            relayUrls: ["wss://inbox.example"],
          }
        }
      )
    ).resolves.toBeUndefined()
    expect(lookedUpPubkey).toBe(ORGANIZER)

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
