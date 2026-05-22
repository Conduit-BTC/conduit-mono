import { describe, expect, it } from "bun:test"
import {
  buildLightningPaymentProofMessage,
  deriveOrderPaymentState,
  parseOrderMessageRumorEvent,
} from "@conduit/core"

const buyerPubkey = "b".repeat(64)
const merchantPubkey = "a".repeat(64)

function rumor({
  id,
  type,
  orderId = "order-1",
  content,
  createdAt = 1,
}: {
  id: string
  type: string
  orderId?: string
  content: string
  createdAt?: number
}) {
  return {
    id,
    pubkey: buyerPubkey,
    created_at: createdAt,
    content,
    tags: [
      ["p", merchantPubkey],
      ["type", type],
      ["order", orderId],
    ],
  }
}

describe("payment proof model", () => {
  it("builds versioned Lightning proof payloads without wallet secrets", () => {
    const proof = buildLightningPaymentProofMessage({
      orderId: "order-1",
      action: "zap",
      amount: 21,
      amountMsats: 21_000,
      currency: "SATS",
      invoice: "lnbc1invoice",
      preimage: "preimage",
      paymentHash: "hash",
      source: "nwc",
      proofDeliveryStatus: "pending",
    })

    expect(proof).toMatchObject({
      version: 1,
      rail: "lightning",
      action: "zap",
      source: "nwc",
      proofDeliveryStatus: "pending",
      verification: {
        state: "buyer_evidence_received",
        checks: [],
      },
    })
    expect(JSON.stringify(proof)).not.toContain("nostr+walletconnect")
    expect(JSON.stringify(proof)).not.toContain("secret")
  })

  it("parses foreign or unknown-version proofs as degraded evidence", () => {
    const message = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-1",
        type: "payment_proof",
        content: JSON.stringify({
          version: 99,
          invoice: "lnbc1foreign",
          note: "paid externally",
          foreignField: "kept",
        }),
      }) as never
    )

    expect(message.type).toBe("payment_proof")
    if (message.type !== "payment_proof") return
    expect(message.payload.version).toBe(99)
    expect(message.payload.invoice).toBe("lnbc1foreign")
    expect(message.payload.preimage).toBeUndefined()
    expect(message.payload.foreignField).toBe("kept")
  })

  it("derives proof delivery states from order conversation messages", () => {
    const order = parseOrderMessageRumorEvent(
      rumor({
        id: "order-event",
        type: "order",
        content: JSON.stringify({
          id: "order-1",
          merchantPubkey,
          buyerPubkey,
          items: [
            {
              productId: "product-1",
              quantity: 1,
              priceAtPurchase: 21,
              currency: "SATS",
            },
          ],
          subtotal: 21,
          currency: "SATS",
          createdAt: 1,
        }),
      }) as never
    )
    const proofRetry = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-retry",
        type: "payment_proof",
        createdAt: 2,
        content: JSON.stringify({
          invoice: "lnbc1invoice",
          proofDeliveryStatus: "retry_needed",
        }),
      }) as never
    )

    expect(deriveOrderPaymentState([order])).toBe("awaiting_invoice")
    expect(deriveOrderPaymentState([order, proofRetry])).toBe(
      "proof_delivery_failed"
    )
  })
})
