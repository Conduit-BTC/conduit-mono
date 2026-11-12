import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-plan"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"
import type {
  CheckoutSparkSettledLegStatus,
  CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import { bytesToHex } from "@noble/hashes/utils.js"
import { sha256 } from "@noble/hashes/sha2.js"

/** Native final collection is shared by ordinary v4 and event v5 plans. */
export function isCheckoutSparkNativeTreasuryPlan(
  plan: Pick<CheckoutSparkSettledPlan, "schemaVersion">
): boolean {
  return plan.schemaVersion === 4 || plan.schemaVersion === 5
}

export interface CheckoutSparkNativeTreasuryPlan {
  readonly schemaVersion: 1
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey: string
  readonly senderIdentityPublicKey: string
  readonly invoiceId: string
  /** Canonical unsigned, sender-restricted, open-amount sats invoice. */
  readonly invoiceRequest: string
  readonly feePolicy: "zero_required"
  readonly residualPolicy: "unused_commerce_reserves"
}

export interface CheckoutSparkNativeTreasuryInvoiceIdInput {
  readonly checkoutId: string
  readonly orderId: string
  readonly walletId: string
  readonly network: CheckoutSparkNetwork
  readonly createdAt: number
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey: string
  readonly senderIdentityPublicKey: string
}

export interface CheckoutSparkNativeTreasuryBudget {
  readonly baseConduitAllocationSats: number
  readonly unusedCommerceReserveSats: number
  readonly authorizedDebitSats: number
  readonly accountingDigest: string
}

export interface CheckoutSparkNativeTreasuryIntent extends CheckoutSparkNativeTreasuryBudget {
  readonly invoiceId: string
  readonly invoiceRequest: string
  readonly amountSats: number
  readonly preparedAt: number
}

export interface CheckoutSparkNativeTreasuryFinalization {
  readonly intent: CheckoutSparkNativeTreasuryIntent | null
  readonly status: CheckoutSparkSettledLegStatus
  /** Actual provider ID learned from exact invoice/history reconciliation. */
  readonly providerTransferId: string | null
  readonly observedAt: number | null
  readonly finalFeeSats: number | null
  readonly finalDebitSats: number | null
}

export function invalid(): never {
  throw new Error("Checkout Spark native treasury evidence is invalid.")
}

export const id = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const digest = (value: unknown): string =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))

function exactKeys(value: object, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid()
}

/** Derive before the plan digest: the binding deliberately has no digest cycle. */
export function deriveCheckoutSparkNativeTreasuryInvoiceId(
  input: CheckoutSparkNativeTreasuryInvoiceIdInput
): string {
  if (
    !id(input.checkoutId) ||
    !id(input.orderId) ||
    !id(input.walletId) ||
    !id(input.sparkAddress, 16_384) ||
    !nonnegative(input.createdAt) ||
    !["mainnet", "regtest"].includes(input.network) ||
    !/^(02|03)[0-9a-f]{64}$/.test(input.receiverIdentityPublicKey) ||
    !/^(02|03)[0-9a-f]{64}$/.test(input.senderIdentityPublicKey)
  )
    invalid()
  const identityDigest = digest([
    "conduit:checkout-spark-native-treasury-invoice:v1",
    input.checkoutId,
    input.orderId,
    input.walletId,
    input.network,
    input.createdAt,
    input.sparkAddress,
    input.receiverIdentityPublicKey,
    input.senderIdentityPublicKey,
  ])
  const bytes = Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(identityDigest.slice(index * 2, index * 2 + 2), 16)
  )
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

/** SDK decoding/encoding is an additional adapter gate, never claimed here. */
export function restoreCheckoutSparkNativeTreasuryPlan(
  value: CheckoutSparkNativeTreasuryPlan,
  plan: Pick<
    CheckoutSparkSettledPlan,
    "checkoutId" | "orderId" | "walletId" | "network" | "createdAt" | "funding"
  >
): CheckoutSparkNativeTreasuryPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "schemaVersion",
    "sparkAddress",
    "receiverIdentityPublicKey",
    "senderIdentityPublicKey",
    "invoiceId",
    "invoiceRequest",
    "feePolicy",
    "residualPolicy",
  ])
  if (
    value.schemaVersion !== 1 ||
    value.feePolicy !== "zero_required" ||
    value.residualPolicy !== "unused_commerce_reserves" ||
    !id(value.invoiceRequest, 16_384) ||
    value.senderIdentityPublicKey !== plan.funding.receiverIdentityPublicKey ||
    value.invoiceId !==
      deriveCheckoutSparkNativeTreasuryInvoiceId({ ...plan, ...value })
  )
    invalid()
  return Object.freeze({ ...value })
}

export function createCheckoutSparkNativeTreasuryFinalization(): CheckoutSparkNativeTreasuryFinalization {
  return Object.freeze({
    intent: null,
    status: "unprepared",
    providerTransferId: null,
    observedAt: null,
    finalFeeSats: null,
    finalDebitSats: null,
  })
}

export function budgetFromExactState(
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkNativeTreasuryBudget {
  if (
    !isCheckoutSparkNativeTreasuryPlan(state.plan) ||
    !state.plan.nativeTreasury ||
    !state.credit
  )
    invalid()
  const fee = state.plan.recipients.find(
    (recipient) => recipient.kind === "conduit"
  )!
  const feeLeg = state.legs.find((leg) => leg.legId === fee.legId)!
  const commerce = state.legs.filter((leg) => leg.legId !== fee.legId)
  if (
    !nonnegative(feeLeg.allocationSats) ||
    commerce.some(
      (leg) =>
        leg.status !== "paid" ||
        !leg.intent ||
        !nonnegative(leg.finalDebitSats) ||
        leg.finalDebitSats! <= 0 ||
        (leg.closedGenerations ?? []).some(
          (entry) => entry.closure.netDebitSats !== 0
        )
    )
  )
    invalid()
  const debits = commerce.reduce(
    (sum, leg) => sum + BigInt(leg.finalDebitSats!),
    0n
  )
  const authorizedDebitSats = Number(BigInt(state.credit.creditedSats) - debits)
  const unusedCommerceReserveSats = authorizedDebitSats - feeLeg.allocationSats
  if (
    !nonnegative(authorizedDebitSats) ||
    !nonnegative(unusedCommerceReserveSats)
  )
    invalid()
  return Object.freeze({
    baseConduitAllocationSats: feeLeg.allocationSats,
    unusedCommerceReserveSats,
    authorizedDebitSats,
    accountingDigest: digest([
      "conduit:checkout-spark-native-treasury-accounting:v1",
      state.plan.planDigest,
      state.credit.transferId,
      state.credit.creditedSats,
      commerce.map((leg) => [
        leg.legId,
        leg.intent!.transferId,
        leg.finalDebitSats,
        leg.finalFeeSats,
        (leg.closedGenerations ?? []).map((entry) => [
          entry.intent.transferId,
          entry.closure.netDebitSats,
        ]),
      ]),
      feeLeg.allocationSats,
      unusedCommerceReserveSats,
      authorizedDebitSats,
    ]),
  })
}

/** Called by router restore with already-validated commerce rows. */
export function restoreCheckoutSparkNativeTreasuryFinalization(
  value: CheckoutSparkNativeTreasuryFinalization,
  state: CheckoutSparkSettledReconciliation
): CheckoutSparkNativeTreasuryFinalization {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  exactKeys(value, [
    "intent",
    "status",
    "providerTransferId",
    "observedAt",
    "finalFeeSats",
    "finalDebitSats",
  ])
  if (value.intent === null) {
    if (
      value.status !== "unprepared" ||
      value.providerTransferId !== null ||
      value.observedAt !== null ||
      value.finalFeeSats !== null ||
      value.finalDebitSats !== null
    )
      invalid()
    return createCheckoutSparkNativeTreasuryFinalization()
  }
  const intent = value.intent
  exactKeys(intent, [
    "invoiceId",
    "invoiceRequest",
    "amountSats",
    "authorizedDebitSats",
    "baseConduitAllocationSats",
    "unusedCommerceReserveSats",
    "accountingDigest",
    "preparedAt",
  ])
  const budget = budgetFromExactState(state)
  if (
    intent.invoiceId !== state.plan.nativeTreasury!.invoiceId ||
    intent.invoiceRequest !== state.plan.nativeTreasury!.invoiceRequest ||
    intent.amountSats <= 0 ||
    intent.amountSats !== budget.authorizedDebitSats ||
    Object.entries(budget).some(
      ([key, expected]) => intent[key as keyof typeof budget] !== expected
    ) ||
    !nonnegative(intent.preparedAt) ||
    intent.preparedAt <
      Math.max(
        state.credit!.observedAt,
        ...state.legs.filter((leg) => leg.intent).map((leg) => leg.observedAt!)
      ) ||
    !nonnegative(value.observedAt) ||
    value.observedAt < intent.preparedAt ||
    ![
      "prepared",
      "submitted",
      "ambiguous",
      "lookup_unavailable",
      "conflicting_evidence",
      "paid",
      "terminal_failure",
    ].includes(value.status) ||
    (value.providerTransferId !== null && !id(value.providerTransferId))
  )
    invalid()
  if (value.status === "paid") {
    if (
      !id(value.providerTransferId) ||
      value.finalFeeSats !== 0 ||
      value.finalDebitSats !== intent.amountSats
    )
      invalid()
  } else if (value.finalFeeSats !== null || value.finalDebitSats !== null)
    invalid()
  return Object.freeze({ ...value, intent: Object.freeze({ ...intent }) })
}
