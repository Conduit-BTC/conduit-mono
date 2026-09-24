import { nip19 } from "@nostr-dev-kit/ndk"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import {
  productSupplierAllocationSchema,
  type ProductSupplierAllocation,
  type ProductSupplierAllocationIssue,
  type ProductSupplierAllocationRecipient,
} from "../schemas"
import type { Product } from "../types"
import { normalizePubkey } from "../utils"
import type { WalletNetwork } from "../wallets"
import { EVENT_KINDS } from "./kinds"
import {
  fetchLnurlPayMetadata,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
  isValidLud16Address,
  type LnurlPayMetadata,
  validateLightningInvoiceForPayment,
} from "./lightning"
import {
  isValidNostrPublicKey,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export const PRODUCT_SUPPLIER_ALLOCATION_TAG = "zap"
export const PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG =
  "conduit_supplier_allocation"
export const PRODUCT_SUPPLIER_ALLOCATION_VERSION = "1"

export interface ProductSupplierAllocationAuthoringRecipient {
  identity: string
  relayHint?: string
  weight: number | string
}

export interface BuildProductSupplierAllocationInput {
  merchantPubkey: string
  merchantRelayHint?: string
  merchantWeight: number | string
  suppliers: readonly ProductSupplierAllocationAuthoringRecipient[]
}

export type BuildProductSupplierAllocationResult =
  | {
      ok: true
      allocation: ProductSupplierAllocation
      tags: string[][]
    }
  | {
      ok: false
      issues: ProductSupplierAllocationIssue[]
      recipients: ProductSupplierAllocationRecipient[]
    }

export interface ParseProductSupplierAllocationInput {
  tags: readonly (readonly string[])[] | undefined
  merchantPubkey: string
  signedRevisionEvent?: SignedPublicNostrEvent
}

export interface ProductSupplierAllocationShare {
  pubkey: string
  role: ProductSupplierAllocationRecipient["role"]
  sats: number
}

export type ProductSupplierAllocationEndpointState =
  "ready" | "unavailable" | "invalid"

export interface ProductSupplierAllocationEndpoint {
  pubkey: string
  role: ProductSupplierAllocationRecipient["role"]
  weight: number
  state: ProductSupplierAllocationEndpointState
  lud16?: string
}

export interface ProductSupplierAllocationEndpointResolution {
  state: ProductSupplierAllocationEndpointState | "not_configured"
  recipients: ProductSupplierAllocationEndpoint[]
}

export type ProductSupplierPaymentEndpointReason =
  | "allocation_invalid"
  | "revision_missing"
  | "revision_invalid"
  | "profile_missing"
  | "lud16_invalid"
  | "metadata_unavailable"
  | "nostr_unsupported"
  | "nostr_pubkey_invalid"

export type ProductSupplierPaymentEndpointState =
  "metadata_ready" | "unavailable" | "invalid"

export type ProductSupplierPaymentEndpoint = {
  pubkey: string
  role: ProductSupplierAllocationRecipient["role"]
  weight: number
  state: ProductSupplierPaymentEndpointState
  reason?: ProductSupplierPaymentEndpointReason
  lud16?: string
  expectedNetwork?: WalletNetwork
  minSendableMsats?: number
  maxSendableMsats?: number
  payRequestUrl?: string
  callback?: string
  allowsNostr?: boolean
  nostrPubkey?: string
}

export interface ProductSupplierPaymentEndpointResolution {
  state: ProductSupplierPaymentEndpointState | "not_configured"
  recipients: ProductSupplierPaymentEndpoint[]
  revisionEventId?: string
  revisionCreatedAt?: number
}

export interface ResolveProductSupplierPaymentEndpointsOptions {
  expectedNetwork: WalletNetwork
  fetchMetadata?: (lud16: string) => Promise<LnurlPayMetadata>
}

export type ProductSupplierPaymentInvoiceReadiness =
  | { state: "ready"; verifiedNetwork: WalletNetwork }
  | {
      state: "invalid"
      reason:
        | "metadata_not_ready"
        | "amount_out_of_range"
        | "invoice_network_unknown"
        | "invoice_network_mismatch"
        | "invoice_invalid"
    }

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

function normalizeAllocationIdentity(
  value: string | null | undefined
): string | null {
  const pubkey = normalizePubkey(value)
  return pubkey && isValidNostrPublicKey(pubkey) ? pubkey : null
}

function hasValidRecipientPubkeys(
  allocation: ProductSupplierAllocation
): boolean {
  return allocation.recipients.every((recipient) =>
    isValidNostrPublicKey(recipient.pubkey)
  )
}

function hasExactSignedAllocationTerms(
  allocation: ProductSupplierAllocation
): boolean {
  const revisionEvent = allocation.revisionEvent
  if (
    !revisionEvent ||
    !allocation.revisionEventId ||
    allocation.revisionCreatedAt === undefined ||
    revisionEvent.id.toLowerCase() !== allocation.revisionEventId ||
    revisionEvent.created_at !== allocation.revisionCreatedAt ||
    !isValidSignedPublicNostrEvent(revisionEvent)
  ) {
    return false
  }

  const verifiedAllocation = parseProductSupplierAllocationTags({
    merchantPubkey: revisionEvent.pubkey,
    tags: revisionEvent.tags,
    signedRevisionEvent: revisionEvent,
  })
  if (
    verifiedAllocation.state !== "valid" ||
    verifiedAllocation.revisionEventId !== allocation.revisionEventId ||
    verifiedAllocation.revisionCreatedAt !== allocation.revisionCreatedAt ||
    verifiedAllocation.recipients.length !== allocation.recipients.length
  ) {
    return false
  }

  return verifiedAllocation.recipients.every((verifiedRecipient, index) => {
    const recipient = allocation.recipients[index]
    return (
      recipient !== undefined &&
      verifiedRecipient.pubkey === recipient.pubkey &&
      verifiedRecipient.relayHint === recipient.relayHint &&
      verifiedRecipient.weight === recipient.weight &&
      verifiedRecipient.role === recipient.role
    )
  })
}

export type ProductSupplierAllocationEvidenceState =
  "absent" | "invalid" | "unverified" | "signed"

/**
 * A syntactically valid allocation is not necessarily evidence from this
 * product's exact signed revision. Keep that distinction in read-side UI.
 */
export function getProductSupplierAllocationEvidenceState(
  product: Pick<
    Product,
    "id" | "pubkey" | "sourceEventId" | "updatedAt" | "supplierAllocation"
  >
): ProductSupplierAllocationEvidenceState {
  const allocation = product.supplierAllocation
  if (!allocation || allocation.state === "absent") return "absent"
  if (allocation.state === "invalid") return "invalid"
  if (!hasExactSignedAllocationTerms(allocation)) return "unverified"

  const revisionEvent = allocation.revisionEvent!
  const dTags = revisionEvent.tags.filter((tag) => tag[0] === "d")
  const dTag = dTags[0]?.[1]
  if (
    revisionEvent.kind !== EVENT_KINDS.PRODUCT ||
    revisionEvent.pubkey !== product.pubkey ||
    dTags.length !== 1 ||
    !dTag ||
    product.id !== `${EVENT_KINDS.PRODUCT}:${revisionEvent.pubkey}:${dTag}` ||
    product.updatedAt !== revisionEvent.created_at * 1_000 ||
    (product.sourceEventId !== undefined &&
      product.sourceEventId !== allocation.revisionEventId)
  ) {
    return "unverified"
  }

  return "signed"
}

function uniqueIssues(
  issues: readonly ProductSupplierAllocationIssue[]
): ProductSupplierAllocationIssue[] {
  return Array.from(new Set(issues))
}

function parsePositiveWeight(value: unknown): number | null {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : ""
  if (!POSITIVE_INTEGER_PATTERN.test(normalized)) return null

  const weight = Number(normalized)
  return Number.isSafeInteger(weight) && weight > 0 ? weight : null
}

function getNprofileRelayHints(identity: string): string[] {
  try {
    const decoded = nip19.decode(identity.trim())
    const relays =
      decoded.data && typeof decoded.data === "object"
        ? (decoded.data as { relays?: unknown }).relays
        : undefined
    if (decoded.type !== "nprofile" || !Array.isArray(relays)) {
      return []
    }

    return relays.filter((relay): relay is string => typeof relay === "string")
  } catch {
    return []
  }
}

function resolveRelayHint(
  identity: string,
  explicitRelayHint: string | undefined
): string | null {
  const candidates = [explicitRelayHint, ...getNprofileRelayHints(identity)]

  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const normalized = normalizePublicWebSocketUrl(candidate)
    if (normalized) return normalized
  }

  return null
}

function createRecipient(
  input: ProductSupplierAllocationAuthoringRecipient,
  role: ProductSupplierAllocationRecipient["role"],
  issues: ProductSupplierAllocationIssue[]
): ProductSupplierAllocationRecipient | null {
  const pubkey = normalizeAllocationIdentity(input.identity)
  if (!pubkey) {
    issues.push(role === "merchant" ? "invalid_author" : "invalid_recipient")
    return null
  }

  const relayHint = resolveRelayHint(input.identity, input.relayHint)
  if (!relayHint) {
    issues.push("invalid_relay_hint")
    return null
  }

  const weight = parsePositiveWeight(input.weight)
  if (weight === null) {
    issues.push("invalid_weight")
    return null
  }

  return { pubkey, relayHint, weight, role }
}

function validateRecipientSet(
  recipients: readonly ProductSupplierAllocationRecipient[],
  merchantPubkey: string | null,
  issues: ProductSupplierAllocationIssue[]
): void {
  const seen = new Set<string>()
  let merchantCount = 0
  let supplierCount = 0
  let totalWeight = 0

  for (const recipient of recipients) {
    if (seen.has(recipient.pubkey)) issues.push("duplicate_recipient")
    seen.add(recipient.pubkey)

    if (recipient.pubkey === merchantPubkey) merchantCount += 1
    else supplierCount += 1

    totalWeight += recipient.weight
    if (!Number.isSafeInteger(totalWeight)) {
      issues.push("weight_total_overflow")
    }
  }

  if (merchantCount === 0) issues.push("missing_merchant")
  if (merchantCount > 1) issues.push("duplicate_merchant")
  if (supplierCount === 0) issues.push("missing_supplier")
}

export function emitProductSupplierAllocationTags(
  allocation: ProductSupplierAllocation
): string[][] {
  if (allocation.state !== "valid") return []
  if (!hasValidRecipientPubkeys(allocation)) {
    throw new Error("Product supplier allocation contains an invalid pubkey")
  }
  const validated = productSupplierAllocationSchema.safeParse(allocation)
  if (!validated.success) {
    throw new Error("Product supplier allocation is not internally valid")
  }
  return [
    [
      PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG,
      PRODUCT_SUPPLIER_ALLOCATION_VERSION,
    ],
    ...validated.data.recipients.map((recipient) => [
      PRODUCT_SUPPLIER_ALLOCATION_TAG,
      recipient.pubkey,
      recipient.relayHint,
      String(recipient.weight),
    ]),
  ]
}

export function buildProductSupplierAllocation(
  input: BuildProductSupplierAllocationInput
): BuildProductSupplierAllocationResult {
  const issues: ProductSupplierAllocationIssue[] = []
  const merchantPubkey = normalizeAllocationIdentity(input.merchantPubkey)
  const recipients: ProductSupplierAllocationRecipient[] = []

  const merchant = createRecipient(
    {
      identity: input.merchantPubkey,
      relayHint: input.merchantRelayHint,
      weight: input.merchantWeight,
    },
    "merchant",
    issues
  )
  if (merchant) recipients.push(merchant)

  for (const supplier of input.suppliers) {
    const recipient = createRecipient(supplier, "supplier", issues)
    if (recipient) recipients.push(recipient)
  }

  validateRecipientSet(recipients, merchantPubkey, issues)
  const normalizedIssues = uniqueIssues(issues)
  if (normalizedIssues.length > 0) {
    return { ok: false, issues: normalizedIssues, recipients }
  }

  const allocation: ProductSupplierAllocation = {
    state: "valid",
    recipients,
    issues: [],
  }
  return {
    ok: true,
    allocation,
    tags: emitProductSupplierAllocationTags(allocation),
  }
}

export function parseProductSupplierAllocationTags(
  input: ParseProductSupplierAllocationInput
): ProductSupplierAllocation {
  const versionTags = (input.tags ?? []).filter(
    (tag) => tag[0] === PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG
  )
  if (versionTags.length === 0) {
    return { state: "absent", recipients: [], issues: [] }
  }

  const zapTags = (input.tags ?? []).filter(
    (tag) => tag[0] === PRODUCT_SUPPLIER_ALLOCATION_TAG
  )
  const issues: ProductSupplierAllocationIssue[] = []
  if (
    versionTags.length !== 1 ||
    versionTags[0]?.length !== 2 ||
    versionTags[0]?.[1] !== PRODUCT_SUPPLIER_ALLOCATION_VERSION
  ) {
    issues.push("invalid_version")
  }
  const merchantPubkey = normalizeAllocationIdentity(input.merchantPubkey)
  if (!merchantPubkey) issues.push("invalid_author")
  const recipients: ProductSupplierAllocationRecipient[] = []

  for (const tag of zapTags) {
    const pubkey = normalizeAllocationIdentity(tag[1])
    if (!pubkey) {
      issues.push("invalid_recipient")
      continue
    }
    const relayHint = normalizePublicWebSocketUrl(tag[2])
    if (!relayHint) {
      issues.push("invalid_relay_hint")
      continue
    }
    const weight = parsePositiveWeight(tag[3])
    if (weight === null) {
      issues.push("invalid_weight")
      continue
    }

    recipients.push({
      pubkey,
      relayHint,
      weight,
      role: pubkey === merchantPubkey ? "merchant" : "supplier",
    })
  }

  validateRecipientSet(recipients, merchantPubkey, issues)
  const normalizedIssues = uniqueIssues(issues)
  const signedRevisionEvent = input.signedRevisionEvent
  const hasExactSignedRevision =
    !!signedRevisionEvent &&
    !!merchantPubkey &&
    signedRevisionEvent.kind === EVENT_KINDS.PRODUCT &&
    signedRevisionEvent.pubkey.toLowerCase() === merchantPubkey &&
    JSON.stringify(signedRevisionEvent.tags) ===
      JSON.stringify(input.tags ?? []) &&
    isValidSignedPublicNostrEvent(signedRevisionEvent)

  return {
    state: normalizedIssues.length === 0 ? "valid" : "invalid",
    recipients,
    issues: normalizedIssues,
    ...(hasExactSignedRevision
      ? {
          revisionEventId: signedRevisionEvent.id.toLowerCase(),
          revisionCreatedAt: signedRevisionEvent.created_at,
          revisionEvent: {
            ...signedRevisionEvent,
            kind: EVENT_KINDS.PRODUCT,
            tags: signedRevisionEvent.tags.map((tag) => [...tag]),
          },
        }
      : {}),
  }
}

export function allocateProductSupplierShares(
  totalSats: number,
  allocation: ProductSupplierAllocation
): ProductSupplierAllocationShare[] {
  if (!Number.isSafeInteger(totalSats) || totalSats < 0) {
    throw new Error("Allocation total must be a non-negative safe integer")
  }
  if (allocation.state !== "valid") {
    throw new Error("A valid signed supplier allocation is required")
  }

  const merchantIndex = allocation.recipients.findIndex(
    (recipient) => recipient.role === "merchant"
  )
  if (merchantIndex < 0) {
    throw new Error("Supplier allocation requires a merchant remainder")
  }

  const totalWeight = allocation.recipients.reduce(
    (sum, recipient) => sum + BigInt(recipient.weight),
    0n
  )
  if (totalWeight <= 0n) {
    throw new Error("Supplier allocation requires positive weights")
  }

  const shares = allocation.recipients.map((recipient) => ({
    pubkey: recipient.pubkey,
    role: recipient.role,
    sats: Number((BigInt(totalSats) * BigInt(recipient.weight)) / totalWeight),
  }))
  const allocated = shares.reduce((sum, share) => sum + share.sats, 0)
  shares[merchantIndex]!.sats += totalSats - allocated
  return shares
}

export function resolveProductSupplierAllocationEndpoints(
  allocation: ProductSupplierAllocation | undefined,
  profilesByPubkey: Readonly<
    Record<string, { lud16?: string | null } | null | undefined>
  >
): ProductSupplierAllocationEndpointResolution {
  if (!allocation || allocation.state === "absent") {
    return { state: "not_configured", recipients: [] }
  }
  if (allocation.state === "invalid") {
    return { state: "invalid", recipients: [] }
  }
  if (!hasValidRecipientPubkeys(allocation)) {
    return {
      state: "invalid",
      recipients: allocation.recipients.map((recipient) => ({
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "invalid",
      })),
    }
  }
  const recipients = allocation.recipients.map((recipient) => {
    const rawLud16 = profilesByPubkey[recipient.pubkey]?.lud16
    const lud16 = typeof rawLud16 === "string" ? rawLud16.trim() : ""
    if (!lud16) {
      return {
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "unavailable" as const,
      }
    }
    if (!isValidLud16Address(lud16)) {
      return {
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "invalid" as const,
      }
    }
    return {
      pubkey: recipient.pubkey,
      role: recipient.role,
      weight: recipient.weight,
      state: "ready" as const,
      lud16: lud16.toLowerCase(),
    }
  })

  const state = recipients.some((recipient) => recipient.state === "invalid")
    ? "invalid"
    : recipients.some((recipient) => recipient.state === "unavailable")
      ? "unavailable"
      : "ready"
  return { state, recipients }
}

export async function resolveProductSupplierPaymentEndpoints(
  allocation: ProductSupplierAllocation | undefined,
  profilesByPubkey: Readonly<
    Record<string, { lud16?: string | null } | null | undefined>
  >,
  options: ResolveProductSupplierPaymentEndpointsOptions
): Promise<ProductSupplierPaymentEndpointResolution> {
  if (!allocation || allocation.state === "absent") {
    return { state: "not_configured", recipients: [] }
  }
  if (allocation.state === "invalid") {
    return {
      state: "invalid",
      recipients: allocation.recipients.map((recipient) => ({
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "invalid",
        reason: "allocation_invalid",
      })),
      ...(allocation.revisionEventId
        ? { revisionEventId: allocation.revisionEventId }
        : {}),
      ...(allocation.revisionCreatedAt !== undefined
        ? { revisionCreatedAt: allocation.revisionCreatedAt }
        : {}),
    }
  }
  if (!hasValidRecipientPubkeys(allocation)) {
    return {
      state: "invalid",
      recipients: allocation.recipients.map((recipient) => ({
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "invalid",
        reason: "allocation_invalid",
      })),
      ...(allocation.revisionEventId
        ? { revisionEventId: allocation.revisionEventId }
        : {}),
      ...(allocation.revisionCreatedAt !== undefined
        ? { revisionCreatedAt: allocation.revisionCreatedAt }
        : {}),
    }
  }
  if (
    !allocation.revisionEvent ||
    !allocation.revisionEventId ||
    allocation.revisionCreatedAt === undefined
  ) {
    return {
      state: "invalid",
      recipients: allocation.recipients.map((recipient) => ({
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "invalid",
        reason: "revision_missing",
      })),
      ...(allocation.revisionEventId
        ? { revisionEventId: allocation.revisionEventId }
        : {}),
      ...(allocation.revisionCreatedAt !== undefined
        ? { revisionCreatedAt: allocation.revisionCreatedAt }
        : {}),
    }
  }
  if (!hasExactSignedAllocationTerms(allocation)) {
    return {
      state: "invalid",
      recipients: allocation.recipients.map((recipient) => ({
        pubkey: recipient.pubkey,
        role: recipient.role,
        weight: recipient.weight,
        state: "invalid",
        reason: "revision_invalid",
      })),
      revisionEventId: allocation.revisionEventId,
      revisionCreatedAt: allocation.revisionCreatedAt,
    }
  }

  const fetchMetadata = options.fetchMetadata ?? fetchLnurlPayMetadata
  const recipients = await Promise.all(
    allocation.recipients.map(
      async (recipient): Promise<ProductSupplierPaymentEndpoint> => {
        const rawLud16 = profilesByPubkey[recipient.pubkey]?.lud16
        const lud16 = typeof rawLud16 === "string" ? rawLud16.trim() : ""
        if (!lud16) {
          return {
            pubkey: recipient.pubkey,
            role: recipient.role,
            weight: recipient.weight,
            state: "unavailable",
            reason: "profile_missing",
          }
        }
        if (!isValidLud16Address(lud16)) {
          return {
            pubkey: recipient.pubkey,
            role: recipient.role,
            weight: recipient.weight,
            state: "invalid",
            reason: "lud16_invalid",
          }
        }

        try {
          const metadata = await fetchMetadata(lud16.toLowerCase())
          if (!metadata.allowsNostr) {
            return {
              pubkey: recipient.pubkey,
              role: recipient.role,
              weight: recipient.weight,
              state: "unavailable",
              reason: "nostr_unsupported",
              lud16: lud16.toLowerCase(),
              expectedNetwork: options.expectedNetwork,
              minSendableMsats: metadata.minSendable,
              maxSendableMsats: metadata.maxSendable,
              payRequestUrl: metadata.payRequestUrl,
              callback: metadata.callback,
              allowsNostr: false,
            }
          }
          const nostrPubkey = isValidNostrPublicKey(metadata.nostrPubkey)
            ? metadata.nostrPubkey!.toLowerCase()
            : null
          if (!nostrPubkey) {
            return {
              pubkey: recipient.pubkey,
              role: recipient.role,
              weight: recipient.weight,
              state: "invalid",
              reason: "nostr_pubkey_invalid",
              lud16: lud16.toLowerCase(),
              expectedNetwork: options.expectedNetwork,
              minSendableMsats: metadata.minSendable,
              maxSendableMsats: metadata.maxSendable,
              payRequestUrl: metadata.payRequestUrl,
              callback: metadata.callback,
              allowsNostr: true,
            }
          }
          // LNURL-pay metadata does not identify the Lightning network. The
          // expected network is a requirement, not verified provider evidence.
          return {
            pubkey: recipient.pubkey,
            role: recipient.role,
            weight: recipient.weight,
            state: "metadata_ready",
            lud16: lud16.toLowerCase(),
            expectedNetwork: options.expectedNetwork,
            minSendableMsats: metadata.minSendable,
            maxSendableMsats: metadata.maxSendable,
            payRequestUrl: metadata.payRequestUrl,
            callback: metadata.callback,
            allowsNostr: true,
            nostrPubkey,
          }
        } catch {
          return {
            pubkey: recipient.pubkey,
            role: recipient.role,
            weight: recipient.weight,
            state: "unavailable",
            reason: "metadata_unavailable",
            lud16: lud16.toLowerCase(),
            expectedNetwork: options.expectedNetwork,
          }
        }
      }
    )
  )
  const state = recipients.some((recipient) => recipient.state === "invalid")
    ? "invalid"
    : recipients.some((recipient) => recipient.state === "unavailable")
      ? "unavailable"
      : "metadata_ready"
  return {
    state,
    recipients,
    ...(allocation.revisionEventId
      ? { revisionEventId: allocation.revisionEventId }
      : {}),
    ...(allocation.revisionCreatedAt !== undefined
      ? { revisionCreatedAt: allocation.revisionCreatedAt }
      : {}),
  }
}

/**
 * An endpoint with valid metadata becomes invoice-ready only after the actual
 * callback invoice satisfies its required network, amount, and expiry. The
 * caller remains responsible for obtaining that invoice from the endpoint's
 * callback and for any separate NIP-57 zap-request binding.
 */
export function validateProductSupplierPaymentInvoice(
  endpoint: ProductSupplierPaymentEndpoint,
  invoice: string,
  expectedAmountMsats: number,
  nowSeconds?: number
): ProductSupplierPaymentInvoiceReadiness {
  if (
    endpoint.state !== "metadata_ready" ||
    !endpoint.expectedNetwork ||
    endpoint.minSendableMsats === undefined ||
    endpoint.maxSendableMsats === undefined
  ) {
    return { state: "invalid", reason: "metadata_not_ready" }
  }
  if (
    !Number.isSafeInteger(expectedAmountMsats) ||
    expectedAmountMsats < endpoint.minSendableMsats ||
    expectedAmountMsats > endpoint.maxSendableMsats
  ) {
    return { state: "invalid", reason: "amount_out_of_range" }
  }

  const invoiceNetwork = getLightningInvoiceNetwork(invoice)
  if (invoiceNetwork === "unknown") {
    return { state: "invalid", reason: "invoice_network_unknown" }
  }
  if (invoiceNetwork !== endpoint.expectedNetwork) {
    return { state: "invalid", reason: "invoice_network_mismatch" }
  }
  const validation = validateLightningInvoiceForPayment({
    invoice,
    expectedAmountMsats,
    expectedNetwork: endpoint.expectedNetwork,
    ...(nowSeconds === undefined ? {} : { nowSeconds }),
  })
  if (!validation.ok || !isValidLightningInvoice(invoice)) {
    return { state: "invalid", reason: "invoice_invalid" }
  }
  return { state: "ready", verifiedNetwork: invoiceNetwork }
}
