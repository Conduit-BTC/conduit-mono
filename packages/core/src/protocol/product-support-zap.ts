import { schnorr } from "@noble/curves/secp256k1.js"

import { normalizePubkey } from "../utils"
import {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  validateLightningInvoiceForPayment,
  type LnurlPayMetadata,
} from "./lightning"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag } from "./nip89"
import type { NostrEventSigner, UnsignedNostrEvent } from "./nostr-event-signer"
import { decodeProductReference } from "./product-reference"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export const PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS = 280
const PRODUCT_SUPPORT_ZAP_MAX_RECEIPT_RELAYS = 8
const PRODUCT_SUPPORT_ZAP_MAX_LNURL_LENGTH = 5_000

export type ProductSupportZapRequestInput = {
  shopperPubkey: string
  recipientPubkey: string
  productAddress: string
  amountMsats: number
  lnurl: string
  relayUrls: readonly string[]
  note?: string | null
  nowSeconds?: number
}

export type PrepareProductSupportZapInvoiceInput = {
  signer: NostrEventSigner
  shopperPubkey: string
  recipientPubkey: string
  productAddress: string
  lud16: string
  amountSats: number
  relayUrls: readonly string[]
  note?: string | null
  nowSeconds?: number
}

export type PreparedProductSupportZapInvoice = {
  invoice: string
  amountMsats: number
  productAddress: string
  receiptPubkey: string
  receiptRelayUrls: string[]
  zapRequest: SignedPublicNostrEvent
}

export interface ProductSupportZapDependencies {
  fetchLnurlPayMetadata: typeof fetchLnurlPayMetadata
  fetchZapInvoice: typeof fetchZapInvoice
  validateLightningInvoiceForPayment: typeof validateLightningInvoiceForPayment
}

const defaultDependencies: ProductSupportZapDependencies = {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  validateLightningInvoiceForPayment,
}

function normalizeBip340Pubkey(
  value: string | null | undefined
): string | null {
  const normalized = normalizePubkey(value)
  if (!normalized || !/^[0-9a-f]{64}$/.test(value?.trim() ?? "")) return null

  try {
    schnorr.utils.lift_x(BigInt(`0x${normalized}`))
    return normalized
  } catch {
    return null
  }
}

function requireAccountPubkey(value: string, label: string): string {
  const normalized = normalizePubkey(value)
  if (!normalized) {
    throw new Error(`Product support ${label} pubkey is invalid.`)
  }
  return normalized
}

function requireProductTarget(
  productAddress: string,
  recipientPubkey: string
): string {
  const product = decodeProductReference(productAddress)
  if (!product) {
    throw new Error("Product support requires a valid kind-30402 address.")
  }
  if (product.authorPubkey !== recipientPubkey) {
    throw new Error(
      "Product support recipient does not own the selected product."
    )
  }
  return product.addressId
}

function requireAmountMsats(amountMsats: number): number {
  if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
    throw new Error("Product support amount must be a positive integer.")
  }
  return amountMsats
}

function requireLnurl(value: string): string {
  const lnurl = value.trim().toLowerCase()
  if (
    !lnurl.startsWith("lnurl1") ||
    lnurl.length > PRODUCT_SUPPORT_ZAP_MAX_LNURL_LENGTH ||
    !/^[a-z0-9]+$/.test(lnurl)
  ) {
    throw new Error("Product support LNURL is invalid.")
  }
  return lnurl
}

function requireReceiptRelayUrls(relayUrls: readonly string[]): string[] {
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls(relayUrls).slice(
    0,
    PRODUCT_SUPPORT_ZAP_MAX_RECEIPT_RELAYS
  )
  if (normalized.length === 0) {
    throw new Error("Product support requires at least one secure zap relay.")
  }
  return normalized
}

export function normalizeProductSupportZapNote(
  value: string | null | undefined
): string {
  const normalized = Array.from(
    (value ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ")
  )
    .filter((character) => {
      const codePoint = character.codePointAt(0)
      return (
        codePoint === 0x0a ||
        (codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f)
      )
    })
    .join("")
    .trim()

  return Array.from(normalized)
    .slice(0, PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS)
    .join("")
    .trimEnd()
}

export function buildProductSupportZapRequest(
  input: ProductSupportZapRequestInput
): UnsignedNostrEvent {
  const shopperPubkey = requireAccountPubkey(input.shopperPubkey, "shopper")
  const recipientPubkey = requireAccountPubkey(
    input.recipientPubkey,
    "recipient"
  )
  const productAddress = requireProductTarget(
    input.productAddress,
    recipientPubkey
  )
  const amountMsats = requireAmountMsats(input.amountMsats)
  const lnurl = requireLnurl(input.lnurl)
  const relayUrls = requireReceiptRelayUrls(input.relayUrls)
  const createdAt = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error("Product support request timestamp is invalid.")
  }

  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    pubkey: shopperPubkey,
    created_at: createdAt,
    content: normalizeProductSupportZapNote(input.note),
    tags: appendConduitClientTag(
      [
        ["p", recipientPubkey],
        ["amount", String(amountMsats)],
        ["lnurl", lnurl],
        ["relays", ...relayUrls],
        ["a", productAddress],
        ["k", String(EVENT_KINDS.PRODUCT)],
      ],
      "market"
    ),
  }
}

function canonicalSignedEvent(
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
}

function signedRequestMatchesDraft(
  event: SignedPublicNostrEvent,
  draft: UnsignedNostrEvent
): boolean {
  return (
    event.pubkey === draft.pubkey &&
    event.created_at === draft.created_at &&
    event.kind === draft.kind &&
    event.content === draft.content &&
    JSON.stringify(event.tags) === JSON.stringify(draft.tags)
  )
}

function amountSatsToMsats(amountSats: number): number {
  if (
    !Number.isSafeInteger(amountSats) ||
    amountSats <= 0 ||
    amountSats > Number.MAX_SAFE_INTEGER / 1_000
  ) {
    throw new Error("Product support amount must be a positive whole satoshi.")
  }
  return amountSats * 1_000
}

function validateZapMetadata(
  metadata: LnurlPayMetadata,
  amountMsats: number
): string {
  if (!metadata.allowsNostr) {
    throw new Error("This Lightning address does not support public zaps.")
  }
  const receiptPubkey = normalizeBip340Pubkey(metadata.nostrPubkey)
  if (!receiptPubkey) {
    throw new Error(
      "The Lightning address returned an invalid zap receipt key."
    )
  }
  if (
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error("The support amount is outside the merchant wallet range.")
  }
  return receiptPubkey
}

export async function prepareProductSupportZapInvoice(
  input: PrepareProductSupportZapInvoiceInput,
  dependencies: ProductSupportZapDependencies = defaultDependencies
): Promise<PreparedProductSupportZapInvoice> {
  const shopperPubkey = requireAccountPubkey(input.shopperPubkey, "shopper")
  const activeSignerPubkey = normalizePubkey(await input.signer.getPublicKey())
  if (!activeSignerPubkey || activeSignerPubkey !== shopperPubkey) {
    throw new Error("The connected signer does not match this support account.")
  }

  const amountMsats = amountSatsToMsats(input.amountSats)
  const metadata = await dependencies.fetchLnurlPayMetadata(input.lud16)
  const receiptPubkey = validateZapMetadata(metadata, amountMsats)
  const draft = buildProductSupportZapRequest({
    shopperPubkey,
    recipientPubkey: input.recipientPubkey,
    productAddress: input.productAddress,
    amountMsats,
    lnurl: metadata.lnurl,
    relayUrls: input.relayUrls,
    note: input.note,
    nowSeconds: input.nowSeconds,
  })

  const signedResult = await input.signer.signEvent(draft)
  if (
    !isValidSignedPublicNostrEvent(signedResult) ||
    !signedRequestMatchesDraft(signedResult, draft)
  ) {
    throw new Error(
      "The signer returned an invalid or altered product support request."
    )
  }
  const zapRequest = canonicalSignedEvent(signedResult)
  const zapRequestJson = JSON.stringify(zapRequest)
  const { invoice } = await dependencies.fetchZapInvoice(
    metadata.callback,
    amountMsats,
    zapRequestJson,
    metadata.lnurl
  )
  const invoiceValidation = dependencies.validateLightningInvoiceForPayment({
    invoice,
    expectedAmountMsats: amountMsats,
  })
  if (!invoiceValidation.ok) {
    throw new Error(invoiceValidation.reason)
  }

  return {
    invoice,
    amountMsats,
    productAddress: draft.tags.find((tag) => tag[0] === "a")![1]!,
    receiptPubkey,
    receiptRelayUrls: draft.tags.find((tag) => tag[0] === "relays")!.slice(1),
    zapRequest,
  }
}
