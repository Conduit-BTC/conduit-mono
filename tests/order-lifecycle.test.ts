import { describe, expect, it } from "bun:test"
import { db, type StoredPaymentAttempt } from "../packages/core/src/db"
import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  LEGACY_ORDER_PAYMENT_RECOVERY_GRACE_MS,
  ORDER_PAYMENT_CLAIM_LEASE_MS,
  ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
  ORDER_PAYMENT_INTERRUPTED_AFTER_WALLET_ERROR,
  ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
  bindMerchantInvoiceForPayment,
  config,
  claimExternalOrderPaymentProof,
  claimOrderLifecyclePayment,
  claimOrderLifecyclePrivateFallbackPayment,
  claimOrderPaymentProofDelivery,
  deriveOrderLifecyclePhase,
  getOrderLifecyclePaymentAdmission,
  getOrderPaymentTargetReplacementAdmission,
  isGuestOrderDataExpired,
  isLegacyInterruptedOrderPayment,
  patchClaimedOrderLifecyclePayment,
  reconcileInterruptedOrderPayment,
  reconcileInterruptedOrderProofDelivery,
  reconcileLegacyInterruptedOrderPayment,
  recordObservedOrderPaymentReceipt,
  recordOrderPaymentProofDelivery,
  recordOrderPaymentReceiptTimeout,
  recordOrderPaymentWalletSuccessRecovery,
  recordOrderPaymentPreparationFailure,
  renewOrderPaymentProofDeliveryClaim,
  replaceOrderPaymentTarget,
  type OrderLifecycle,
  type OrderPaymentClaimInput,
} from "@conduit/core"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const base = {
  orderDeliveryStatus: "not_started" as const,
  invoiceStatus: "not_requested" as const,
  paymentStatus: "not_started" as const,
  proofDeliveryStatus: "not_started" as const,
}

async function withMockOrderPaymentDb<T>(
  initial: {
    lifecycle?: OrderLifecycle
    paymentAttempt?: StoredPaymentAttempt
  },
  run: (state: {
    lifecycle: () => OrderLifecycle | undefined
    paymentAttempt: () => StoredPaymentAttempt | undefined
  }) => Promise<T>
): Promise<T> {
  let lifecycle = initial.lifecycle
  let paymentAttempt = initial.paymentAttempt
  const lifecycleTable = db.orderLifecycles as typeof db.orderLifecycles & {
    get: typeof db.orderLifecycles.get
    put: typeof db.orderLifecycles.put
  }
  const paymentAttemptTable =
    db.paymentAttempts as typeof db.paymentAttempts & {
      get: typeof db.paymentAttempts.get
      put: typeof db.paymentAttempts.put
    }
  const database = db as typeof db & { transaction: typeof db.transaction }
  const originalLifecycleGet = lifecycleTable.get
  const originalLifecyclePut = lifecycleTable.put
  const originalPaymentAttemptGet = paymentAttemptTable.get
  const originalPaymentAttemptPut = paymentAttemptTable.put
  const originalTransaction = database.transaction
  let transactionTail: Promise<unknown> = Promise.resolve()

  lifecycleTable.get = (async (orderId: string) =>
    lifecycle?.orderId === orderId
      ? lifecycle
      : undefined) as typeof lifecycleTable.get
  lifecycleTable.put = (async (next: OrderLifecycle) => {
    lifecycle = next
    return next.orderId
  }) as typeof lifecycleTable.put
  paymentAttemptTable.get = (async (orderId: string) =>
    paymentAttempt?.id === orderId
      ? paymentAttempt
      : undefined) as typeof paymentAttemptTable.get
  paymentAttemptTable.put = (async (next: StoredPaymentAttempt) => {
    paymentAttempt = next
    return next.id
  }) as typeof paymentAttemptTable.put
  database.transaction = ((...args: unknown[]) => {
    const scope = args.at(-1) as () => Promise<unknown>
    const result = transactionTail.then(scope, scope)
    transactionTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }) as typeof database.transaction

  try {
    return await run({
      lifecycle: () => lifecycle,
      paymentAttempt: () => paymentAttempt,
    })
  } finally {
    lifecycleTable.get = originalLifecycleGet
    lifecycleTable.put = originalLifecyclePut
    paymentAttemptTable.get = originalPaymentAttemptGet
    paymentAttemptTable.put = originalPaymentAttemptPut
    database.transaction = originalTransaction
  }
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

describe("isLegacyInterruptedOrderPayment", () => {
  it("recognizes only the legacy mid-payment and pending-proof states", () => {
    expect(
      isLegacyInterruptedOrderPayment({
        ...base,
        invoiceStatus: "requesting",
        paymentStatus: "paying",
      })
    ).toBe(true)
    expect(
      isLegacyInterruptedOrderPayment({
        ...base,
        invoiceStatus: "received",
        paymentStatus: "paying",
      })
    ).toBe(true)
    expect(
      isLegacyInterruptedOrderPayment({
        ...base,
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
      })
    ).toBe(true)
    expect(
      isLegacyInterruptedOrderPayment({
        ...base,
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "current-proof-owner",
      })
    ).toBe(false)
    expect(isLegacyInterruptedOrderPayment(base)).toBe(false)
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
    paymentClaimId: "payment-claim-current",
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

  it("rejects a second admission while a durable claim exists", () => {
    expect(
      getOrderLifecyclePaymentAdmission(
        { ...lifecycle, paymentClaimId: "another-tab" },
        input
      )
    ).toBe("unsafe_state")
  })

  it("claims invoice work before marking the wallet payment as started", async () => {
    await withMockOrderPaymentDb({ lifecycle }, async (state) => {
      const result = await claimOrderLifecyclePayment(input)

      expect(result.status).toBe("claimed")
      expect(state.lifecycle()).toMatchObject({
        paymentClaimId: input.paymentClaimId,
        invoiceStatus: "requesting",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
      })
      expect(state.lifecycle()?.paymentClaimedAt).toBeNumber()
      expect(
        state.lifecycle()!.paymentClaimLeaseExpiresAt! -
          state.lifecycle()!.paymentClaimedAt!
      ).toBe(ORDER_PAYMENT_CLAIM_LEASE_MS)
    })
  })

  it("atomically claims only one legacy anonymous private fallback", async () => {
    const failed: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "failed",
      paymentStatus: "failed",
      lastError: "Legacy anonymous zap failed.",
    }
    const privateInput: OrderPaymentClaimInput = {
      ...input,
      checkoutMode: "private_checkout",
      zapContent: "",
    }

    await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
      const first =
        await claimOrderLifecyclePrivateFallbackPayment(privateInput)
      const second = await claimOrderLifecyclePrivateFallbackPayment({
        ...privateInput,
        paymentClaimId: "payment-claim-other-tab",
      })

      expect(first.status).toBe("claimed")
      expect(second.status).toBe("unsafe_state")
      expect(state.lifecycle()).toMatchObject({
        paymentClaimId: privateInput.paymentClaimId,
        checkoutMode: "private_checkout",
        publicZapFallback: true,
        invoiceStatus: "requesting",
        paymentStatus: "not_started",
      })
    })
  })

  it("records storage preparation failure without claiming payment", async () => {
    await withMockOrderPaymentDb({ lifecycle }, async (state) => {
      const result = await recordOrderPaymentPreparationFailure(
        input,
        "Recoverable payment storage is unavailable."
      )

      expect(result.status).toBe("recorded")
      expect(state.lifecycle()).toMatchObject({
        invoiceStatus: "failed",
        paymentStatus: "failed",
        lastError: "Recoverable payment storage is unavailable.",
      })
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
    })
  })

  it("fences the invoice-to-wallet checkpoint by payment claim ID", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "requesting",
      paymentStatus: "not_started",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const stale = await patchClaimedOrderLifecyclePayment(
        claimed.orderId,
        "payment-claim-stale",
        {
          invoiceStatus: "received",
          paymentStatus: "paying",
          invoice: "lnbc1stale",
        }
      )
      expect(stale.status).toBe("claim_mismatch")
      expect(state.lifecycle()?.invoice).toBeUndefined()

      const current = await patchClaimedOrderLifecyclePayment(
        claimed.orderId,
        input.paymentClaimId,
        {
          invoiceStatus: "received",
          paymentStatus: "paying",
          invoice: "lnbc1current",
        }
      )
      expect(current.status).toBe("patched")
      expect(state.lifecycle()).toMatchObject({
        paymentClaimId: input.paymentClaimId,
        invoiceStatus: "received",
        paymentStatus: "paying",
        invoice: "lnbc1current",
      })

      const terminal = await patchClaimedOrderLifecyclePayment(
        claimed.orderId,
        input.paymentClaimId,
        {
          paymentClaimId: undefined,
          invoiceStatus: "failed",
          paymentStatus: "failed",
        }
      )
      expect(terminal.status).toBe("patched")
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
    })
  })

  it("transfers pending proof work when exact receipt evidence fences a payment claim", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      paymentClaimedAt: Date.now(),
      paymentClaimLeaseExpiresAt: Date.now() + ORDER_PAYMENT_CLAIM_LEASE_MS,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
      invoice: "lnbc1public",
      zapRequestId: "zap-request-current",
      zapReceiptStatus: "waiting",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const receipt = await recordObservedOrderPaymentReceipt(claimed.orderId, {
        zapRequestId: "zap-request-current",
        zapReceiptId: "zap-receipt-current",
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "proof-claim-receipt",
      })
      expect(receipt.status).toBe("recorded")
      if (receipt.status !== "recorded") throw new Error("receipt not recorded")
      expect(receipt.proofDeliveryClaimed).toBe(true)
      expect(state.lifecycle()).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "proof-claim-receipt",
        zapReceiptStatus: "observed",
        zapReceiptId: "zap-receipt-current",
      })
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()

      const staleFailure = await patchClaimedOrderLifecyclePayment(
        claimed.orderId,
        input.paymentClaimId,
        { paymentStatus: "failed" }
      )
      expect(staleFailure.status).toBe("claim_mismatch")
      expect(state.lifecycle()?.paymentStatus).toBe("paid")

      const duplicateReceipt = await recordObservedOrderPaymentReceipt(
        claimed.orderId,
        {
          zapRequestId: "zap-request-current",
          zapReceiptId: "zap-receipt-current",
          proofDeliveryStatus: "pending",
          proofDeliveryClaimId: "proof-claim-duplicate",
        }
      )
      expect(duplicateReceipt.status).toBe("recorded")
      if (duplicateReceipt.status !== "recorded") {
        throw new Error("duplicate receipt not recorded")
      }
      expect(duplicateReceipt.proofDeliveryClaimed).toBe(false)
      expect(state.lifecycle()?.proofDeliveryClaimId).toBe(
        "proof-claim-receipt"
      )

      await recordOrderPaymentWalletSuccessRecovery(claimed.orderId, {
        proofDeliveryStatus: "pending",
        invoice: claimed.invoice!,
        preimage: "payment-preimage",
      })
      expect(state.lifecycle()?.proofDeliveryStatus).toBe("pending")
    })
  })

  it("keeps a deferred receipt timeout from overwriting exact evidence", async () => {
    const waiting: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "received",
      paymentStatus: "paying",
      invoice: "lnbc1public",
      zapRequestId: "zap-request-current",
      zapReceiptStatus: "waiting",
    }
    let releaseTimeout!: () => void
    const timeoutReleased = new Promise<void>((resolve) => {
      releaseTimeout = resolve
    })

    await withMockOrderPaymentDb({ lifecycle: waiting }, async (state) => {
      const staleTimeoutObserver = (async () => {
        const capturedRequestId = waiting.zapRequestId!
        await timeoutReleased
        return recordOrderPaymentReceiptTimeout(
          waiting.orderId,
          capturedRequestId
        )
      })()

      await recordObservedOrderPaymentReceipt(waiting.orderId, {
        zapRequestId: waiting.zapRequestId!,
        zapReceiptId: "zap-receipt-current",
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "proof-claim-timeout-race",
      })
      releaseTimeout()

      const timeout = await staleTimeoutObserver
      expect(timeout.status).toBe("preserved")
      expect(state.lifecycle()).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
        zapReceiptStatus: "observed",
        zapReceiptId: "zap-receipt-current",
      })
      expect(state.lifecycle()?.lastError).toBeUndefined()
    })
  })

  it("never regresses sent proof delivery from stale receipt work", async () => {
    const sent: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "sent",
      invoice: "lnbc1public",
      zapRequestId: "zap-request-current",
      zapReceiptStatus: "waiting",
    }

    await withMockOrderPaymentDb({ lifecycle: sent }, async (state) => {
      const receipt = await recordObservedOrderPaymentReceipt(sent.orderId, {
        zapRequestId: sent.zapRequestId!,
        zapReceiptId: "zap-receipt-current",
        proofDeliveryStatus: "pending",
      })
      const staleRetry = await recordOrderPaymentProofDelivery(
        sent.orderId,
        "retry_needed"
      )
      const recovered = await recordOrderPaymentWalletSuccessRecovery(
        sent.orderId,
        {
          proofDeliveryStatus: "retry_needed",
          invoice: sent.invoice!,
          paymentHash: "payment-hash",
          preimage: "payment-preimage",
        }
      )

      expect(staleRetry.status).toBe("preserved")
      expect(receipt.status).toBe("recorded")
      if (receipt.status !== "recorded") throw new Error("receipt not recorded")
      expect(receipt.proofDeliveryClaimed).toBe(false)
      expect(recovered.status).toBe("recorded")
      expect(state.lifecycle()).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "sent",
        paymentHash: "payment-hash",
        preimage: "payment-preimage",
        zapReceiptStatus: "observed",
        zapReceiptId: "zap-receipt-current",
      })
    })
  })

  it("keeps paid evidence while closing an unobserved receipt window", async () => {
    const paid: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "sent",
      invoice: "lnbc1public",
      preimage: "payment-preimage",
      zapRequestId: "zap-request-current",
      zapReceiptStatus: "waiting",
    }

    await withMockOrderPaymentDb({ lifecycle: paid }, async (state) => {
      const timeout = await recordOrderPaymentReceiptTimeout(
        paid.orderId,
        paid.zapRequestId!
      )

      expect(timeout.status).toBe("recorded")
      expect(state.lifecycle()).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "sent",
        preimage: "payment-preimage",
        zapReceiptStatus: "receipt_not_observed",
      })
      expect(state.lifecycle()?.lastError).toBeUndefined()
    })
  })

  it("allows only one browser document to claim proof publication", async () => {
    const now = 1_800_000_000_000
    const retry: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "retry_needed",
      invoice: "lnbc1private",
      preimage: "payment-preimage",
    }

    await withMockOrderPaymentDb({ lifecycle: retry }, async (state) => {
      const first = await claimOrderPaymentProofDelivery(
        retry.orderId,
        "proof-owner-first",
        now
      )
      const second = await claimOrderPaymentProofDelivery(
        retry.orderId,
        "proof-owner-second",
        now
      )

      expect(first.status).toBe("claimed")
      expect(second.status).toBe("preserved")
      expect(state.lifecycle()).toMatchObject({
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "proof-owner-first",
        proofDeliveryClaimLeaseExpiresAt:
          now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
      })

      const active = await reconcileInterruptedOrderProofDelivery(
        retry.orderId,
        "proof-owner-first",
        now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS - 1
      )
      expect(active.status).toBe("claim_active")

      const takeover = await claimOrderPaymentProofDelivery(
        retry.orderId,
        "proof-owner-second",
        now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS + 1
      )
      expect(takeover.status).toBe("claimed")

      const staleCompletion = await recordOrderPaymentProofDelivery(
        retry.orderId,
        "retry_needed",
        {},
        "proof-owner-first"
      )
      expect(staleCompletion.status).toBe("claim_mismatch")
      expect(state.lifecycle()).toMatchObject({
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "proof-owner-second",
      })

      await recordOrderPaymentWalletSuccessRecovery(retry.orderId, {
        proofDeliveryStatus: "retry_needed",
        proofDeliveryClaimId: "proof-owner-first",
        invoice: retry.invoice!,
        preimage: "payment-preimage",
      })
      expect(state.lifecycle()).toMatchObject({
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "proof-owner-second",
      })

      const recovered = await reconcileInterruptedOrderProofDelivery(
        retry.orderId,
        "proof-owner-second",
        now + ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS * 2 + 2
      )
      expect(recovered.status).toBe("recovered")
      expect(state.lifecycle()?.proofDeliveryStatus).toBe("retry_needed")
      expect(state.lifecycle()?.proofDeliveryClaimId).toBeUndefined()

      const delayedHeartbeat = await renewOrderPaymentProofDeliveryClaim(
        retry.orderId,
        "proof-owner-second"
      )
      expect(delayedHeartbeat.status).toBe("preserved")
      expect(state.lifecycle()?.proofDeliveryStatus).toBe("retry_needed")
    })
  })

  it("restores a sent external proof checkpoint when its publisher lease expires", async () => {
    const now = 1_800_000_000_000
    const pending: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "external_wallet",
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
      paymentClaimId: "proof-owner",
      proofDeliveryClaimId: "proof-owner",
      proofDeliveryClaimedAt: now - ORDER_PROOF_DELIVERY_CLAIM_LEASE_MS,
      proofDeliveryClaimLeaseExpiresAt: now,
      invoice: "lnbc1private",
    }
    const paymentAttempt: StoredPaymentAttempt = {
      id: pending.orderId,
      orderId: pending.orderId,
      buyerPubkey: pending.buyerPubkey,
      merchantPubkey: pending.merchantPubkey,
      amountMsats: pending.totalMsats,
      currency: "SATS",
      invoice: pending.invoice!,
      proofDeliveryStatus: "sent",
      createdAt: pending.createdAt,
      updatedAt: now,
    }

    await withMockOrderPaymentDb(
      { lifecycle: pending, paymentAttempt },
      async (state) => {
        const recovered = await reconcileInterruptedOrderProofDelivery(
          pending.orderId,
          "proof-owner",
          now + 1
        )

        expect(recovered.status).toBe("recovered")
        expect(state.lifecycle()?.proofDeliveryStatus).toBe("sent")
        expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
        expect(state.lifecycle()?.proofDeliveryClaimId).toBeUndefined()
      }
    )
  })

  it("preserves a proof publisher while its matching payment lease is live", async () => {
    const now = 1_800_000_000_000
    const pending: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
      paymentClaimId: "shared-owner",
      paymentClaimLeaseExpiresAt: now + ORDER_PAYMENT_CLAIM_LEASE_MS,
      proofDeliveryClaimId: "shared-owner",
      proofDeliveryClaimLeaseExpiresAt: now - 1,
      invoice: "lnbc1private",
      preimage: "payment-preimage",
    }

    await withMockOrderPaymentDb({ lifecycle: pending }, async (state) => {
      const active = await reconcileInterruptedOrderProofDelivery(
        pending.orderId,
        "shared-owner",
        now
      )
      expect(active.status).toBe("claim_active")
      expect(state.lifecycle()?.proofDeliveryStatus).toBe("pending")

      const recovered = await reconcileInterruptedOrderProofDelivery(
        pending.orderId,
        "shared-owner",
        now + ORDER_PAYMENT_CLAIM_LEASE_MS + 1
      )
      expect(recovered.status).toBe("recovered")
      expect(state.lifecycle()?.proofDeliveryStatus).toBe("retry_needed")
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
      expect(state.lifecycle()?.proofDeliveryClaimId).toBeUndefined()
    })
  })

  it("lets a later receipt observer reclaim retryable proof work", async () => {
    const observed: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "retry_needed",
      invoice: "lnbc1public",
      zapRequestId: "zap-request-current",
      zapReceiptStatus: "observed",
      zapReceiptId: "zap-receipt-current",
    }

    await withMockOrderPaymentDb({ lifecycle: observed }, async (state) => {
      const receipt = await recordObservedOrderPaymentReceipt(
        observed.orderId,
        {
          zapRequestId: observed.zapRequestId!,
          zapReceiptId: observed.zapReceiptId!,
          proofDeliveryStatus: "pending",
          proofDeliveryClaimId: "later-receipt-owner",
        }
      )

      expect(receipt.status).toBe("recorded")
      if (receipt.status !== "recorded") throw new Error("receipt not recorded")
      expect(receipt.proofDeliveryClaimed).toBe(true)
      expect(state.lifecycle()).toMatchObject({
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "later-receipt-owner",
      })
    })
  })

  it("atomically preserves an external payment attestation for recovery", async () => {
    const manual: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "external_wallet",
      publicZapSigner: undefined,
      invoiceStatus: "manual_required",
      paymentStatus: "manual_required",
      proofDeliveryStatus: "not_started",
      invoice: "lnbc1external",
      updatedAt: Date.now() - LEGACY_ORDER_PAYMENT_RECOVERY_GRACE_MS - 1,
    }

    await withMockOrderPaymentDb({ lifecycle: manual }, async (state) => {
      const first = await claimExternalOrderPaymentProof(
        manual.orderId,
        "external-proof-owner-first"
      )
      const second = await claimExternalOrderPaymentProof(
        manual.orderId,
        "external-proof-owner-second"
      )

      expect(first.status).toBe("claimed")
      expect(second.status).toBe("preserved")
      expect(state.lifecycle()).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
        proofDeliveryClaimId: "external-proof-owner-first",
      })

      const recovered = await reconcileInterruptedOrderProofDelivery(
        manual.orderId,
        "external-proof-owner-first",
        state.lifecycle()!.proofDeliveryClaimLeaseExpiresAt! + 1
      )
      expect(recovered.status).toBe("recovered")
      expect(state.lifecycle()).toMatchObject({
        paymentStatus: "paid",
        proofDeliveryStatus: "retry_needed",
      })
    })
  })

  it("atomically binds handoff and reporting to one exact merchant invoice", async () => {
    const awaiting: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "pay_later",
      publicZapSigner: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
      invoice: undefined,
      paymentHash: undefined,
      invoiceExpiresAt: undefined,
    }
    const previousNetwork = config.lightningNetwork
    config.lightningNetwork = "mainnet"
    try {
      const buildInvoice = (paymentHashByte: number) =>
        makeBolt11Fixture({
          hrp: "lnbc20n",
          createdAt: 1_800_000_000,
          fields: [
            bolt11PaymentHashField(new Uint8Array(32).fill(paymentHashByte)),
            bolt11PlainDescriptionField(),
          ],
        })
      const firstInvoice = {
        buyerPubkey: awaiting.buyerPubkey,
        merchantPubkey: awaiting.merchantPubkey,
        totalMsats: awaiting.totalMsats,
        invoice: buildInvoice(17),
        paymentHash: "11".repeat(32),
        expiresAt: 1_800_003_600,
      }
      const competingInvoice = {
        ...firstInvoice,
        invoice: buildInvoice(34),
        paymentHash: "22".repeat(32),
      }

      await withMockOrderPaymentDb({ lifecycle: awaiting }, async (state) => {
        const [first, second] = await Promise.all([
          bindMerchantInvoiceForPayment(
            awaiting.orderId,
            firstInvoice,
            1_800_000_001_000
          ),
          bindMerchantInvoiceForPayment(
            awaiting.orderId,
            competingInvoice,
            1_800_000_001_000
          ),
        ])

        expect(first.status).toBe("bound")
        expect(second.status).toBe("preserved")
        expect(state.lifecycle()).toMatchObject({
          invoiceStatus: "manual_required",
          paymentStatus: "manual_required",
          proofDeliveryStatus: "not_started",
          invoice: firstInvoice.invoice,
          paymentHash: firstInvoice.paymentHash,
          invoiceExpiresAt: firstInvoice.expiresAt,
        })
      })

      await withMockOrderPaymentDb({ lifecycle: awaiting }, async (state) => {
        const [first, second] = await Promise.all([
          claimExternalOrderPaymentProof(
            awaiting.orderId,
            "projected-proof-owner-first",
            { merchantInvoice: firstInvoice, nowMs: 1_800_000_001_000 }
          ),
          claimExternalOrderPaymentProof(
            awaiting.orderId,
            "projected-proof-owner-second",
            { merchantInvoice: competingInvoice, nowMs: 1_800_000_001_000 }
          ),
        ])

        expect(first.status).toBe("claimed")
        expect(second.status).toBe("preserved")
        expect(state.lifecycle()).toMatchObject({
          invoiceStatus: "manual_required",
          paymentStatus: "paid",
          proofDeliveryStatus: "pending",
          proofDeliveryClaimId: "projected-proof-owner-first",
          invoice: firstInvoice.invoice,
          paymentHash: firstInvoice.paymentHash,
          invoiceExpiresAt: firstInvoice.expiresAt,
        })
      })
    } finally {
      config.lightningNetwork = previousNetwork
    }
  })

  it("recovers an owned interruption before any invoice reached a wallet", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "requesting",
      paymentStatus: "not_started",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const result = await reconcileInterruptedOrderPayment(
        claimed.orderId,
        input.paymentClaimId
      )

      expect(result.status).toBe("recovered_before_payment")
      expect(state.lifecycle()).toMatchObject({
        invoiceStatus: "failed",
        paymentStatus: "failed",
        lastError: ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
      })
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
      expect(getOrderLifecyclePaymentAdmission(state.lifecycle(), input)).toBe(
        "admissible"
      )
    })
  })

  it("does not recover a claimant while its renewable lease is live", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      paymentClaimedAt: Date.now(),
      paymentClaimLeaseExpiresAt: Date.now() + ORDER_PAYMENT_CLAIM_LEASE_MS,
      invoiceStatus: "requesting",
      paymentStatus: "not_started",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const result = await reconcileInterruptedOrderPayment(
        claimed.orderId,
        input.paymentClaimId
      )

      expect(result.status).toBe("claim_active")
      expect(state.lifecycle()).toEqual(claimed)
    })
  })

  it("preserves an issued invoice and marks an unproven handoff ambiguous", async () => {
    const invoice = "lnbc1interrupted"
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "received",
      paymentStatus: "paying",
      invoice,
      zapRequestId: "zap-request-current",
      zapReceiptStatus: "waiting",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const result = await reconcileInterruptedOrderPayment(
        claimed.orderId,
        input.paymentClaimId
      )

      expect(result.status).toBe("marked_ambiguous")
      expect(state.lifecycle()).toMatchObject({
        invoice,
        invoiceStatus: "received",
        paymentStatus: "ambiguous",
        zapRequestId: "zap-request-current",
        zapReceiptStatus: "waiting",
        lastError: ORDER_PAYMENT_INTERRUPTED_AFTER_WALLET_ERROR,
      })
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
      expect(getOrderLifecyclePaymentAdmission(state.lifecycle(), input)).toBe(
        "unsafe_state"
      )
    })
  })

  it("restores a proven payment and exposes its unsent proof for retry", async () => {
    const invoice = "lnbc1paid"
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "received",
      paymentStatus: "paying",
      invoice,
    }
    const paymentAttempt: StoredPaymentAttempt = {
      id: claimed.orderId,
      orderId: claimed.orderId,
      buyerPubkey: claimed.buyerPubkey,
      merchantPubkey: claimed.merchantPubkey,
      amountMsats: claimed.totalMsats,
      currency: "SATS",
      invoice,
      paymentHash: "payment-hash",
      preimage: "payment-preimage",
      feeMsats: 21,
      proofDeliveryStatus: "pending",
      createdAt: claimed.createdAt,
      updatedAt: claimed.updatedAt,
    }

    await withMockOrderPaymentDb(
      { lifecycle: claimed, paymentAttempt },
      async (state) => {
        const result = await reconcileInterruptedOrderPayment(
          claimed.orderId,
          input.paymentClaimId
        )

        expect(result.status).toBe("restored_paid")
        expect(state.lifecycle()).toMatchObject({
          invoice,
          invoiceStatus: "received",
          paymentStatus: "paid",
          paymentHash: "payment-hash",
          preimage: "payment-preimage",
          feeMsats: 21,
          proofDeliveryStatus: "retry_needed",
        })
        expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
        expect(state.paymentAttempt()?.proofDeliveryStatus).toBe("retry_needed")
      }
    )
  })

  it("recovers a paid lifecycle checkpoint when attempt storage was unavailable", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "received",
      paymentStatus: "paid",
      proofDeliveryStatus: "pending",
      invoice: "lnbc1paid-lifecycle-only",
      paymentHash: "payment-hash",
      preimage: "payment-preimage",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const result = await reconcileInterruptedOrderPayment(
        claimed.orderId,
        input.paymentClaimId
      )

      expect(result.status).toBe("restored_paid")
      expect(state.lifecycle()).toMatchObject({
        invoiceStatus: "received",
        paymentStatus: "paid",
        proofDeliveryStatus: "retry_needed",
        invoice: "lnbc1paid-lifecycle-only",
        preimage: "payment-preimage",
      })
      expect(state.lifecycle()?.paymentClaimId).toBeUndefined()
    })
  })

  it("recovers only stale legacy claims that predate owner tokens", async () => {
    const now = 1_800_000_000_000
    const legacy: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "requesting",
      paymentStatus: "paying",
      updatedAt: now - LEGACY_ORDER_PAYMENT_RECOVERY_GRACE_MS - 1,
    }

    await withMockOrderPaymentDb({ lifecycle: legacy }, async (state) => {
      const result = await reconcileLegacyInterruptedOrderPayment(
        legacy.orderId,
        now
      )

      expect(result.status).toBe("recovered_before_payment")
      expect(state.lifecycle()).toMatchObject({
        invoiceStatus: "failed",
        paymentStatus: "failed",
        lastError: ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
      })
    })

    const fresh = {
      ...legacy,
      updatedAt: now - LEGACY_ORDER_PAYMENT_RECOVERY_GRACE_MS + 1,
    }
    await withMockOrderPaymentDb({ lifecycle: fresh }, async (state) => {
      const result = await reconcileLegacyInterruptedOrderPayment(
        fresh.orderId,
        now
      )

      expect(result.status).toBe("not_stale")
      expect(state.lifecycle()).toEqual(fresh)
    })
  })

  it("does not reconcile an interruption owned by another payment claim", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      invoiceStatus: "requesting",
      paymentStatus: "not_started",
    }

    await withMockOrderPaymentDb({ lifecycle: claimed }, async (state) => {
      const result = await reconcileInterruptedOrderPayment(
        claimed.orderId,
        "payment-claim-other"
      )

      expect(result.status).toBe("claim_mismatch")
      expect(state.lifecycle()).toEqual(claimed)
    })
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
        paymentClaimId: undefined,
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
        paymentClaimId: undefined,
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
