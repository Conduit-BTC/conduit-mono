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

const HEX_64 = /^[0-9a-f]{64}$/i

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
      event.created_at <= 0 ||
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
