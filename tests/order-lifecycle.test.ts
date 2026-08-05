import { describe, expect, it } from "bun:test"
import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  claimOrderLifecyclePayment,
  db,
  deriveOrderLifecyclePhase,
  getOrderLifecyclePaymentAdmission,
  getOrderPaymentTargetReplacementAdmission,
  isGuestOrderDataExpired,
  replaceOrderPaymentTarget,
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
    paymentTarget: {
      type: "wallet",
      walletId: "wallet-order",
      providerId: "spark",
    },
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
    paymentTarget: lifecycle.paymentTarget!,
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
    expect(
      getOrderLifecyclePaymentAdmission(lifecycle, {
        ...input,
        paymentTarget: {
          type: "wallet",
          walletId: "wallet-current-default",
          providerId: "spark",
        },
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

  it("only permits an explicit target change before a definite payment attempt", () => {
    expect(getOrderPaymentTargetReplacementAdmission(lifecycle)).toBe(
      "replaceable"
    )
    expect(
      getOrderPaymentTargetReplacementAdmission({
        ...lifecycle,
        paymentStatus: "failed",
        invoiceStatus: "received",
      })
    ).toBe("replaceable")

    for (const paymentStatus of [
      "paying",
      "paid",
      "manual_required",
      "ambiguous",
    ] as const) {
      expect(
        getOrderPaymentTargetReplacementAdmission({
          ...lifecycle,
          paymentStatus,
        })
      ).toBe("unsafe_state")
    }
  })

  it("persists one opaque provider token for retries and rotates it after an explicit target change", async () => {
    let stored: OrderLifecycle = {
      ...lifecycle,
      // Defend against stale/corrupt local state recreating the old privacy bug.
      walletPaymentAttemptId: `wallet-${lifecycle.orderId}`,
    }
    const table = db.orderLifecycles as typeof db.orderLifecycles & {
      get: typeof db.orderLifecycles.get
      put: typeof db.orderLifecycles.put
    }
    const database = db as typeof db & {
      transaction: typeof db.transaction
    }
    const originalGet = table.get
    const originalPut = table.put
    const originalTransaction = database.transaction

    table.get = (async () => stored) as typeof table.get
    table.put = (async (next: OrderLifecycle) => {
      stored = next
      return next.orderId
    }) as typeof table.put
    database.transaction = (async (
      _mode: string,
      _table: unknown,
      callback: () => Promise<unknown>
    ) => callback()) as typeof database.transaction

    try {
      const first = await claimOrderLifecyclePayment(input)
      if (first.status !== "claimed") {
        throw new Error("Expected the first payment claim to succeed.")
      }
      const firstToken = first.lifecycle.walletPaymentAttemptId

      expect(firstToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
      expect(firstToken).not.toBe(lifecycle.orderId)
      expect(first.lifecycle.paymentTarget).toEqual(lifecycle.paymentTarget)

      stored = {
        ...first.lifecycle,
        invoiceStatus: "failed",
        paymentStatus: "failed",
      }
      const retry = await claimOrderLifecyclePayment(input)
      if (retry.status !== "claimed") {
        throw new Error("Expected the retry payment claim to succeed.")
      }

      expect(retry.lifecycle.walletPaymentAttemptId).toBe(firstToken)
      expect(retry.lifecycle.paymentTarget).toEqual(lifecycle.paymentTarget)

      stored = {
        ...retry.lifecycle,
        invoiceStatus: "failed",
        paymentStatus: "failed",
      }
      const replacementTarget = {
        type: "wallet" as const,
        walletId: "wallet-backup",
        providerId: "spark" as const,
      }
      const replacement = await replaceOrderPaymentTarget(
        lifecycle.orderId,
        replacementTarget
      )
      if (replacement.status !== "updated") {
        throw new Error("Expected the explicit target replacement to succeed.")
      }

      expect(replacement.lifecycle.paymentTarget).toEqual(replacementTarget)
      expect(replacement.lifecycle.walletPaymentAttemptId).toBeUndefined()

      const replacementClaim = await claimOrderLifecyclePayment({
        ...input,
        paymentTarget: replacementTarget,
      })
      if (replacementClaim.status !== "claimed") {
        throw new Error("Expected the replacement payment claim to succeed.")
      }

      expect(replacementClaim.lifecycle.walletPaymentAttemptId).not.toBe(
        firstToken
      )
      expect(replacementClaim.lifecycle.walletPaymentAttemptId).not.toBe(
        lifecycle.orderId
      )
      expect(replacementClaim.lifecycle.paymentTarget).toEqual(
        replacementTarget
      )
    } finally {
      table.get = originalGet
      table.put = originalPut
      database.transaction = originalTransaction
    }
  })
})
