import { schnorr } from "@noble/curves/secp256k1.js"

import { normalizePubkey } from "../utils"
import type { Product } from "../types"
import {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  isValidLud16Address,
  normalizeLightningInvoice,
  validateLightningInvoiceForPayment,
  type LnurlPayMetadata,
} from "./lightning"
import {
  getProductDetail,
  getProfiles,
  isCommerceReadIncomplete,
  type CommerceProductRecord,
  type CommerceQueryMeta,
  type ProfileBatchQuery,
} from "./commerce"
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
  product: Pick<Product, "id" | "pubkey" | "updatedAt" | "supportZapRouting">
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

export function getProductSupportZapRoutingError(
  product: PrepareProductSupportZapInvoiceInput["product"] | undefined
): string | null {
  const evidence = product?.supportZapRouting
  const readEvidence = evidence?.readEvidence
  const target = product && decodeProductReference(product.id)
  if (
    !product ||
    !evidence ||
    !readEvidence ||
    !target ||
    target.authorPubkey !== product.pubkey.toLowerCase() ||
    evidence.productAddress !== target.addressId ||
    !/^[0-9a-f]{64}$/.test(evidence.eventId) ||
    !Number.isSafeInteger(evidence.eventCreatedAt) ||
    evidence.eventCreatedAt * 1000 !== product.updatedAt ||
    readEvidence.source === "local_cache" ||
    isCommerceReadIncomplete(readEvidence) ||
    !Number.isSafeInteger(readEvidence.fetchedAt) ||
    readEvidence.fetchedAt <= 0 ||
    (evidence.state !== "default" && evidence.state !== "unsupported")
  ) {
    return "Refresh this product to verify its support payment routing."
  }
  return evidence.state === "unsupported"
    ? "This product uses custom zap routing that Conduit does not support yet. No invoice will be created."
    : null
}

/**
 * Stable identity for an invoice's signed product routing and read quality.
 * `fetchedAt` is intentionally excluded: a newer complete observation of the
 * same signed revision does not change the target. Source and completeness
 * fields remain so cache-only or incomplete evidence still invalidates it.
 */
export function getProductSupportZapEvidenceFingerprint(
  product: PrepareProductSupportZapInvoiceInput["product"] | undefined
): string | null {
  const routing = product?.supportZapRouting
  const readEvidence = routing?.readEvidence
  if (!product || !routing || !readEvidence) return null
  const readEvidenceComplete =
    readEvidence.source !== "local_cache" &&
    !isCommerceReadIncomplete(readEvidence) &&
    Number.isSafeInteger(readEvidence.fetchedAt) &&
    readEvidence.fetchedAt > 0

  return JSON.stringify([
    product.id,
    product.pubkey,
    product.updatedAt,
    routing.state,
    routing.productAddress,
    routing.eventId,
    routing.eventCreatedAt,
    readEvidence.source,
    readEvidence.stale,
    readEvidence.degraded,
    readEvidence.capped,
    readEvidenceComplete,
  ])
}

export interface ProductSupportZapDependencies {
  getProductDetail: typeof getProductDetail
  getProfiles: typeof getProfiles
  fetchLnurlPayMetadata: typeof fetchLnurlPayMetadata
  fetchZapInvoice: typeof fetchZapInvoice
  validateLightningInvoiceForPayment: typeof validateLightningInvoiceForPayment
}

const defaultDependencies: ProductSupportZapDependencies = {
  getProductDetail,
  getProfiles,
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  validateLightningInvoiceForPayment,
}

function findExactProductSupportRecord(
  record: CommerceProductRecord | null,
  productAddress: string
): CommerceProductRecord | null {
  if (!record) return null
  const candidates = [
    record,
    ...(record.family ? [record.family.parent, ...record.family.children] : []),
  ]
  return (
    candidates.find(
      (candidate) =>
        candidate.addressId === productAddress ||
        decodeProductReference(candidate.product.id)?.addressId ===
          productAddress
    ) ?? null
  )
}

function routingEvidenceMatchesMeta(
  product: PrepareProductSupportZapInvoiceInput["product"],
  meta: CommerceQueryMeta
): boolean {
  const evidence = product.supportZapRouting?.readEvidence
  return (
    !!evidence &&
    evidence.source === meta.source &&
    evidence.stale === meta.stale &&
    evidence.degraded === meta.degraded &&
    evidence.capped === (meta.capped ?? false) &&
    evidence.fetchedAt === meta.fetchedAt
  )
}

async function requireCurrentProductSupportRouting(
  input: PrepareProductSupportZapInvoiceInput,
  shopperPubkey: string,
  dependencies: Pick<ProductSupportZapDependencies, "getProductDetail">
): Promise<void> {
  assertProductSupportRequestCurrent(input.isCurrent)
  const productAddress = decodeProductReference(input.productAddress)?.addressId
  if (!productAddress) {
    throw new Error("The product support target changed. Refresh this product.")
  }

  let result: Awaited<ReturnType<typeof getProductDetail>>
  try {
    result = await dependencies.getProductDetail({
      productId: productAddress,
      includeMarketHidden: true,
      authenticatedPubkey: shopperPubkey,
      shouldContinue: input.isCurrent,
    })
  } catch {
    assertProductSupportRequestCurrent(input.isCurrent)
    throw new Error(
      "The product's current support routing could not be confirmed from relays. Retry before creating an invoice."
    )
  }
  assertProductSupportRequestCurrent(input.isCurrent)

  if (
    result.meta.source === "local_cache" ||
    isCommerceReadIncomplete(result.meta)
  ) {
    throw new Error(
      "The product's current support routing could not be confirmed from relays. Retry before creating an invoice."
    )
  }

  const currentRecord = findExactProductSupportRecord(
    result.data,
    productAddress
  )
  const currentProduct = currentRecord?.product
  if (
    !currentRecord ||
    !currentProduct ||
    currentRecord.addressId !== productAddress ||
    !routingEvidenceMatchesMeta(currentProduct, result.meta)
  ) {
    throw new Error(
      "The product's current support routing could not be confirmed from relays. Retry before creating an invoice."
    )
  }

  const routingError = getProductSupportZapRoutingError(currentProduct)
  if (routingError) throw new Error(routingError)

  const selectedRouting = input.product.supportZapRouting
  const currentRouting = currentProduct.supportZapRouting
  if (
    !selectedRouting ||
    !currentRouting ||
    currentRecord.eventId !== selectedRouting.eventId ||
    currentRecord.eventCreatedAt !== selectedRouting.eventCreatedAt ||
    currentRouting.eventId !== selectedRouting.eventId ||
    currentRouting.eventCreatedAt !== selectedRouting.eventCreatedAt ||
    currentRouting.productAddress !== selectedRouting.productAddress ||
    currentRouting.state !== selectedRouting.state ||
    normalizePubkey(currentProduct.pubkey) !==
      normalizePubkey(input.recipientPubkey)
  ) {
    throw new Error("The product support target changed. Refresh this product.")
  }
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
  > = defaultDependencies,
  readContext: Pick<
    ProfileBatchQuery,
    "accountPubkey" | "authenticatedPubkey" | "shouldContinue"
  > = {}
): Promise<string> {
  const normalizedRecipient = requireAccountPubkey(recipientPubkey, "recipient")
  let result: Awaited<ReturnType<typeof getProfiles>>
  try {
    result = await dependencies.getProfiles({
      ...readContext,
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
  const routingError = getProductSupportZapRoutingError(input.product)
  if (routingError) throw new Error(routingError)
  if (
    decodeProductReference(input.product.id)?.addressId !==
      decodeProductReference(input.productAddress)?.addressId ||
    normalizePubkey(input.product.pubkey) !==
      normalizePubkey(input.recipientPubkey)
  ) {
    throw new Error("The product support target changed. Refresh this product.")
  }
  const shopperPubkey = requireAccountPubkey(input.shopperPubkey, "shopper")
  await requireCurrentProductSupportRouting(input, shopperPubkey, dependencies)
  assertProductSupportRequestCurrent(input.isCurrent)
  const activeSignerPubkey = normalizePubkey(await input.signer.getPublicKey())
  assertProductSupportRequestCurrent(input.isCurrent)
  if (!activeSignerPubkey || activeSignerPubkey !== shopperPubkey) {
    throw new Error("The connected signer does not match this support account.")
  }

  const profileReadContext = {
    accountPubkey: shopperPubkey,
    authenticatedPubkey: shopperPubkey,
    shouldContinue: input.isCurrent,
  }
  const amountMsats = amountSatsToMsats(input.amountSats)
  const lud16 = await resolveProductSupportPaymentAddress(
    input.recipientPubkey,
    dependencies,
    profileReadContext
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
    dependencies,
    profileReadContext
  )
  assertProductSupportRequestCurrent(input.isCurrent)
  if (confirmedLud16 !== lud16) {
    throw new Error(
      "The merchant's Lightning address changed while the invoice was being prepared. The invoice was discarded. Try again."
    )
  }

  await requireCurrentProductSupportRouting(input, shopperPubkey, dependencies)
  assertProductSupportRequestCurrent(input.isCurrent)

  // The invoice can expire while either final evidence read is pending.
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
