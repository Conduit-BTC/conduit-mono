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
  type CheckoutSparkNetwork,
} from "@conduit/core"

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
}

export interface CheckoutSparkLnurlInvoiceDependencies {
  fetchMetadata?: typeof fetchLnurlPayMetadata
  fetchInvoice?: typeof fetchLnurlInvoice
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
    !Number.isSafeInteger(lnurlMetadata.minSendable) ||
    !Number.isSafeInteger(lnurlMetadata.maxSendable) ||
    lnurlMetadata.minSendable <= 0 ||
    lnurlMetadata.maxSendable < lnurlMetadata.minSendable ||
    amountMsats < lnurlMetadata.minSendable ||
    amountMsats > lnurlMetadata.maxSendable
  ) {
    throw new Error("Checkout Spark payout is outside the LNURL payment range.")
  }
  const callback = normalizeSafeLnurlPayRequestUrl(lnurlMetadata.callback)
  if (!callback) {
    throw new Error("Checkout Spark recipient payment callback is unsafe.")
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

  return {
    paymentRequest,
    paymentHash,
    expiresAt: invoiceMetadata.expiresAt,
  }
}
