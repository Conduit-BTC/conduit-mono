import { describe, expect, it } from "bun:test"
import {
  readExactSparkLightningRecoveredTransfer,
  verifyExactSparkLightningRequestDebit,
} from "../packages/core/src/protocol/spark-lightning-exact-history"

const transferId = "7a283679-74e6-4b0f-a080-484af611953a"
const invoice = "lnbc10n1testinvoice"

function transfer() {
  return {
    sparkId: transferId,
    totalAmount: { originalValue: 101, originalUnit: "SATOSHI" },
    userRequest: {
      typename: "LightningSendRequest",
      id: "request-1",
      status: "PENDING",
      fee: { originalValue: 1, originalUnit: "SATOSHI" },
      encodedInvoice: invoice,
      idempotencyKey: transferId,
    },
  }
}

describe("shared exact Spark Lightning history", () => {
  it("pins transfer, recovered invoice, idempotency key, and polled debit", () => {
    const recovered = readExactSparkLightningRecoveredTransfer({
      transferId,
      paymentRequest: invoice,
      transfer: transfer(),
    })
    expect(recovered.request.id).toBe("request-1")
    expect(
      verifyExactSparkLightningRequestDebit({
        requestId: recovered.request.id,
        amountSats: 100,
        maxFeeSats: 2,
        totalAmount: recovered.totalAmount,
        request: recovered.request,
      })
    ).toBe(101)
  })

  it("rejects a different transfer, request kind, key, or invoice", () => {
    const cases = [
      { patch: { sparkId: "other" }, error: /transfer identity/ },
      {
        patch: {
          userRequest: { ...transfer().userRequest, typename: "Other" },
        },
        error: /invalid Lightning recovery evidence/,
      },
      {
        patch: {
          userRequest: { ...transfer().userRequest, idempotencyKey: "other" },
        },
        error: /payment identity/,
      },
      {
        patch: {
          userRequest: {
            ...transfer().userRequest,
            encodedInvoice: "lnbc10n1otherinvoice",
          },
        },
        error: /different Lightning invoice/,
      },
    ]
    for (const { patch, error } of cases) {
      expect(() =>
        readExactSparkLightningRecoveredTransfer({
          transferId,
          paymentRequest: invoice,
          transfer: { ...transfer(), ...patch },
        })
      ).toThrow(error)
    }
  })

  it("rejects changed polled request, over-cap fee, and absent or unequal total", () => {
    const base = {
      requestId: "request-1",
      amountSats: 100,
      maxFeeSats: 2,
      totalAmount: { originalValue: 101, originalUnit: "SATOSHI" },
      request: {
        id: "request-1",
        fee: { originalValue: 1, originalUnit: "SATOSHI" },
      },
    }
    expect(() =>
      verifyExactSparkLightningRequestDebit({
        ...base,
        request: { ...base.request, id: "different" },
      })
    ).toThrow(/request identity/)
    expect(() =>
      verifyExactSparkLightningRequestDebit({
        ...base,
        request: {
          ...base.request,
          fee: { originalValue: 3, originalUnit: "SATOSHI" },
        },
      })
    ).toThrow(/above the approved maximum/)
    expect(() =>
      verifyExactSparkLightningRequestDebit({
        ...base,
        totalAmount: undefined,
      })
    ).toThrow(/conflicting Lightning transfer total/)
    expect(() =>
      verifyExactSparkLightningRequestDebit({
        ...base,
        totalAmount: { originalValue: 102, originalUnit: "SATOSHI" },
      })
    ).toThrow(/conflicting Lightning transfer total/)
  })
})
