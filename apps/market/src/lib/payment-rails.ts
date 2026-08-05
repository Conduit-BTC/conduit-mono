import {
  buildPaymentAttemptResultTelemetryProperties,
  classifyNwcPaymentError,
  hasWebLN,
  recordBrowserTelemetryEvent,
  weblnSendPayment,
  type ConduitAppId,
  type NwcDiagnostic,
  type NwcConnection,
} from "@conduit/core"
import {
  payInvoiceWithBuyerNwcSession,
  type NwcSessionPaymentResult,
} from "./buyer-nwc-session"

export type CheckoutPaymentRail = "nwc" | "webln"

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
      diagnostics?: NwcDiagnostic[]
    }

type PaymentRailDependencies = {
  nwcSessionPayInvoice: typeof payInvoiceWithBuyerNwcSession
  hasWebLN: typeof hasWebLN
  weblnSendPayment: typeof weblnSendPayment
  recordPaymentAttemptResult?: (
    input: Parameters<typeof buildPaymentAttemptResultTelemetryProperties>[0]
  ) => void
}

const defaultDependencies: PaymentRailDependencies = {
  nwcSessionPayInvoice: payInvoiceWithBuyerNwcSession,
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

function isWeblnAmbiguousProofFailure(error: unknown): boolean {
  return getErrorMessage(error, "").includes("did not return a payment proof")
}

function isNwcPrePublishFailure(
  result: NwcSessionPaymentResult
): result is Extract<
  NwcSessionPaymentResult,
  { status: "pre_publish_failed" }
> {
  return result.status === "pre_publish_failed"
}

function getNwcDiagnosticTelemetryStatus(
  diagnostic: NwcDiagnostic
): "blocked" | "unavailable" | "ambiguous" {
  if (
    diagnostic.code === "permission_or_budget" ||
    diagnostic.code === "invoice_amount_mismatch" ||
    diagnostic.code === "network_mismatch"
  ) {
    return "blocked"
  }
  if (
    diagnostic.code === "invalid_uri" ||
    diagnostic.code === "private_relay" ||
    diagnostic.code === "non_wss_relay" ||
    diagnostic.code === "relay_unreachable" ||
    diagnostic.code === "unsupported_pay_invoice"
  ) {
    return "unavailable"
  }
  return "ambiguous"
}

export async function payCheckoutInvoice(
  input: {
    invoice: string
    amountMsats: number
    walletConnection: NwcConnection | null
    tryNwc: boolean
    tryWebln?: boolean
    timeoutMs: number
    appId: ConduitAppId
    metadata?: Record<string, unknown>
  },
  dependencies: PaymentRailDependencies = defaultDependencies
): Promise<CheckoutInvoicePaymentResult> {
  const failures: string[] = []
  const diagnostics: NwcDiagnostic[] = []
  const amountSats = input.amountMsats / 1_000
  const recordPaymentAttemptResult =
    dependencies.recordPaymentAttemptResult ?? recordMarketPaymentAttemptResult
  let attemptedAutomaticRail = false

  if (input.walletConnection && input.tryNwc) {
    attemptedAutomaticRail = true
    const startedAt = Date.now()
    let result: NwcSessionPaymentResult | null = null
    try {
      result = await dependencies.nwcSessionPayInvoice(input.walletConnection, {
        invoice: input.invoice,
        amountMsats: input.amountMsats,
        timeoutMs: input.timeoutMs,
        appId: input.appId,
        metadata: input.metadata,
      })
    } catch (error) {
      const diagnostic = classifyNwcPaymentError(error, input.walletConnection)
      recordPaymentAttemptResult({
        amountSats,
        latencyMs: Date.now() - startedAt,
        rail: "nwc",
        status: getNwcDiagnosticTelemetryStatus(diagnostic),
      })
      if (!diagnostic.safeManualFallback) {
        throw new Error(`${diagnostic.detail} ${diagnostic.action}`, {
          cause: error,
        })
      }
      diagnostics.push(diagnostic)
      failures.push(`${diagnostic.title}: ${diagnostic.action}`)
    }

    if (result) {
      if (result.status === "paid") {
        recordPaymentAttemptResult({
          amountSats,
          latencyMs: Date.now() - startedAt,
          rail: "nwc",
          status: "success",
        })
        return {
          status: "paid",
          rail: "nwc",
          preimage: result.preimage,
          paymentHash: result.paymentHash,
          feeMsats: result.feeMsats,
        }
      }

      const diagnostic = classifyNwcPaymentError(
        result.reason,
        input.walletConnection
      )
      recordPaymentAttemptResult({
        amountSats,
        latencyMs: Date.now() - startedAt,
        rail: "nwc",
        status:
          result.status === "pre_publish_failed"
            ? "unavailable"
            : result.status === "published_timeout"
              ? "ambiguous"
              : getNwcDiagnosticTelemetryStatus(diagnostic),
      })

      if (!isNwcPrePublishFailure(result) && !diagnostic.safeManualFallback) {
        throw new Error(
          `${result.reason} Check your wallet before trying another payment path.`
        )
      }

      diagnostics.push(diagnostic)
      failures.push(`${diagnostic.title}: ${diagnostic.action}`)
    }
  }

  if (input.tryWebln !== false && dependencies.hasWebLN()) {
    attemptedAutomaticRail = true
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
      recordPaymentAttemptResult({
        amountSats,
        latencyMs: Date.now() - startedAt,
        rail: "webln",
        status: isWeblnAmbiguousProofFailure(error) ? "ambiguous" : "failure",
      })
      if (isWeblnAmbiguousProofFailure(error)) {
        throw new Error(
          `${message} Check your wallet before trying another payment path.`,
          { cause: error }
        )
      }
      failures.push(message)
    }
  }

  if (!attemptedAutomaticRail) {
    recordPaymentAttemptResult({
      amountSats,
      rail: "none",
      status: "unavailable",
    })
  }

  return {
    status: "manual_required",
    reason:
      failures.length > 0
        ? failures.join(" ")
        : "No automatic Lightning payment rail is currently available.",
    ...(diagnostics.length > 0 && { diagnostics }),
  }
}
