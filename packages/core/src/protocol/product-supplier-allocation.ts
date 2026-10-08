import { nip19 } from "@nostr-dev-kit/ndk"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import {
  productSupplierAllocationSchema,
  type ProductSupplierAllocation,
  type ProductSupplierAllocationIssue,
  type ProductSupplierAllocationRecipient,
} from "../schemas"
import { normalizePubkey } from "../utils"
import { EVENT_KINDS } from "./kinds"
import {
  isValidNostrPublicKey,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { isVerifiedNostrEvent } from "./verified-public-event"

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

/** Safe public discovery hints only; never private-inbox or payment authority. */
export function resolveProductSupplierAllocationRelayHint(
  identity: string,
  explicitRelayHint?: string
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

  const relayHint = resolveProductSupplierAllocationRelayHint(
    input.identity,
    input.relayHint
  )
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
  const signedRevisionEvent = input.signedRevisionEvent
  const merchantPubkey = normalizeAllocationIdentity(input.merchantPubkey)
  const hasExactSignedRevision =
    !!signedRevisionEvent &&
    !!merchantPubkey &&
    signedRevisionEvent.kind === EVENT_KINDS.PRODUCT &&
    signedRevisionEvent.pubkey.toLowerCase() === merchantPubkey &&
    JSON.stringify(signedRevisionEvent.tags) ===
      JSON.stringify(input.tags ?? []) &&
    // Only the exact opaque admission object can reuse public proof. Raw
    // private history and copied/persisted events retain independent checks.
    (isVerifiedNostrEvent(signedRevisionEvent) ||
      isValidSignedPublicNostrEvent(signedRevisionEvent))
  const signedRevision = hasExactSignedRevision
    ? {
        revisionEventId: signedRevisionEvent.id.toLowerCase(),
        revisionCreatedAt: signedRevisionEvent.created_at,
        revisionEvent: {
          id: signedRevisionEvent.id,
          pubkey: signedRevisionEvent.pubkey,
          created_at: signedRevisionEvent.created_at,
          kind: EVENT_KINDS.PRODUCT,
          tags: signedRevisionEvent.tags.map((tag) => [...tag]),
          content: signedRevisionEvent.content,
          sig: signedRevisionEvent.sig,
        },
      }
    : {}
  const versionTags = (input.tags ?? []).filter(
    (tag) => tag[0] === PRODUCT_SUPPLIER_ALLOCATION_VERSION_TAG
  )
  if (versionTags.length === 0) {
    // An unmarked product may carry ordinary NIP-57 zap metadata. Preserve
    // its exact signed revision so checkout can prove allocation absence.
    return { state: "absent", recipients: [], issues: [], ...signedRevision }
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
  return {
    state: normalizedIssues.length === 0 ? "valid" : "invalid",
    recipients,
    issues: normalizedIssues,
    ...signedRevision,
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
