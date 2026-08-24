import { describe, expect, it } from "bun:test"

import {
  getNextOrderPaymentLeaseExpiry,
  reconcileOrderPaymentForDisplay,
} from "../apps/market/src/lib/order-payment-recovery"
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
  it("schedules the next live lease when another lease is already expired", () => {
    const now = 1_700_000_000_000
    expect(
      getNextOrderPaymentLeaseExpiry(
        [
          lifecycle("mixed-leases", {
            paymentClaimLeaseExpiresAt: now - 1,
            proofDeliveryClaimLeaseExpiresAt: now + 10_000,
          }),
        ],
        now
      )
    ).toBe(now + 10_000)
  })

  it("schedules the later lease when payment and proof share one owner", () => {
    const now = 1_700_000_000_000
    expect(
      getNextOrderPaymentLeaseExpiry(
        [
          lifecycle("shared-owner-leases", {
            paymentClaimId: "shared-owner",
            paymentClaimLeaseExpiresAt: now + 15_000,
            proofDeliveryClaimId: "shared-owner",
            proofDeliveryClaimLeaseExpiresAt: now + 5_000,
          }),
        ],
        now
      )
    ).toBe(now + 15_000)
  })

  it("preserves a live proof owner before reconciling its payment claim", async () => {
    const claimed = lifecycle("mixed-claim", {
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
      paymentClaimId: "shared-owner",
      paymentClaimLeaseExpiresAt: 1_700_000_000_000,
      proofDeliveryClaimId: "shared-owner",
      proofDeliveryClaimLeaseExpiresAt: 1_700_000_030_000,
    })
    let paymentRecoveryCalls = 0
    let proofRecoveryCalls = 0

    const result = await reconcileOrderPaymentForDisplay(claimed, {
      readOrderPaymentClaim: () => null,
      isOrderPaymentRunning: () => false,
      reconcileInterruptedOrderPayment: async () => {
        paymentRecoveryCalls += 1
        return { status: "restored_paid", lifecycle: claimed }
      },
      reconcileInterruptedOrderProofDelivery: async () => {
        proofRecoveryCalls += 1
        return { status: "claim_active", lifecycle: claimed }
      },
    })

    expect(result).toEqual(claimed)
    expect(proofRecoveryCalls).toBe(1)
    expect(paymentRecoveryCalls).toBe(0)
  })

  it("recovers an expired proof lease before the legacy payment gate", async () => {
    const claimed = lifecycle("proof-lease", {
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
      proofDeliveryClaimId: "proof-owner",
      proofDeliveryClaimLeaseExpiresAt: 1_700_000_000_100,
    })
    const recovered = {
      ...claimed,
      proofDeliveryStatus: "retry_needed" as const,
      proofDeliveryClaimId: undefined,
      proofDeliveryClaimLeaseExpiresAt: undefined,
    }
    let proofRecoveryCalls = 0
    let legacyRecoveryCalls = 0

    const result = await reconcileOrderPaymentForDisplay(claimed, {
      readOrderPaymentClaim: () => null,
      isOrderPaymentRunning: () => false,
      reconcileInterruptedOrderProofDelivery: async (
        orderId,
        proofDeliveryClaimId
      ) => {
        proofRecoveryCalls += 1
        expect(orderId).toBe(claimed.orderId)
        expect(proofDeliveryClaimId).toBe("proof-owner")
        return { status: "recovered", lifecycle: recovered }
      },
      reconcileLegacyInterruptedOrderPayment: async () => {
        legacyRecoveryCalls += 1
        return { status: "not_legacy_interrupted", lifecycle: claimed }
      },
    })

    expect(result).toEqual(recovered)
    expect(proofRecoveryCalls).toBe(1)
    expect(legacyRecoveryCalls).toBe(0)
  })

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
