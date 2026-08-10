import { describe, expect, it } from "bun:test"

import { reconcileOrderPaymentForDisplay } from "../apps/market/src/lib/order-payment-recovery"
import type { OrderLifecycle } from "../packages/core/src/db"

function lifecycle(
  orderId: string,
  overrides: Partial<OrderLifecycle> = {}
): OrderLifecycle {
  return {
    orderId,
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    checkoutMode: "private_checkout",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "requesting",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe("Orders payment recovery", () => {
  it("keeps every readable row visible when one reconciliation write fails", async () => {
    const failed = lifecycle("failed-write", { paymentClaimId: "claim-a" })
    const recovered = lifecycle("recovered", { paymentClaimId: "claim-b" })
    const recoveredResult = lifecycle("recovered", {
      invoiceStatus: "failed",
      paymentStatus: "failed",
    })

    const rows = await Promise.all(
      [failed, recovered].map((row) =>
        reconcileOrderPaymentForDisplay(row, {
          readOrderPaymentClaim: () => null,
          isOrderPaymentRunning: () => false,
          reconcileInterruptedOrderPayment: async (orderId) => {
            if (orderId === failed.orderId) {
              throw new Error("IndexedDB write failed")
            }
            return {
              status: "recovered_before_payment",
              lifecycle: recoveredResult,
            }
          },
        })
      )
    )

    expect(rows).toEqual([failed, recoveredResult])
  })

  it("retains a matching session marker when reconciliation is indeterminate", async () => {
    const claimed = lifecycle("indeterminate", { paymentClaimId: "claim-a" })
    let clearCalls = 0

    const result = await reconcileOrderPaymentForDisplay(claimed, {
      readOrderPaymentClaim: () => "claim-a",
      clearOrderPaymentClaim: () => {
        clearCalls += 1
        return true
      },
      isOrderPaymentRunning: () => false,
      reconcileInterruptedOrderPayment: async () => {
        throw new Error("IndexedDB unavailable")
      },
    })

    expect(result).toEqual(claimed)
    expect(clearCalls).toBe(0)
  })
})
