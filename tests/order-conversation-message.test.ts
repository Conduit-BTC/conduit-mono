import { describe, expect, it } from "bun:test"
import type { ParsedOrderMessage } from "@conduit/core"
import { getConversationPreview } from "@conduit/ui"

function statusMessage(status: string): ParsedOrderMessage {
  return {
    id: `status-${status}`,
    orderId: "order-1",
    type: "status_update",
    createdAt: 1,
    senderPubkey: "merchant",
    recipientPubkey: "buyer",
    rawContent: "",
    payload: { status },
  } as ParsedOrderMessage
}

describe("order conversation status presentation", () => {
  it("uses the canonical display label for known statuses", () => {
    expect(getConversationPreview(statusMessage("refund_requested"))).toBe(
      "Status updated to Refund requested"
    )
  })

  it("keeps unknown incoming statuses readable", () => {
    expect(getConversationPreview(statusMessage("awaiting_fulfillment"))).toBe(
      "Status updated to Awaiting Fulfillment"
    )
  })
})
