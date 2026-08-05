import {
  buildPaymentAttemptResultTelemetryProperties,
  classifyNwcPaymentError,
  getNwcErrorCode,
  getWeblnPaymentFailurePhase,
  hasWebLN,
  isNwcPrePublishDiagnosticCode,
  isNwcWalletRefusalErrorCode,
  isWeblnPreSubmitFailure,
  recordBrowserTelemetryEvent,
  weblnSendPayment,
  type ConduitAppId,
  type NwcDiagnostic,
  type NwcConnection,
  type ShopperPaymentRail,
} from "@conduit/core"
import {
  payInvoiceWithBuyerNwcSession,
  type NwcSessionPaymentResult,
} from "./buyer-nwc-session"

export type CheckoutPaymentRail = "nwc" | "webln"

/**
 * Marks an error whose payment outcome is unknown. `isAmbiguousPaymentError`
 * in the order payment service matches this exact sentence to stop a retry, so
 * both sides must read it from here.
 */
export const AMBIGUOUS_PAYMENT_WARNING =
  "Check your wallet before trying another payment path."

/**
 * Added when a wallet already held this invoice. A BOLT11 invoice can only
 * settle once, so re-presenting the same invoice is safe; requesting a new one
 * would not be.
 */
export const SAME_INVOICE_ONLY_WARNING =
  "Check your wallet before paying this same invoice again."

export function isAmbiguousCheckoutPaymentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes(AMBIGUOUS_PAYMENT_WARNING)
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
      diagnostics?: NwcDiagnostic[]
    }

export function getPreferredPaymentRailAttempts(
  preferredRail: ShopperPaymentRail,
  availability: { nwc: boolean; webln: boolean }
): {
  tryNwc: boolean
  tryWebln: boolean
  preferredAutomaticRail: CheckoutPaymentRail
} {
  if (preferredRail === "manual") {
    return {
      tryNwc: false,
      tryWebln: false,
      preferredAutomaticRail: "nwc",
    }
  }
  return {
    tryNwc: availability.nwc,
    tryWebln: availability.webln,
    preferredAutomaticRail: preferredRail === "webln" ? "webln" : "nwc",
  }
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

type WeblnFailureTreatment = "retry_other_rail" | "manual_only" | "ambiguous"

/**
 * How a WebLN failure may be recovered.
 *
 * Only a proven pre-submit failure may be handed to another rail. Once the
 * wallet held the invoice the outcome is unknown, so nothing retries
 * automatically - but the shopper may still settle that same invoice manually,
 * because a BOLT11 invoice cannot be settled twice. A wallet that reported
 * success without a preimage most likely paid, so nothing is offered.
 */
function getWeblnFailureTreatment(error: unknown): WeblnFailureTreatment {
  if (isWeblnPreSubmitFailure(error)) return "retry_other_rail"
  if (getWeblnPaymentFailurePhase(error) === "settled_without_proof") {
    return "ambiguous"
  }
  return "manual_only"
}

function isNwcPrePublishFailure(
  result: NwcSessionPaymentResult
): result is Extract<
  NwcSessionPaymentResult,
  { status: "pre_publish_failed" }
> {
  return result.status === "pre_publish_failed"
}

/**
 * Whether another rail or the manual invoice may reuse this invoice.
 *
 * Decided by the structured result rather than the wallet's message text: a
 * published request whose outcome is unknown must never be retried, and a
 * wallet error only clears the invoice when its NIP-47 code proves the wallet
 * refused before attempting payment.
 */
function isNwcSafeFallbackResult(result: NwcSessionPaymentResult): boolean {
  if (isNwcPrePublishFailure(result)) return true
  if (result.status !== "wallet_error") return false
  return isNwcWalletRefusalErrorCode(result.errorCode)
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
    preferredAutomaticRail?: CheckoutPaymentRail
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
  let attemptedWebln = false
  /** Set once a wallet has held this invoice, blocking every automatic rail. */
  let blockedAutomaticRails = false

  const attemptWebln =
    async (): Promise<CheckoutInvoicePaymentResult | null> => {
      if (
        attemptedWebln ||
        blockedAutomaticRails ||
        input.tryWebln === false ||
        !dependencies.hasWebLN()
      ) {
        return null
      }
      attemptedWebln = true
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
        const treatment = getWeblnFailureTreatment(error)
        recordPaymentAttemptResult({
          amountSats,
          latencyMs: Date.now() - startedAt,
          rail: "webln",
          status: treatment === "retry_other_rail" ? "failure" : "ambiguous",
        })
        if (treatment === "ambiguous") {
          throw new Error(`${message} ${AMBIGUOUS_PAYMENT_WARNING}`, {
            cause: error,
          })
        }
        if (treatment === "manual_only") {
          // The wallet held this invoice, so no rail may retry it. The same
          // invoice is still safe for the shopper to settle deliberately.
          blockedAutomaticRails = true
          failures.push(`${message} ${SAME_INVOICE_ONLY_WARNING}`)
          return null
        }
        failures.push(message)
        return null
      }
    }

  if (input.preferredAutomaticRail === "webln") {
    const result = await attemptWebln()
    if (result) return result
  }

  if (input.walletConnection && input.tryNwc && !blockedAutomaticRails) {
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
      const refusedWithoutAttempt = isNwcWalletRefusalErrorCode(
        getNwcErrorCode(error)
      )
      if (
        !refusedWithoutAttempt &&
        !isNwcPrePublishDiagnosticCode(diagnostic.code)
      ) {
        throw new Error(
          `${diagnostic.detail} ${diagnostic.action} ${AMBIGUOUS_PAYMENT_WARNING}`,
          { cause: error }
        )
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

      if (!isNwcSafeFallbackResult(result)) {
        throw new Error(`${result.reason} ${AMBIGUOUS_PAYMENT_WARNING}`)
      }

      diagnostics.push(diagnostic)
      failures.push(`${diagnostic.title}: ${diagnostic.action}`)
    }
  }

  const weblnResult = await attemptWebln()
  if (weblnResult) return weblnResult

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
