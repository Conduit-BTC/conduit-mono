import {
  applyCheckoutSparkEvidence,
  restoreCheckoutSparkReconciliation,
  type CheckoutSparkFundingState,
  type CheckoutSparkReconciliation,
  type ConduitAppId,
  type WalletPaymentFeeApproval,
} from "@conduit/core"

import {
  payCheckoutInvoice,
  type CheckoutInvoicePaymentResult,
  type CheckoutPaymentTarget,
} from "./payment-rails"
import { getSparkWalletManager } from "./spark-sdk"
import type {
  SparkCheckoutReceiveReconciliation,
  SparkCheckoutReceiveRequest,
  SparkWalletManager,
} from "./spark-wallet"
import {
  saveCheckoutSparkRouterFundingProgress,
  type CheckoutSparkRouterFundingSubmissionState,
  type CheckoutSparkRouterStorage,
  type PreparedCheckoutSparkRouterFunding,
  type StoredCheckoutSparkRouterPreparation,
} from "./checkout-spark-router-preparation"

export interface CheckoutSparkRouterFundingPaymentInput {
  grossFundingSats: number
  paymentTarget: CheckoutPaymentTarget
  walletPaymentAttemptId?: string
  approveFee?: WalletPaymentFeeApproval
  beforeSend?: () => Promise<void>
  timeoutMs: number
  appId: ConduitAppId
  metadata?: Record<string, unknown>
}

export type CheckoutSparkRouterFundingResult =
  | {
      status: "funded"
      reconciliation: CheckoutSparkReconciliation
    }
  | {
      status: "awaiting_reconciliation"
      paymentSubmission: "accepted" | "unknown"
      reconciliation: CheckoutSparkReconciliation
    }
  | {
      status: "manual_required"
      reason: string
      reconciliation: CheckoutSparkReconciliation
    }
  | {
      status: "payment_retryable"
      reason: string
      reconciliation: CheckoutSparkReconciliation
    }

type PayFundingInvoice = (
  input: Parameters<typeof payCheckoutInvoice>[0]
) => Promise<CheckoutInvoicePaymentResult>

export interface CheckoutSparkRouterFundingDependencies {
  payInvoice?: PayFundingInvoice
  reconcileCheckoutReceive?: (
    walletId: string,
    request: SparkCheckoutReceiveRequest
  ) => Promise<SparkCheckoutReceiveReconciliation>
  persistProgress?: (input: {
    reconciliation: CheckoutSparkReconciliation
    fundingSubmissionState: CheckoutSparkRouterFundingSubmissionState
    savedAt: number
  }) =>
    | StoredCheckoutSparkRouterPreparation
    | void
    | Promise<StoredCheckoutSparkRouterPreparation | void>
  storage?: CheckoutSparkRouterStorage | null
  now?: () => number
}

export interface CheckoutSparkRouterFundingBridge {
  fund(
    input: CheckoutSparkRouterFundingPaymentInput
  ): Promise<CheckoutSparkRouterFundingResult>
}

type PaymentSubmissionOutcome = "accepted" | "unknown"

function requireSparkManager(): SparkWalletManager {
  const manager = getSparkWalletManager()
  if (!manager) throw new Error("Spark is unavailable in this Market build.")
  return manager
}

function paymentTargetKey(target: CheckoutPaymentTarget): string {
  return target.type === "wallet"
    ? `${target.type}:${target.providerId}:${target.walletId}`
    : target.type
}

function assertPreparedFunding(
  prepared: PreparedCheckoutSparkRouterFunding
): void {
  const reconciliation = restoreCheckoutSparkReconciliation(
    prepared.reconciliation
  )
  const { funding, walletId, network, planDigest } = prepared.plan
  const receive = prepared.fundingReceive
  const expiryMs = receive.expirySecs * 1_000

  if (
    !Object.isFrozen(prepared.plan) ||
    !Object.isFrozen(prepared.plan.funding) ||
    !Object.isFrozen(prepared.fundingReceive) ||
    reconciliation.plan.planDigest !== planDigest ||
    prepared.fundingInvoice !== funding.paymentRequest ||
    receive.walletId !== walletId ||
    receive.network !== network ||
    receive.id !== funding.requestId ||
    receive.paymentRequest !== funding.paymentRequest ||
    receive.paymentHash !== funding.paymentHash ||
    receive.requiredNetSats !== funding.requiredNetSats ||
    receive.grossFundingSats !== funding.grossFundingSats ||
    receive.createdAt !== funding.createdAt ||
    receive.expiresAt !== funding.expiresAt ||
    !Number.isSafeInteger(receive.expirySecs) ||
    receive.expirySecs <= 0 ||
    receive.createdAt + expiryMs !== receive.expiresAt ||
    !receive.providerStatus.trim() ||
    !prepared.recoveryHandoffId.trim() ||
    (prepared.fundingSubmissionState !== "not_started" &&
      prepared.fundingSubmissionState !== "provisional")
  ) {
    throw new Error(
      "Checkout Spark funding bridge requires one exact prepared funding request."
    )
  }
}

function fundingEvidenceState(
  result: SparkCheckoutReceiveReconciliation,
  requiredNetSats: number
): Exclude<CheckoutSparkFundingState, "unreconciled"> {
  const { availableSats, ownedSats, incomingSats } = result.funds
  if (
    !Number.isSafeInteger(availableSats) ||
    availableSats < 0 ||
    !Number.isSafeInteger(ownedSats) ||
    ownedSats < availableSats ||
    !Number.isSafeInteger(incomingSats) ||
    incomingSats < 0 ||
    (result.state === "spendable" && availableSats < requiredNetSats) ||
    (result.state !== "spendable" && availableSats >= requiredNetSats)
  ) {
    return "conflicting_evidence"
  }
  if (result.state !== "unresolved_failure") return result.state
  if (result.failureReason === "lookup_unavailable") {
    return "lookup_unavailable"
  }
  if (result.failureReason === "conflicting_evidence") {
    return "conflicting_evidence"
  }
  return "unresolved_failure"
}

/**
 * Bind one prepared checkout-router receive request to one explicit payer rail.
 * A payer proof is provisional: only exact Spark receive reconciliation may
 * return `funded`, and subsequent calls reconcile without submitting again.
 * The durable provisional marker is intentionally fail-closed across a reload,
 * including when the process exits before the provider can accept the payment.
 */
export function createCheckoutSparkRouterFundingBridge(
  prepared: PreparedCheckoutSparkRouterFunding,
  dependencies: CheckoutSparkRouterFundingDependencies = {}
): CheckoutSparkRouterFundingBridge {
  assertPreparedFunding(prepared)

  const payInvoice = dependencies.payInvoice ?? payCheckoutInvoice
  const reconcileCheckoutReceive =
    dependencies.reconcileCheckoutReceive ??
    ((walletId: string, request: SparkCheckoutReceiveRequest) =>
      requireSparkManager().reconcileCheckoutReceive(walletId, request))
  const now = dependencies.now ?? Date.now
  const persistProgress =
    dependencies.persistProgress ??
    ((input: {
      reconciliation: CheckoutSparkReconciliation
      fundingSubmissionState: CheckoutSparkRouterFundingSubmissionState
      savedAt: number
    }) => {
      saveCheckoutSparkRouterFundingProgress(
        {
          checkoutId: prepared.plan.checkoutId,
          planDigest: prepared.plan.planDigest,
          ...input,
        },
        dependencies.storage
      )
    })
  let reconciliation = restoreCheckoutSparkReconciliation(
    prepared.reconciliation
  )
  let submissionState = prepared.fundingSubmissionState
  let submissionOutcome: PaymentSubmissionOutcome = "unknown"
  let selectedTargetKey: string | null = null
  let inFlight: Promise<CheckoutSparkRouterFundingResult> | null = null

  const readPersistedProgress = (
    persisted: StoredCheckoutSparkRouterPreparation | void,
    fallbackReconciliation: CheckoutSparkReconciliation,
    fallbackSubmissionState: CheckoutSparkRouterFundingSubmissionState
  ): {
    reconciliation: CheckoutSparkReconciliation
    fundingSubmissionState: CheckoutSparkRouterFundingSubmissionState
  } => ({
    reconciliation: restoreCheckoutSparkReconciliation(
      persisted?.reconciliation ?? fallbackReconciliation
    ),
    fundingSubmissionState:
      persisted?.fundingSubmissionState ?? fallbackSubmissionState,
  })

  const reconcileFunding =
    async (): Promise<CheckoutSparkRouterFundingResult> => {
      let provider: SparkCheckoutReceiveReconciliation
      try {
        provider = await reconcileCheckoutReceive(
          prepared.plan.walletId,
          prepared.fundingReceive
        )
      } catch {
        return {
          status: "awaiting_reconciliation",
          paymentSubmission: submissionOutcome,
          reconciliation,
        }
      }

      const nextReconciliation = applyCheckoutSparkEvidence(reconciliation, {
        type: "funding",
        requestId: prepared.plan.funding.requestId,
        paymentRequest: prepared.plan.funding.paymentRequest,
        paymentHash: prepared.plan.funding.paymentHash,
        walletId: prepared.plan.walletId,
        network: prepared.plan.network,
        requiredNetSats: prepared.plan.funding.requiredNetSats,
        grossFundingSats: prepared.plan.funding.grossFundingSats,
        state: fundingEvidenceState(
          provider,
          prepared.plan.funding.requiredNetSats
        ),
        observedAt: provider.funds.observedAt,
      })
      const persisted = await persistProgress({
        reconciliation: nextReconciliation,
        fundingSubmissionState: submissionState,
        savedAt: now(),
      })
      const durable = readPersistedProgress(
        persisted,
        nextReconciliation,
        submissionState
      )
      reconciliation = durable.reconciliation
      submissionState = durable.fundingSubmissionState

      return reconciliation.funding.state === "spendable"
        ? { status: "funded", reconciliation }
        : {
            status: "awaiting_reconciliation",
            paymentSubmission: submissionOutcome,
            reconciliation,
          }
    }

  return {
    fund(input) {
      if (
        !Number.isSafeInteger(input.grossFundingSats) ||
        input.grossFundingSats !== prepared.plan.funding.grossFundingSats
      ) {
        return Promise.reject(
          new Error(
            "Checkout Spark funding amount does not match the prepared request."
          )
        )
      }
      const amountMsats = input.grossFundingSats * 1_000
      if (!Number.isSafeInteger(amountMsats)) {
        return Promise.reject(
          new Error("Checkout Spark funding millisat amount is unsafe.")
        )
      }

      const targetKey = paymentTargetKey(input.paymentTarget)
      if (selectedTargetKey !== null && selectedTargetKey !== targetKey) {
        return Promise.reject(
          new Error("Checkout Spark funding target is already fixed.")
        )
      }
      if (inFlight) return inFlight

      const operation = async (): Promise<CheckoutSparkRouterFundingResult> => {
        const observed = await reconcileFunding()
        if (observed.status === "funded") return observed
        if (submissionState === "provisional") return observed

        if (input.paymentTarget.type === "manual") {
          const manual = await payInvoice({
            invoice: prepared.fundingInvoice,
            amountMsats,
            paymentTarget: input.paymentTarget,
            timeoutMs: input.timeoutMs,
            appId: input.appId,
            metadata: input.metadata,
          })
          if (manual.status !== "manual_required") {
            throw new Error(
              "Manual checkout funding unexpectedly invoked an automatic payment rail."
            )
          }
          return {
            status: "manual_required",
            reason: manual.reason,
            reconciliation,
          }
        }

        const persistedProvisional = await persistProgress({
          reconciliation,
          fundingSubmissionState: "provisional",
          savedAt: now(),
        })
        const provisional = readPersistedProgress(
          persistedProvisional,
          reconciliation,
          "provisional"
        )
        reconciliation = provisional.reconciliation
        submissionState = provisional.fundingSubmissionState
        if (submissionState !== "provisional") {
          throw new Error(
            "Checkout Spark funding submission was not durably reserved."
          )
        }
        selectedTargetKey = targetKey
        const payment = await payInvoice({
          invoice: prepared.fundingInvoice,
          amountMsats,
          paymentTarget: input.paymentTarget,
          walletPaymentAttemptId: input.walletPaymentAttemptId,
          approveFee: input.approveFee,
          beforeSend: input.beforeSend,
          timeoutMs: input.timeoutMs,
          appId: input.appId,
          metadata: input.metadata,
        }).catch(() => {
          submissionOutcome = "unknown"
          return null
        })

        if (payment === null) return reconcileFunding()
        if (payment.status === "manual_required") {
          throw new Error(
            "Automatic checkout funding unexpectedly changed payment rails."
          )
        }
        if (payment.status === "retryable_failure") {
          const persistedRetryable = await persistProgress({
            reconciliation,
            fundingSubmissionState: "not_started",
            savedAt: now(),
          })
          const retryable = readPersistedProgress(
            persistedRetryable,
            reconciliation,
            "not_started"
          )
          reconciliation = retryable.reconciliation
          submissionState = retryable.fundingSubmissionState
          if (submissionState === "provisional") {
            return reconciliation.funding.state === "spendable"
              ? { status: "funded", reconciliation }
              : {
                  status: "awaiting_reconciliation",
                  paymentSubmission: submissionOutcome,
                  reconciliation,
                }
          }
          selectedTargetKey = null
          return {
            status: "payment_retryable",
            reason: payment.reason,
            reconciliation,
          }
        }

        submissionOutcome = "accepted"
        return reconcileFunding()
      }

      inFlight = operation().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }
}
