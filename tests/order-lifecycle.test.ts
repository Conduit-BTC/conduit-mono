import { describe, expect, it } from "bun:test"
import {
  db,
  type CachedProfile,
  type StoredPaymentAttempt,
} from "../packages/core/src/db"
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
  claimOrderLifecycleUpdatedAddressPayment,
  claimOrderPaymentProofDelivery,
  deriveOrderLifecyclePhase,
  fenceClaimedOrderLifecyclePaymentAuthority,
  getOrderLifecyclePaymentAdmission,
  getOrderPaymentTargetReplacementAdmission,
  getOrderPaymentAddressReplacementAdmission,
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
import { makeMerchantInvoiceReopenEvidence } from "./support/merchant-invoice-reopen-fixture"

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
    profile?: CachedProfile
  },
  run: (state: {
    lifecycle: () => OrderLifecycle | undefined
    paymentAttempt: () => StoredPaymentAttempt | undefined
    profile: () => CachedProfile | undefined
    transactionTables: () => unknown[][]
  }) => Promise<T>
): Promise<T> {
  let lifecycle = initial.lifecycle
  let paymentAttempt = initial.paymentAttempt
  let profile = initial.profile
  const lifecycleTable = db.orderLifecycles as typeof db.orderLifecycles & {
    get: typeof db.orderLifecycles.get
    put: typeof db.orderLifecycles.put
  }
  const paymentAttemptTable =
    db.paymentAttempts as typeof db.paymentAttempts & {
      get: typeof db.paymentAttempts.get
      put: typeof db.paymentAttempts.put
    }
  const profileTable = db.profiles as typeof db.profiles & {
    get: typeof db.profiles.get
    put: typeof db.profiles.put
  }
  const database = db as typeof db & { transaction: typeof db.transaction }
  const originalLifecycleGet = lifecycleTable.get
  const originalLifecyclePut = lifecycleTable.put
  const originalPaymentAttemptGet = paymentAttemptTable.get
  const originalPaymentAttemptPut = paymentAttemptTable.put
  const originalProfileGet = profileTable.get
  const originalProfilePut = profileTable.put
  const originalTransaction = database.transaction
  let transactionTail: Promise<unknown> = Promise.resolve()
  const transactionTables: unknown[][] = []

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
  profileTable.get = (async (pubkey: string) =>
    profile?.pubkey === pubkey ? profile : undefined) as typeof profileTable.get
  profileTable.put = (async (next: CachedProfile) => {
    profile = next
    return next.pubkey
  }) as typeof profileTable.put
  database.transaction = ((...args: unknown[]) => {
    const scope = args.at(-1) as () => Promise<unknown>
    transactionTables.push(args.slice(1, -1))
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
      profile: () => profile,
      transactionTables: () => transactionTables,
    })
  } finally {
    lifecycleTable.get = originalLifecycleGet
    lifecycleTable.put = originalLifecyclePut
    paymentAttemptTable.get = originalPaymentAttemptGet
    paymentAttemptTable.put = originalPaymentAttemptPut
    profileTable.get = originalProfileGet
    profileTable.put = originalProfilePut
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

  describe("updated merchant payment address", () => {
    const failed: OrderLifecycle = {
      ...lifecycle,
      invoiceStatus: "failed",
      paymentStatus: "failed",
      lastError: "Invoice preparation failed.",
      walletPaymentAttemptId: "f7347f64-a8aa-4e42-a476-0db58e014564",
      zapRequestId: "previous-request",
      zapRequestCreatedAt: 1_700_000_000,
      zapLnurl: "previous-lnurl",
      zapReceiptPubkey: "previous-provider",
      zapReceiptRelayUrls: ["wss://previous.example"],
    }
    const nextAddress = "merchant@new-wallet.example"
    const manualFailed: OrderLifecycle = {
      ...failed,
      checkoutMode: "external_wallet",
      publicZapSigner: undefined,
      paymentTarget: { type: "manual" },
      zapContent: "",
    }
    const manualInput: OrderPaymentClaimInput = {
      ...input,
      checkoutMode: "private_checkout",
      paymentTarget: { type: "manual" },
      zapContent: "",
    }

    it("recovers checkout-persisted private manual orders without changing their mode or target", async () => {
      await withMockOrderPaymentDb(
        { lifecycle: manualFailed },
        async (state) => {
          const result = await claimOrderLifecycleUpdatedAddressPayment(
            manualInput,
            manualFailed.updatedAt,
            nextAddress
          )
          expect(result.status).toBe("claimed")
          expect(state.lifecycle()).toMatchObject({
            orderId: manualFailed.orderId,
            checkoutMode: "external_wallet",
            paymentTarget: { type: "manual" },
            merchantLightningAddress: nextAddress,
            paymentClaimId: manualInput.paymentClaimId,
            invoiceStatus: "requesting",
            totalMsats: manualFailed.totalMsats,
          })
          expect(state.lifecycle()?.walletPaymentAttemptId).toBeUndefined()
        }
      )
    })

    it("replaces only a failed preparation and claims the new destination atomically", async () => {
      await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
        const result = await claimOrderLifecycleUpdatedAddressPayment(
          input,
          failed.updatedAt,
          nextAddress
        )
        expect(result.status).toBe("claimed")
        const next = state.lifecycle()!
        expect(next.merchantLightningAddress).toBe(nextAddress)
        expect(next.paymentClaimId).toBe(input.paymentClaimId)
        expect(next.invoiceStatus).toBe("requesting")
        expect(next.paymentStatus).toBe("not_started")
        expect(next.walletPaymentAttemptId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )
        expect(next.walletPaymentAttemptId).not.toBe(
          failed.walletPaymentAttemptId
        )
        expect(next.zapRequestId).toBeUndefined()
        expect(next.zapRequestCreatedAt).toBeUndefined()
        expect(next.zapLnurl).toBeUndefined()
        expect(next.zapReceiptPubkey).toBeUndefined()
        expect(next.zapReceiptRelayUrls).toBeUndefined()
        expect(next.lastError).toBeUndefined()
        expect(next.buyerPubkey).toBe(failed.buyerPubkey)
        expect(next.merchantPubkey).toBe(failed.merchantPubkey)
        expect(next.totalMsats).toBe(failed.totalMsats)
        expect(next.items).toEqual(failed.items)
        expect(next.checkoutMode).toBe(failed.checkoutMode)
        expect(next.zapContent).toBe(failed.zapContent)
      })
    })

    it("permits only one competing address replacement claim", async () => {
      await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
        const results = await Promise.all([
          claimOrderLifecycleUpdatedAddressPayment(
            input,
            failed.updatedAt,
            nextAddress
          ),
          claimOrderLifecycleUpdatedAddressPayment(
            { ...input, paymentClaimId: "competing-claim" },
            failed.updatedAt,
            "merchant@other-wallet.example"
          ),
        ])
        expect(results.map((result) => result.status)).toEqual([
          "claimed",
          "unsafe_state",
        ])
        expect(state.lifecycle()?.merchantLightningAddress).toBe(nextAddress)
        expect(state.lifecycle()?.paymentClaimId).toBe(input.paymentClaimId)
      })
    })

    it("requires the exact old payment snapshot and reviewed revision", async () => {
      for (const mismatch of [
        { ...input, merchantLightningAddress: nextAddress },
        { ...input, buyerPubkey: "another-buyer" },
        { ...input, merchantPubkey: "another-merchant" },
        { ...input, totalMsats: input.totalMsats + 1 },
        { ...input, zapContent: "different comment" },
        { ...input, items: [{ ...input.items[0]!, quantity: 3 }] },
        { ...input, paymentTarget: { type: "manual" as const } },
      ]) {
        await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
          expect(
            (
              await claimOrderLifecycleUpdatedAddressPayment(
                mismatch,
                failed.updatedAt,
                nextAddress
              )
            ).status
          ).toBe("snapshot_mismatch")
          expect(state.lifecycle()).toBe(failed)
        })
      }
      await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
        expect(
          (
            await claimOrderLifecycleUpdatedAddressPayment(
              input,
              failed.updatedAt - 1,
              nextAddress
            )
          ).status
        ).toBe("snapshot_mismatch")
        expect(state.lifecycle()).toBe(failed)
      })
    })

    it("rejects terminal, uncertain, invoiced, or proof-bearing payment state", async () => {
      const unsafe: Array<Partial<OrderLifecycle>> = [
        { phase: "cancelled" },
        { phase: "completed" },
        { completedAt: 1_700_000_001_000 },
        { checkoutMode: "pay_later" },
        { feeMsats: 0 },
        { invoiceExpiresAt: 1_700_000_001 },
        { zapReceiptObservationDeadline: 1_700_000_001_000 },
        { orderDeliveryStatus: "failed" },
        { paymentStatus: "paid" },
        { paymentStatus: "paying" },
        { paymentStatus: "ambiguous" },
        { paymentStatus: "manual_required" },
        { paymentStatus: "not_started" },
        { invoiceStatus: "received" },
        { invoiceStatus: "manual_required" },
        { invoiceStatus: "requesting" },
        { invoice: "synthetic-invoice" },
        { paymentHash: "synthetic-payment-hash" },
        { preimage: "synthetic-preimage" },
        { zapReceiptId: "synthetic-receipt" },
        { zapReceiptStatus: "waiting" },
        { zapReceiptStatus: "observed" },
        { proofDeliveryStatus: "sent" },
        { proofDeliveryStatus: "pending" },
        { proofDeliveryClaimId: "proof-owner" },
        { paymentClaimId: "payment-owner" },
      ]
      expect(getOrderPaymentAddressReplacementAdmission(failed)).toBe(
        "replaceable"
      )
      for (const [stored, claimInput] of [
        [failed, input],
        [manualFailed, manualInput],
      ] as const) {
        for (const override of unsafe) {
          const initial = { ...stored, ...override }
          expect(getOrderPaymentAddressReplacementAdmission(initial)).toBe(
            "unsafe_state"
          )
          await withMockOrderPaymentDb(
            { lifecycle: initial },
            async (state) => {
              expect(
                (
                  await claimOrderLifecycleUpdatedAddressPayment(
                    claimInput,
                    initial.updatedAt,
                    nextAddress
                  )
                ).status
              ).toBe("unsafe_state")
              expect(state.lifecycle()).toBe(initial)
            }
          )
        }
      }
    })

    it("rejects invalid or unchanged addresses and an ended buyer session", async () => {
      for (const address of [
        "",
        "not-an-address",
        "merchant@localhost",
        input.merchantLightningAddress!,
      ]) {
        await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
          expect(
            (
              await claimOrderLifecycleUpdatedAddressPayment(
                input,
                failed.updatedAt,
                address
              )
            ).status
          ).toBe("unsafe_state")
          expect(state.lifecycle()).toBe(failed)
        })
      }
      await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
        expect(
          (
            await claimOrderLifecycleUpdatedAddressPayment(
              input,
              failed.updatedAt,
              nextAddress,
              () => false
            )
          ).status
        ).toBe("unsafe_state")
        expect(state.lifecycle()).toBe(failed)
      })
    })

    it("rejects any retained payment or report attempt, even if incomplete", async () => {
      const attempt: StoredPaymentAttempt = {
        id: failed.orderId,
        orderId: failed.orderId,
        buyerPubkey: failed.buyerPubkey,
        merchantPubkey: failed.merchantPubkey,
        amountMsats: failed.totalMsats,
        currency: "SATS",
        proofDeliveryStatus: "pending",
        createdAt: failed.createdAt,
        updatedAt: failed.updatedAt,
      }
      for (const [stored, claimInput] of [
        [failed, input],
        [manualFailed, manualInput],
      ] as const) {
        for (const evidence of [
          {},
          { invoice: "synthetic-invoice" },
          { paymentHash: "synthetic-payment-hash" },
          { preimage: "synthetic-preimage" },
          { zapReceiptId: "synthetic-receipt" },
          { feeMsats: 0 },
          { proofDeliveryStatus: "sent" as const },
          { proofDeliveryStatus: "retry_needed" as const },
        ]) {
          const paymentAttempt = { ...attempt, ...evidence }
          await withMockOrderPaymentDb(
            { lifecycle: stored, paymentAttempt },
            async (state) => {
              expect(
                (
                  await claimOrderLifecycleUpdatedAddressPayment(
                    claimInput,
                    stored.updatedAt,
                    nextAddress
                  )
                ).status
              ).toBe("unsafe_state")
              expect(state.lifecycle()).toBe(stored)
              expect(state.paymentAttempt()).toBe(paymentAttempt)
            }
          )
        }
      }
    })

    it("rechecks the buyer session after asynchronous transaction reads", async () => {
      await withMockOrderPaymentDb({ lifecycle: failed }, async (state) => {
        let sessionCurrent = true
        const originalGet = db.paymentAttempts.get
        db.paymentAttempts.get = (async () => {
          sessionCurrent = false
          return undefined
        }) as typeof db.paymentAttempts.get
        try {
          expect(
            (
              await claimOrderLifecycleUpdatedAddressPayment(
                input,
                failed.updatedAt,
                nextAddress,
                () => sessionCurrent
              )
            ).status
          ).toBe("unsafe_state")
          expect(state.lifecycle()).toBe(failed)
        } finally {
          db.paymentAttempts.get = originalGet
        }
      })
    })

    it("normalizes the new address without changing manual payment selection", async () => {
      const manual: OrderLifecycle = {
        ...failed,
        paymentTarget: { type: "manual" },
      }
      await withMockOrderPaymentDb({ lifecycle: manual }, async (state) => {
        expect(
          (
            await claimOrderLifecycleUpdatedAddressPayment(
              { ...input, paymentTarget: { type: "manual" } },
              manual.updatedAt,
              `  ${nextAddress.toUpperCase()}  `,
              () => true
            )
          ).status
        ).toBe("claimed")
        expect(state.lifecycle()?.merchantLightningAddress).toBe(nextAddress)
        expect(state.lifecycle()?.paymentTarget).toEqual({ type: "manual" })
        expect(state.lifecycle()?.walletPaymentAttemptId).toBeUndefined()
        expect(state.lifecycle()!.updatedAt).toBeGreaterThan(manual.updatedAt)
      })
    })

    it("reports missing lifecycle state", async () => {
      expect(getOrderPaymentAddressReplacementAdmission(undefined)).toBe(
        "missing"
      )
      await withMockOrderPaymentDb({}, async () => {
        expect(
          await claimOrderLifecycleUpdatedAddressPayment(
            input,
            failed.updatedAt,
            nextAddress
          )
        ).toEqual({
          status: "missing",
          lifecycle: null,
        })
      })
    })
  })

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
    expect(
      getOrderLifecyclePaymentAdmission(
        { ...lifecycle, phase: "cancelled" },
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
      if (result.status === "claimed") {
        expect(result.preclaimLifecycle).toEqual(lifecycle)
      }
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

  it("selects profile authority and renews the matching payment claim together", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      paymentClaimedAt: Date.now(),
      paymentClaimLeaseExpiresAt: Date.now() + 1,
      invoiceStatus: "received",
      paymentStatus: "paying",
    }
    const profile: CachedProfile = {
      pubkey: claimed.merchantPubkey,
      rawContent: "{}",
      eventId: "d".repeat(64),
      eventCreatedAt: 2,
      cachedAt: Date.now(),
    }
    await withMockOrderPaymentDb(
      { lifecycle: claimed, profile },
      async (state) => {
        const fenced = await fenceClaimedOrderLifecyclePaymentAuthority(
          claimed.orderId,
          input.paymentClaimId,
          claimed.merchantPubkey
        )
        expect(fenced.status).toBe("fenced")
        if (fenced.status !== "fenced") throw new Error("claim not fenced")
        expect(fenced.selectedProfileContext.frontier).toMatchObject({
          eventId: profile.eventId,
          rawContent: profile.rawContent,
          validity: "valid",
        })
        expect(fenced.lifecycle.paymentClaimLeaseExpiresAt).toBeGreaterThan(
          claimed.paymentClaimLeaseExpiresAt!
        )

        await db.orderLifecycles.put({
          ...state.lifecycle()!,
          paymentClaimId: "competing-claim",
        })
        const stale = await fenceClaimedOrderLifecyclePaymentAuthority(
          claimed.orderId,
          input.paymentClaimId,
          claimed.merchantPubkey
        )
        expect(stale.status).toBe("claim_mismatch")
      }
    )
  })

  it("serializes the payment fence behind a stronger profile retention transaction", async () => {
    const claimed: OrderLifecycle = {
      ...lifecycle,
      paymentClaimId: input.paymentClaimId,
      paymentClaimedAt: Date.now(),
      paymentClaimLeaseExpiresAt: Date.now() + 1,
      invoiceStatus: "received",
      paymentStatus: "paying",
    }
    const originalProfile: CachedProfile = {
      pubkey: claimed.merchantPubkey,
      rawContent: JSON.stringify({ lud16: "old@example.com" }),
      eventId: "c".repeat(64),
      eventCreatedAt: 1,
      cachedAt: Date.now(),
    }
    const strongerProfile: CachedProfile = {
      ...originalProfile,
      rawContent: "{}",
      eventId: "d".repeat(64),
      eventCreatedAt: 2,
    }

    await withMockOrderPaymentDb(
      { lifecycle: claimed, profile: originalProfile },
      async (state) => {
        let releaseProfileWrite!: () => void
        let signalProfileWrite!: () => void
        const profileWriteStarted = new Promise<void>((resolve) => {
          signalProfileWrite = resolve
        })
        const profileWriteGate = new Promise<void>((resolve) => {
          releaseProfileWrite = resolve
        })
        const profileWrite = db.transaction("rw", db.profiles, async () => {
          signalProfileWrite()
          await profileWriteGate
          await db.profiles.put(strongerProfile)
        })
        await profileWriteStarted

        let fenceSettled = false
        const fence = fenceClaimedOrderLifecyclePaymentAuthority(
          claimed.orderId,
          input.paymentClaimId,
          claimed.merchantPubkey
        ).finally(() => {
          fenceSettled = true
        })
        await Promise.resolve()
        expect(fenceSettled).toBe(false)

        releaseProfileWrite()
        await profileWrite
        const result = await fence
        expect(result.status).toBe("fenced")
        if (result.status !== "fenced") throw new Error("claim not fenced")
        expect(result.selectedProfileContext.frontier).toMatchObject({
          eventId: strongerProfile.eventId,
          rawContent: strongerProfile.rawContent,
        })
        expect(state.profile()).toEqual(strongerProfile)
        expect(
          state
            .transactionTables()
            .some(
              (tables) =>
                tables.includes(db.orderLifecycles) &&
                tables.includes(db.profiles)
            )
        ).toBe(true)
      }
    )
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

  it("rejects completed and public manual reports before claiming payment evidence", async () => {
    const manual: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "private_checkout",
      publicZapSigner: undefined,
      invoiceStatus: "manual_required",
      paymentStatus: "manual_required",
      proofDeliveryStatus: "not_started",
      invoice: "lnbc1external",
    }
    for (const blocked of [
      { ...manual, phase: "completed" as const },
      { ...manual, checkoutMode: "public_zap_as_shopper" as const },
      { ...manual, checkoutMode: "anonymous_public_zap" as const },
    ]) {
      await withMockOrderPaymentDb({ lifecycle: blocked }, async (state) => {
        const result = await claimExternalOrderPaymentProof(
          blocked.orderId,
          "blocked-report",
          { authorizeClaim: () => true }
        )
        expect(result.status).toBe("preserved")
        expect(state.lifecycle()).toEqual(blocked)
      })
    }
  })

  it("authorizes an already-paid private report once without reopening cancellation", async () => {
    const cancelled: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "private_checkout",
      publicZapSigner: undefined,
      invoiceStatus: "manual_required",
      paymentStatus: "manual_required",
      proofDeliveryStatus: "not_started",
      invoice: "lnbc1external",
      phase: "cancelled",
    }
    let authorizations = 0
    const authorizeClaim = (current: OrderLifecycle) => {
      authorizations += 1
      expect(current.paymentStatus).toBe("manual_required")
      return current.invoice === cancelled.invoice
    }
    await withMockOrderPaymentDb({ lifecycle: cancelled }, async (state) => {
      const result = await claimExternalOrderPaymentProof(
        cancelled.orderId,
        "cancelled-report",
        { authorizeClaim }
      )
      expect(result.status).toBe("claimed")
      expect(state.lifecycle()).toMatchObject({
        phase: "cancelled",
        paymentStatus: "paid",
        proofDeliveryStatus: "pending",
        invoice: cancelled.invoice,
      })
      expect(
        (
          await claimExternalOrderPaymentProof(
            cancelled.orderId,
            "duplicate-report",
            { authorizeClaim }
          )
        ).status
      ).toBe("preserved")
      expect(authorizations).toBe(1)
    })
  })

  it("rechecks projected authority and exact identities after the transaction reads storage", async () => {
    const original: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "private_checkout",
      publicZapSigner: undefined,
      invoiceStatus: "manual_required",
      paymentStatus: "manual_required",
      proofDeliveryStatus: "not_started",
      invoice: "lnbc1original",
    }
    for (const change of [
      { buyerPubkey: "another-buyer" },
      { merchantPubkey: "another-merchant" },
      { invoice: "lnbc1another" },
      { phase: "completed" as const },
      {},
    ]) {
      await withMockOrderPaymentDb({ lifecycle: original }, async (state) => {
        let projectedAccessAllowsReport = true
        let inspected: OrderLifecycle | undefined
        const claim = claimExternalOrderPaymentProof(
          original.orderId,
          "stale-report",
          {
            authorizeClaim: (current) => {
              inspected = current
              return (
                projectedAccessAllowsReport &&
                current.buyerPubkey === original.buyerPubkey &&
                current.merchantPubkey === original.merchantPubkey &&
                current.invoice === original.invoice
              )
            },
          }
        )
        // The queued transaction must see newer local state and projected authority.
        const changed = { ...original, ...change }
        await db.orderLifecycles.put(changed)
        if (Object.keys(change).length === 0)
          projectedAccessAllowsReport = false
        expect((await claim).status).toBe("preserved")
        if (changed.phase === "completed") {
          expect(inspected).toBeUndefined()
        } else {
          expect(inspected).toEqual(changed)
        }
        expect(state.lifecycle()).toEqual(changed)
      })
    }
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

  it("admits a projected merchant invoice only with current exact reopen evidence", async () => {
    const cancelled: OrderLifecycle = {
      ...lifecycle,
      checkoutMode: "pay_later",
      publicZapSigner: undefined,
      invoiceStatus: "not_requested",
      paymentStatus: "not_started",
      proofDeliveryStatus: "not_started",
      invoice: undefined,
      paymentHash: undefined,
      invoiceExpiresAt: undefined,
      phase: "cancelled",
    }
    const invoice = makeBolt11Fixture({
      hrp: "lnbc20n",
      createdAt: 1_800_000_000,
      fields: [
        bolt11PaymentHashField(new Uint8Array(32).fill(17)),
        bolt11PlainDescriptionField(),
      ],
    })
    const baseClaim = {
      buyerPubkey: cancelled.buyerPubkey,
      merchantPubkey: cancelled.merchantPubkey,
      totalMsats: cancelled.totalMsats,
      invoice,
      paymentHash: "11".repeat(32),
      expiresAt: 1_800_003_600,
    }
    const reopenEvidence = makeMerchantInvoiceReopenEvidence(cancelled)
    const previousNetwork = config.lightningNetwork
    config.lightningNetwork = "mainnet"
    try {
      await withMockOrderPaymentDb({ lifecycle: cancelled }, async () => {
        expect(
          (
            await bindMerchantInvoiceForPayment(
              cancelled.orderId,
              baseClaim,
              1_800_000_001_000
            )
          ).status
        ).toBe("preserved")
      })

      for (const merchantPaymentEvidence of [
        "paid_then_processing",
        "shipping_update",
      ] as const) {
        await withMockOrderPaymentDb({ lifecycle: cancelled }, async () => {
          expect(
            (
              await bindMerchantInvoiceForPayment(
                cancelled.orderId,
                {
                  ...baseClaim,
                  reopenEvidence: makeMerchantInvoiceReopenEvidence(cancelled, {
                    merchantPaymentEvidence,
                  }),
                },
                1_800_000_001_000
              )
            ).status
          ).toBe("preserved")
        })
      }

      await withMockOrderPaymentDb({ lifecycle: cancelled }, async (state) => {
        const result = await bindMerchantInvoiceForPayment(
          cancelled.orderId,
          { ...baseClaim, reopenEvidence },
          1_800_000_001_000
        )
        expect(result.status).toBe("bound")
        expect(state.lifecycle()).toMatchObject({
          phase: "cancelled",
          invoiceStatus: "manual_required",
          paymentStatus: "manual_required",
          invoice,
        })
      })

      await withMockOrderPaymentDb({ lifecycle: cancelled }, async () => {
        expect(
          (
            await bindMerchantInvoiceForPayment(
              cancelled.orderId,
              {
                ...baseClaim,
                reopenEvidence: makeMerchantInvoiceReopenEvidence(cancelled, {
                  laterCancellation: true,
                }),
              },
              1_800_000_001_000
            )
          ).status
        ).toBe("preserved")
      })

      await withMockOrderPaymentDb({ lifecycle: cancelled }, async (state) => {
        const result = await claimExternalOrderPaymentProof(
          cancelled.orderId,
          "reopened-projected-proof",
          {
            merchantInvoice: { ...baseClaim, reopenEvidence },
            nowMs: 1_800_000_001_000,
          }
        )
        expect(result.status).toBe("claimed")
        expect(state.lifecycle()).toMatchObject({
          phase: "cancelled",
          paymentStatus: "paid",
          proofDeliveryStatus: "pending",
          invoice,
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
