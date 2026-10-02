import {
  deriveCheckoutSparkSettledTransferId,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
} from "./checkout-spark-merchant-settlement"

const HEX_64 = /^[0-9a-f]{64}$/
const invalid = (): never => {
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
  readonly schemaVersion: 1
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
    readonly transferId: string
    readonly allocationSats: number
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
    schemaVersion: 1,
    checkoutId: state.plan.checkoutId,
    planDigest: state.plan.planDigest,
    orderId: state.plan.orderId,
    merchantPubkey: state.plan.merchantPubkey,
    walletId: state.plan.walletId,
    commerceTotalSats: state.plan.commerceQuote.commerceTotalSats,
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
        transferId: deriveCheckoutSparkSettledTransferId(
          state.plan,
          recipient.legId
        ),
        allocationSats,
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
  ])
  if (
    value.schemaVersion !== 1 ||
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
    exactKeys(leg, ["legId", "kind", "transferId", "allocationSats"])
    if (
      !HEX_64.test(leg.legId) ||
      seen.has(leg.legId) ||
      !["merchant", "supplier", "organizer", "conduit"].includes(leg.kind) ||
      !validId(leg.transferId) ||
      !validAllocation(leg.allocationSats)
    )
      invalid()
    seen.add(leg.legId)
    if (leg.kind === "merchant") merchants += 1
    if (leg.kind === "conduit") fees += 1
  }
  if (merchants !== 1 || fees !== 1) invalid()
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
    legs: value.legs.map((leg) => ({ ...leg })),
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
  return record
}
