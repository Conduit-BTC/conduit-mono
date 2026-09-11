import { schnorr } from "@noble/curves/secp256k1.js"

import { normalizePubkey } from "../utils"
import {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  isValidLud16Address,
  normalizeLightningInvoice,
  validateLightningInvoiceForPayment,
  type LnurlPayMetadata,
} from "./lightning"
import { getProfiles, isCommerceReadIncomplete } from "./commerce"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, buildConduitClientTag } from "./nip89"
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
const PRODUCT_SUPPORT_ZAP_QR_LEVEL_M_MAX_BYTES = 2_331

export type ProductSupportZapPublicField =
  | "zap_request_type"
  | "shopper_identity_and_signature"
  | "timestamp"
  | "public_note"
  | "amount"
  | "merchant_reference"
  | "product_reference_and_kind"
  | "lightning_endpoint"
  | "receipt_relays"
  | "client_attribution"

export type ProductSupportZapDisclosure = {
  publicFields: ProductSupportZapPublicField[]
  preSubmitCopy: string
}

const PRODUCT_SUPPORT_ZAP_PUBLIC_FIELD_LABELS: Record<
  ProductSupportZapPublicField,
  string
> = {
  zap_request_type: "the public zap-request type",
  shopper_identity_and_signature: "your Nostr identity and signature",
  timestamp: "a timestamp",
  public_note: "your public note",
  amount: "the amount",
  merchant_reference: "the merchant reference",
  product_reference_and_kind: "the product reference and kind",
  lightning_endpoint: "the Lightning endpoint",
  receipt_relays: "the requested receipt relays",
  client_attribution: "Conduit Market attribution",
}

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
  amountSats: number
  relayUrls: readonly string[]
  note?: string | null
  nowSeconds?: number
  isCurrent?: () => boolean
}

export interface ProductSupportZapDependencies {
  getProfiles: typeof getProfiles
  fetchLnurlPayMetadata: typeof fetchLnurlPayMetadata
  fetchZapInvoice: typeof fetchZapInvoice
  validateLightningInvoiceForPayment: typeof validateLightningInvoiceForPayment
}

const defaultDependencies: ProductSupportZapDependencies = {
  getProfiles,
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  validateLightningInvoiceForPayment,
}

export function getProductSupportZapDisclosure(input: {
  note?: string | null
  includeClientAttribution?: boolean
}): ProductSupportZapDisclosure {
  const publicFields: ProductSupportZapPublicField[] = [
    "zap_request_type",
    "shopper_identity_and_signature",
    "timestamp",
    ...(normalizeProductSupportZapNote(input.note)
      ? ["public_note" as const]
      : []),
    "amount",
    "merchant_reference",
    "product_reference_and_kind",
    "lightning_endpoint",
    "receipt_relays",
    ...((input.includeClientAttribution ??
    buildConduitClientTag("market") !== null)
      ? (["client_attribution"] as const)
      : []),
  ]
  const fieldLabels = publicFields.map(
    (field) => PRODUCT_SUPPORT_ZAP_PUBLIC_FIELD_LABELS[field]
  )

  return {
    publicFields,
    preSubmitCopy: `Creating the invoice sends a signed public zap request to the merchant's Lightning provider, even if you never pay it. The request includes ${new Intl.ListFormat("en", { type: "conjunction" }).format(fieldLabels)}. It never includes cart, order, shipping, or customer details. If paid, the provider may publish that request inside a public zap receipt on Nostr.`,
  }
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

function assertProductSupportRequestCurrent(
  isCurrent: (() => boolean) | undefined
): void {
  if (isCurrent && !isCurrent()) {
    throw new Error(
      "The product support target changed while the invoice was being prepared. Try again."
    )
  }
}

export async function resolveProductSupportPaymentAddress(
  recipientPubkey: string,
  dependencies: Pick<
    ProductSupportZapDependencies,
    "getProfiles"
  > = defaultDependencies
): Promise<string> {
  const normalizedRecipient = requireAccountPubkey(recipientPubkey, "recipient")
  let result: Awaited<ReturnType<typeof getProfiles>>
  try {
    result = await dependencies.getProfiles({
      pubkeys: [normalizedRecipient],
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "payment",
      priority: "visible",
    })
  } catch {
    throw new Error(
      "The merchant's current Lightning address could not be confirmed from relays. Retry before creating an invoice."
    )
  }

  if (
    result.meta.source !== "public" ||
    isCommerceReadIncomplete(result.meta)
  ) {
    throw new Error(
      "The merchant's current Lightning address could not be confirmed from relays. Retry before creating an invoice."
    )
  }

  const lud16 = result.data[normalizedRecipient]?.lud16?.trim() ?? ""
  if (!isValidLud16Address(lud16)) {
    throw new Error(
      "The merchant's current profile does not include a valid Lightning address."
    )
  }
  return lud16
}

export async function prepareProductSupportZapInvoice(
  input: PrepareProductSupportZapInvoiceInput,
  dependencies: ProductSupportZapDependencies = defaultDependencies
): Promise<string> {
  assertProductSupportRequestCurrent(input.isCurrent)
  const shopperPubkey = requireAccountPubkey(input.shopperPubkey, "shopper")
  const activeSignerPubkey = normalizePubkey(await input.signer.getPublicKey())
  assertProductSupportRequestCurrent(input.isCurrent)
  if (!activeSignerPubkey || activeSignerPubkey !== shopperPubkey) {
    throw new Error("The connected signer does not match this support account.")
  }

  const amountMsats = amountSatsToMsats(input.amountSats)
  const lud16 = await resolveProductSupportPaymentAddress(
    input.recipientPubkey,
    dependencies
  )
  assertProductSupportRequestCurrent(input.isCurrent)
  const metadata = await dependencies.fetchLnurlPayMetadata(lud16)
  assertProductSupportRequestCurrent(input.isCurrent)
  validateZapMetadata(metadata, amountMsats)
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
  assertProductSupportRequestCurrent(input.isCurrent)
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
  assertProductSupportRequestCurrent(input.isCurrent)
  const invoiceValidation = dependencies.validateLightningInvoiceForPayment({
    invoice,
    expectedAmountMsats: amountMsats,
  })
  if (!invoiceValidation.ok) {
    throw new Error(invoiceValidation.reason)
  }
  if (
    new TextEncoder().encode(normalizeLightningInvoice(invoice)).length >
    PRODUCT_SUPPORT_ZAP_QR_LEVEL_M_MAX_BYTES
  ) {
    throw new Error(
      "The Lightning provider returned an invoice that is too large to display as a QR code."
    )
  }
  const confirmedLud16 = await resolveProductSupportPaymentAddress(
    input.recipientPubkey,
    dependencies
  )
  assertProductSupportRequestCurrent(input.isCurrent)
  if (confirmedLud16 !== lud16) {
    throw new Error(
      "The merchant's Lightning address changed while the invoice was being prepared. The invoice was discarded. Try again."
    )
  }

  // The invoice can expire while the final relay confirmation is pending.
  const confirmedInvoiceValidation =
    dependencies.validateLightningInvoiceForPayment({
      invoice,
      expectedAmountMsats: amountMsats,
    })
  if (!confirmedInvoiceValidation.ok) {
    throw new Error(confirmedInvoiceValidation.reason)
  }

  return invoice
}
