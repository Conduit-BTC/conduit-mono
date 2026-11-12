import {
  type CheckoutSparkNativeTreasuryBudget,
  isCheckoutSparkNativeTreasuryPlan,
} from "./checkout-spark-treasury-model"
import {
  type CheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledPlan,
} from "./checkout-spark-settled-plan"

export function invalid(): never {
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

export function validTime(value: number): number {
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
  readonly schemaVersion: 1 | 2 | 3
  readonly nativeTreasury?: CheckoutSparkNativeTreasurySettlement | null
  readonly merchantPubkey: string
  readonly orderId: string
  readonly checkoutId: string
  readonly planDigest: string
  readonly merchantLegId: string | null
  /** V3 event records retain organizer evidence separately from goods settlement. */
  readonly organizerLegId?: string | null
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
  /** Informational receiver receipts; never establish this checkout's debit. */
  readonly receiverSettlementObserved?: boolean
  readonly receiverCommerceObserved?: boolean
}

/** Only validated V3 recipient kinds determine the required commerce legs. */
export function createCheckoutSparkMerchantSettlementRecord(
  plan: CheckoutSparkSettledPlan
): CheckoutSparkMerchantSettlementRecord {
  const canonical = restoreCheckoutSparkSettledPlan(plan)
  const merchant = canonical.recipients.find((leg) => leg.kind === "merchant")
  const fee = canonical.recipients.find((leg) => leg.kind === "conduit")!
  return {
    schemaVersion:
      canonical.schemaVersion === 5 ? 3 : canonical.schemaVersion === 4 ? 2 : 1,
    ...(isCheckoutSparkNativeTreasuryPlan(canonical)
      ? { nativeTreasury: null }
      : {}),
    ...(canonical.schemaVersion === 5
      ? {
          organizerLegId:
            canonical.recipients.find((leg) => leg.kind === "organizer")
              ?.legId ?? null,
        }
      : {}),
    merchantPubkey: canonical.merchantPubkey,
    orderId: canonical.orderId,
    checkoutId: canonical.checkoutId,
    planDigest: canonical.planDigest,
    merchantLegId: merchant?.legId ?? null,
    requiredCommerceLegIds: canonical.recipients
      .filter((leg) =>
        canonical.schemaVersion === 5
          ? leg.kind === "merchant" || leg.kind === "supplier"
          : leg.kind !== "conduit"
      )
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
    ...(record.schemaVersion === 2 || record.schemaVersion === 3
      ? ["nativeTreasury"]
      : []),
    ...(record.schemaVersion === 3 ? ["organizerLegId"] : []),
  ])
  if (
    (record.schemaVersion !== 1 &&
      record.schemaVersion !== 2 &&
      record.schemaVersion !== 3) ||
    typeof record.merchantPubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.merchantPubkey) ||
    typeof record.planDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.planDigest) ||
    !validId(record.orderId) ||
    !validId(record.checkoutId) ||
    !(record.schemaVersion === 3 && record.merchantLegId === null
      ? true
      : typeof record.merchantLegId === "string" &&
        /^[0-9a-f]{64}$/.test(record.merchantLegId)) ||
    (record.schemaVersion === 3 &&
      !(
        record.organizerLegId === null ||
        (typeof record.organizerLegId === "string" &&
          /^[0-9a-f]{64}$/.test(record.organizerLegId))
      )) ||
    typeof record.feeLegId !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.feeLegId) ||
    !Array.isArray(record.requiredCommerceLegIds) ||
    (record.merchantLegId === null
      ? record.schemaVersion !== 3 ||
        record.requiredCommerceLegIds.length !== 0 ||
        record.organizerLegId === null
      : record.requiredCommerceLegIds.length < 1 ||
        !record.requiredCommerceLegIds.includes(record.merchantLegId)) ||
    (record.schemaVersion === 3 &&
      record.organizerLegId !== null &&
      (record.organizerLegId === record.feeLegId ||
        record.requiredCommerceLegIds.includes(record.organizerLegId!))) ||
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
  if (
    (record.schemaVersion === 2 || record.schemaVersion === 3) &&
    record.nativeTreasury !== null
  )
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
      ((record.schemaVersion === 2 || record.schemaVersion === 3) &&
        leg.legId === record.feeLegId) ||
      (leg.legId !== record.feeLegId &&
        !record.requiredCommerceLegIds.includes(leg.legId) &&
        !(record.schemaVersion === 3 && leg.legId === record.organizerLegId)) ||
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
      record.organizerLegId !== expected.organizerLegId ||
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
    ...(record.schemaVersion === 2 || record.schemaVersion === 3
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
    merchantVerified:
      verified.merchantLegId === null
        ? creditVerified
        : attributed.has(verified.merchantLegId),
    commerceVerified:
      creditVerified &&
      verified.requiredCommerceLegIds.every((legId) => attributed.has(legId)),
    feePending:
      creditVerified &&
      (verified.schemaVersion === 2 || verified.schemaVersion === 3
        ? verified.nativeTreasury === null
        : !paid.has(verified.feeLegId)),
    recipientUnverified: verified.paidLegs.some(
      (leg) => leg.recipientVerified !== true
    ),
  }
}
