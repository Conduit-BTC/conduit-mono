import type { ConduitAppId } from "../protocol/nip89"
import type {
  WalletKind,
  WalletLifecycleStatus,
  WalletProviderId,
} from "./index"

export interface WalletProviderLifecycle {
  getStatus(walletId: string): WalletLifecycleStatus
  close(walletId: string): Promise<void>
}

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

export interface WalletBalanceResult {
  balanceMsats: number
}

export interface WalletBalanceCapability {
  (walletId: string): Promise<WalletBalanceResult>
}

export interface WalletReceiveInput {
  amountMsats?: number
  description?: string
  expirySeconds?: number
}

export interface WalletReceiveResult {
  paymentRequest: string
  feeMsats?: number
}

export interface WalletReceiveCapability {
  (walletId: string, input: WalletReceiveInput): Promise<WalletReceiveResult>
}

export interface WalletHistoryEntry {
  id: string
  direction: "send" | "receive"
  status: "completed" | "pending" | "failed"
  amountMsats: number
  feeMsats?: number
  createdAt: number
}

export interface WalletHistoryCapability {
  (walletId: string): Promise<WalletHistoryEntry[]>
}

interface WalletProvider {
  readonly providerId: WalletProviderId
  readonly kind: WalletKind
  readonly lifecycle: WalletProviderLifecycle
  readonly payInvoice?: WalletPayInvoiceCapability
  readonly balance?: WalletBalanceCapability
  readonly receive?: WalletReceiveCapability
  readonly history?: WalletHistoryCapability
}

export interface PortableWalletProvider extends WalletProvider {
  readonly kind: "portable"
}

export interface ConnectedWalletProvider extends WalletProvider {
  readonly kind: "connected"
}

export type RegisteredWalletProvider =
  PortableWalletProvider | ConnectedWalletProvider

export interface WalletPaymentTarget {
  walletId: string
  providerId: WalletProviderId
}
