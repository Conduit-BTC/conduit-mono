import {
  deriveCheckoutSparkSettledTransferId,
  getCheckoutSparkSettledLegGeneration,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
} from "./checkout-spark-merchant-settlement"

const HEX_64 = /^[0-9a-f]{64}$/
function invalid(): never {
  throw new Error("Checkout Spark retained settlement binding is invalid.")
}
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value
const validSats = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
const validAllocation = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const exactKeys = (value: object, keys: readonly string[]): void => {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid()
}

/** Local account binding made only after the exact buyer order was delivered. */
export interface CheckoutSparkBuyerOrderBinding {
  readonly schemaVersion: 1
  readonly checkoutId: string
  readonly planDigest: string
  readonly orderId: string
  readonly merchantPubkey: string
  readonly buyerPubkey: string
  readonly walletId: string
  readonly commerceTotalSats: number
}

/** No wallet credential, invoice, destination, order body, or payment hash. */
export interface CheckoutSparkRetiredSettlementSummary {
  readonly schemaVersion: 1 | 2 | 3
  readonly nativeTreasury?: null | {
    readonly invoiceId: string
    readonly providerTransferId: string | null
    readonly principalSats: number
    readonly finalFeeSats: number | null
    readonly finalDebitSats: number | null
    readonly baseConduitAllocationSats: number
    readonly unusedCommerceReserveSats: number
    readonly authorizedDebitSats: number
    readonly accountingDigest: string
  }
  readonly checkoutId: string
  readonly planDigest: string
  readonly orderId: string
  readonly merchantPubkey: string
  readonly walletId: string
  readonly commerceTotalSats: number
  /** Frozen attribution reference, not proof that the provider credited funds. */
  readonly credit: null | {
    readonly transferId: string
    readonly creditedSats: number
  }
  readonly legs: readonly {
    readonly legId: string
    readonly kind: "merchant" | "supplier" | "organizer" | "conduit"
    readonly transferId: string | null
    readonly allocationSats: number
    readonly generation?: 0 | 1
    readonly closedTransferIds?: readonly string[]
    readonly historicalNetDebitSats?: 0
  }[]
}

export function restoreCheckoutSparkBuyerOrderBinding(
  value: CheckoutSparkBuyerOrderBinding
): CheckoutSparkBuyerOrderBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "schemaVersion",
    "checkoutId",
    "planDigest",
    "orderId",
    "merchantPubkey",
    "buyerPubkey",
    "walletId",
    "commerceTotalSats",
  ])
  if (
    value.schemaVersion !== 1 ||
    !validId(value.checkoutId) ||
    !HEX_64.test(value.planDigest) ||
    !validId(value.orderId) ||
    !HEX_64.test(value.merchantPubkey) ||
    !HEX_64.test(value.buyerPubkey) ||
    !validId(value.walletId) ||
    !validSats(value.commerceTotalSats)
  )
    invalid()
  return { ...value }
}

export function createCheckoutSparkRetiredSettlementSummary(
  input: CheckoutSparkSettledReconciliation
): CheckoutSparkRetiredSettlementSummary {
  const state = restoreCheckoutSparkSettledReconciliation(input)
  const summary: CheckoutSparkRetiredSettlementSummary = {
    schemaVersion:
      state.schemaVersion === 5 ? 3 : state.schemaVersion === 4 ? 2 : 1,
    checkoutId: state.plan.checkoutId,
    planDigest: state.plan.planDigest,
    orderId: state.plan.orderId,
    merchantPubkey: state.plan.merchantPubkey,
    walletId: state.plan.walletId,
    commerceTotalSats: state.plan.commerceQuote.commerceTotalSats,
    ...(state.schemaVersion === 5
      ? {
          nativeTreasury: state.treasuryFinalization!.intent
            ? {
                invoiceId: state.treasuryFinalization!.intent.invoiceId,
                providerTransferId:
                  state.treasuryFinalization!.providerTransferId,
                principalSats: state.treasuryFinalization!.intent.amountSats,
                finalFeeSats: state.treasuryFinalization!.finalFeeSats,
                finalDebitSats: state.treasuryFinalization!.finalDebitSats,
                baseConduitAllocationSats:
                  state.treasuryFinalization!.intent.baseConduitAllocationSats,
                unusedCommerceReserveSats:
                  state.treasuryFinalization!.intent.unusedCommerceReserveSats,
                authorizedDebitSats:
                  state.treasuryFinalization!.intent.authorizedDebitSats,
                accountingDigest:
                  state.treasuryFinalization!.intent.accountingDigest,
              }
            : null,
        }
      : {}),
    credit: state.credit
      ? {
          transferId: state.credit.transferId,
          creditedSats: state.credit.creditedSats,
        }
      : null,
    legs: state.plan.recipients.map((recipient) => {
      const leg = state.legs.find(
        (candidate) => candidate.legId === recipient.legId
      )
      const allocationSats = leg?.allocationSats
      if (!validAllocation(allocationSats)) {
        throw new Error("Checkout Spark retained allocation is invalid.")
      }
      return {
        legId: recipient.legId,
        kind: recipient.kind,
        transferId:
          state.schemaVersion === 5 && recipient.kind === "conduit"
            ? state.treasuryFinalization!.providerTransferId
            : state.schemaVersion !== 3 && leg?.intent
              ? leg.intent.transferId
              : deriveCheckoutSparkSettledTransferId(
                  state.plan,
                  recipient.legId
                ),
        allocationSats,
        ...(state.schemaVersion !== 3
          ? {
              generation: getCheckoutSparkSettledLegGeneration(leg!),
              closedTransferIds: (leg!.closedGenerations ?? []).map(
                (entry) => entry.intent.transferId
              ),
              historicalNetDebitSats: 0 as const,
            }
          : {}),
      }
    }),
  }
  return restoreCheckoutSparkRetiredSettlementSummary(summary)
}

export function restoreCheckoutSparkRetiredSettlementSummary(
  value: CheckoutSparkRetiredSettlementSummary
): CheckoutSparkRetiredSettlementSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "schemaVersion",
    "checkoutId",
    "planDigest",
    "orderId",
    "merchantPubkey",
    "walletId",
    "commerceTotalSats",
    "credit",
    "legs",
    ...(value.schemaVersion === 3 ? ["nativeTreasury"] : []),
  ])
  if (
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3) ||
    !validId(value.checkoutId) ||
    !HEX_64.test(value.planDigest) ||
    !validId(value.orderId) ||
    !HEX_64.test(value.merchantPubkey) ||
    !validId(value.walletId) ||
    !validSats(value.commerceTotalSats) ||
    !Array.isArray(value.legs) ||
    value.legs.length < 2
  )
    invalid()
  if (value.credit !== null) {
    if (
      !value.credit ||
      typeof value.credit !== "object" ||
      Array.isArray(value.credit)
    )
      invalid()
    exactKeys(value.credit, ["transferId", "creditedSats"])
    if (
      !validId(value.credit.transferId) ||
      !validSats(value.credit.creditedSats)
    )
      invalid()
  }
  const seen = new Set<string>()
  let merchants = 0
  let fees = 0
  for (const leg of value.legs) {
    if (!leg || typeof leg !== "object" || Array.isArray(leg)) invalid()
    exactKeys(leg, [
      "legId",
      "kind",
      "transferId",
      "allocationSats",
      ...(value.schemaVersion !== 1
        ? ["generation", "closedTransferIds", "historicalNetDebitSats"]
        : []),
    ])
    if (
      value.schemaVersion !== 1 &&
      (![0, 1].includes(leg.generation!) ||
        !Array.isArray(leg.closedTransferIds) ||
        leg.closedTransferIds.length !== leg.generation ||
        leg.historicalNetDebitSats !== 0 ||
        leg.closedTransferIds.some(
          (id: string) => !validId(id) || id === leg.transferId
        ) ||
        new Set(leg.closedTransferIds).size !== leg.closedTransferIds.length)
    )
      invalid()
    if (
      !HEX_64.test(leg.legId) ||
      seen.has(leg.legId) ||
      !["merchant", "supplier", "organizer", "conduit"].includes(leg.kind) ||
      !(value.schemaVersion === 3 && leg.kind === "conduit"
        ? leg.transferId === null || validId(leg.transferId)
        : validId(leg.transferId)) ||
      !validAllocation(leg.allocationSats)
    )
      invalid()
    seen.add(leg.legId)
    if (leg.kind === "merchant") merchants += 1
    if (leg.kind === "conduit") fees += 1
  }
  if (merchants !== 1 || fees !== 1) invalid()
  if (value.schemaVersion === 3) {
    const native = value.nativeTreasury
    const fee = value.legs.find((leg) => leg.kind === "conduit")!
    if (native === null) {
      if (fee.transferId !== null) invalid()
    } else {
      if (!native || typeof native !== "object" || Array.isArray(native))
        invalid()
      exactKeys(native, [
        "invoiceId",
        "providerTransferId",
        "principalSats",
        "finalFeeSats",
        "finalDebitSats",
        "baseConduitAllocationSats",
        "unusedCommerceReserveSats",
        "authorizedDebitSats",
        "accountingDigest",
      ])
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          native.invoiceId
        ) ||
        !HEX_64.test(native.accountingDigest) ||
        !validSats(native.principalSats) ||
        !validAllocation(native.baseConduitAllocationSats) ||
        !validAllocation(native.unusedCommerceReserveSats) ||
        native.authorizedDebitSats !== native.principalSats ||
        native.baseConduitAllocationSats + native.unusedCommerceReserveSats !==
          native.authorizedDebitSats ||
        native.baseConduitAllocationSats !== fee.allocationSats ||
        native.providerTransferId !== fee.transferId ||
        (native.providerTransferId !== null &&
          !validId(native.providerTransferId)) ||
        (native.finalFeeSats === null) !== (native.finalDebitSats === null) ||
        (native.finalFeeSats !== null &&
          (native.finalFeeSats !== 0 ||
            native.finalDebitSats !== native.principalSats ||
            !native.providerTransferId))
      )
        invalid()
    }
  }
  if (
    value.credit &&
    value.legs.reduce(
      (total, leg) => total + BigInt(leg.allocationSats),
      0n
    ) !== BigInt(value.credit.creditedSats)
  )
    invalid()
  return {
    ...value,
    credit: value.credit ? { ...value.credit } : null,
    legs: value.legs.map((leg) => ({
      ...leg,
      ...(value.schemaVersion !== 1
        ? { closedTransferIds: Object.freeze([...leg.closedTransferIds!]) }
        : {}),
    })),
    ...(value.schemaVersion === 3
      ? {
          nativeTreasury: value.nativeTreasury
            ? { ...value.nativeTreasury }
            : null,
        }
      : {}),
  }
}

/** Provider-only record must still agree with every retained frozen allocation. */
export function validateCheckoutSparkRetiredSettlementRecord(
  summaryInput: CheckoutSparkRetiredSettlementSummary,
  recordInput: CheckoutSparkMerchantSettlementRecord
): CheckoutSparkMerchantSettlementRecord {
  const summary = restoreCheckoutSparkRetiredSettlementSummary(summaryInput)
  const record = restoreCheckoutSparkMerchantSettlementRecord(recordInput)
  const merchant = summary.legs.find((leg) => leg.kind === "merchant")!
  const fee = summary.legs.find((leg) => leg.kind === "conduit")!
  const commerce = summary.legs.filter((leg) => leg.kind !== "conduit")
  if (
    record.checkoutId !== summary.checkoutId ||
    record.schemaVersion !== (summary.schemaVersion === 3 ? 2 : 1) ||
    record.planDigest !== summary.planDigest ||
    record.orderId !== summary.orderId ||
    record.merchantPubkey !== summary.merchantPubkey ||
    record.merchantLegId !== merchant.legId ||
    record.feeLegId !== fee.legId ||
    JSON.stringify(record.requiredCommerceLegIds) !==
      JSON.stringify(commerce.map((leg) => leg.legId)) ||
    (record.credit !== null &&
      (!summary.credit ||
        record.credit.transferId !== summary.credit.transferId ||
        record.credit.creditedSats !== summary.credit.creditedSats)) ||
    record.paidLegs.some(
      (paid) =>
        summary.legs.find((leg) => leg.legId === paid.legId)?.allocationSats !==
          paid.allocationSats ||
        summary.legs.find((leg) => leg.legId === paid.legId)?.transferId !==
          paid.transferId
    )
  )
    invalid()
  if (summary.schemaVersion === 3 && record.nativeTreasury) {
    const native = summary.nativeTreasury
    if (
      !native ||
      Object.entries(native).some(
        ([key, value]) =>
          record.nativeTreasury![key as keyof typeof record.nativeTreasury] !==
          value
      ) ||
      !record.credit ||
      !commerce.every((leg) =>
        record.paidLegs.some(
          (paid) => paid.legId === leg.legId && paid.recipientVerified === true
        )
      ) ||
      BigInt(record.credit.creditedSats) -
        record.paidLegs.reduce(
          (total, paid) => total + BigInt(paid.finalDebitSats),
          0n
        ) !==
        BigInt(record.nativeTreasury.finalDebitSats)
    )
      invalid()
  }
  return record
}
