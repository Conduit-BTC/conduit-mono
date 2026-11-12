import {
  type CheckoutSparkMerchantSettlementRecord,
  restoreCheckoutSparkMerchantSettlementRecord,
  invalid,
  validTime,
  restoreCheckoutSparkNativeTreasurySettlement,
  type CheckoutSparkNativeTreasurySettlement,
} from "./checkout-spark-merchant-settlement-model"
import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-plan"
import type { SparkCheckoutReceiveCreditProof } from "./checkout-spark-receive-credit"
import {
  recordCheckoutSparkSettledCredit,
  createCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
  restoreCheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledOutgoingObservation,
  requireCheckoutSparkSettledExactOutgoingRequest,
} from "./checkout-spark-settled-outgoing-history"
import {
  type CheckoutSparkInvoiceOriginRecord,
  hasCheckoutSparkInvoiceOrigin,
} from "./checkout-spark-invoice-origin"
import {
  type CheckoutSparkInvoiceRecipientRecord,
  hasCheckoutSparkInvoiceRecipientSettlement,
  hasCheckoutSparkInvoiceRecipient,
} from "./checkout-spark-invoice-recipient"
import {
  type CheckoutSparkNativeTreasuryEvidence,
  deriveCheckoutSparkNativeTreasuryBudget,
} from "./checkout-spark-treasury-finalization"

export {
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkNativeTreasurySettlement,
  restoreCheckoutSparkNativeTreasurySettlement,
  type CheckoutSparkMerchantSettlementProjection,
  createCheckoutSparkMerchantSettlementRecord,
  restoreCheckoutSparkMerchantSettlementRecord,
  projectCheckoutSparkMerchantSettlement,
} from "./checkout-spark-merchant-settlement-model"

/** Input must be the result of the exact Spark receive provider proof seam. */
export function recordCheckoutSparkMerchantCredit(
  record: CheckoutSparkMerchantSettlementRecord,
  plan: CheckoutSparkSettledPlan,
  proof: SparkCheckoutReceiveCreditProof,
  observedAt: number
): CheckoutSparkMerchantSettlementRecord {
  const current = restoreCheckoutSparkMerchantSettlementRecord(record, plan)
  if (proof.mode !== "ordinary_v3") invalid()
  const verified = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: proof.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: proof.transferId,
      receiverIdentityPublicKey: proof.receiverIdentityPublicKey,
      grossSats: proof.grossSats,
      creditedSats: proof.creditedSats,
      observedAt: validTime(observedAt),
    }
  )
  const credit = verified.credit!
  for (const paid of current.paidLegs) {
    const expected = verified.legs.find((leg) => leg.legId === paid.legId)
    if (expected?.allocationSats !== paid.allocationSats) invalid()
  }
  if (current.credit) {
    if (
      current.credit.transferId !== credit.transferId ||
      current.credit.creditedSats !== credit.creditedSats
    ) {
      invalid()
    }
    return current
  }
  return {
    ...current,
    credit: {
      transferId: credit.transferId,
      creditedSats: credit.creditedSats,
      observedAt: credit.observedAt,
    },
  }
}

/** Input observation must come from exact provider history, never buyer state.paid. */
export function recordCheckoutSparkMerchantPayout(
  record: CheckoutSparkMerchantSettlementRecord,
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget,
  observation: CheckoutSparkSettledOutgoingObservation,
  observedAt: number,
  invoiceOrigin?: CheckoutSparkInvoiceOriginRecord,
  invoiceRecipient?: CheckoutSparkInvoiceRecipientRecord
): CheckoutSparkMerchantSettlementRecord {
  const current = restoreCheckoutSparkMerchantSettlementRecord(record, plan)
  const exact = requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
  const recipient = plan.recipients.find((leg) => leg.legId === target.legId)
  if (observation.status !== "paid") {
    throw new Error("Checkout Spark merchant settlement evidence is invalid.")
  }
  if (
    !recipient ||
    (!current.requiredCommerceLegIds.includes(recipient.legId) &&
      recipient.legId !== current.feeLegId &&
      !(
        current.schemaVersion === 3 &&
        recipient.legId === current.organizerLegId
      )) ||
    observation.legId !== target.legId ||
    observation.transferId !== exact.transferId ||
    observation.paymentRequest !== exact.paymentRequest ||
    observation.paymentHash !== target.intent.paymentHash ||
    observation.invoiceAmountSats !== exact.amountSats ||
    observation.maxFeeSats !== exact.maxFeeSats ||
    !Number.isSafeInteger(observation.finalFeeSats) ||
    observation.finalFeeSats < 0 ||
    observation.finalFeeSats > exact.maxFeeSats ||
    observation.finalDebitSats !==
      exact.amountSats + observation.finalFeeSats ||
    observation.finalDebitSats > target.allocationSats ||
    observedAt < target.intent.preparedAt
  ) {
    invalid()
  }
  validTime(observedAt)
  if (current.credit) {
    const allocation = recordCheckoutSparkSettledCredit(
      createCheckoutSparkSettledReconciliation(plan),
      {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: current.credit.transferId,
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: plan.funding.grossFundingSats,
        creditedSats: current.credit.creditedSats,
        observedAt: current.credit.observedAt,
      }
    ).legs.find((leg) => leg.legId === target.legId)?.allocationSats
    if (allocation !== target.allocationSats) invalid()
  }
  const next = {
    legId: target.legId,
    transferId: exact.transferId,
    allocationSats: target.allocationSats,
    finalDebitSats: observation.finalDebitSats,
    finalFeeSats: observation.finalFeeSats,
    observedAt,
    ...((
      target.intent.receiverBinding
        ? hasCheckoutSparkInvoiceRecipientSettlement(
            invoiceRecipient,
            plan,
            target
          )
        : hasCheckoutSparkInvoiceOrigin(invoiceOrigin, plan, target) ||
          hasCheckoutSparkInvoiceRecipient(invoiceRecipient, plan, target)
    )
      ? { recipientVerified: true as const }
      : {}),
  }
  const previous = current.paidLegs.find((leg) => leg.legId === target.legId)
  if (previous) {
    if (
      previous.transferId !== next.transferId ||
      previous.allocationSats !== next.allocationSats ||
      previous.finalDebitSats !== next.finalDebitSats ||
      previous.finalFeeSats !== next.finalFeeSats
    ) {
      invalid()
    }
    return next.recipientVerified && !previous.recipientVerified
      ? {
          ...current,
          paidLegs: current.paidLegs.map((leg) =>
            leg.legId === next.legId
              ? { ...leg, recipientVerified: true as const }
              : leg
          ),
        }
      : current
  }
  return { ...current, paidLegs: [...current.paidLegs, next] }
}

/** Evidence must come from exact native provider invoice + transfer history. */
export function recordCheckoutSparkMerchantTreasury(
  recordInput: CheckoutSparkMerchantSettlementRecord,
  stateInput: CheckoutSparkSettledReconciliation,
  evidence: CheckoutSparkNativeTreasuryEvidence
): CheckoutSparkMerchantSettlementRecord {
  const state = restoreCheckoutSparkSettledReconciliation(stateInput)
  const record = restoreCheckoutSparkMerchantSettlementRecord(
    recordInput,
    state.plan
  )
  const intent = state.treasuryFinalization?.intent
  const budget = deriveCheckoutSparkNativeTreasuryBudget(state, record)
  if (
    (record.schemaVersion !== 2 && record.schemaVersion !== 3) ||
    !intent ||
    evidence.status !== "paid" ||
    evidence.invoiceId !== intent.invoiceId ||
    !evidence.providerTransferId ||
    evidence.finalFeeSats !== 0 ||
    evidence.finalDebitSats !== intent.amountSats ||
    evidence.observedAt < intent.preparedAt ||
    intent.accountingDigest !== budget.accountingDigest
  )
    invalid()
  const next = restoreCheckoutSparkNativeTreasurySettlement({
    invoiceId: intent.invoiceId,
    providerTransferId: evidence.providerTransferId,
    principalSats: intent.amountSats,
    finalDebitSats: evidence.finalDebitSats,
    finalFeeSats: 0,
    observedAt: evidence.observedAt,
    baseConduitAllocationSats: intent.baseConduitAllocationSats,
    unusedCommerceReserveSats: intent.unusedCommerceReserveSats,
    authorizedDebitSats: intent.authorizedDebitSats,
    accountingDigest: intent.accountingDigest,
  })
  if (record.nativeTreasury) {
    if (
      Object.entries(next).some(
        ([key, value]) =>
          key !== "observedAt" &&
          record.nativeTreasury![
            key as keyof CheckoutSparkNativeTreasurySettlement
          ] !== value
      )
    )
      invalid()
    return record
  }
  return { ...record, nativeTreasury: next }
}
