import { describe, expect, it } from "bun:test"
import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  deriveOrderLifecyclePhase,
  getOrderLifecyclePaymentAdmission,
  isGuestOrderDataExpired,
  type OrderLifecycle,
  type OrderPaymentClaimInput,
} from "@conduit/core"

const base = {
  orderDeliveryStatus: "not_started" as const,
  invoiceStatus: "not_requested" as const,
  paymentStatus: "not_started" as const,
  proofDeliveryStatus: "not_started" as const,
}

describe("deriveOrderLifecyclePhase", () => {
  it("is pending before anything is delivered", () => {
    expect(deriveOrderLifecyclePhase(base)).toBe("pending")
  })

  it("is in_progress once the order is delivered", () => {
    expect(
      deriveOrderLifecyclePhase({ ...base, orderDeliveryStatus: "sent" })
    ).toBe("in_progress")
  })

  it("is in_progress once payment has moved (even if proof is pending)", () => {
    expect(
      deriveOrderLifecyclePhase({
        ...base,
        orderDeliveryStatus: "sent",
        paymentStatus: "paid",
        proofDeliveryStatus: "retry_needed",
      })
    ).toBe("in_progress")
  })

  it("is failed when order delivery failed", () => {
    expect(
      deriveOrderLifecyclePhase({ ...base, orderDeliveryStatus: "failed" })
    ).toBe("failed")
  })

  it("is failed when payment failed and nothing was delivered", () => {
    expect(
      deriveOrderLifecyclePhase({ ...base, paymentStatus: "failed" })
    ).toBe("failed")
  })

  it("keeps a delivered order in progress even if a later payment attempt failed", () => {
    // delivered + paid already returned in_progress above; a pre-funds failure
    // on a delivered order should not flip the whole order to failed.
    expect(
      deriveOrderLifecyclePhase({
        ...base,
        orderDeliveryStatus: "sent",
        paymentStatus: "manual_required",
      })
    ).toBe("in_progress")
  })

  it("honors explicit terminal phases (completed/cancelled are sticky)", () => {
    expect(deriveOrderLifecyclePhase({ ...base, phase: "completed" })).toBe(
      "completed"
    )
    expect(deriveOrderLifecyclePhase({ ...base, phase: "cancelled" })).toBe(
      "cancelled"
    )
  })
})

describe("guest order data retention", () => {
  const createdAt = 1_700_000_000_000

  it("expires guest lifecycle data at the bounded recovery deadline", () => {
    expect(
      isGuestOrderDataExpired(
        { buyerIdentityKind: "guest_ephemeral", createdAt },
        createdAt + GUEST_ORDER_LOCAL_RETENTION_MS - 1
      )
    ).toBe(false)
    expect(
      isGuestOrderDataExpired(
        { buyerIdentityKind: "guest_ephemeral", createdAt },
        createdAt + GUEST_ORDER_LOCAL_RETENTION_MS
      )
    ).toBe(true)
  })

  it("never applies the guest retention rule to signed-in orders", () => {
    expect(
      isGuestOrderDataExpired(
        { buyerIdentityKind: "signed_in", createdAt },
        createdAt + GUEST_ORDER_LOCAL_RETENTION_MS * 2
      )
    ).toBe(false)
  })
})

describe("order payment admission", () => {
  const lifecycle: OrderLifecycle = {
    orderId: "payment-admission-order",
    buyerPubkey: "buyer",
    merchantPubkey: "merchant",
    merchantLightningAddress: "merchant@wallet.example",
    checkoutMode: "anonymous_public_zap",
    publicZapSigner: "anon",
    items: [
      {
        productId: "30402:merchant:item",
        format: "digital",
        quantity: 2,
        priceAtPurchase: 1,
        currency: "SATS",
      },
    ],
    itemSubtotalSats: 2,
    shippingCostSats: 0,
    totalSats: 2,
    totalMsats: 2_000,
    currency: "SATS",
    zapContent: "Zapped out 2 items at https://shop.conduit.market/",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
  const input: OrderPaymentClaimInput = {
    orderId: lifecycle.orderId,
    buyerPubkey: lifecycle.buyerPubkey,
    merchantPubkey: lifecycle.merchantPubkey,
    merchantLightningAddress: lifecycle.merchantLightningAddress ?? null,
    checkoutMode: "anonymous_public_zap",
    zapContent: lifecycle.zapContent ?? "",
    totalSats: lifecycle.totalSats,
    totalMsats: lifecycle.totalMsats,
    items: lifecycle.items.map((item) => ({
      productAddress: item.productId,
      quantity: item.quantity,
    })),
  }

  it("admits an exact delivered-order snapshot", () => {
    expect(getOrderLifecyclePaymentAdmission(lifecycle, input)).toBe(
      "admissible"
    )
  })

  it("rejects payment context that disagrees with the delivered order", () => {
    expect(
      getOrderLifecyclePaymentAdmission(lifecycle, {
        ...input,
        totalMsats: input.totalMsats + 1_000,
      })
    ).toBe("snapshot_mismatch")
  })

  it("rejects states where an invoice may already be payable or paid", () => {
    for (const paymentStatus of [
      "paying",
      "paid",
      "manual_required",
      "ambiguous",
    ] as const) {
      expect(
        getOrderLifecyclePaymentAdmission(
          { ...lifecycle, paymentStatus },
          input
        )
      ).toBe("unsafe_state")
    }
  })

  it("requires a delivered, non-terminal order", () => {
    expect(
      getOrderLifecyclePaymentAdmission(
        { ...lifecycle, orderDeliveryStatus: "pending" },
        input
      )
    ).toBe("unsafe_state")
    expect(
      getOrderLifecyclePaymentAdmission(
        { ...lifecycle, phase: "completed" },
        input
      )
    ).toBe("unsafe_state")
  })
})
