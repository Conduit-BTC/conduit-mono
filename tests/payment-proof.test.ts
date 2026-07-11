import { describe, expect, it } from "bun:test"
import {
  buildLightningPaymentProofMessage,
  extractOrderSummary,
  hasPaymentProofEvidence,
  isPaymentProofEvidenceMessage,
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

function merchantRumor(input: Parameters<typeof rumor>[0]) {
  const event = rumor(input)
  return {
    ...event,
    pubkey: merchantPubkey,
    tags: event.tags.map((tag) => (tag[0] === "p" ? ["p", buyerPubkey] : tag)),
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

function parsedGuestOrder() {
  return parseOrderMessageRumorEvent(
    rumor({
      id: "guest-order-event",
      type: "order",
      content: JSON.stringify({
        id: "order-1",
        merchantPubkey,
        buyerPubkey,
        buyerIdentityKind: "guest_ephemeral",
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
        guestContact: {
          email: "buyer@example.com",
          phone: "+15551234567",
        },
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

  it("preserves order item title snapshots in summaries", () => {
    const order = parseOrderMessageRumorEvent(
      rumor({
        id: "order-title-event",
        type: "order",
        content: JSON.stringify({
          id: "order-1",
          merchantPubkey,
          buyerPubkey,
          items: [
            {
              productId:
                "30402:merchant:cnd26-publicnd26-public-product-ref-testc-product-ref-test-ec3t68",
              title: "CND26 Public Product Ref Test",
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

    const summary = extractOrderSummary([order])

    expect(summary.items[0]?.title).toBe("CND26 Public Product Ref Test")
  })

  it("projects structured guest contact into order summaries", () => {
    const summary = extractOrderSummary([parsedGuestOrder()])

    expect(summary.guestContact).toEqual({
      email: "buyer@example.com",
      phone: "+15551234567",
    })
    expect(summary.buyerIdentityKind).toBe("guest_ephemeral")
  })

  it("accepts only fixed-direction messages when projecting order state", () => {
    const order = parsedOrder()
    const buyerAuthoredStatus = parseOrderMessageRumorEvent(
      rumor({
        id: "forged-status",
        type: "status_update",
        content: JSON.stringify({ status: "complete" }),
      }) as never
    )
    const buyerAuthoredInvoice = parseOrderMessageRumorEvent(
      rumor({
        id: "forged-invoice",
        type: "payment_request",
        content: JSON.stringify({ invoice: "lnbc1forged" }),
      }) as never
    )
    const buyerAuthoredShipping = parseOrderMessageRumorEvent(
      rumor({
        id: "forged-shipping",
        type: "shipping_update",
        content: JSON.stringify({ trackingNumber: "forged" }),
      }) as never
    )
    const merchantAuthoredProof = parseOrderMessageRumorEvent(
      merchantRumor({
        id: "forged-proof",
        type: "payment_proof",
        content: JSON.stringify({
          invoice: "lnbc1forged",
          preimage: "forged",
        }),
      }) as never
    )

    const summary = extractOrderSummary([
      order,
      buyerAuthoredStatus,
      buyerAuthoredInvoice,
      buyerAuthoredShipping,
      merchantAuthoredProof,
    ])

    expect(summary.accepted).toBe(false)
    expect(summary.paymentConfirmed).toBe(false)
    expect(summary.invoiceSent).toBe(false)
    expect(summary.paymentProofReceived).toBe(false)
    expect(summary.trackingNumber).toBeNull()
  })

  it("tracks merchant acceptance and payment as independent historical gates", () => {
    const order = parsedOrder()
    const accepted = parseOrderMessageRumorEvent(
      merchantRumor({
        id: "accepted-status",
        type: "status_update",
        createdAt: 2,
        content: JSON.stringify({ status: "accepted" }),
      }) as never
    )
    const paid = parseOrderMessageRumorEvent(
      merchantRumor({
        id: "paid-status",
        type: "status_update",
        createdAt: 3,
        content: JSON.stringify({ status: "paid" }),
      }) as never
    )

    const summary = extractOrderSummary([order, accepted, paid])
    expect(summary.accepted).toBe(true)
    expect(summary.paymentConfirmed).toBe(true)
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
    expect(summary.paymentReportCount).toBe(1)
    expect(summary.paymentReportAmount).toBe(21)
    expect(summary.paymentReportCurrency).toBe("SATS")
  })

  it("recognizes legacy external-source reports emitted before external_invoice action", () => {
    const order = parsedOrder()
    const legacyExternalReport = parseOrderMessageRumorEvent(
      rumor({
        id: "legacy-external-payment-report",
        type: "payment_proof",
        content: JSON.stringify({
          version: 1,
          orderId: "order-1",
          rail: "lightning",
          action: "private_checkout",
          amount: 21,
          amountMsats: 21_000,
          currency: "SATS",
          invoice: "lnbc1invoice",
          source: "external",
        }),
      }) as never
    )

    expect(legacyExternalReport.type).toBe("payment_proof")
    if (legacyExternalReport.type !== "payment_proof") return

    expect(hasPaymentProofEvidence(legacyExternalReport.payload)).toBe(false)

    const summary = extractOrderSummary([order, legacyExternalReport])
    expect(summary.paymentProofReceived).toBe(false)
    expect(summary.paymentReportReceived).toBe(true)
    expect(summary.paymentReportCount).toBe(1)
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
