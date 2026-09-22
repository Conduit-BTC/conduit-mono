import { describe, expect, it, mock } from "bun:test"
import {
  applyCheckoutSparkEvidence,
  createCheckoutSparkReconciliation,
  freezeCheckoutSparkPlan,
} from "@conduit/core"

import {
  createCheckoutSparkRouterFundingBridge,
  type CheckoutSparkRouterFundingLockManager,
  type CheckoutSparkRouterFundingPaymentInput,
} from "../apps/market/src/lib/checkout-spark-router-funding"
import {
  getCheckoutSparkRouterPreparation,
  saveCheckoutSparkRouterFundingProgress,
  saveCheckoutSparkRouterPreparation,
  type PreparedCheckoutSparkRouterFunding,
} from "../apps/market/src/lib/checkout-spark-router-preparation"

const CREATED_AT = 1_800_000_000_000
const FUNDING_INVOICE = "lnbc-router-funding"

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function preparedFunding(
  grossFundingSats = 1_240
): PreparedCheckoutSparkRouterFunding {
  const plan = freezeCheckoutSparkPlan({
    checkoutId: "checkout-router-funding-1",
    orderId: "order-router-funding-1",
    merchantPubkey: "a".repeat(64),
    walletId: "spark-router-wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "spark-router-receive-1",
      paymentRequest: FUNDING_INVOICE,
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 600_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: "a".repeat(64),
        paymentRequest: "lnbc-merchant",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        paymentRequest: "lnbc-conduit",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
  })
  return {
    plan,
    reconciliation: createCheckoutSparkReconciliation(plan),
    recoveryHandoffId: "handoff-router-funding-1",
    fundingInvoice: FUNDING_INVOICE,
    fundingReceive: Object.freeze({
      walletId: plan.walletId,
      network: plan.network,
      id: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      providerStatus: "PENDING",
      requiredNetSats: plan.funding.requiredNetSats,
      grossFundingSats: plan.funding.grossFundingSats,
      expirySecs: 600,
      createdAt: plan.funding.createdAt,
      expiresAt: plan.funding.expiresAt,
    }),
    fundingSubmissionState: "not_started",
  }
}

function paymentInput(): CheckoutSparkRouterFundingPaymentInput {
  return {
    grossFundingSats: 1_240,
    paymentTarget: {
      type: "wallet",
      walletId: "wallet-personal",
      providerId: "nwc",
    },
    walletPaymentAttemptId: "router-funding-attempt-1",
    timeoutMs: 60_000,
    appId: "market",
  }
}

describe("checkout Spark router funding bridge", () => {
  it("treats payer success as provisional until the exact Spark receive is spendable", async () => {
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "payer-proof",
      paymentHash: "payer-hash",
    }))
    let reconcileCalls = 0
    const reconcileCheckoutReceive = mock(async () => {
      reconcileCalls += 1
      return reconcileCalls === 1
        ? {
            state: "pending" as const,
            providerStatus: "PENDING",
            failureReason: null,
            funds: {
              availableSats: 0,
              ownedSats: 0,
              incomingSats: 0,
              observedAt: CREATED_AT + 500,
            },
          }
        : {
            state: "spendable" as const,
            providerStatus: "SETTLED",
            failureReason: null,
            funds: {
              availableSats: 1_235,
              ownedSats: 1_240,
              incomingSats: 0,
              observedAt: CREATED_AT + 1_000,
            },
          }
    })
    const prepared = preparedFunding()
    const bridge = createCheckoutSparkRouterFundingBridge(prepared, {
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })

    const result = await bridge.fund(paymentInput())

    expect(result.status).toBe("funded")
    expect(result.reconciliation.funding).toEqual({
      state: "spendable",
      observedAt: CREATED_AT + 1_000,
    })
    expect(payInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: FUNDING_INVOICE,
        amountMsats: 1_240_000,
        paymentTarget: paymentInput().paymentTarget,
        walletPaymentAttemptId: "router-funding-attempt-1",
      })
    )
    expect(reconcileCheckoutReceive).toHaveBeenCalledWith(
      prepared.plan.walletId,
      prepared.fundingReceive
    )
  })

  it("reconciles delayed funding again without submitting the invoice twice", async () => {
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "webln" as const,
      preimage: "payer-proof",
    }))
    let reconcileCalls = 0
    const reconcileCheckoutReceive = mock(async () => {
      reconcileCalls += 1
      return reconcileCalls <= 2
        ? {
            state: "pending" as const,
            providerStatus: "PENDING",
            failureReason: null,
            funds: {
              availableSats: 0,
              ownedSats: 0,
              incomingSats: 1_240,
              observedAt: CREATED_AT + 1_000,
            },
          }
        : {
            state: "spendable" as const,
            providerStatus: "SETTLED",
            failureReason: null,
            funds: {
              availableSats: 1_235,
              ownedSats: 1_240,
              incomingSats: 0,
              observedAt: CREATED_AT + 2_000,
            },
          }
    })
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })
    const input = {
      ...paymentInput(),
      paymentTarget: { type: "webln" as const },
      walletPaymentAttemptId: undefined,
    }

    await expect(bridge.fund(input)).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "accepted",
      reconciliation: { funding: { state: "pending" } },
    })
    await expect(bridge.fund(input)).resolves.toMatchObject({
      status: "funded",
      reconciliation: { funding: { state: "spendable" } },
    })

    expect(payInvoice).toHaveBeenCalledTimes(1)
    expect(reconcileCheckoutReceive).toHaveBeenCalledTimes(3)
  })

  it("keeps manual funding explicit without claiming the router is funded", async () => {
    const payInvoice = mock(async () => ({
      status: "manual_required" as const,
      reason: "Pay this invoice with another Lightning wallet.",
    }))
    const reconcileCheckoutReceive = mock(async () => {
      throw new Error("manual selection must not reconcile before payment")
    })
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })

    await expect(
      bridge.fund({
        ...paymentInput(),
        paymentTarget: { type: "manual" },
        walletPaymentAttemptId: undefined,
      })
    ).resolves.toMatchObject({
      status: "manual_required",
      reason: "Pay this invoice with another Lightning wallet.",
    })
    expect(payInvoice).toHaveBeenCalledTimes(1)
    expect(reconcileCheckoutReceive).toHaveBeenCalledTimes(1)
  })

  it("keeps a cancelled wallet review retryable on the selected path", async () => {
    const payInvoice = mock(async () => ({
      status: "retryable_failure" as const,
      reason: "Spark payment was not approved.",
    }))
    const reconcileCheckoutReceive = mock(async () => {
      throw new Error("cancelled payment must not be treated as submitted")
    })
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "payment_retryable",
      reason: "Spark payment was not approved.",
    })
    expect(reconcileCheckoutReceive).toHaveBeenCalledTimes(1)
  })

  it("reconciles an unknown payer outcome and never submits it again", async () => {
    const payInvoice = mock(async () => {
      throw new Error("payer did not return a payment proof")
    })
    let reconcileCalls = 0
    const reconcileCheckoutReceive = mock(async () => {
      reconcileCalls += 1
      return reconcileCalls <= 2
        ? {
            state: "pending" as const,
            providerStatus: "PENDING",
            failureReason: null,
            funds: {
              availableSats: 0,
              ownedSats: 0,
              incomingSats: 0,
              observedAt: CREATED_AT + 1_000,
            },
          }
        : {
            state: "spendable" as const,
            providerStatus: "SETTLED",
            failureReason: null,
            funds: {
              availableSats: 1_235,
              ownedSats: 1_240,
              incomingSats: 0,
              observedAt: CREATED_AT + 2_000,
            },
          }
    })
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "unknown",
    })
    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "funded",
    })
    expect(payInvoice).toHaveBeenCalledTimes(1)
  })

  it("rejects a gross amount mismatch before any payer or Spark call", async () => {
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-pay",
    }))
    const reconcileCheckoutReceive = mock(async () => ({
      state: "spendable" as const,
      providerStatus: "SETTLED",
      failureReason: null,
      funds: {
        availableSats: 1_235,
        ownedSats: 1_240,
        incomingSats: 0,
        observedAt: CREATED_AT + 1_000,
      },
    }))
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })

    await expect(
      bridge.fund({ ...paymentInput(), grossFundingSats: 1_241 })
    ).rejects.toThrow("does not match the prepared request")
    expect(payInvoice).toHaveBeenCalledTimes(0)
    expect(reconcileCheckoutReceive).toHaveBeenCalledTimes(0)
  })

  it("rejects funding whose millisat conversion is not a safe integer", async () => {
    const grossFundingSats = Number.MAX_SAFE_INTEGER
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-pay",
    }))
    const reconcileCheckoutReceive = mock(async () => {
      throw new Error("unsafe funding must not reconcile")
    })
    const bridge = createCheckoutSparkRouterFundingBridge(
      preparedFunding(grossFundingSats),
      {
        payInvoice,
        reconcileCheckoutReceive,
        persistProgress: async () => undefined,
      }
    )

    await expect(
      bridge.fund({ ...paymentInput(), grossFundingSats })
    ).rejects.toThrow("millisat amount is unsafe")
    expect(payInvoice).toHaveBeenCalledTimes(0)
    expect(reconcileCheckoutReceive).toHaveBeenCalledTimes(0)
  })

  it("does not trust a spendable label without the exact required funds", async () => {
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice: async () => ({
        status: "paid",
        rail: "wallet",
        preimage: "payer-proof",
      }),
      reconcileCheckoutReceive: async () => ({
        state: "spendable",
        providerStatus: "SETTLED",
        failureReason: null,
        funds: {
          availableSats: 1_234,
          ownedSats: 1_240,
          incomingSats: 0,
          observedAt: CREATED_AT + 1_000,
        },
      }),
      persistProgress: async () => undefined,
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      reconciliation: { funding: { state: "conflicting_evidence" } },
    })
  })

  it("recreates from durable provisional state without sending the payer invoice again", async () => {
    const prepared = preparedFunding()
    let durable = {
      reconciliation: prepared.reconciliation,
      fundingSubmissionState: prepared.fundingSubmissionState,
      savedAt: CREATED_AT,
    }
    const firstPay = mock(async () => ({
      status: "paid" as const,
      rail: "webln" as const,
      preimage: "payer-proof",
    }))
    const firstBridge = createCheckoutSparkRouterFundingBridge(prepared, {
      payInvoice: firstPay,
      reconcileCheckoutReceive: async () => ({
        state: "pending",
        providerStatus: "PENDING",
        failureReason: null,
        funds: {
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 1_240,
          observedAt: CREATED_AT + 1_000,
        },
      }),
      persistProgress: async (progress) => {
        durable = progress
      },
    })

    await expect(firstBridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "accepted",
    })
    expect(durable.fundingSubmissionState).toBe("provisional")

    const reopenedPay = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-pay-again",
    }))
    const reopenedBridge = createCheckoutSparkRouterFundingBridge(
      {
        ...prepared,
        reconciliation: durable.reconciliation,
        fundingSubmissionState: durable.fundingSubmissionState,
      },
      {
        payInvoice: reopenedPay,
        reconcileCheckoutReceive: async () => ({
          state: "spendable",
          providerStatus: "SETTLED",
          failureReason: null,
          funds: {
            availableSats: 1_235,
            ownedSats: 1_240,
            incomingSats: 0,
            observedAt: CREATED_AT + 2_000,
          },
        }),
        persistProgress: async (progress) => {
          durable = progress
        },
      }
    )

    await expect(reopenedBridge.fund(paymentInput())).resolves.toMatchObject({
      status: "funded",
    })
    expect(firstPay).toHaveBeenCalledTimes(1)
    expect(reopenedPay).toHaveBeenCalledTimes(0)
  })

  it("reconciles an already-spendable exact receive before any new submission", async () => {
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-pay-again",
    }))
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive: async () => ({
        state: "spendable",
        providerStatus: "SETTLED",
        failureReason: null,
        funds: {
          availableSats: 1_235,
          ownedSats: 1_240,
          incomingSats: 0,
          observedAt: CREATED_AT + 1_000,
        },
      }),
      persistProgress: async () => undefined,
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "funded",
    })
    expect(payInvoice).toHaveBeenCalledTimes(0)
  })

  it("durably marks a provisional submission before invoking the selected rail", async () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    saveCheckoutSparkRouterPreparation(
      {
        reconciliation: prepared.reconciliation,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT,
      },
      storage
    )
    const statesAtPay: string[] = []
    const bridge = createCheckoutSparkRouterFundingBridge(prepared, {
      storage,
      now: () => CREATED_AT + 1_000,
      payInvoice: async () => {
        statesAtPay.push(
          getCheckoutSparkRouterPreparation(prepared.plan.checkoutId, storage)
            ?.fundingSubmissionState ?? "missing"
        )
        return {
          status: "paid",
          rail: "wallet",
          preimage: "payer-proof",
        }
      },
      reconcileCheckoutReceive: async () => ({
        state: "pending",
        providerStatus: "PENDING",
        failureReason: null,
        funds: {
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 1_240,
          observedAt: CREATED_AT + 1_000,
        },
      }),
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
    })
    expect(statesAtPay).toEqual(["provisional"])
    expect(
      getCheckoutSparkRouterPreparation(prepared.plan.checkoutId, storage)
        ?.fundingSubmissionState
    ).toBe("provisional")
  })

  it("does not let a stale preparation write regress provisional submission state", () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    const stale = saveCheckoutSparkRouterPreparation(
      {
        reconciliation: prepared.reconciliation,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT,
      },
      storage
    )
    saveCheckoutSparkRouterFundingProgress(
      {
        checkoutId: prepared.plan.checkoutId,
        planDigest: prepared.plan.planDigest,
        reconciliation: prepared.reconciliation,
        fundingSubmissionState: "provisional",
        savedAt: CREATED_AT + 1,
      },
      storage
    )

    saveCheckoutSparkRouterPreparation(
      {
        ...stale,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT + 2,
      },
      storage
    )

    expect(
      getCheckoutSparkRouterPreparation(prepared.plan.checkoutId, storage)
        ?.fundingSubmissionState
    ).toBe("provisional")
  })

  it("keeps newer exact funding evidence when a stale retryable result settles", () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    const pending = applyCheckoutSparkEvidence(prepared.reconciliation, {
      type: "funding",
      requestId: prepared.plan.funding.requestId,
      paymentRequest: prepared.plan.funding.paymentRequest,
      paymentHash: prepared.plan.funding.paymentHash,
      walletId: prepared.plan.walletId,
      network: prepared.plan.network,
      requiredNetSats: prepared.plan.funding.requiredNetSats,
      grossFundingSats: prepared.plan.funding.grossFundingSats,
      state: "pending",
      observedAt: CREATED_AT + 1_000,
    })
    const spendable = applyCheckoutSparkEvidence(pending, {
      type: "funding",
      requestId: prepared.plan.funding.requestId,
      paymentRequest: prepared.plan.funding.paymentRequest,
      paymentHash: prepared.plan.funding.paymentHash,
      walletId: prepared.plan.walletId,
      network: prepared.plan.network,
      requiredNetSats: prepared.plan.funding.requiredNetSats,
      grossFundingSats: prepared.plan.funding.grossFundingSats,
      state: "spendable",
      observedAt: CREATED_AT + 2_000,
    })
    saveCheckoutSparkRouterPreparation(
      {
        reconciliation: pending,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT + 1_000,
      },
      storage
    )
    saveCheckoutSparkRouterFundingProgress(
      {
        checkoutId: prepared.plan.checkoutId,
        planDigest: prepared.plan.planDigest,
        reconciliation: spendable,
        fundingSubmissionState: "provisional",
        savedAt: CREATED_AT + 2_000,
      },
      storage
    )

    saveCheckoutSparkRouterFundingProgress(
      {
        checkoutId: prepared.plan.checkoutId,
        planDigest: prepared.plan.planDigest,
        reconciliation: pending,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT + 3_000,
      },
      storage
    )

    const durable = getCheckoutSparkRouterPreparation(
      prepared.plan.checkoutId,
      storage
    )
    expect(durable?.reconciliation.funding).toEqual({
      state: "spendable",
      observedAt: CREATED_AT + 2_000,
    })
    expect(durable?.fundingSubmissionState).toBe("provisional")
  })

  it("fails closed after a crash gap instead of resending after recreation", async () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    saveCheckoutSparkRouterPreparation(
      {
        reconciliation: prepared.reconciliation,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT,
      },
      storage
    )
    const pendingReceive = async () => ({
      state: "pending" as const,
      providerStatus: "PENDING",
      failureReason: null,
      funds: {
        availableSats: 0,
        ownedSats: 0,
        incomingSats: 0,
        observedAt: CREATED_AT + 1_000,
      },
    })
    const firstPay = mock(async () => {
      throw new Error("process stopped before provider submission")
    })
    const firstBridge = createCheckoutSparkRouterFundingBridge(prepared, {
      storage,
      now: () => CREATED_AT + 1_000,
      payInvoice: firstPay,
      reconcileCheckoutReceive: pendingReceive,
    })

    await expect(firstBridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "unknown",
    })
    expect(firstPay).toHaveBeenCalledTimes(1)

    const durable = getCheckoutSparkRouterPreparation(
      prepared.plan.checkoutId,
      storage
    )
    expect(durable?.fundingSubmissionState).toBe("provisional")
    if (!durable) throw new Error("expected durable funding progress")

    const resumedPay = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-resend",
    }))
    const resumedBridge = createCheckoutSparkRouterFundingBridge(
      {
        ...prepared,
        reconciliation: durable.reconciliation,
        fundingSubmissionState: durable.fundingSubmissionState,
      },
      {
        storage,
        now: () => CREATED_AT + 2_000,
        payInvoice: resumedPay,
        reconcileCheckoutReceive: pendingReceive,
      }
    )

    await expect(resumedBridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "unknown",
    })
    expect(resumedPay).toHaveBeenCalledTimes(0)
  })

  it("uses the durable merged submission state before deciding whether to send", async () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    saveCheckoutSparkRouterPreparation(
      {
        reconciliation: prepared.reconciliation,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT,
      },
      storage
    )
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-send",
    }))
    const bridge = createCheckoutSparkRouterFundingBridge(prepared, {
      storage,
      now: () => CREATED_AT + 2_000,
      payInvoice,
      reconcileCheckoutReceive: async () => {
        saveCheckoutSparkRouterFundingProgress(
          {
            checkoutId: prepared.plan.checkoutId,
            planDigest: prepared.plan.planDigest,
            reconciliation: prepared.reconciliation,
            fundingSubmissionState: "provisional",
            savedAt: CREATED_AT + 1_000,
          },
          storage
        )
        return {
          state: "pending",
          providerStatus: "PENDING",
          failureReason: null,
          funds: {
            availableSats: 0,
            ownedSats: 0,
            incomingSats: 0,
            observedAt: CREATED_AT + 1_500,
          },
        }
      },
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "unknown",
    })
    expect(payInvoice).toHaveBeenCalledTimes(0)
  })

  it("coalesces concurrent funding calls into one selected-rail submission", async () => {
    let releasePayment!: (value: {
      status: "paid"
      rail: "wallet"
      preimage: string
    }) => void
    let markPaymentStarted!: () => void
    const paymentStarted = new Promise<void>((resolve) => {
      markPaymentStarted = resolve
    })
    const payInvoice = mock(() => {
      markPaymentStarted()
      return new Promise<{
        status: "paid"
        rail: "wallet"
        preimage: string
      }>((resolve) => {
        releasePayment = resolve
      })
    })
    let reconcileCalls = 0
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive: async () => {
        reconcileCalls += 1
        return reconcileCalls === 1
          ? {
              state: "pending",
              providerStatus: "PENDING",
              failureReason: null,
              funds: {
                availableSats: 0,
                ownedSats: 0,
                incomingSats: 0,
                observedAt: CREATED_AT + 500,
              },
            }
          : {
              state: "spendable",
              providerStatus: "SETTLED",
              failureReason: null,
              funds: {
                availableSats: 1_235,
                ownedSats: 1_240,
                incomingSats: 0,
                observedAt: CREATED_AT + 1_000,
              },
            }
      },
      persistProgress: async () => undefined,
    })

    const first = bridge.fund(paymentInput())
    const second = bridge.fund(paymentInput())
    expect(first).toBe(second)
    await paymentStarted
    releasePayment({ status: "paid", rail: "wallet", preimage: "proof" })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "funded" }),
      expect.objectContaining({ status: "funded" }),
    ])
    expect(payInvoice).toHaveBeenCalledTimes(1)
  })

  it("rejects a different concurrent funding target instead of silently coalescing it", async () => {
    let releasePreflight!: () => void
    const preflightHeld = new Promise<void>((resolve) => {
      releasePreflight = resolve
    })
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "payer-proof",
    }))
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      payInvoice,
      reconcileCheckoutReceive: async () => {
        await preflightHeld
        return {
          state: "pending",
          providerStatus: "PENDING",
          failureReason: null,
          funds: {
            availableSats: 0,
            ownedSats: 0,
            incomingSats: 0,
            observedAt: CREATED_AT + 500,
          },
        }
      },
      persistProgress: async () => undefined,
    })

    const first = bridge.fund(paymentInput())
    await expect(
      bridge.fund({
        ...paymentInput(),
        paymentTarget: { type: "webln" },
        walletPaymentAttemptId: undefined,
      })
    ).rejects.toThrow("funding target is already fixed")

    releasePreflight()
    await first
    expect(payInvoice).toHaveBeenCalledTimes(1)
  })

  it("fails closed before reconciliation or payment when a browser cannot lock funding", async () => {
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "must-not-send",
    }))
    const reconcileCheckoutReceive = mock(async () => ({
      state: "pending" as const,
      providerStatus: "PENDING",
      failureReason: null,
      funds: {
        availableSats: 0,
        ownedSats: 0,
        incomingSats: 0,
        observedAt: CREATED_AT + 500,
      },
    }))
    const bridge = createCheckoutSparkRouterFundingBridge(preparedFunding(), {
      lockManager: null,
      requireCrossTabLock: true,
      payInvoice,
      reconcileCheckoutReceive,
      persistProgress: async () => undefined,
    })

    await expect(bridge.fund(paymentInput())).rejects.toThrow(
      "cannot safely coordinate checkout funding across tabs"
    )
    expect(reconcileCheckoutReceive).toHaveBeenCalledTimes(0)
    expect(payInvoice).toHaveBeenCalledTimes(0)
  })

  it("releases only a definite retryable submission for another attempt", async () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    saveCheckoutSparkRouterPreparation(
      {
        reconciliation: prepared.reconciliation,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT,
      },
      storage
    )
    const lockManager: CheckoutSparkRouterFundingLockManager = {
      async request(name, _options, callback) {
        return callback({ name })
      },
    }
    let attempts = 0
    const payInvoice = mock(async () => {
      attempts += 1
      return attempts === 1
        ? {
            status: "retryable_failure" as const,
            reason: "Wallet review declined before sending.",
          }
        : {
            status: "paid" as const,
            rail: "wallet" as const,
            preimage: "payer-proof",
          }
    })
    const bridge = createCheckoutSparkRouterFundingBridge(prepared, {
      storage,
      lockManager,
      requireCrossTabLock: true,
      now: () => CREATED_AT + 1_000,
      payInvoice,
      reconcileCheckoutReceive: async () => ({
        state: "pending",
        providerStatus: "PENDING",
        failureReason: null,
        funds: {
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 0,
          observedAt: CREATED_AT + 500,
        },
      }),
    })

    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "payment_retryable",
    })
    expect(
      getCheckoutSparkRouterPreparation(prepared.plan.checkoutId, storage)
        ?.fundingSubmissionState
    ).toBe("not_started")
    await expect(bridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "accepted",
    })
    expect(payInvoice).toHaveBeenCalledTimes(2)
    expect(
      getCheckoutSparkRouterPreparation(prepared.plan.checkoutId, storage)
        ?.fundingSubmissionState
    ).toBe("provisional")
  })

  it("does not submit twice when another tab holds the exact funding lock", async () => {
    const prepared = preparedFunding()
    const storage = new MemoryStorage()
    saveCheckoutSparkRouterPreparation(
      {
        reconciliation: prepared.reconciliation,
        recoveryHandoffId: prepared.recoveryHandoffId,
        fundingInvoiceExposedAt: CREATED_AT,
        fundingSubmissionState: "not_started",
        savedAt: CREATED_AT,
      },
      storage
    )

    let lockHeld = false
    const lockNames: string[] = []
    const lockManager: CheckoutSparkRouterFundingLockManager = {
      async request(name, options, callback) {
        expect(options).toEqual({ mode: "exclusive", ifAvailable: true })
        lockNames.push(name)
        if (lockHeld) return callback(null)
        lockHeld = true
        try {
          return await callback({ name })
        } finally {
          lockHeld = false
        }
      },
    }
    let releasePayment!: (result: {
      status: "paid"
      rail: "wallet"
      preimage: string
    }) => void
    let markPaymentStarted!: () => void
    const paymentStarted = new Promise<void>((resolve) => {
      markPaymentStarted = resolve
    })
    const payInvoice = mock(() => {
      markPaymentStarted()
      return new Promise<{
        status: "paid"
        rail: "wallet"
        preimage: string
      }>((resolve) => {
        releasePayment = resolve
      })
    })
    const reconcileCheckoutReceive = async () => ({
      state: "pending" as const,
      providerStatus: "PENDING",
      failureReason: null,
      funds: {
        availableSats: 0,
        ownedSats: 0,
        incomingSats: 0,
        observedAt: CREATED_AT + 500,
      },
    })
    const dependencies = {
      storage,
      lockManager,
      requireCrossTabLock: true,
      now: () => CREATED_AT + 1_000,
      payInvoice,
      reconcileCheckoutReceive,
    }
    const firstBridge = createCheckoutSparkRouterFundingBridge(
      prepared,
      dependencies
    )
    const secondBridge = createCheckoutSparkRouterFundingBridge(
      prepared,
      dependencies
    )

    const first = firstBridge.fund(paymentInput())
    await paymentStarted
    await expect(secondBridge.fund(paymentInput())).rejects.toThrow(
      "already active in another tab"
    )
    expect(payInvoice).toHaveBeenCalledTimes(1)
    expect(
      getCheckoutSparkRouterPreparation(prepared.plan.checkoutId, storage)
        ?.fundingSubmissionState
    ).toBe("provisional")

    releasePayment({ status: "paid", rail: "wallet", preimage: "proof" })
    await expect(first).resolves.toMatchObject({
      status: "awaiting_reconciliation",
    })
    await expect(secondBridge.fund(paymentInput())).resolves.toMatchObject({
      status: "awaiting_reconciliation",
    })
    expect(payInvoice).toHaveBeenCalledTimes(1)
    expect(lockNames).toEqual([
      `conduit:checkout-spark-router-funding:${prepared.plan.planDigest}`,
      `conduit:checkout-spark-router-funding:${prepared.plan.planDigest}`,
      `conduit:checkout-spark-router-funding:${prepared.plan.planDigest}`,
    ])
  })
})
