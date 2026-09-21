import { schnorr } from "@noble/curves/secp256k1.js"
import { hexToBytes } from "@noble/curves/utils.js"
import { sha256 } from "@noble/hashes/sha2.js"

export type SignedPublicNostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface ReplaceableEventFrontier {
  createdAt?: number
  eventId?: string
}

const HEX_64 = /^[0-9a-f]{64}$/i

/**
 * Validate one Nostr x-only public key against the BIP-340 secp256k1 curve.
 * Shape-only 32-byte hex values are not necessarily usable public keys.
 */
export function isValidNostrPublicKey(
  value: string | null | undefined
): boolean {
  if (!value || !HEX_64.test(value)) return false

  try {
    schnorr.utils.lift_x(BigInt(`0x${value}`))
    return true
  } catch {
    return false
  }
}

function normalizeFrontierCreatedAt(
  value: number | undefined
): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function normalizeFrontierEventId(
  value: string | undefined
): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized || undefined
}

/**
 * Compare NIP-01 replaceable-event frontiers. The newer timestamp wins and
 * the lexicographically lowest event id wins a timestamp tie. A positive
 * result means `candidate` wins. Known signed evidence wins over a legacy
 * projection that lacks the corresponding frontier field.
 */
export function compareReplaceableEventFrontiers(
  candidate: ReplaceableEventFrontier,
  current: ReplaceableEventFrontier
): -1 | 0 | 1 {
  const candidateCreatedAt = normalizeFrontierCreatedAt(candidate.createdAt)
  const currentCreatedAt = normalizeFrontierCreatedAt(current.createdAt)

  if (candidateCreatedAt === undefined && currentCreatedAt === undefined)
    return 0
  if (candidateCreatedAt === undefined) return -1
  if (currentCreatedAt === undefined) return 1
  if (candidateCreatedAt > currentCreatedAt) return 1
  if (candidateCreatedAt < currentCreatedAt) return -1

  const candidateEventId = normalizeFrontierEventId(candidate.eventId)
  const currentEventId = normalizeFrontierEventId(current.eventId)
  if (candidateEventId === currentEventId) return 0
  if (!candidateEventId) return -1
  if (!currentEventId) return 1
  return candidateEventId < currentEventId ? 1 : -1
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function computeEventId(event: SignedPublicNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
  return bytesToHex(sha256(new TextEncoder().encode(serialized)))
}

export function isValidSignedPublicNostrEvent(
  event: SignedPublicNostrEvent
): boolean {
  try {
    if (
      !HEX_64.test(event.id) ||
      !HEX_64.test(event.pubkey) ||
      !/^[0-9a-f]{128}$/i.test(event.sig) ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 ||
      !Number.isSafeInteger(event.kind) ||
      typeof event.content !== "string" ||
      !Array.isArray(event.tags) ||
      event.tags.some(
        (tag) =>
          !Array.isArray(tag) ||
          tag.length === 0 ||
          tag.some((value) => typeof value !== "string")
      )
    ) {
      return false
    }
    if (computeEventId(event) !== event.id.toLowerCase()) return false
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey)
    )
  } catch {
    return false
  }
}

export function isExactRelayAuthEvent(input: {
  event: SignedPublicNostrEvent
  expectedPubkey: string
  relayUrl: string
  challenge: string
  createdAt: number
}): boolean {
  const { event, expectedPubkey, relayUrl, challenge, createdAt } = input
  return (
    isValidSignedPublicNostrEvent(event) &&
    event.kind === 22_242 &&
    event.pubkey.toLowerCase() === expectedPubkey.toLowerCase() &&
    event.created_at === createdAt &&
    event.content === "" &&
    JSON.stringify(event.tags) ===
      JSON.stringify([
        ["relay", relayUrl],
        ["challenge", challenge],
      ])
  )
}
