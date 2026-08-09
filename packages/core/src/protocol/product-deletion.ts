import { EVENT_KINDS } from "./kinds"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

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
  signedEvent: SignedPublicNostrEvent
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
  event: SignedPublicNostrEvent
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

function cloneSignedEvent(
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

/**
 * Validate and parse one product deletion atomically.
 *
 * Callers that need both the exact signed event and its targets should use this
 * boundary so evidence extraction never repeats the Schnorr verification. The
 * returned event is a defensive clone of the bytes that were validated.
 */
export function validateProductDeletionEvent(
  event: SignedPublicNostrEvent
): ValidatedProductDeletion | null {
  if (
    event.kind !== EVENT_KINDS.DELETION ||
    !isValidSignedPublicNostrEvent(event)
  ) {
    return null
  }

  const signedEvent = cloneSignedEvent(event)
  return {
    signedEvent,
    evidence: extractProductDeletionEvidence(signedEvent),
  }
}

/**
 * Safe default for callers that only need evidence. Signature validation is
 * always performed exactly once before any targets are returned.
 */
export function productDeletionEvidenceFromSignedEvent(
  event: SignedPublicNostrEvent
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

function findExactEventEvidence(
  candidate: ProductDeletionCandidate,
  evidence: readonly ProductDeletionEvidence[]
): ProductDeletionEvidence | null {
  const authorPubkey = normalizeHex64(candidate.authorPubkey)
  const eventId = normalizeHex64(candidate.eventId)
  if (!authorPubkey || !eventId) return null

  return (
    evidence
      .filter(
        (item) =>
          item.target === "event" &&
          isValidEvidenceIdentity(item) &&
          item.authorPubkey.toLowerCase() === authorPubkey &&
          normalizeHex64(item.eventId) === eventId
      )
      .sort(compareEvidence)[0] ?? null
  )
}

function findAddressEvidence(
  candidate: ProductDeletionCandidate,
  evidence: readonly ProductDeletionEvidence[]
): ProductDeletionEvidence | null {
  const authorPubkey = normalizeHex64(candidate.authorPubkey)
  const address = parseProductAddressCoordinate(candidate.addressId)
  const createdAt = candidate.createdAt
  if (
    !authorPubkey ||
    !address ||
    address.authorPubkey !== authorPubkey ||
    typeof createdAt !== "number" ||
    !isValidEventTimestamp(createdAt)
  ) {
    return null
  }

  return (
    evidence
      .filter((item) => {
        if (
          item.target !== "address" ||
          !isValidEvidenceIdentity(item) ||
          item.authorPubkey.toLowerCase() !== authorPubkey ||
          item.deletedAt < createdAt
        ) {
          return false
        }
        const evidenceAddress = parseProductAddressCoordinate(item.addressId)
        return (
          evidenceAddress?.authorPubkey === authorPubkey &&
          evidenceAddress.addressId === address.addressId
        )
      })
      .sort(compareEvidence)[0] ?? null
  )
}

export function resolveProductDeletion(
  candidate: ProductDeletionCandidate,
  evidence: readonly ProductDeletionEvidence[]
): ProductDeletionResolution {
  const exactEventEvidence = findExactEventEvidence(candidate, evidence)
  if (exactEventEvidence) {
    return {
      deleted: true,
      matchedBy: "event",
      evidence: exactEventEvidence,
    }
  }

  const addressEvidence = findAddressEvidence(candidate, evidence)
  if (addressEvidence) {
    return {
      deleted: true,
      matchedBy: "address",
      evidence: addressEvidence,
    }
  }

  return {
    deleted: false,
    matchedBy: null,
    evidence: null,
  }
}

export function isProductDeletedByNip09(
  candidate: ProductDeletionCandidate,
  evidence: readonly ProductDeletionEvidence[]
): boolean {
  return resolveProductDeletion(candidate, evidence).deleted
}
