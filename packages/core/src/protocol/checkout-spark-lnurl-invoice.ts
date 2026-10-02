import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
  isValidLud16Address,
  normalizeLightningInvoice,
  normalizeSafeLnurlPayRequestUrl,
} from "./lightning"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_PAYMENT_REQUEST_LENGTH = 16_384

export interface CheckoutSparkLnurlInvoiceInput {
  /** Already authorized from the recipient's exact signed payment profile. */
  lud16: string
  amountSats: number
  network: CheckoutSparkNetwork
  nowSeconds: number
  /** Same signed-account and checkout generation that authorized the payout. */
  shouldContinue: () => boolean
}

export interface CheckoutSparkLnurlInvoice {
  paymentRequest: string
  paymentHash: string
  expiresAt: number
  /** Live local resolution evidence; never serialize or include in recovery. */
  origin?: CheckoutSparkLnurlInvoiceOrigin
}

declare const invoiceOriginBrand: unique symbol
export interface CheckoutSparkLnurlInvoiceOrigin {
  readonly [invoiceOriginBrand]: true
}

interface InvoiceOriginSnapshot {
  lud16: string
  network: CheckoutSparkNetwork
  amountSats: number
  paymentRequest: string
  paymentHash: string
  expiresAt: number
  resolvedAt: number
}

const invoiceOrigins = new WeakMap<
  CheckoutSparkLnurlInvoiceOrigin,
  InvoiceOriginSnapshot
>()

export class CheckoutSparkInvoiceOriginUnavailableError extends Error {
  constructor() {
    super("Checkout Spark invoice recipient is not verified on this device.")
    this.name = "CheckoutSparkInvoiceOriginUnavailableError"
  }
}

/** Check an opaque local resolution, not a caller's structural invoice claim. */
export function assertCheckoutSparkLnurlInvoiceOrigin(
  origin: CheckoutSparkLnurlInvoiceOrigin | undefined,
  expected: Omit<InvoiceOriginSnapshot, "resolvedAt">
): number {
  const observed = origin && invoiceOrigins.get(origin)
  if (
    !observed ||
    observed.lud16 !== expected.lud16 ||
    observed.network !== expected.network ||
    observed.amountSats !== expected.amountSats ||
    observed.paymentRequest !== expected.paymentRequest ||
    observed.paymentHash !== expected.paymentHash ||
    observed.expiresAt !== expected.expiresAt
  ) {
    throw new CheckoutSparkInvoiceOriginUnavailableError()
  }
  return observed.resolvedAt
}

export interface CheckoutSparkLnurlInvoiceDependencies {
  fetchMetadata?: typeof fetchLnurlPayMetadata
  fetchInvoice?: typeof fetchLnurlInvoice
}

/** A usable whole-sat range observed from valid, safe plain-LNURL metadata. */
export class CheckoutSparkLnurlInvoiceRangeError extends Error {
  constructor(
    readonly minimumSats: number,
    readonly maximumSats: number
  ) {
    super("Checkout Spark payout is outside the LNURL payment range.")
    this.name = "CheckoutSparkLnurlInvoiceRangeError"
  }
}

/**
 * Resolve one private, exact-amount payout invoice. Recipient and amount
 * authority must already be settled; this helper never infers them from LNURL
 * metadata and never sends NIP-57 parameters to the callback.
 */
export async function resolveCheckoutSparkLnurlInvoice(
  input: CheckoutSparkLnurlInvoiceInput,
  dependencies: CheckoutSparkLnurlInvoiceDependencies = {}
): Promise<CheckoutSparkLnurlInvoice> {
  const assertCurrent = () => {
    if (input.shouldContinue() === false) {
      throw new Error("Checkout Spark payout authority changed.")
    }
  }
  assertCurrent()
  const lud16 = input.lud16.trim()
  if (!isValidLud16Address(lud16)) {
    throw new Error("Checkout Spark recipient address is invalid.")
  }
  if (input.network !== "mainnet" && input.network !== "regtest") {
    throw new Error("Checkout Spark payout network is invalid.")
  }
  if (!Number.isSafeInteger(input.amountSats) || input.amountSats <= 0) {
    throw new Error("Checkout Spark payout amount is invalid.")
  }
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
    throw new Error("Checkout Spark validation time is invalid.")
  }
  const amountMsatsBig = BigInt(input.amountSats) * 1_000n
  if (amountMsatsBig > MAX_SAFE_INTEGER) {
    throw new Error("Checkout Spark payout amount is unsafe.")
  }
  const amountMsats = Number(amountMsatsBig)

  let lnurlMetadata: Awaited<ReturnType<typeof fetchLnurlPayMetadata>>
  try {
    lnurlMetadata = await (dependencies.fetchMetadata ?? fetchLnurlPayMetadata)(
      lud16
    )
  } catch {
    throw new Error("Checkout Spark recipient payment endpoint is unavailable.")
  }
  assertCurrent()
  if (
    lnurlMetadata.tag !== "payRequest" ||
    !Number.isSafeInteger(lnurlMetadata.minSendable) ||
    !Number.isSafeInteger(lnurlMetadata.maxSendable) ||
    lnurlMetadata.minSendable <= 0 ||
    lnurlMetadata.maxSendable < lnurlMetadata.minSendable
  ) {
    throw new Error("Checkout Spark recipient payment metadata is invalid.")
  }
  const callback = normalizeSafeLnurlPayRequestUrl(lnurlMetadata.callback)
  if (!callback) {
    throw new Error("Checkout Spark recipient payment callback is unsafe.")
  }
  const minimumSats = Number(
    (BigInt(lnurlMetadata.minSendable) + 999n) / 1_000n
  )
  const maximumSats = Number(BigInt(lnurlMetadata.maxSendable) / 1_000n)
  if (minimumSats > maximumSats) {
    throw new Error("Checkout Spark recipient has no whole-sat payment range.")
  }
  if (input.amountSats < minimumSats || input.amountSats > maximumSats) {
    throw new CheckoutSparkLnurlInvoiceRangeError(minimumSats, maximumSats)
  }

  let invoice: string
  try {
    // Intentionally pass no third argument: the core helper strips any
    // pre-existing `nostr` or `lnurl` callback parameters for plain invoices.
    const response = await (dependencies.fetchInvoice ?? fetchLnurlInvoice)(
      callback,
      amountMsats
    )
    invoice = response.invoice
  } catch {
    throw new Error("Checkout Spark recipient invoice is unavailable.")
  }
  assertCurrent()
  if (typeof invoice !== "string") {
    throw new Error("Checkout Spark recipient invoice is invalid.")
  }
  const paymentRequest = normalizeLightningInvoice(invoice).toLowerCase()
  if (
    !paymentRequest ||
    paymentRequest.length > MAX_PAYMENT_REQUEST_LENGTH ||
    !isValidLightningInvoice(paymentRequest)
  ) {
    throw new Error("Checkout Spark recipient invoice is invalid.")
  }
  if (getLightningInvoiceNetwork(paymentRequest) !== input.network) {
    throw new Error("Checkout Spark recipient invoice network is invalid.")
  }
  const invoiceMetadata = decodeLightningInvoiceMetadata(paymentRequest)
  if (invoiceMetadata.msats !== amountMsats) {
    throw new Error("Checkout Spark recipient invoice amount is invalid.")
  }
  if (
    invoiceMetadata.expiresAt === null ||
    invoiceMetadata.expiresAt <= input.nowSeconds
  ) {
    throw new Error("Checkout Spark recipient invoice is expired.")
  }
  const paymentHash = decodeLightningInvoicePaymentHash(paymentRequest)
  if (!paymentHash) {
    throw new Error("Checkout Spark recipient invoice hash is invalid.")
  }

  const origin = Object.freeze({}) as CheckoutSparkLnurlInvoiceOrigin
  invoiceOrigins.set(
    origin,
    Object.freeze({
      lud16,
      network: input.network,
      amountSats: input.amountSats,
      paymentRequest,
      paymentHash,
      expiresAt: invoiceMetadata.expiresAt,
      resolvedAt: input.nowSeconds * 1_000,
    })
  )
  return {
    paymentRequest,
    paymentHash,
    expiresAt: invoiceMetadata.expiresAt,
    origin,
  }
}
