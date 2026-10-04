import { decodeLightningInvoicePaymentHash } from "./lightning"
import {
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
  type CheckoutSparkSettledPlan,
} from "./checkout-spark-settled-router"
import {
  classifyCheckoutSparkSettledPayment,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledProviderPayment,
} from "./checkout-spark-settled-outgoing"

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
    (plan.schemaVersion !== 3 && plan.schemaVersion !== 4) ||
    target.walletId !== plan.walletId ||
    target.network !== plan.network ||
    !recipient ||
    (plan.schemaVersion === 4 && recipient.kind === "conduit") ||
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
