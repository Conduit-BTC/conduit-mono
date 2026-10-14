import { normalizeLightningInvoice } from "./lightning"

interface NativeAmount {
  readonly originalValue: number
  readonly originalUnit: string
}

interface NativeTransfer {
  readonly sparkId?: string
  readonly totalAmount?: NativeAmount
  readonly userRequest?: unknown
}

export interface ExactSparkLightningRecoveredRequest {
  readonly typename: "LightningSendRequest"
  readonly id: string
  readonly status: string
  readonly fee: NativeAmount
  readonly paymentPreimage?: string
  readonly encodedInvoice: string
  readonly idempotencyKey: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function canonicalInvoice(invoice: string): string | null {
  const normalized = normalizeLightningInvoice(invoice)
  return /[a-z]/.test(normalized) && /[A-Z]/.test(normalized)
    ? null
    : normalized.toLowerCase()
}

/**
 * Verify Spark's exact transfer and persisted Lightning request before any
 * status polling. A transfer's mere existence is never payment evidence.
 */
export function readExactSparkLightningRecoveredTransfer(input: {
  readonly transferId: string
  readonly paymentRequest: string
  readonly transfer: NativeTransfer
}): {
  readonly request: ExactSparkLightningRecoveredRequest
  readonly totalAmount?: NativeAmount
} {
  if (input.transfer.sparkId !== input.transferId) {
    throw new Error("Spark returned a conflicting transfer identity.")
  }
  const recovered = asRecord(input.transfer.userRequest)
  const fee = asRecord(recovered?.fee)
  if (
    recovered?.typename !== "LightningSendRequest" ||
    typeof recovered.id !== "string" ||
    recovered.id.length === 0 ||
    typeof recovered.status !== "string" ||
    typeof recovered.encodedInvoice !== "string" ||
    typeof recovered.idempotencyKey !== "string" ||
    typeof fee?.originalValue !== "number" ||
    typeof fee.originalUnit !== "string" ||
    (recovered.paymentPreimage !== undefined &&
      recovered.paymentPreimage !== null &&
      typeof recovered.paymentPreimage !== "string")
  ) {
    throw new Error("Spark returned invalid Lightning recovery evidence.")
  }
  if (recovered.idempotencyKey !== input.transferId) {
    throw new Error("Spark returned a conflicting Lightning payment identity.")
  }
  const recoveredInvoice = canonicalInvoice(recovered.encodedInvoice)
  const expectedInvoice = canonicalInvoice(input.paymentRequest)
  if (!recoveredInvoice || recoveredInvoice !== expectedInvoice) {
    throw new Error("Spark returned a different Lightning invoice.")
  }
  return {
    request: {
      typename: "LightningSendRequest",
      id: recovered.id,
      status: recovered.status,
      fee: {
        originalValue: fee.originalValue,
        originalUnit: fee.originalUnit,
      },
      ...(typeof recovered.paymentPreimage === "string"
        ? { paymentPreimage: recovered.paymentPreimage }
        : {}),
      encodedInvoice: recovered.encodedInvoice,
      idempotencyKey: recovered.idempotencyKey,
    },
    ...(input.transfer.totalAmount
      ? { totalAmount: input.transfer.totalAmount }
      : {}),
  }
}

/** Recheck each polled request against the same ID, fee ceiling, and debit. */
export function verifyExactSparkLightningRequestDebit(input: {
  readonly requestId: string
  readonly amountSats: number
  readonly maxFeeSats: number
  readonly totalAmount?: NativeAmount
  readonly request: {
    readonly id: string
    readonly fee: NativeAmount
  }
}): number {
  if (input.request.id !== input.requestId) {
    throw new Error("Spark returned a conflicting Lightning request identity.")
  }
  const fee = input.request.fee
  if (!Number.isFinite(fee.originalValue) || fee.originalValue < 0) {
    throw new Error("Spark returned an invalid Lightning payment fee.")
  }
  const feeSats =
    fee.originalUnit === "SATOSHI"
      ? Math.ceil(fee.originalValue)
      : fee.originalUnit === "MILLISATOSHI"
        ? Math.ceil(fee.originalValue / 1_000)
        : Number.NaN
  if (
    !Number.isSafeInteger(feeSats) ||
    feeSats < 0 ||
    feeSats > input.maxFeeSats
  ) {
    throw new Error(
      feeSats > input.maxFeeSats
        ? "Spark returned a Lightning fee above the approved maximum."
        : "Spark returned an invalid Lightning payment fee."
    )
  }
  const expectedTotalSats = input.amountSats + feeSats
  const total = input.totalAmount
  const totalSats =
    total?.originalUnit === "SATOSHI"
      ? total.originalValue
      : total?.originalUnit === "MILLISATOSHI"
        ? total.originalValue / 1_000
        : Number.NaN
  if (
    !Number.isSafeInteger(expectedTotalSats) ||
    !Number.isSafeInteger(totalSats) ||
    totalSats < 0 ||
    totalSats !== expectedTotalSats
  ) {
    throw new Error("Spark returned a conflicting Lightning transfer total.")
  }
  return totalSats
}
