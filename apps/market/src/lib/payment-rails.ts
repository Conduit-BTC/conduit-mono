import {
  getWeblnPaymentFailurePhase,
  hasWebLN,
  weblnSendPayment,
  type ConduitAppId,
  type OrderPaymentTarget,
  type WalletPaymentDiagnostic,
  type WalletPaymentFeeApproval,
} from "@conduit/core"
import {
  marketWalletPaymentCoordinator,
  type WalletPaymentCoordinator,
} from "./wallet-payment-coordinator"

export type CheckoutPaymentRail = "wallet" | "webln"

/**
 * One explicit execution target for one payment attempt.
 *
 * A discriminated union makes implicit rail fallback unrepresentable. Callers
 * must return to buyer review before changing this target.
 */
export type CheckoutPaymentTarget = OrderPaymentTarget

/** Marks a payment outcome that must be checked in the selected wallet first. */
export const AMBIGUOUS_PAYMENT_WARNING =
  "Check your wallet before trying another payment path."

export function isAmbiguousCheckoutPaymentError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(AMBIGUOUS_PAYMENT_WARNING)
  )
}

export type CheckoutInvoicePaymentResult =
  | {
      status: "paid"
      rail: CheckoutPaymentRail
      preimage: string
      paymentHash?: string
      feeMsats?: number
    }
  | {
      status: "manual_required"
      reason: string
      diagnostics?: WalletPaymentDiagnostic[]
    }
  | {
      status: "retryable_failure"
      /** Only before_publish permits settled funding to clear its reservation. */
      phase: "before_publish" | "after_publish"
      reason: string
      diagnostics?: WalletPaymentDiagnostic[]
    }

type PaymentRailDependencies = {
  walletPaymentCoordinator: Pick<WalletPaymentCoordinator, "payInvoice">
  hasWebLN: typeof hasWebLN
  weblnSendPayment: typeof weblnSendPayment
}

const defaultDependencies: PaymentRailDependencies = {
  walletPaymentCoordinator: marketWalletPaymentCoordinator,
  hasWebLN,
  weblnSendPayment,
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export async function payCheckoutInvoice(
  input: {
    invoice: string
    amountMsats: number
    /** Opaque local provider token. Never use a commerce order identifier. */
    walletPaymentAttemptId?: string
    paymentTarget: CheckoutPaymentTarget
    approveFee?: WalletPaymentFeeApproval
    beforeSend?: () => Promise<void>
    timeoutMs: number
    appId: ConduitAppId
    metadata?: Record<string, unknown>
  },
  dependencies: PaymentRailDependencies = defaultDependencies
): Promise<CheckoutInvoicePaymentResult> {
  if (input.paymentTarget.type === "wallet") {
    if (!input.walletPaymentAttemptId) {
      return {
        status: "retryable_failure",
        phase: "before_publish",
        reason: "Wallet payment attempt is missing an idempotency key.",
      }
    }
    const providerId = input.paymentTarget.providerId

    const result = await dependencies.walletPaymentCoordinator.payInvoice(
      {
        walletId: input.paymentTarget.walletId,
        providerId,
      },
      {
        invoice: input.invoice,
        amountMsats: input.amountMsats,
        idempotencyKey: input.walletPaymentAttemptId,
        timeoutMs: input.timeoutMs,
        appId: input.appId,
        metadata: input.metadata,
        approveFee: input.approveFee,
        beforeSend: input.beforeSend,
      }
    )
    if (result.status === "paid") {
      return {
        status: "paid",
        rail: "wallet",
        preimage: result.preimage,
        paymentHash: result.paymentHash,
        feeMsats: result.feeMsats,
      }
    }

    const diagnostic =
      result.status === "declined" ? undefined : result.diagnostics?.[0]

    if (result.status === "ambiguous") {
      throw new Error(`${result.reason} ${AMBIGUOUS_PAYMENT_WARNING}`)
    }
    const reason = diagnostic
      ? `${diagnostic.title}: ${diagnostic.action}`
      : result.reason
    return {
      status: "retryable_failure",
      phase: result.status === "failed" ? result.phase : "before_publish",
      reason,
      diagnostics:
        result.status === "declined" ? undefined : result.diagnostics,
    }
  }

  if (input.paymentTarget.type === "webln") {
    if (!dependencies.hasWebLN()) {
      return {
        status: "retryable_failure",
        phase: "before_publish",
        reason: "The selected browser wallet is unavailable.",
      }
    }

    try {
      const result = await dependencies.weblnSendPayment({
        invoice: input.invoice,
        beforeSend: input.beforeSend,
      })

      return {
        status: "paid",
        rail: "webln",
        preimage: result.preimage,
        paymentHash: result.paymentHash,
      }
    } catch (error) {
      const message = getErrorMessage(error, "Browser wallet payment failed")
      const phase = getWeblnPaymentFailurePhase(error)
      if (
        phase === "unavailable" ||
        phase === "enable" ||
        phase === "admission"
      ) {
        return {
          status: "retryable_failure",
          phase: "before_publish",
          reason: message,
        }
      }

      throw new Error(`${message} ${AMBIGUOUS_PAYMENT_WARNING}`, {
        cause: error,
      })
    }
  }

  return {
    status: "manual_required",
    reason: "No automatic Lightning payment rail is currently available.",
  }
}
