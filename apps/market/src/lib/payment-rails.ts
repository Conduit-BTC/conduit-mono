import {
  classifyNwcPaymentError,
  hasWebLN,
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
}

const defaultDependencies: PaymentRailDependencies = {
  nwcSessionPayInvoice: payInvoiceWithBuyerNwcSession,
  hasWebLN,
  weblnSendPayment,
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

  if (input.walletConnection && input.tryNwc) {
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
    try {
      const result = await dependencies.weblnSendPayment({
        invoice: input.invoice,
      })

      return {
        status: "paid",
        rail: "webln",
        preimage: result.preimage,
        paymentHash: result.paymentHash,
      }
    } catch (error) {
      const message = getErrorMessage(error, "Browser wallet payment failed")
      if (isWeblnAmbiguousProofFailure(error)) {
        throw new Error(
          `${message} Check your wallet before trying another payment path.`,
          { cause: error }
        )
      }
      failures.push(message)
    }
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
