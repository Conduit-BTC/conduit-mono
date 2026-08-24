import {
  buildPaymentAttemptResultTelemetryProperties,
  getWeblnPaymentFailurePhase,
  hasWebLN,
  recordBrowserTelemetryEvent,
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
      reason: string
      diagnostics?: WalletPaymentDiagnostic[]
    }

type PaymentRailDependencies = {
  walletPaymentCoordinator: Pick<WalletPaymentCoordinator, "payInvoice">
  hasWebLN: typeof hasWebLN
  weblnSendPayment: typeof weblnSendPayment
  recordPaymentAttemptResult?: (
    input: Parameters<typeof buildPaymentAttemptResultTelemetryProperties>[0]
  ) => void
}

const defaultDependencies: PaymentRailDependencies = {
  walletPaymentCoordinator: marketWalletPaymentCoordinator,
  hasWebLN,
  weblnSendPayment,
}

function recordMarketPaymentAttemptResult(
  input: Parameters<typeof buildPaymentAttemptResultTelemetryProperties>[0]
): void {
  recordBrowserTelemetryEvent({
    app: "market",
    eventName: "payment_attempt_result",
    properties: buildPaymentAttemptResultTelemetryProperties(input),
  })
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function getWalletDiagnosticTelemetryStatus(
  diagnostic: WalletPaymentDiagnostic
): "blocked" | "unavailable" | "ambiguous" {
  if (diagnostic.safeManualFallback === false) return "ambiguous"
  return /amount|budget|permission|network|rejected/i.test(diagnostic.title)
    ? "blocked"
    : "unavailable"
}

export async function payCheckoutInvoice(
  input: {
    invoice: string
    amountMsats: number
    /** Opaque local provider token. Never use a commerce order identifier. */
    walletPaymentAttemptId?: string
    paymentTarget: CheckoutPaymentTarget
    approveFee?: WalletPaymentFeeApproval
    timeoutMs: number
    appId: ConduitAppId
    metadata?: Record<string, unknown>
  },
  dependencies: PaymentRailDependencies = defaultDependencies
): Promise<CheckoutInvoicePaymentResult> {
  const amountSats = input.amountMsats / 1_000
  const recordPaymentAttemptResult =
    dependencies.recordPaymentAttemptResult ?? recordMarketPaymentAttemptResult

  if (input.paymentTarget.type === "wallet") {
    if (!input.walletPaymentAttemptId) {
      return {
        status: "retryable_failure",
        reason: "Wallet payment attempt is missing an idempotency key.",
      }
    }
    const providerId = input.paymentTarget.providerId
    const startedAt = Date.now()
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
      }
    )
    if (result.status === "paid") {
      recordPaymentAttemptResult({
        amountSats,
        latencyMs: Date.now() - startedAt,
        rail: "wallet",
        status: "success",
      })
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
    const telemetryStatus =
      result.status === "declined"
        ? "blocked"
        : result.status === "ambiguous"
          ? "ambiguous"
          : diagnostic
            ? getWalletDiagnosticTelemetryStatus(diagnostic)
            : result.phase === "before_publish"
              ? "unavailable"
              : "failure"
    recordPaymentAttemptResult({
      amountSats,
      latencyMs: Date.now() - startedAt,
      rail: "wallet",
      status: telemetryStatus,
    })

    if (result.status === "ambiguous") {
      throw new Error(`${result.reason} ${AMBIGUOUS_PAYMENT_WARNING}`)
    }
    const reason = diagnostic
      ? `${diagnostic.title}: ${diagnostic.action}`
      : result.reason
    return {
      status: "retryable_failure",
      reason,
      diagnostics:
        result.status === "declined" ? undefined : result.diagnostics,
    }
  }

  if (input.paymentTarget.type === "webln") {
    if (!dependencies.hasWebLN()) {
      recordPaymentAttemptResult({
        amountSats,
        rail: "webln",
        status: "unavailable",
      })
      return {
        status: "retryable_failure",
        reason: "The selected browser wallet is unavailable.",
      }
    }
    const startedAt = Date.now()
    try {
      const result = await dependencies.weblnSendPayment({
        invoice: input.invoice,
      })

      recordPaymentAttemptResult({
        amountSats,
        latencyMs: Date.now() - startedAt,
        rail: "webln",
        status: "success",
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
      if (phase === "unavailable" || phase === "enable") {
        recordPaymentAttemptResult({
          amountSats,
          latencyMs: Date.now() - startedAt,
          rail: "webln",
          status: phase === "unavailable" ? "unavailable" : "failure",
        })
        return {
          status: "retryable_failure",
          reason: message,
        }
      }
      recordPaymentAttemptResult({
        amountSats,
        latencyMs: Date.now() - startedAt,
        rail: "webln",
        status: "ambiguous",
      })
      throw new Error(`${message} ${AMBIGUOUS_PAYMENT_WARNING}`, {
        cause: error,
      })
    }
  }

  recordPaymentAttemptResult({
    amountSats,
    rail: "none",
    status: "unavailable",
  })

  return {
    status: "manual_required",
    reason: "No automatic Lightning payment rail is currently available.",
  }
}
