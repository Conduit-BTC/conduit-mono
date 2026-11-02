import { describe, expect, test } from "bun:test"
import {
  createEventGuestReceipt,
  getEventGuestReceiptCommitment,
  verifyEventGuestReceipt,
  verifyEventPickupReceipt,
} from "@conduit/core/protocol/event-guest-checkout"
import { orderSchema } from "@conduit/core/schemas"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

function fixture() {
  const event = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const receipt = createEventGuestReceipt(event.merchant)
  const commitment = getEventGuestReceiptCommitment(receipt)
  const order = orderSchema.parse({
    ...event.order,
    id: receipt.orderId,
    buyerIdentityKind: "signed_in",
    pickupReceiptCommitment: commitment,
  })
  return { ...event, receipt, commitment, order }
}

describe("event pickup receipt matching", () => {
  test("an explicitly signed-in Event buyer can match their exact private pickup commitment", () => {
    const state = fixture()
    expect(
      verifyEventPickupReceipt(state.receipt, state.order, state.merchant)
    ).toBe(true)
    // Matching possession is intentionally not a payment or redemption result.
    expect(
      verifyEventGuestReceipt(state.receipt, state.order, state.merchant)
    ).toBe(false)
  })

  test("historical guest commitments and v1 receipts remain valid without the new field", () => {
    const state = fixture()
    const guest = orderSchema.parse({
      ...state.order,
      buyerIdentityKind: "guest_ephemeral",
      pickupReceiptCommitment: undefined,
      contactFreePickup: {
        label: "Local buyer",
        receiptCommitment: state.commitment,
      },
    })
    expect(verifyEventGuestReceipt(state.receipt, guest, state.merchant)).toBe(
      true
    )
    expect(verifyEventPickupReceipt(state.receipt, guest, state.merchant)).toBe(
      true
    )
  })

  test("wrong order, merchant, code and unsupported receipt versions do not match", () => {
    const state = fixture()
    expect(
      verifyEventPickupReceipt(
        state.receipt,
        { ...state.order, id: crypto.randomUUID() },
        state.merchant
      )
    ).toBe(false)
    expect(
      verifyEventPickupReceipt(state.receipt, state.order, state.organizer)
    ).toBe(false)
    expect(
      verifyEventPickupReceipt(
        { ...state.receipt, claimSecret: "0".repeat(64) },
        state.order,
        state.merchant
      )
    ).toBe(false)
    expect(
      verifyEventPickupReceipt(
        { ...state.receipt, version: 2 },
        state.order,
        state.merchant
      )
    ).toBe(false)
  })

  test("a new commitment cannot bypass explicit identity, Event fulfillment or conflicting historical evidence", () => {
    const state = fixture()
    expect(
      verifyEventPickupReceipt(
        state.receipt,
        { ...state.order, buyerIdentityKind: undefined },
        state.merchant
      )
    ).toBe(false)
    expect(
      verifyEventPickupReceipt(
        state.receipt,
        {
          ...state.order,
          items: [
            { ...state.order.items[0]!, fulfillment: { type: "shipping" } },
          ],
        },
        state.merchant
      )
    ).toBe(false)
    expect(
      verifyEventPickupReceipt(
        state.receipt,
        { ...state.order, items: [] },
        state.merchant
      )
    ).toBe(false)
    expect(
      verifyEventPickupReceipt(
        state.receipt,
        {
          ...state.order,
          buyerIdentityKind: "guest_ephemeral",
          contactFreePickup: {
            label: "Local buyer",
            receiptCommitment: "0".repeat(64),
          },
        },
        state.merchant
      )
    ).toBe(false)
  })
})
