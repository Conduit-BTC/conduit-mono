import { describe, expect, it } from "bun:test"
import {
  buildOrderStatusTimeline,
  completeMerchantOrder,
  getMerchantManualCompletionMethods,
  prepareMerchantManualCompletion,
  extractOrderSummary,
  isMerchantOrderPaid,
  parseOrderMessageRumorEvent,
  statusUpdateMessageSchema,
  type MerchantOrderState,
  type ParsedOrderMessage,
} from "@conduit/core"

const paid: MerchantOrderState = {
  status: "paid",
  paid: true,
  fulfillmentMode: "unknown",
}
const participants = {
  merchantPubkey: "a".repeat(64),
  buyerPubkey: "b".repeat(64),
}
function completion(): ParsedOrderMessage {
  return parseOrderMessageRumorEvent({
    id: "c".repeat(64),
    kind: 16,
    pubkey: participants.merchantPubkey,
    created_at: 20,
    tags: [
      ["p", participants.buyerPubkey],
      ["type", "status_update"],
      ["order", "old-order"],
      ["status", "complete"],
    ],
    content: JSON.stringify({
      completionBasis: "historical_handoff",
      note: "Collected at the past event",
    }),
  })
}

describe("merchant completion without tracking", () => {
  it("records a delivered shipment without inventing shipment fields", () => {
    const state = { ...paid, fulfillmentMode: "shipping" as const }
    expect(getMerchantManualCompletionMethods(state)).toEqual([
      "delivered_without_tracking",
    ])
    expect(
      prepareMerchantManualCompletion(
        state,
        "delivered_without_tracking",
        "  Delivered last week  "
      )
    ).toEqual({
      tags: [["status", "complete"]],
      payload: {
        status: "complete",
        completionBasis: "delivered_without_tracking",
        note: "Delivered last week",
      },
    })
    expect(() =>
      prepareMerchantManualCompletion(state, "historical_handoff")
    ).toThrow()
  })
  it("allows an explicit historical handoff statement for unknown legacy fulfillment", () => {
    expect(getMerchantManualCompletionMethods(paid)).toEqual([
      "delivered_without_tracking",
      "historical_handoff",
    ])
    expect(
      prepareMerchantManualCompletion(paid, "historical_handoff").payload
    ).toEqual({ status: "complete", completionBasis: "historical_handoff" })
    const timeline = buildOrderStatusTimeline({
      ...paid,
      status: "complete",
      completionBasis: "historical_handoff",
    })
    expect(timeline.some((step) => step.key === "shipped")).toBe(false)
    expect(timeline.at(-1)).toMatchObject({
      title: "Handoff recorded",
      subtitle: "Completion confirmed by merchant.",
      status: "complete",
    })
  })
  it("retains payment, terminal, unknown-status, digital and organizer authority gates", () => {
    for (const state of [
      { ...paid, paid: false, paymentObserved: true },
      { ...paid, status: "cancelled" },
      { ...paid, status: "refund_requested" },
      { ...paid, status: "complete" },
      { ...paid, status: "delivered" },
      { ...paid, status: "future_status" },
      { ...paid, pickupClaimed: true },
      { ...paid, fulfillmentMode: "pickup" as const },
      { ...paid, fulfillmentMode: "digital" as const },
    ])
      expect(() =>
        prepareMerchantManualCompletion(state, "historical_handoff")
      ).toThrow()
  })
  it("round-trips the attestation and note without creating payment or tracking evidence", () => {
    const message = completion()
    const summary = extractOrderSummary([message], participants)
    expect(summary.completionBasis).toBe("historical_handoff")
    expect(summary.completionNote).toBe("Collected at the past event")
    expect(summary.paymentConfirmed).toBe(false)
    expect(summary.shippingUpdateReceived).toBe(false)
    expect(summary.trackingNumber).toBeNull()
    expect(
      isMerchantOrderPaid({
        status: "complete",
        completionBasis: "historical_handoff",
      })
    ).toBe(false)
    expect(
      extractOrderSummary(
        [{ ...message, senderPubkey: participants.buyerPubkey }, message],
        participants
      ).completionBasis
    ).toBe("historical_handoff")
    expect(
      extractOrderSummary(
        [{ ...message, senderPubkey: participants.buyerPubkey }],
        participants
      ).completionBasis
    ).toBeUndefined()
  })
  it("rejects account changes before opening or signing a completion", async () => {
    const input = {
      ...participants,
      orderId: "old-order",
      messages: [completion()],
      delivery: "self_only" as const,
      authenticatedPubkey: participants.buyerPubkey,
      basis: "historical_handoff" as const,
    }
    await expect(completeMerchantOrder(input)).rejects.toThrow(
      "Connect the intended merchant"
    )
    await expect(
      completeMerchantOrder({
        ...input,
        authenticatedPubkey: participants.merchantPubkey,
        shouldContinue: () => false,
      })
    ).rejects.toThrow("Connect the intended merchant")
  })
  it("requires completion status and bounds optional notes", () => {
    expect(
      statusUpdateMessageSchema.safeParse({
        status: "paid",
        completionBasis: "historical_handoff",
      }).success
    ).toBe(false)
    expect(() =>
      prepareMerchantManualCompletion(
        paid,
        "historical_handoff",
        "x".repeat(2001)
      )
    ).toThrow()
  })
})
