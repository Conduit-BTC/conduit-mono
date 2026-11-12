import {
  type CheckoutSparkSettledPlan,
  deriveCheckoutSparkSettledRenewalTransferId,
  deriveCheckoutSparkSettledTransferId,
} from "./checkout-spark-settled-plan"
import type { CheckoutSparkSettledLegIntentInput as Intent } from "./checkout-spark-settled-router"
import { decodeLightningInvoicePaymentHash } from "./lightning"

export interface CheckoutSparkSettledOutgoingTarget {
  readonly generation?: 0 | 1
  readonly walletId: string
  readonly network: CheckoutSparkSettledPlan["network"]
  readonly legId: string
  readonly recipientId: string
  readonly allocationSats: number
  /** All unpaid allocations must remain reserved in the current wallet. */
  readonly unpaidAllocationSats: number
  readonly intent: Intent
}

interface CheckoutSparkSettledOutgoingObservationIdentity {
  readonly legId: string
  readonly transferId: string
  readonly paymentRequest: string
  readonly paymentHash: string
  readonly invoiceAmountSats: number
  readonly maxFeeSats: number
}

export type CheckoutSparkSettledOutgoingObservation =
  CheckoutSparkSettledOutgoingObservationIdentity &
    (
      | {
          readonly status:
            | "not_found"
            | "lookup_unavailable"
            | "conflicting_evidence"
            | "pending"
            | "terminal_failure"
        }
      | {
          readonly status: "paid"
          readonly finalFeeSats: number
          readonly finalDebitSats: number
        }
    )

/** The provider's payment fields needed for exact outgoing reconciliation. */
export interface CheckoutSparkSettledProviderPayment {
  readonly status: string
  readonly fees: unknown
  readonly details?: {
    readonly type: string
    readonly htlcDetails?: {
      readonly paymentHash: string
      readonly preimage?: string
    }
  }
}

function paymentObservation(
  target: CheckoutSparkSettledOutgoingTarget,
  status: CheckoutSparkSettledOutgoingObservation["status"],
  finalFeeSats?: number,
  finalDebitSats?: number
): CheckoutSparkSettledOutgoingObservation {
  const identity = {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
  }
  return status === "paid"
    ? {
        ...identity,
        status,
        finalFeeSats: finalFeeSats!,
        finalDebitSats: finalDebitSats!,
      }
    : { ...identity, status }
}

/** Require the exact provider-verified debit and invoice preimage for a paid leg. */
export async function classifyCheckoutSparkSettledPayment(
  payment: CheckoutSparkSettledProviderPayment,
  target: CheckoutSparkSettledOutgoingTarget,
  verifiedTransferTotalSats?: number
): Promise<CheckoutSparkSettledOutgoingObservation> {
  const fee = payment.fees
  if (
    payment.details?.type !== "lightning" ||
    typeof fee !== "bigint" ||
    fee < 0n ||
    fee > BigInt(target.intent.maxFeeSats)
  ) {
    return paymentObservation(target, "conflicting_evidence")
  }
  if (payment.status === "pending") return paymentObservation(target, "pending")
  if (payment.status === "failed") {
    return paymentObservation(target, "terminal_failure")
  }
  if (payment.status !== "completed") {
    return paymentObservation(target, "conflicting_evidence")
  }
  if (
    !Number.isSafeInteger(verifiedTransferTotalSats) ||
    verifiedTransferTotalSats !==
      target.intent.invoiceAmountSats + Number(fee) ||
    verifiedTransferTotalSats > target.allocationSats
  ) {
    return paymentObservation(target, "conflicting_evidence")
  }
  const htlc = payment.details.htlcDetails
  const preimageHex = htlc?.preimage
  if (
    !htlc ||
    htlc.paymentHash?.toLowerCase() !== target.intent.paymentHash ||
    !preimageHex ||
    !/^[0-9a-f]{64}$/i.test(preimageHex) ||
    !globalThis.crypto?.subtle
  ) {
    return paymentObservation(target, "conflicting_evidence")
  }
  const preimage = Uint8Array.from(preimageHex.match(/.{2}/g)!, (byte) =>
    Number.parseInt(byte, 16)
  )
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", preimage)
  )
  const actualHash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return actualHash === target.intent.paymentHash
    ? paymentObservation(target, "paid", Number(fee), verifiedTransferTotalSats)
    : paymentObservation(target, "conflicting_evidence")
}

/** The frozen SDK request is derived from the signed plan, never from UI state. */
export function requireCheckoutSparkSettledExactOutgoingRequest(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): {
  network: CheckoutSparkSettledPlan["network"]
  transferId: string
  paymentRequest: string
  amountSats: number
  maxFeeSats: number
} {
  const recipient = plan.recipients.find(
    (candidate) => candidate.legId === target.legId
  )
  if (
    (plan.schemaVersion !== 3 &&
      plan.schemaVersion !== 4 &&
      plan.schemaVersion !== 5) ||
    target.walletId !== plan.walletId ||
    target.network !== plan.network ||
    !recipient ||
    ((plan.schemaVersion === 4 || plan.schemaVersion === 5) &&
      recipient.kind === "conduit") ||
    target.recipientId !== recipient.recipientId ||
    target.intent.legId !== recipient.legId ||
    (target.generation !== undefined &&
      target.generation !== 0 &&
      target.generation !== 1) ||
    target.intent.transferId !==
      (target.generation === 1
        ? deriveCheckoutSparkSettledRenewalTransferId(plan, recipient.legId)
        : deriveCheckoutSparkSettledTransferId(plan, recipient.legId)) ||
    !Number.isSafeInteger(target.allocationSats) ||
    target.allocationSats <= 0 ||
    target.intent.invoiceAmountSats + target.intent.maxFeeSats !==
      target.allocationSats ||
    !Number.isSafeInteger(target.unpaidAllocationSats) ||
    target.unpaidAllocationSats < target.allocationSats ||
    target.unpaidAllocationSats > plan.funding.grossFundingSats ||
    decodeLightningInvoicePaymentHash(target.intent.paymentRequest) !==
      target.intent.paymentHash
  ) {
    throw new Error("Checkout Spark settled payout differs from its plan.")
  }
  return {
    network: plan.network,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    amountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
  }
}

export type CheckoutSparkSettledExactOutgoingHistory =
  | {
      readonly status:
        "not_found" | "lookup_unavailable" | "conflicting_evidence"
    }
  | {
      readonly status: "resolved"
      readonly payment: CheckoutSparkSettledProviderPayment
      readonly verifiedTransferTotalSats?: number
    }

export function checkoutSparkSettledOutgoingStatusObservation(
  target: CheckoutSparkSettledOutgoingTarget,
  status:
    "not_found" | "lookup_unavailable" | "conflicting_evidence" | "pending"
): CheckoutSparkSettledOutgoingObservation {
  return {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
    status,
  }
}

/** Incomplete history stays unavailable; a bare absence is never a receipt. */
export async function classifyCheckoutSparkSettledExactOutgoingHistory(
  target: CheckoutSparkSettledOutgoingTarget,
  history: CheckoutSparkSettledExactOutgoingHistory
): Promise<CheckoutSparkSettledOutgoingObservation> {
  return history.status === "resolved"
    ? classifyCheckoutSparkSettledPayment(
        history.payment,
        target,
        history.verifiedTransferTotalSats
      )
    : checkoutSparkSettledOutgoingStatusObservation(target, history.status)
}
