import type { ConduitAppId } from "../protocol/nip89"
import type { WalletProviderId } from "./index"

export interface WalletPaymentFeeQuote {
  amountSats: number
  feeSats: number
  totalSats: number
}

export type WalletPaymentFeeApproval = (
  quote: WalletPaymentFeeQuote
) => Promise<boolean>

export interface WalletPaymentDiagnostic {
  title: string
  detail: string
  action: string
  code?: string
  severity?: "info" | "warning" | "error"
  relayHosts?: string[]
  safeManualFallback?: boolean
}

export interface WalletPayInvoiceInput {
  invoice: string
  amountMsats: number
  idempotencyKey: string
  timeoutMs: number
  appId: ConduitAppId
  metadata?: Record<string, unknown>
  approveFee?: WalletPaymentFeeApproval
}

export type WalletPayInvoiceResult =
  | {
      status: "paid"
      preimage: string
      paymentHash?: string
      feeMsats?: number
    }
  | {
      status: "declined"
      reason: string
    }
  | {
      /**
       * The provider definitively reported that funds did not move. Callers may
       * retry the same target or let the user explicitly choose another one.
       */
      status: "failed"
      phase: "before_publish" | "after_publish"
      reason: string
      diagnostics?: WalletPaymentDiagnostic[]
    }
  | {
      /**
       * Funds may have moved. Callers must not retry or change targets until
       * the result is reconciled against the selected wallet.
       */
      status: "ambiguous"
      reason: string
      diagnostics?: WalletPaymentDiagnostic[]
    }

export interface WalletPayInvoiceCapability {
  (
    walletId: string,
    input: WalletPayInvoiceInput
  ): Promise<WalletPayInvoiceResult>
}

export interface RegisteredWalletProvider {
  readonly providerId: WalletProviderId
  readonly payInvoice?: WalletPayInvoiceCapability
}

export interface WalletPaymentTarget {
  walletId: string
  providerId: WalletProviderId
}
