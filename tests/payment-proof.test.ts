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
  tags = [],
}: {
  id: string
  type: string
  orderId?: string
  content: string
  createdAt?: number
  tags?: string[][]
}) {
  return {
    id,
    pubkey: buyerPubkey,
    created_at: createdAt,
    content,
    tags: [["p", merchantPubkey], ["type", type], ["order", orderId], ...tags],
  }
}

function parsedOrder() {
  return parseOrderMessageRumorEvent(
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
}

describe("payment proof model", () => {
  it("builds strict v1 public zap proofs with a zap request id", () => {
    const proof = buildLightningPaymentProofMessage({
      orderId: "order-1",
      action: "zap",
      amount: 21,
      amountMsats: 21_000,
      currency: "SATS",
      invoice: "lnbc1invoice",
      preimage: "preimage",
      paymentHash: "hash",
      zapRequestId: "zap-request-id",
      source: "nwc",
      proofDeliveryStatus: "pending",
    })

    expect(proof).toMatchObject({
      version: 1,
      rail: "lightning",
      action: "zap",
      amountMsats: 21_000,
      zapRequestId: "zap-request-id",
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

  it("builds private checkout proofs without requiring public zap context", () => {
    const proof = buildLightningPaymentProofMessage({
      orderId: "order-1",
      action: "private_checkout",
      amount: 21,
      amountMsats: 21_000,
      currency: "SATS",
      invoice: "lnbc1private",
      preimage: "preimage",
      source: "webln",
    })

    expect(proof).toMatchObject({
      version: 1,
      rail: "lightning",
      action: "private_checkout",
      invoice: "lnbc1private",
      preimage: "preimage",
      source: "webln",
    })
    expect(proof.zapRequestId).toBeUndefined()
  })

  it("rejects Conduit-created proofs without payment evidence", () => {
    expect(() =>
      buildLightningPaymentProofMessage({
        orderId: "order-1",
        action: "private_checkout",
        amount: 21,
        amountMsats: 21_000,
        currency: "SATS",
        source: "nwc",
      } as never)
    ).toThrow()
  })

  it("rejects public zap proofs without zap request linkage", () => {
    expect(() =>
      buildLightningPaymentProofMessage({
        orderId: "order-1",
        action: "zap",
        amount: 21,
        amountMsats: 21_000,
        currency: "SATS",
        invoice: "lnbc1invoice",
        preimage: "preimage",
        source: "nwc",
      })
    ).toThrow("Public zap proofs must include the zap request id.")
  })

  it("parses foreign proofs with unknown known-field values as degraded evidence", () => {
    const message = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-foreign",
        type: "payment_proof",
        content: JSON.stringify({
          version: 99,
          rail: "stablecoin",
          action: "wallet_receipt",
          source: "phoenix",
          proofDeliveryStatus: "wallet_seen",
          invoice: "foreign-invoice",
          verification: {
            state: "foreign_verification_state",
            checks: ["wallet_receipt_seen"],
          },
          foreignField: "kept",
        }),
        tags: [["rail", "stablecoin"]],
      }) as never
    )

    expect(message.type).toBe("payment_proof")
    if (message.type !== "payment_proof") return
    expect(message.payload).toMatchObject({
      version: 99,
      rail: "stablecoin",
      action: "wallet_receipt",
      source: "phoenix",
      proofDeliveryStatus: "wallet_seen",
      invoice: "foreign-invoice",
      verification: {
        state: "foreign_verification_state",
        checks: ["wallet_receipt_seen"],
      },
      foreignField: "kept",
    })
    expect(message.payload.preimage).toBeUndefined()
  })

  it("derives explicit states for proof delivery and verification outcomes", () => {
    const order = parsedOrder()
    const proofRetry = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-retry",
        type: "payment_proof",
        createdAt: 2,
        content: JSON.stringify({
          invoice: "lnbc1invoice",
          preimage: "preimage",
          proofDeliveryStatus: "retry_needed",
        }),
      }) as never
    )
    const proofDisputed = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-disputed",
        type: "payment_proof",
        createdAt: 3,
        content: JSON.stringify({
          invoice: "lnbc1invoice",
          preimage: "preimage",
          verification: {
            state: "disputed",
            checks: [],
          },
        }),
      }) as never
    )
    const proofFailed = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-failed",
        type: "payment_proof",
        createdAt: 4,
        content: JSON.stringify({
          invoice: "lnbc1invoice",
          preimage: "preimage",
          verification: {
            state: "verification_failed",
            checks: [],
          },
        }),
      }) as never
    )

    expect(deriveOrderPaymentState([order])).toBe("awaiting_invoice")
    expect(deriveOrderPaymentState([order, proofRetry])).toBe(
      "proof_delivery_failed"
    )
    expect(deriveOrderPaymentState([order, proofDisputed])).toBe(
      "proof_disputed"
    )
    expect(deriveOrderPaymentState([order, proofFailed])).toBe("payment_failed")
  })
})
