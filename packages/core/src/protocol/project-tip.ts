import { schnorr } from "@noble/curves/secp256k1.js"
import { config } from "../config"
import { normalizePubkey } from "../utils"
import { EVENT_KINDS } from "./kinds"
import {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  validateLightningInvoiceForPayment,
  type LnurlPayMetadata,
} from "./lightning"
import type { NostrEventSigner, UnsignedNostrEvent } from "./nostr-event-signer"
import {
  PROJECT_TIP_LIGHTNING_ADDRESS,
  PROJECT_TIP_MESSAGE,
  PROJECT_TIP_RECIPIENT_PUBKEY,
  validateProjectTipAmount,
} from "./project-tip-authorization"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export {
  PROJECT_TIP_AMOUNTS_SATS,
  PROJECT_TIP_LIGHTNING_ADDRESS,
  PROJECT_TIP_LNURL,
  PROJECT_TIP_MESSAGE,
  PROJECT_TIP_MIN_SATS,
  PROJECT_TIP_PAY_REQUEST_URL,
  PROJECT_TIP_RECIPIENT_PUBKEY,
  isAuthorizedProjectTipDraft,
  validateProjectTipAmount,
  type ProjectTipSigningAuthorization,
} from "./project-tip-authorization"

export function validateProjectTipMetadata(
  metadata: LnurlPayMetadata,
  amountMsats: number
): void {
  let validReceiptPubkey = false
  if (/^[0-9a-f]{64}$/i.test(metadata.nostrPubkey ?? "")) {
    try {
      schnorr.utils.lift_x(BigInt(`0x${metadata.nostrPubkey}`))
      validReceiptPubkey = true
    } catch {
      validReceiptPubkey = false
    }
  }
  if (!metadata.allowsNostr || !validReceiptPubkey) {
    throw new Error("Conduit's Lightning address is not accepting public zaps.")
  }
  if (
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error(
      "That tip amount is outside the Lightning provider's range."
    )
  }
}

export function buildProjectTipRequest(input: {
  senderPubkey: string
  amountMsats: number
  lnurl: string
  relayUrls: readonly string[]
  createdAt?: number
}): UnsignedNostrEvent {
  const senderPubkey = normalizePubkey(input.senderPubkey)
  if (!senderPubkey || !/^[0-9a-f]{64}$/.test(senderPubkey)) {
    throw new Error("The tip signer is invalid.")
  }
  validateProjectTipAmount(input.amountMsats / 1_000)
  if (!/^lnurl1[a-z0-9]+$/i.test(input.lnurl)) {
    throw new Error("The tip Lightning endpoint is invalid.")
  }
  if (input.relayUrls.length === 0 || input.relayUrls.length > 8) {
    throw new Error("Tip receipt relays are unavailable.")
  }
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1_000)
  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    pubkey: senderPubkey,
    created_at: createdAt,
    content: PROJECT_TIP_MESSAGE,
    tags: [
      ["p", PROJECT_TIP_RECIPIENT_PUBKEY],
      ["amount", String(input.amountMsats)],
      ["lnurl", input.lnurl],
      ["relays", ...input.relayUrls],
    ],
  }
}

export function assertProjectTipSignature(
  signed: SignedPublicNostrEvent,
  draft: UnsignedNostrEvent
): void {
  if (
    !isValidSignedPublicNostrEvent(signed) ||
    signed.pubkey !== draft.pubkey ||
    signed.kind !== draft.kind ||
    signed.created_at !== draft.created_at ||
    signed.content !== draft.content ||
    JSON.stringify(signed.tags) !== JSON.stringify(draft.tags)
  ) {
    throw new Error("The signed tip request did not match the selected tip.")
  }
}

export type PreparedProjectTip = {
  invoice: string
  zapRequestId: string
  requestCreatedAt: number
  amountMsats: number
  lnurl: string
  lnurlNostrPubkey: string
  relayUrls: string[]
}

export async function prepareProjectTip(input: {
  amountSats: number
  signer: NostrEventSigner
}): Promise<PreparedProjectTip> {
  const amountMsats = validateProjectTipAmount(input.amountSats)
  const metadata = await fetchLnurlPayMetadata(PROJECT_TIP_LIGHTNING_ADDRESS)
  validateProjectTipMetadata(metadata, amountMsats)
  const senderPubkey = await input.signer.getPublicKey()
  const relayUrls = [...config.zapRelayUrls].slice(0, 8)
  const draft = buildProjectTipRequest({
    senderPubkey,
    amountMsats,
    lnurl: metadata.lnurl,
    relayUrls,
  })
  const signed = await input.signer.signEvent(draft)
  assertProjectTipSignature(signed, draft)
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
    requestCreatedAt: draft.created_at,
    amountMsats,
    lnurl: metadata.lnurl,
    lnurlNostrPubkey: metadata.nostrPubkey!.toLowerCase(),
    relayUrls,
  }
}
