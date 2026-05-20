import {
  hasWebLN,
  nwcPayInvoice,
  weblnSendPayment,
  type ConduitAppId,
  type NwcConnection,
} from "@conduit/core"

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
    }

type PaymentRailDependencies = {
  nwcPayInvoice: typeof nwcPayInvoice
  hasWebLN: typeof hasWebLN
  weblnSendPayment: typeof weblnSendPayment
}

const defaultDependencies: PaymentRailDependencies = {
  nwcPayInvoice,
  hasWebLN,
  weblnSendPayment,
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function isNwcPrePaymentFailure(error: unknown): boolean {
  return getErrorMessage(error, "").includes("Failed to connect to NWC relay")
}

function isWeblnAmbiguousProofFailure(error: unknown): boolean {
  return getErrorMessage(error, "").includes("did not return a payment proof")
}

export async function payCheckoutInvoice(
  input: {
    invoice: string
    amountMsats: number
    walletConnection: NwcConnection | null
    preferNwc: boolean
    timeoutMs: number
    appId: ConduitAppId
    metadata?: Record<string, unknown>
  },
  dependencies: PaymentRailDependencies = defaultDependencies
): Promise<CheckoutInvoicePaymentResult> {
  const failures: string[] = []

  if (input.walletConnection && input.preferNwc) {
    try {
      const result = await dependencies.nwcPayInvoice(
        input.walletConnection,
        {
          invoice: input.invoice,
          amountMsats: input.amountMsats,
          metadata: input.metadata,
        },
        input.timeoutMs,
        input.appId
      )

      return {
        status: "paid",
        rail: "nwc",
        preimage: result.preimage,
        paymentHash: result.paymentHash,
        feeMsats: result.feeMsats,
      }
    } catch (error) {
      const message = getErrorMessage(error, "Connected wallet payment failed")
      if (!isNwcPrePaymentFailure(error)) {
        throw new Error(
          `${message} Check your wallet before trying another payment path.`
        )
      }
      failures.push(message)
    }
  }

  if (dependencies.hasWebLN()) {
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
          `${message} Check your wallet before trying another payment path.`
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
  }
}
