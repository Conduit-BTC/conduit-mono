import {
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
  normalizeLightningInvoice,
  validateLightningInvoiceForPayment,
} from "@conduit/core"

/** Cash App consumes the existing invoice; this never creates a payment. */
export function getCashAppLightningUrl(
  invoice: string,
  expectedAmountSats: number | null,
  nowSeconds = Math.floor(Date.now() / 1_000)
): string | null {
  if (
    expectedAmountSats === null ||
    expectedAmountSats <= 0 ||
    !Number.isSafeInteger(expectedAmountSats * 1_000) ||
    getLightningInvoiceNetwork(invoice) !== "mainnet" ||
    !decodeLightningInvoicePaymentHash(invoice) ||
    !isValidLightningInvoice(invoice) ||
    !validateLightningInvoiceForPayment({
      invoice,
      expectedAmountMsats: expectedAmountSats * 1_000,
      nowSeconds,
    }).ok
  ) {
    return null
  }
  return `https://cash.app/launch/lightning/${normalizeLightningInvoice(invoice)}`
}
