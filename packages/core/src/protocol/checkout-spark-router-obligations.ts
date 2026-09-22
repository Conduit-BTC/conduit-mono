import type {
  CheckoutSparkNetwork,
  CheckoutSparkObligationPlanInput,
} from "./checkout-spark-reconciliation"
import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
  normalizeLightningInvoice,
} from "./lightning"

export const CONDUIT_CHECKOUT_FEE_RECIPIENT = "conduithodlings@strike.me"

const CONDUIT_FEE_NUMERATOR = 21n
const CONDUIT_FEE_DENOMINATOR = 1_000n
const CONDUIT_FEE_FLOOR_SATS = 111n
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_RECIPIENT_ID_LENGTH = 512
const MAX_PAYMENT_REQUEST_LENGTH = 16_384

export interface CheckoutSparkCommerceObligationInput {
  kind: "merchant" | "supplier"
  recipientId: string
  paymentRequest: string
  amountSats: number
  maxFeeSats: number
}

export interface CheckoutSparkOrganizerObligationInput {
  recipientId: string
  paymentRequest: string
  amountSats: number
  maxFeeSats: number
}

export interface CheckoutSparkConduitObligationInput {
  paymentRequest: string
  maxFeeSats: number
}

export interface BuildCheckoutSparkRouterObligationsInput {
  network: CheckoutSparkNetwork
  nowSeconds: number
  /** Final authorized merchandise plus shipping amount, excluding fees. */
  commerceTotalSats: number
  /** Already-authorized and endpoint-resolved merchant/supplier legs. */
  commerce: readonly CheckoutSparkCommerceObligationInput[]
  /** Optional already-authorized and endpoint-resolved event organizer leg. */
  organizer?: CheckoutSparkOrganizerObligationInput | null
  /** Exact invoice and fee allowance for the fixed Conduit destination. */
  conduit: CheckoutSparkConduitObligationInput
}

export interface CheckoutSparkRouterObligations {
  commerceTotalSats: number
  conduitFeeSats: number
  /** Amount that must remain spendable after the funding receive settles. */
  requiredNetSats: number
  obligations: readonly CheckoutSparkObligationPlanInput[]
}

type NormalizedCheckoutSparkObligation = CheckoutSparkObligationPlanInput & {
  paymentHash: string
}

function normalizePositiveSats(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Checkout Spark ${label} is invalid.`)
  }
  return value
}

function normalizeFeeSats(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Checkout Spark maximum fee is invalid.")
  }
  return value
}

function normalizeBoundedString(
  value: string,
  label: string,
  maxLength: number
): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Checkout Spark ${label} is invalid.`)
  }
  return normalized
}

function safeNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE_INTEGER) {
    throw new Error(`Checkout Spark ${label} is unsafe.`)
  }
  return Number(value)
}

/**
 * Compute 2.1% of the authorized commerce base with the fixed 111-sat floor.
 * BigInt arithmetic keeps the ceiling exact before narrowing to a safe number.
 */
export function calculateConduitCheckoutFeeSats(
  commerceTotalSats: number
): number {
  const commerceTotal = BigInt(
    normalizePositiveSats(commerceTotalSats, "commerce total")
  )
  const percentageFee =
    (commerceTotal * CONDUIT_FEE_NUMERATOR + CONDUIT_FEE_DENOMINATOR - 1n) /
    CONDUIT_FEE_DENOMINATOR
  return safeNumber(
    percentageFee > CONDUIT_FEE_FLOOR_SATS
      ? percentageFee
      : CONDUIT_FEE_FLOOR_SATS,
    "Conduit fee"
  )
}

function normalizeObligation(
  input:
    | CheckoutSparkCommerceObligationInput
    | (CheckoutSparkOrganizerObligationInput & { kind: "organizer" })
    | (CheckoutSparkConduitObligationInput & {
        kind: "conduit"
        recipientId: string
        amountSats: number
      }),
  network: CheckoutSparkNetwork,
  nowSeconds: number
): NormalizedCheckoutSparkObligation {
  const amountSats = normalizePositiveSats(input.amountSats, "amount")
  const paymentRequest = normalizeBoundedString(
    normalizeLightningInvoice(input.paymentRequest).toLowerCase(),
    "payment request",
    MAX_PAYMENT_REQUEST_LENGTH
  )
  if (!isValidLightningInvoice(paymentRequest)) {
    throw new Error("Checkout Spark payment request is invalid.")
  }
  if (getLightningInvoiceNetwork(paymentRequest) !== network) {
    throw new Error("Checkout Spark payment request network is invalid.")
  }

  const expectedMsats = BigInt(amountSats) * 1_000n
  if (expectedMsats > MAX_SAFE_INTEGER) {
    throw new Error("Checkout Spark payment request amount is unsafe.")
  }
  const metadata = decodeLightningInvoiceMetadata(paymentRequest)
  if (metadata.msats !== Number(expectedMsats)) {
    throw new Error("Checkout Spark payment request amount is invalid.")
  }
  if (metadata.expiresAt === null || metadata.expiresAt <= nowSeconds) {
    throw new Error("Checkout Spark payment request is expired.")
  }
  const paymentHash = decodeLightningInvoicePaymentHash(paymentRequest)
  if (!paymentHash) {
    throw new Error("Checkout Spark payment request hash is invalid.")
  }

  return {
    kind: input.kind,
    recipientId: normalizeBoundedString(
      input.recipientId,
      "recipient",
      MAX_RECIPIENT_ID_LENGTH
    ),
    paymentRequest,
    paymentHash,
    amountSats,
    maxFeeSats: normalizeFeeSats(input.maxFeeSats),
  }
}

/**
 * Canonicalize the already-authorized economic legs before wallet creation.
 *
 * This deliberately does not discover recipients, interpret signed supplier or
 * event terms, or obtain invoices. Those producers must resolve current exact
 * endpoints and pass their immutable results through this fail-closed seam.
 */
export function buildCheckoutSparkRouterObligations(
  input: BuildCheckoutSparkRouterObligationsInput
): CheckoutSparkRouterObligations {
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
    throw new Error("Checkout Spark validation time is invalid.")
  }
  const commerceTotalSats = normalizePositiveSats(
    input.commerceTotalSats,
    "commerce total"
  )
  const commerce = input.commerce.map((obligation) =>
    normalizeObligation(obligation, input.network, input.nowSeconds)
  )
  if (
    commerce.filter((obligation) => obligation.kind === "merchant").length !== 1
  ) {
    throw new Error(
      "Checkout Spark requires exactly one merchant commerce obligation."
    )
  }

  const commerceSum = commerce.reduce(
    (sum, obligation) => sum + BigInt(obligation.amountSats),
    0n
  )
  if (commerceSum !== BigInt(commerceTotalSats)) {
    throw new Error(
      "Checkout Spark commerce obligations do not match the authorized commerce total."
    )
  }

  const conduitFeeSats = calculateConduitCheckoutFeeSats(commerceTotalSats)
  const organizers = input.organizer
    ? [
        normalizeObligation(
          { kind: "organizer", ...input.organizer },
          input.network,
          input.nowSeconds
        ),
      ]
    : []
  const conduit = normalizeObligation(
    {
      kind: "conduit",
      recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
      paymentRequest: input.conduit.paymentRequest,
      amountSats: conduitFeeSats,
      maxFeeSats: input.conduit.maxFeeSats,
    },
    input.network,
    input.nowSeconds
  )
  const obligations = [
    ...commerce.filter((obligation) => obligation.kind === "merchant"),
    ...commerce.filter((obligation) => obligation.kind === "supplier"),
    ...organizers,
    conduit,
  ]

  const paymentHashes = new Set<string>()
  const recipientsByKind = new Set<string>()
  for (const obligation of obligations) {
    if (paymentHashes.has(obligation.paymentHash)) {
      throw new Error("Checkout Spark payment hash is duplicated.")
    }
    paymentHashes.add(obligation.paymentHash)

    const recipientKey = `${obligation.kind}:${obligation.recipientId}`
    if (recipientsByKind.has(recipientKey)) {
      throw new Error("Checkout Spark recipient is duplicated.")
    }
    recipientsByKind.add(recipientKey)
  }

  const requiredNetSats = safeNumber(
    obligations.reduce(
      (sum, obligation) =>
        sum + BigInt(obligation.amountSats) + BigInt(obligation.maxFeeSats),
      0n
    ),
    "required funding"
  )

  return Object.freeze({
    commerceTotalSats,
    conduitFeeSats,
    requiredNetSats,
    obligations: Object.freeze(
      obligations.map(
        ({ kind, recipientId, paymentRequest, amountSats, maxFeeSats }) =>
          Object.freeze({
            kind,
            recipientId,
            paymentRequest,
            amountSats,
            maxFeeSats,
          })
      )
    ),
  })
}
