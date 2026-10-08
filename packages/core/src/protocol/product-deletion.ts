import { EVENT_KINDS } from "./kinds"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"

const HEX_64 = /^[0-9a-f]{64}$/i

export type ProductAddressCoordinate = Readonly<{
  kind: typeof EVENT_KINDS.PRODUCT
  authorPubkey: string
  dTag: string
  addressId: string
}>

export type ProductDeletionTarget = Readonly<{
  authorPubkey: string
  eventId: string | null
  addressId: string | null
  eventKey: string | null
  addressKey: string | null
  tags: readonly (readonly string[])[]
}>

export type ProductDeletionEvidence =
  | Readonly<{
      target: "event"
      deletionEventId: string
      authorPubkey: string
      deletedAt: number
      eventId: string
    }>
  | Readonly<{
      target: "address"
      deletionEventId: string
      authorPubkey: string
      deletedAt: number
      addressId: string
    }>

export type ProductDeletionCandidate = Readonly<{
  authorPubkey: string
  eventId?: string | null
  addressId?: string | null
  createdAt?: number | null
}>

export type ProductDeletionResolution =
  | Readonly<{
      deleted: false
      matchedBy: null
      evidence: null
    }>
  | Readonly<{
      deleted: true
      matchedBy: ProductDeletionEvidence["target"]
      evidence: ProductDeletionEvidence
    }>

export type ValidatedProductDeletion = Readonly<{
  signedEvent: VerifiedNostrEvent
  evidence: readonly ProductDeletionEvidence[]
}>

function normalizeHex64(value: string | null | undefined): string | null {
  return value && HEX_64.test(value) ? value.toLowerCase() : null
}

function isValidEventTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function parseProductAddressCoordinate(
  value: string | null | undefined
): ProductAddressCoordinate | null {
  if (!value) return null

  const kindSeparator = value.indexOf(":")
  const authorSeparator = value.indexOf(":", kindSeparator + 1)
  if (kindSeparator < 1 || authorSeparator < 0) return null

  const kind = value.slice(0, kindSeparator)
  const authorPubkey = normalizeHex64(
    value.slice(kindSeparator + 1, authorSeparator)
  )
  const dTag = value.slice(authorSeparator + 1)
  if (
    kind !== String(EVENT_KINDS.PRODUCT) ||
    !authorPubkey ||
    dTag.length === 0
  ) {
    return null
  }

  return {
    kind: EVENT_KINDS.PRODUCT,
    authorPubkey,
    dTag,
    addressId: `${EVENT_KINDS.PRODUCT}:${authorPubkey}:${dTag}`,
  }
}

/**
 * Normalizes a stored product reference to its kind-30402 address coordinate.
 * Bare legacy d-tags are prefixed with the owning merchant so V1 cart storage
 * migrates unchanged; full coordinates must parse and stay merchant-scoped.
 */
export function normalizeProductCoordinate(
  storedProductId: string,
  merchantPubkey: string
): string | null {
  if (!storedProductId.startsWith(`${EVENT_KINDS.PRODUCT}:`)) {
    return `${EVENT_KINDS.PRODUCT}:${merchantPubkey}:${storedProductId}`
  }
  const address = parseProductAddressCoordinate(storedProductId)
  return address && address.authorPubkey === merchantPubkey
    ? address.addressId
    : null
}

export function productDeletionEventKey(
  authorPubkey: string,
  eventId: string
): string | null {
  const normalizedAuthor = normalizeHex64(authorPubkey)
  const normalizedEventId = normalizeHex64(eventId)
  return normalizedAuthor && normalizedEventId
    ? `e:${normalizedAuthor}:${normalizedEventId}`
    : null
}

export function productDeletionAddressKey(addressId: string): string | null {
  const address = parseProductAddressCoordinate(addressId)
  return address ? `a:${address.addressId}` : null
}

export function buildProductDeletionTarget(input: {
  authorPubkey: string
  eventId?: string | null
  addressId?: string | null
}): ProductDeletionTarget {
  const authorPubkey = normalizeHex64(input.authorPubkey)
  if (!authorPubkey) {
    throw new Error("Product deletion author pubkey is invalid.")
  }

  const eventId = normalizeHex64(input.eventId)
  const parsedAddress = parseProductAddressCoordinate(input.addressId)
  const addressId =
    parsedAddress?.authorPubkey === authorPubkey
      ? parsedAddress.addressId
      : null

  if (!eventId && !addressId) {
    throw new Error(
      "Product deletion requires a valid event id or same-author product address."
    )
  }

  const tags: (readonly string[])[] = []
  if (eventId) tags.push(["e", eventId])
  if (addressId) tags.push(["a", addressId])
  tags.push(["k", String(EVENT_KINDS.PRODUCT)])

  return {
    authorPubkey,
    eventId,
    addressId,
    eventKey: eventId ? productDeletionEventKey(authorPubkey, eventId) : null,
    addressKey: addressId ? productDeletionAddressKey(addressId) : null,
    tags,
  }
}

function extractProductDeletionEvidence(
  event: VerifiedNostrEvent
): readonly ProductDeletionEvidence[] {
  const authorPubkey = event.pubkey.toLowerCase()
  const deletionEventId = event.id.toLowerCase()
  const evidence = new Map<string, ProductDeletionEvidence>()

  for (const [tagName, tagValue] of event.tags) {
    if (tagName === "e") {
      const eventId = normalizeHex64(tagValue)
      if (!eventId) continue
      const key = productDeletionEventKey(authorPubkey, eventId)
      if (!key) continue
      evidence.set(key, {
        target: "event",
        deletionEventId,
        authorPubkey,
        deletedAt: event.created_at,
        eventId,
      })
      continue
    }

    if (tagName === "a") {
      const address = parseProductAddressCoordinate(tagValue)
      if (!address || address.authorPubkey !== authorPubkey) continue
      const key = productDeletionAddressKey(address.addressId)
      if (!key) continue
      evidence.set(key, {
        target: "address",
        deletionEventId,
        authorPubkey,
        deletedAt: event.created_at,
        addressId: address.addressId,
      })
    }
  }

  return Array.from(evidence.values())
}

/**
 * Parse one previously admitted product deletion and its same-author targets.
 * The trusted event keeps the exact immutable bytes admitted by the public
 * verification boundary.
 */
export function validateProductDeletionEvent(
  event: SignedPublicNostrEvent | VerifiedNostrEvent
): ValidatedProductDeletion | null {
  if (event.kind !== EVENT_KINDS.DELETION || !isVerifiedNostrEvent(event)) {
    return null
  }

  return {
    signedEvent: event,
    evidence: extractProductDeletionEvidence(event),
  }
}

/**
 * Safe default for callers that only need evidence from an admitted event.
 */
export function productDeletionEvidenceFromSignedEvent(
  event: SignedPublicNostrEvent | VerifiedNostrEvent
): readonly ProductDeletionEvidence[] | null {
  return validateProductDeletionEvent(event)?.evidence ?? null
}

function isValidEvidenceIdentity(evidence: ProductDeletionEvidence): boolean {
  return (
    normalizeHex64(evidence.deletionEventId) !== null &&
    normalizeHex64(evidence.authorPubkey) !== null &&
    isValidEventTimestamp(evidence.deletedAt)
  )
}

function compareEvidence(
  left: ProductDeletionEvidence,
  right: ProductDeletionEvidence
): number {
  if (left.deletedAt !== right.deletedAt) {
    return right.deletedAt - left.deletedAt
  }
  if (left.deletionEventId < right.deletionEventId) return -1
  if (left.deletionEventId > right.deletionEventId) return 1
  return 0
}

/** Index one immutable evidence snapshot for all products in a synchronous read. */
export function prepareProductDeletionResolver(
  evidence: readonly ProductDeletionEvidence[]
): (candidate: ProductDeletionCandidate) => ProductDeletionResolution {
  const byEvent = new Map<string, ProductDeletionEvidence>()
  const byAddress = new Map<string, ProductDeletionEvidence>()

  for (const item of evidence) {
    if (!isValidEvidenceIdentity(item)) continue
    const authorPubkey = item.authorPubkey.toLowerCase()
    const target = item.target
    if (target === "event") {
      const eventId = normalizeHex64(item.eventId)
      if (!eventId) continue
      const key = `${authorPubkey}:${eventId}`
      const previous = byEvent.get(key)
      if (!previous || compareEvidence(item, previous) < 0)
        byEvent.set(key, item)
    } else if (target === "address") {
      const address = parseProductAddressCoordinate(item.addressId)
      if (!address || address.authorPubkey !== authorPubkey) continue
      const previous = byAddress.get(address.addressId)
      if (!previous || compareEvidence(item, previous) < 0)
        byAddress.set(address.addressId, item)
    }
  }

  return (candidate) => {
    const authorPubkey = normalizeHex64(candidate.authorPubkey)
    if (authorPubkey) {
      const eventId = normalizeHex64(candidate.eventId)
      const exact = eventId
        ? byEvent.get(`${authorPubkey}:${eventId}`)
        : undefined
      if (exact) return { deleted: true, matchedBy: "event", evidence: exact }

      const address = parseProductAddressCoordinate(candidate.addressId)
      const createdAt = candidate.createdAt
      if (
        address?.authorPubkey === authorPubkey &&
        typeof createdAt === "number" &&
        isValidEventTimestamp(createdAt)
      ) {
        const matched = byAddress.get(address.addressId)
        if (matched && matched.deletedAt >= createdAt)
          return { deleted: true, matchedBy: "address", evidence: matched }
      }
    }
    return { deleted: false, matchedBy: null, evidence: null }
  }
}

export function resolveProductDeletion(
  candidate: ProductDeletionCandidate,
  evidence: readonly ProductDeletionEvidence[]
): ProductDeletionResolution {
  return prepareProductDeletionResolver(evidence)(candidate)
}

export function isProductDeletedByNip09(
  candidate: ProductDeletionCandidate,
  evidence: readonly ProductDeletionEvidence[]
): boolean {
  return resolveProductDeletion(candidate, evidence).deleted
}
