import {
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
  PROJECT_TIP_LIGHTNING_ADDRESS,
  isValidLightningInvoice,
  validateLightningInvoiceForPayment,
  validateProjectTipAmount,
  type PreparedProjectTip,
} from "@conduit/core"

/** Guest tips are ordinary Lightning payments, without a public zap message. */
export async function prepareGuestProjectTip(
  amountSats: number
): Promise<PreparedProjectTip> {
  const amountMsats = validateProjectTipAmount(amountSats)
  const metadata = await fetchLnurlPayMetadata(PROJECT_TIP_LIGHTNING_ADDRESS)
  if (
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error(
      "That tip amount is outside the Lightning provider's range."
    )
  }
  const result = await fetchLnurlInvoice(metadata.callback, amountMsats)
  if (!isValidLightningInvoice(result.invoice)) {
    throw new Error("The Lightning provider returned an invalid invoice.")
  }
  const payment = validateLightningInvoiceForPayment({
    invoice: result.invoice,
    expectedAmountMsats: amountMsats,
  })
  if (!payment.ok) throw new Error(payment.reason)
  return {
    invoice: result.invoice,
    amountMsats,
    zapRequestId: null,
    requestCreatedAt: Math.floor(Date.now() / 1_000),
    lnurl: metadata.lnurl,
    lnurlNostrPubkey: null,
    relayUrls: [],
  }
}
