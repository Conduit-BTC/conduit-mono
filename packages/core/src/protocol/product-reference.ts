import { nip19 } from "@nostr-dev-kit/ndk"

import { EVENT_KINDS } from "./kinds"

const PRODUCT_ADDRESS_PATTERN = /^30402:([0-9a-f]{64}):([\s\S]+)$/i
const MAX_NIP19_TLV_VALUE_BYTES = 255

export interface ProductAddressReference {
  kind: typeof EVENT_KINDS.PRODUCT
  authorPubkey: string
  dTag: string
  addressId: string
}

function parseProductAddressReference(
  value: string
): ProductAddressReference | null {
  const match = PRODUCT_ADDRESS_PATTERN.exec(value)
  if (!match?.[1] || !match[2]) return null

  const authorPubkey = match[1].toLowerCase()
  return {
    kind: EVENT_KINDS.PRODUCT,
    authorPubkey,
    dTag: match[2],
    addressId: `${EVENT_KINDS.PRODUCT}:${authorPubkey}:${match[2]}`,
  }
}

/** Resolve a route/share reference to Conduit's canonical product coordinate. */
export function decodeProductReference(
  value: string
): ProductAddressReference | null {
  const rawAddress = parseProductAddressReference(value)
  if (rawAddress) return rawAddress

  let decodedValue: string
  try {
    decodedValue = decodeURIComponent(value)
  } catch {
    return null
  }

  if (/^naddr1/i.test(decodedValue)) {
    try {
      const decoded = nip19.decode(decodedValue)
      if (
        decoded.type !== "naddr" ||
        !decoded.data ||
        typeof decoded.data !== "object" ||
        decoded.data.kind !== EVENT_KINDS.PRODUCT ||
        typeof decoded.data.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/i.test(decoded.data.pubkey) ||
        typeof decoded.data.identifier !== "string" ||
        decoded.data.identifier.length === 0
      ) {
        return null
      }

      const authorPubkey = decoded.data.pubkey.toLowerCase()
      return {
        kind: EVENT_KINDS.PRODUCT,
        authorPubkey,
        dTag: decoded.data.identifier,
        addressId: `${EVENT_KINDS.PRODUCT}:${authorPubkey}:${decoded.data.identifier}`,
      }
    } catch {
      return null
    }
  }

  return parseProductAddressReference(decodedValue)
}

/** Encode a stable, human-shareable NIP-19 reference for a product address. */
export function encodeProductNaddr(value: string): string {
  const reference = decodeProductReference(value)
  if (!reference) {
    throw new Error("Product share link requires a valid kind-30402 address.")
  }
  if (
    new TextEncoder().encode(reference.dTag).byteLength >
    MAX_NIP19_TLV_VALUE_BYTES
  ) {
    throw new Error("Product identifier must not exceed 255 UTF-8 bytes.")
  }

  return nip19.naddrEncode({
    kind: reference.kind,
    pubkey: reference.authorPubkey,
    identifier: reference.dTag,
    relays: [],
  })
}
