import {
  decodeLightningInvoiceMetadata,
  isValidLightningInvoice,
} from "./lightning"

const MIN_EXECUTION_ALLOWANCE_MS = 5 * 60_000
const PER_OBLIGATION_ALLOWANCE_MS = 60_000
export const CHECKOUT_SPARK_PROVIDER_SEND_WINDOW_MS = 60_000

function invoiceExpiryMs(paymentRequest: string): number | null {
  if (!isValidLightningInvoice(paymentRequest)) return null
  const expiresAt = decodeLightningInvoiceMetadata(paymentRequest).expiresAt
  if (expiresAt === null) return null
  const expiresAtMs = expiresAt * 1_000
  return Number.isSafeInteger(expiresAtMs) ? expiresAtMs : null
}

/**
 * An exposed funding invoice must leave time for funding, shopper execution,
 * merchant takeover, and every frozen outgoing leg. This is a bounded online
 * execution budget, not a promise that long-offline merchant recovery can pay
 * an expired invoice or replace one inside the signed plan.
 */
export function assertCheckoutSparkOutgoingInvoiceLifetime(input: {
  obligations: readonly { paymentRequest: string }[]
  fundingExpiresAt: number
  takeoverAt: number
}): void {
  if (
    !Number.isSafeInteger(input.fundingExpiresAt) ||
    input.fundingExpiresAt < 0 ||
    !Number.isSafeInteger(input.takeoverAt) ||
    input.takeoverAt < 0 ||
    input.obligations.length === 0
  ) {
    throw new Error("Checkout Spark invoice window terms are invalid.")
  }
  const perLegAllowance = input.obligations.length * PER_OBLIGATION_ALLOWANCE_MS
  const allowance = Math.max(MIN_EXECUTION_ALLOWANCE_MS, perLegAllowance)
  const deadline =
    Math.max(input.fundingExpiresAt, input.takeoverAt) + allowance
  if (!Number.isSafeInteger(deadline)) {
    throw new Error("Checkout Spark invoice window is unsafe.")
  }
  for (const obligation of input.obligations) {
    const expiresAtMs = invoiceExpiryMs(obligation.paymentRequest)
    if (expiresAtMs === null || expiresAtMs <= deadline) {
      throw new Error(
        "Checkout Spark outgoing invoice lifetime is insufficient."
      )
    }
  }
}

/** Fail closed before a provider preflight or send if this exact leg is stale. */
export function hasCheckoutSparkProviderSendWindow(input: {
  paymentRequest: string
  nowMs: number
}): boolean {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) return false
  const expiresAtMs = invoiceExpiryMs(input.paymentRequest)
  const requiredUntil = input.nowMs + CHECKOUT_SPARK_PROVIDER_SEND_WINDOW_MS
  return (
    expiresAtMs !== null &&
    Number.isSafeInteger(requiredUntil) &&
    expiresAtMs > requiredUntil
  )
}
