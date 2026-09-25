import {
  config,
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  isValidSignedPublicNostrEvent,
  PROJECT_TIP_LIGHTNING_ADDRESS,
  PROJECT_TIP_RECIPIENT_PUBKEY,
  validateLightningInvoiceForPayment,
  validateProjectTipAmount,
  validateProjectTipMetadata,
  type PreparedProjectTip,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  buildProjectTipRequest,
  assertProjectTipSignature,
} from "@conduit/core/protocol/project-tip"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Guests use the existing server-held Anon Conduit Shopper signer. */
export async function prepareAnonymousProjectTip(
  amountSats: number
): Promise<PreparedProjectTip> {
  const amountMsats = validateProjectTipAmount(amountSats)
  const response = await fetch("/api/project-tip-sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountSats }),
  })
  const body: unknown = await response.json()
  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : "Anonymous tip signing is unavailable."
    )
  }
  if (
    !isRecord(body) ||
    !isRecord(body.rawEvent) ||
    !isValidSignedPublicNostrEvent(body.rawEvent as SignedPublicNostrEvent) ||
    typeof body.lnurl !== "string" ||
    typeof body.callback !== "string" ||
    typeof body.lnurlNostrPubkey !== "string" ||
    !Array.isArray(body.relayUrls) ||
    !body.relayUrls.every((relay) => typeof relay === "string")
  ) {
    throw new Error("Anonymous tip signer returned an invalid zap request.")
  }
  const signed = body.rawEvent as SignedPublicNostrEvent
  if (
    !config.anonZapSignerPubkey ||
    signed.pubkey !== config.anonZapSignerPubkey.toLowerCase()
  ) {
    throw new Error("Anonymous tip signer identity does not match.")
  }
  const metadata = await fetchLnurlPayMetadata(PROJECT_TIP_LIGHTNING_ADDRESS)
  validateProjectTipMetadata(metadata, amountMsats)
  if (
    body.lnurl !== metadata.lnurl ||
    body.callback !== metadata.callback ||
    body.lnurlNostrPubkey.toLowerCase() !== metadata.nostrPubkey?.toLowerCase()
  ) {
    throw new Error("Conduit's Lightning payment details changed. Try again.")
  }
  const draft = buildProjectTipRequest({
    senderPubkey: signed.pubkey,
    amountMsats,
    lnurl: metadata.lnurl,
    relayUrls: body.relayUrls,
    createdAt: signed.created_at,
  })
  assertProjectTipSignature(signed, draft)
  if (
    signed.tags.find((tag) => tag[0] === "p")?.[1] !==
    PROJECT_TIP_RECIPIENT_PUBKEY
  ) {
    throw new Error("The tip recipient changed.")
  }
  const result = await fetchZapInvoice(
    metadata.callback,
    amountMsats,
    JSON.stringify(signed),
    metadata.lnurl
  )
  const payment = validateLightningInvoiceForPayment({
    invoice: result.invoice,
    expectedAmountMsats: amountMsats,
  })
  if (!payment.ok) throw new Error(payment.reason)
  return {
    invoice: result.invoice,
    zapRequestId: signed.id,
    requestCreatedAt: signed.created_at,
    amountMsats,
    lnurl: metadata.lnurl,
    lnurlNostrPubkey: metadata.nostrPubkey!.toLowerCase(),
    relayUrls: body.relayUrls,
  }
}
