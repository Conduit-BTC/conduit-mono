import { nip19 } from "nostr-tools"

import { EVENT_KINDS } from "./kinds"
import { parseProductAddressCoordinate } from "./product-deletion"

/** Shopper-authored note budget; preserves the existing public-comment limit. */
export const ZAP_NOTE_MAX_CODE_POINTS = 280

/**
 * Defensive bound for the composed note plus deterministic product reference.
 * Every accepted 255-byte NIP-19 identifier retains the complete note budget.
 */
export const ZAP_REQUEST_CONTENT_MAX_CODE_POINTS = 1_024

const PRODUCT_ZAP_CONTENT_SEPARATOR = "\n\n"
const NOSTR_URI_PREFIX = "nostr:"
const MAX_NIP19_TLV_VALUE_BYTES = 255

export type ParsedZapRequestContent = Readonly<{
  note: string
  productAddress: string | null
  productNaddr: string | null
}>

type ProductZapAddress = Readonly<{
  pubkey: string
  identifier: string
  address: string
}>

function normalizeZapNoteInput(input: string | null | undefined): string {
  return (input ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim()
}

function hasInvalidProductIdentifierCodePoint(identifier: string): boolean {
  return Array.from(identifier).some((character) => {
    const codePoint = character.codePointAt(0)!
    return (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    )
  })
}

function parseProductZapAddress(
  productAddress: string
): ProductZapAddress | null {
  const coordinate = parseProductAddressCoordinate(productAddress)
  if (
    !coordinate ||
    hasInvalidProductIdentifierCodePoint(coordinate.dTag) ||
    new TextEncoder().encode(coordinate.dTag).byteLength >
      MAX_NIP19_TLV_VALUE_BYTES
  ) {
    return null
  }

  return {
    pubkey: coordinate.authorPubkey,
    identifier: coordinate.dTag,
    address: coordinate.addressId,
  }
}

function requireProductZapAddress(productAddress: string): ProductZapAddress {
  const parsed = parseProductZapAddress(productAddress)
  if (!parsed) {
    throw new Error("Product zap address is invalid or cannot be encoded.")
  }
  return parsed
}

function getProductZapSuffix(productAddress: string): string {
  return `${NOSTR_URI_PREFIX}${getProductZapNaddr(productAddress)}`
}

function decodeProductNaddr(value: string): ProductZapAddress | null {
  try {
    const decoded = nip19.decode(value)
    if (decoded.type !== "naddr" || decoded.data.kind !== EVENT_KINDS.PRODUCT) {
      return null
    }

    return parseProductZapAddress(
      `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`
    )
  } catch {
    return null
  }
}

function parseProductNaddr(value: string): {
  address: string
  naddr: string
} | null {
  const parsedAddress = decodeProductNaddr(value)
  if (!parsedAddress) return null

  return {
    address: parsedAddress.address,
    naddr: getProductZapNaddr(parsedAddress.address),
  }
}

export function countZapContentCodePoints(input: string): number {
  return Array.from(input).length
}

export function truncateZapNoteInput(
  input: string | null | undefined,
  maxCodePoints: number
): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 0) {
    throw new Error("Zap note code point limit is invalid.")
  }

  const normalized = normalizeZapNoteInput(input)
  if (countZapContentCodePoints(normalized) <= maxCodePoints) {
    return normalized
  }

  return Array.from(normalized).slice(0, maxCodePoints).join("").trimEnd()
}

export function getProductZapNaddr(productAddress: string): string {
  const parsed = requireProductZapAddress(productAddress)
  try {
    const naddr = nip19.naddrEncode({
      kind: EVENT_KINDS.PRODUCT,
      pubkey: parsed.pubkey,
      identifier: parsed.identifier,
      relays: [],
    })
    const decoded = decodeProductNaddr(naddr)
    if (decoded?.address !== parsed.address) {
      throw new Error("Product zap address did not round-trip through NIP-19.")
    }
    return naddr
  } catch (error) {
    throw new Error("Product zap address cannot be encoded as naddr.", {
      cause: error,
    })
  }
}

export function parseZapRequestContent(
  content: string,
  expectedProductAddress?: string | null
): ParsedZapRequestContent {
  const normalizedContent = normalizeZapNoteInput(content)
  const separatorIndex = normalizedContent.lastIndexOf(
    `${PRODUCT_ZAP_CONTENT_SEPARATOR}${NOSTR_URI_PREFIX}`
  )
  const isNaddrOnly = normalizedContent
    .toLowerCase()
    .startsWith(`${NOSTR_URI_PREFIX}naddr1`)
  const suffixStart = isNaddrOnly
    ? 0
    : separatorIndex >= 0
      ? separatorIndex + PRODUCT_ZAP_CONTENT_SEPARATOR.length
      : -1

  if (suffixStart < 0) {
    return {
      note: normalizedContent,
      productAddress: null,
      productNaddr: null,
    }
  }

  const suffix = normalizedContent.slice(suffixStart)
  if (!suffix.toLowerCase().startsWith(`${NOSTR_URI_PREFIX}naddr1`)) {
    return {
      note: normalizedContent,
      productAddress: null,
      productNaddr: null,
    }
  }

  const parsedNaddr = parseProductNaddr(suffix.slice(NOSTR_URI_PREFIX.length))
  const expectedAddress =
    expectedProductAddress === undefined
      ? undefined
      : expectedProductAddress === null
        ? null
        : (parseProductZapAddress(expectedProductAddress)?.address ?? null)
  if (
    !parsedNaddr ||
    expectedAddress === null ||
    (expectedAddress !== undefined && expectedAddress !== parsedNaddr.address)
  ) {
    return {
      note: normalizedContent,
      productAddress: null,
      productNaddr: null,
    }
  }

  return {
    note: isNaddrOnly
      ? ""
      : normalizeZapNoteInput(normalizedContent.slice(0, separatorIndex)),
    productAddress: parsedNaddr.address,
    productNaddr: parsedNaddr.naddr,
  }
}

export function buildZapRequestContent(input: {
  note?: string | null
  productAddress?: string | null
}): string {
  if (!input.productAddress) {
    return truncateZapNoteInput(input.note, ZAP_NOTE_MAX_CODE_POINTS)
  }

  const productAddress = requireProductZapAddress(input.productAddress).address
  const parsedInput = parseZapRequestContent(input.note ?? "", productAddress)
  const noteInput = parsedInput.productAddress ? parsedInput.note : input.note
  const note = truncateZapNoteInput(noteInput, ZAP_NOTE_MAX_CODE_POINTS)
  const suffix = getProductZapSuffix(productAddress)
  const content = note
    ? `${note}${PRODUCT_ZAP_CONTENT_SEPARATOR}${suffix}`
    : suffix

  if (
    countZapContentCodePoints(content) > ZAP_REQUEST_CONTENT_MAX_CODE_POINTS
  ) {
    throw new Error("Zap request content exceeds the zap content limit.")
  }
  return content
}

export function buildProductZapTargetTags(productAddress: string): string[][] {
  const parsed = requireProductZapAddress(productAddress)
  return [
    ["a", parsed.address],
    ["k", String(EVENT_KINDS.PRODUCT)],
  ]
}
