import type { SparkCheckoutReceiveCreditProof } from "./checkout-spark-receive-credit"
import {
  createCheckoutSparkSettledReconciliation,
  recordCheckoutSparkSettledCredit,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  deriveCheckoutSparkNativeTreasuryBudget,
  type CheckoutSparkNativeTreasuryEvidence,
  type CheckoutSparkNativeTreasuryBudget,
} from "./checkout-spark-treasury-finalization"
import type {
  CheckoutSparkSettledOutgoingObservation,
  CheckoutSparkSettledOutgoingTarget,
} from "./checkout-spark-settled-outgoing"
import { requireCheckoutSparkSettledExactOutgoingRequest } from "./checkout-spark-settled-outgoing-history"
import {
  hasCheckoutSparkInvoiceOrigin,
  type CheckoutSparkInvoiceOriginRecord,
} from "./checkout-spark-invoice-origin"
import {
  hasCheckoutSparkInvoiceRecipient,
  type CheckoutSparkInvoiceRecipientRecord,
} from "./checkout-spark-invoice-recipient"

function invalid(): never {
  throw new Error("Checkout Spark merchant settlement evidence is invalid.")
}

function exactKeys(value: object, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    invalid()
  }
}

function validTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function validSats(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalid()
  return value
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  )
}

/** Private device-local provider facts; never send this record to Nostr or telemetry. */
export interface CheckoutSparkMerchantSettlementRecord {
  readonly schemaVersion: 1 | 2
  readonly nativeTreasury?: CheckoutSparkNativeTreasurySettlement | null
  readonly merchantPubkey: string
  readonly orderId: string
  readonly checkoutId: string
  readonly planDigest: string
  readonly merchantLegId: string
  readonly requiredCommerceLegIds: readonly string[]
  readonly feeLegId: string
  readonly credit: null | {
    readonly transferId: string
    readonly creditedSats: number
    readonly observedAt: number
  }
  readonly paidLegs: readonly {
    readonly legId: string
    readonly transferId: string
    readonly allocationSats: number
    readonly finalDebitSats: number
    readonly finalFeeSats: number
    readonly observedAt: number
    /** Exact invoice has independently verified frozen-recipient attribution. */
    readonly recipientVerified?: true
  }[]
}

/** Native principal and actual debit, without invoice/address/recovery material. */
export interface CheckoutSparkNativeTreasurySettlement extends CheckoutSparkNativeTreasuryBudget {
  readonly invoiceId: string
  readonly providerTransferId: string
  readonly principalSats: number
  readonly finalDebitSats: number
  readonly finalFeeSats: 0
  readonly observedAt: number
}

export function restoreCheckoutSparkNativeTreasurySettlement(
  value: CheckoutSparkNativeTreasurySettlement
): CheckoutSparkNativeTreasurySettlement {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "invoiceId",
    "providerTransferId",
    "principalSats",
    "finalDebitSats",
    "finalFeeSats",
    "observedAt",
    "baseConduitAllocationSats",
    "unusedCommerceReserveSats",
    "authorizedDebitSats",
    "accountingDigest",
  ])
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.invoiceId
    ) ||
    !validId(value.providerTransferId) ||
    !/^[0-9a-f]{64}$/.test(value.accountingDigest) ||
    !Number.isSafeInteger(value.baseConduitAllocationSats) ||
    value.baseConduitAllocationSats < 0 ||
    !Number.isSafeInteger(value.unusedCommerceReserveSats) ||
    value.unusedCommerceReserveSats < 0 ||
    validSats(value.principalSats) !== validSats(value.finalDebitSats) ||
    value.finalFeeSats !== 0 ||
    value.authorizedDebitSats !== value.finalDebitSats ||
    value.baseConduitAllocationSats + value.unusedCommerceReserveSats !==
      value.authorizedDebitSats
  )
    invalid()
  validTime(value.observedAt)
  return Object.freeze({ ...value })
}

export interface CheckoutSparkMerchantSettlementProjection {
  readonly creditVerified: boolean
  readonly merchantVerified: boolean
  readonly commerceVerified: boolean
  readonly feePending: boolean
  readonly recipientUnverified?: boolean
}

/** Only validated V3 recipient kinds determine the required commerce legs. */
export function createCheckoutSparkMerchantSettlementRecord(
  plan: CheckoutSparkSettledPlan
): CheckoutSparkMerchantSettlementRecord {
  const canonical = restoreCheckoutSparkSettledPlan(plan)
  const merchant = canonical.recipients.find((leg) => leg.kind === "merchant")!
  const fee = canonical.recipients.find((leg) => leg.kind === "conduit")!
  return {
    schemaVersion: canonical.schemaVersion === 4 ? 2 : 1,
    ...(canonical.schemaVersion === 4 ? { nativeTreasury: null } : {}),
    merchantPubkey: canonical.merchantPubkey,
    orderId: canonical.orderId,
    checkoutId: canonical.checkoutId,
    planDigest: canonical.planDigest,
    merchantLegId: merchant.legId,
    requiredCommerceLegIds: canonical.recipients
      .filter((leg) => leg.kind !== "conduit")
      .map((leg) => leg.legId),
    feeLegId: fee.legId,
    credit: null,
    paidLegs: [],
  }
}

/** Validate the persisted allowlist before it can authorize a projection. */
export function restoreCheckoutSparkMerchantSettlementRecord(
  record: CheckoutSparkMerchantSettlementRecord,
  plan?: CheckoutSparkSettledPlan
): CheckoutSparkMerchantSettlementRecord {
  if (!record || typeof record !== "object") invalid()
  exactKeys(record, [
    "schemaVersion",
    "merchantPubkey",
    "orderId",
    "checkoutId",
    "planDigest",
    "merchantLegId",
    "requiredCommerceLegIds",
    "feeLegId",
    "credit",
    "paidLegs",
    ...(record.schemaVersion === 2 ? ["nativeTreasury"] : []),
  ])
  if (
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
    typeof record.merchantPubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.merchantPubkey) ||
    typeof record.planDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.planDigest) ||
    !validId(record.orderId) ||
    !validId(record.checkoutId) ||
    typeof record.merchantLegId !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.merchantLegId) ||
    typeof record.feeLegId !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.feeLegId) ||
    !Array.isArray(record.requiredCommerceLegIds) ||
    record.requiredCommerceLegIds.length < 1 ||
    !record.requiredCommerceLegIds.includes(record.merchantLegId) ||
    record.requiredCommerceLegIds.includes(record.feeLegId) ||
    new Set(record.requiredCommerceLegIds).size !==
      record.requiredCommerceLegIds.length ||
    record.requiredCommerceLegIds.some(
      (id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)
    ) ||
    !Array.isArray(record.paidLegs) ||
    record.paidLegs.length > record.requiredCommerceLegIds.length + 1 ||
    (record.credit !== null &&
      (typeof record.credit !== "object" || Array.isArray(record.credit)))
  ) {
    invalid()
  }
  if (record.schemaVersion === 2 && record.nativeTreasury !== null)
    restoreCheckoutSparkNativeTreasurySettlement(record.nativeTreasury!)
  if (record.credit) {
    exactKeys(record.credit, ["transferId", "creditedSats", "observedAt"])
    if (!validId(record.credit.transferId)) {
      invalid()
    }
    validSats(record.credit.creditedSats)
    validTime(record.credit.observedAt)
  }
  const ids = new Set<string>()
  for (const leg of record.paidLegs) {
    if (!leg || typeof leg !== "object") invalid()
    exactKeys(leg, [
      "legId",
      "transferId",
      "allocationSats",
      "finalDebitSats",
      "finalFeeSats",
      "observedAt",
      ...(leg.recipientVerified === undefined ? [] : ["recipientVerified"]),
    ])
    if (
      (record.schemaVersion === 2 && leg.legId === record.feeLegId) ||
      (leg.legId !== record.feeLegId &&
        !record.requiredCommerceLegIds.includes(leg.legId)) ||
      ids.has(leg.legId) ||
      !validId(leg.transferId) ||
      validSats(leg.allocationSats) < validSats(leg.finalDebitSats) ||
      !Number.isSafeInteger(leg.finalFeeSats) ||
      leg.finalFeeSats < 0 ||
      leg.finalFeeSats >= leg.finalDebitSats ||
      (leg.recipientVerified !== undefined && leg.recipientVerified !== true)
    ) {
      invalid()
    }
    validTime(leg.observedAt)
    ids.add(leg.legId)
  }
  if (plan) {
    const expected = createCheckoutSparkMerchantSettlementRecord(plan)
    if (
      record.merchantPubkey !== expected.merchantPubkey ||
      record.schemaVersion !== expected.schemaVersion ||
      record.orderId !== expected.orderId ||
      record.checkoutId !== expected.checkoutId ||
      record.planDigest !== expected.planDigest ||
      record.merchantLegId !== expected.merchantLegId ||
      record.feeLegId !== expected.feeLegId ||
      JSON.stringify(record.requiredCommerceLegIds) !==
        JSON.stringify(expected.requiredCommerceLegIds)
    ) {
      invalid()
    }
  }
  return {
    ...record,
    requiredCommerceLegIds: [...record.requiredCommerceLegIds],
    credit: record.credit ? { ...record.credit } : null,
    paidLegs: record.paidLegs.map((leg) => ({ ...leg })),
    ...(record.schemaVersion === 2
      ? {
          nativeTreasury: record.nativeTreasury
            ? restoreCheckoutSparkNativeTreasurySettlement(
                record.nativeTreasury
              )
            : null,
        }
      : {}),
  }
}

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
      recipient.legId !== current.feeLegId) ||
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
    ...(hasCheckoutSparkInvoiceOrigin(invoiceOrigin, plan, target) ||
    hasCheckoutSparkInvoiceRecipient(invoiceRecipient, plan, target)
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

/** A buyer-signed paid claim is intentionally not an input to this projection. */
export function projectCheckoutSparkMerchantSettlement(
  record: CheckoutSparkMerchantSettlementRecord
): CheckoutSparkMerchantSettlementProjection {
  const verified = restoreCheckoutSparkMerchantSettlementRecord(record)
  const paid = new Set(verified.paidLegs.map((leg) => leg.legId))
  const attributed = new Set(
    verified.paidLegs
      .filter((leg) => leg.recipientVerified === true)
      .map((leg) => leg.legId)
  )
  const creditVerified = verified.credit !== null
  return {
    creditVerified,
    merchantVerified: attributed.has(verified.merchantLegId),
    commerceVerified:
      creditVerified &&
      verified.requiredCommerceLegIds.every((legId) => attributed.has(legId)),
    feePending:
      creditVerified &&
      (verified.schemaVersion === 2
        ? verified.nativeTreasury === null
        : !paid.has(verified.feeLegId)),
    recipientUnverified: verified.paidLegs.some(
      (leg) => leg.recipientVerified !== true
    ),
  }
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
    record.schemaVersion !== 2 ||
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
