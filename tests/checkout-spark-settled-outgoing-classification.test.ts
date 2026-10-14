import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"

import {
  classifyCheckoutSparkSettledPayment,
  type CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"

const PREIMAGE = "11".repeat(32)
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex")

const target: CheckoutSparkSettledOutgoingTarget = {
  walletId: "wallet",
  network: "mainnet",
  legId: "merchant-leg",
  recipientId: "merchant",
  allocationSats: 1_000,
  unpaidAllocationSats: 1_111,
  intent: {
    legId: "merchant-leg",
    transferId: "exact-transfer",
    paymentRequest: "exact-invoice",
    paymentHash: PAYMENT_HASH,
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: 1_800_000_000_000,
  },
}

const completedPayment = {
  status: "completed",
  fees: 4n,
  details: {
    type: "lightning",
    htlcDetails: { paymentHash: PAYMENT_HASH, preimage: PREIMAGE },
  },
}

describe("settled Spark outgoing payment classification", () => {
  it("accepts only an exact preimage, hash, fee and transfer total", async () => {
    expect(
      await classifyCheckoutSparkSettledPayment(completedPayment, target, 999)
    ).toEqual({
      legId: target.legId,
      transferId: target.intent.transferId,
      paymentRequest: target.intent.paymentRequest,
      paymentHash: target.intent.paymentHash,
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: 999,
    })
  })

  it("rejects a wrong preimage or reported payment hash", async () => {
    const wrongPreimage = {
      ...completedPayment,
      details: {
        type: "lightning",
        htlcDetails: {
          paymentHash: PAYMENT_HASH,
          preimage: "22".repeat(32),
        },
      },
    }
    const wrongHash = {
      ...completedPayment,
      details: {
        type: "lightning",
        htlcDetails: {
          paymentHash: "ff".repeat(32),
          preimage: PREIMAGE,
        },
      },
    }
    expect(
      (await classifyCheckoutSparkSettledPayment(wrongPreimage, target, 999))
        .status
    ).toBe("conflicting_evidence")
    expect(
      (await classifyCheckoutSparkSettledPayment(wrongHash, target, 999)).status
    ).toBe("conflicting_evidence")
  })

  it("rejects an excessive fee or mismatched transfer total", async () => {
    expect(
      (
        await classifyCheckoutSparkSettledPayment(
          { ...completedPayment, fees: 6n },
          target,
          1_001
        )
      ).status
    ).toBe("conflicting_evidence")
    expect(
      (await classifyCheckoutSparkSettledPayment(completedPayment, target, 998))
        .status
    ).toBe("conflicting_evidence")
    expect(
      (await classifyCheckoutSparkSettledPayment(completedPayment, target))
        .status
    ).toBe("conflicting_evidence")
  })

  it("preserves pending and failed outcomes without inventing a paid receipt", async () => {
    expect(
      (
        await classifyCheckoutSparkSettledPayment(
          { ...completedPayment, status: "pending" },
          target
        )
      ).status
    ).toBe("pending")
    expect(
      (
        await classifyCheckoutSparkSettledPayment(
          { ...completedPayment, status: "failed" },
          target
        )
      ).status
    ).toBe("terminal_failure")
  })
})
