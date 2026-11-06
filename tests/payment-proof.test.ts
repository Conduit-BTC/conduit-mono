import {
  buildLightningPaymentProofMessage,
  extractOrderSummary,
  hasPaymentProofEvidence,
  isPaymentProofEvidenceMessage,
  parseOrderMessageRumorEvent,
} from "@conduit/core"
import { describe, expect, it } from "bun:test"

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
  it("rejects Conduit-created proofs without payment evidence", () => {
    expect(() =>
      buildLightningPaymentProofMessage({
        orderId: "order-1",
        action: "private_checkout",
        amount: 21,
        amountMsats: 21_000,
        currency: "SATS",
        source: "wallet",
      } as never)
    ).toThrow()
  })

  it("treats parsed malformed proofs as messages, not payment evidence", () => {
    const order = parsedOrder()
    const malformedProof = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-empty",
        type: "payment_proof",
        createdAt: 2,
        content: JSON.stringify({}),
      }) as never
    )

    expect(malformedProof.type).toBe("payment_proof")
    if (malformedProof.type !== "payment_proof") return
    expect(malformedProof.payload).toMatchObject({
      orderId: "order-1",
    })
    expect(hasPaymentProofEvidence(malformedProof.payload)).toBe(false)
    expect(isPaymentProofEvidenceMessage(malformedProof)).toBe(false)

    const summary = extractOrderSummary([order, malformedProof])
    expect(summary.paymentProofReceived).toBe(false)
    expect(summary.paymentProofCount).toBe(0)
    expect(summary.paymentProofAmount).toBeNull()
    expect(summary.paymentProofCurrency).toBeNull()
  })

  it("requires concrete payment evidence before proof messages affect payment summaries", () => {
    const order = parsedOrder()
    const incompleteForeignProof = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-incomplete-foreign",
        type: "payment_proof",
        createdAt: 2,
        content: JSON.stringify({
          rail: "stablecoin",
          invoice: "foreign-invoice",
          verification: {
            state: "wallet_seen",
            checks: ["foreign_wallet_claim"],
          },
        }),
      }) as never
    )
    const proofWithEvidence = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-evidence",
        type: "payment_proof",
        createdAt: 3,
        content: JSON.stringify({
          amount: 21,
          currency: "SATS",
          invoice: "lnbc1invoice",
          preimage: "preimage",
        }),
      }) as never
    )

    expect(incompleteForeignProof.type).toBe("payment_proof")
    expect(proofWithEvidence.type).toBe("payment_proof")
    if (
      incompleteForeignProof.type !== "payment_proof" ||
      proofWithEvidence.type !== "payment_proof"
    ) {
      return
    }

    expect(hasPaymentProofEvidence(incompleteForeignProof.payload)).toBe(false)
    expect(hasPaymentProofEvidence(proofWithEvidence.payload)).toBe(true)

    const summaryBeforeEvidence = extractOrderSummary([
      order,
      incompleteForeignProof,
    ])
    expect(summaryBeforeEvidence.paymentProofReceived).toBe(false)
    expect(summaryBeforeEvidence.paymentProofCount).toBe(0)
    expect(summaryBeforeEvidence.paymentReportReceived).toBe(false)
    expect(summaryBeforeEvidence.paymentReportCount).toBe(0)

    const summaryAfterEvidence = extractOrderSummary([
      order,
      incompleteForeignProof,
      proofWithEvidence,
    ])
    expect(summaryAfterEvidence.paymentProofReceived).toBe(true)
    expect(summaryAfterEvidence.paymentProofCount).toBe(1)
    expect(summaryAfterEvidence.paymentProofAmount).toBe(21)
    expect(summaryAfterEvidence.paymentProofCurrency).toBe("SATS")
    expect(summaryAfterEvidence.paymentReportReceived).toBe(true)
    expect(summaryAfterEvidence.externalPaymentReportReceived).toBe(false)
    expect(summaryAfterEvidence.paymentReportCount).toBe(1)
    expect(summaryAfterEvidence.paymentReportAmount).toBe(21)
    expect(summaryAfterEvidence.paymentReportCurrency).toBe("SATS")
  })

  it("separates external wallet payment reports from strict payment evidence", () => {
    const order = parsedOrder()
    const externalReport = parseOrderMessageRumorEvent(
      rumor({
        id: "external-payment-report",
        type: "payment_proof",
        content: JSON.stringify({
          version: 1,
          orderId: "order-1",
          rail: "lightning",
          action: "external_invoice",
          amount: 21,
          amountMsats: 21_000,
          currency: "SATS",
          invoice: "lnbc1invoice",
          source: "external",
          verification: {
            state: "needs_merchant_verification",
            checks: [],
          },
        }),
      }) as never
    )

    expect(externalReport.type).toBe("payment_proof")
    if (externalReport.type !== "payment_proof") return

    expect(hasPaymentProofEvidence(externalReport.payload)).toBe(false)

    const summary = extractOrderSummary([order, externalReport])
    expect(summary.paymentProofReceived).toBe(false)
    expect(summary.paymentProofCount).toBe(0)
    expect(summary.paymentReportReceived).toBe(true)
    expect(summary.externalPaymentReportReceived).toBe(true)
    expect(summary.paymentReportCount).toBe(1)
    expect(summary.paymentReportAmount).toBe(21)
    expect(summary.paymentReportCurrency).toBe("SATS")
  })

  it("does not count disputed or failed proof claims as payment evidence", () => {
    const disputedProof = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-disputed",
        type: "payment_proof",
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
    const failedProof = parseOrderMessageRumorEvent(
      rumor({
        id: "proof-failed",
        type: "payment_proof",
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

    expect(disputedProof.type).toBe("payment_proof")
    expect(failedProof.type).toBe("payment_proof")
    if (disputedProof.type !== "payment_proof") return
    if (failedProof.type !== "payment_proof") return

    expect(hasPaymentProofEvidence(disputedProof.payload)).toBe(false)
    expect(hasPaymentProofEvidence(failedProof.payload)).toBe(false)
  })
})
