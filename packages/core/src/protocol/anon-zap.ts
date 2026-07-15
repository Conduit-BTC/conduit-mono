import { schnorr } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"

import { EVENT_KINDS } from "./kinds"

export type AnonZapRequestDraft = {
  kind: number
  createdAt: number
  content: string
  tags: string[][]
}

export type SignedAnonZapRequest = {
  id: string
  rawEvent: unknown
}

export type AnonZapValidationResult =
  { ok: true } | { ok: false; reason: string }

export type AnonZapValidationOptions = {
  allowedClientTags?: readonly string[][]
}

export const ANON_ZAP_ALLOWED_TAGS = new Set([
  "p",
  "amount",
  "lnurl",
  "relays",
  "client",
  "omf",
  "omf_provider",
  "omf_auth",
])

export const ANON_ZAP_PROVIDER_ATTESTATION_TAG = "omf_auth"
const ANON_ZAP_PROVIDER_ATTESTATION_DOMAIN =
  "conduit-anon-zap-provider-attestation-v1"

function countTags(tags: readonly string[][], name: string): number {
  return tags.reduce((count, tag) => count + (tag[0] === name ? 1 : 0), 0)
}

function getSingleTag(
  tags: readonly string[][],
  name: string
): string[] | null {
  const matches = tags.filter((tag) => tag[0] === name)
  return matches.length === 1 ? matches[0] : null
}

function isAllowedRelayUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const localhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1"
    return url.protocol === "wss:" || (url.protocol === "ws:" && localhost)
  } catch {
    return false
  }
}

function isHexPubkey(value: string | undefined): boolean {
  return !!value && /^[0-9a-f]{64}$/i.test(value)
}

function normalizeNip89Address(value: string | undefined): string | null {
  const match = /^31990:([0-9a-f]{64}):([A-Za-z0-9._-]{1,128})$/i.exec(
    value ?? ""
  )
  if (!match) return null
  return `31990:${match[1].toLowerCase()}:${match[2]}`
}

function normalizeClientRelayHint(value: string | undefined): string | null {
  if (!value) return null

  try {
    const url = new URL(value)
    const localhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && localhost)) {
      return null
    }
    if (url.username || url.password || url.search || url.hash) {
      return null
    }

    const pathname =
      url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

function clientTagsEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length || left[0] !== right[0]) return false
  if (left.length !== 4 || left[0] !== "client") return tagsEqual(left, right)

  return (
    left[1] === right[1] &&
    normalizeNip89Address(left[2]) === normalizeNip89Address(right[2]) &&
    normalizeClientRelayHint(left[3]) === normalizeClientRelayHint(right[3])
  )
}

function tagsEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function isAllowedClientTag(
  tag: string[],
  options: AnonZapValidationOptions
): boolean {
  if (
    options.allowedClientTags?.some((allowedTag) =>
      clientTagsEqual(tag, allowedTag)
    )
  ) {
    return true
  }
  return (
    tag.length === 2 &&
    (tag[1] === "conduit-market" || tag[1] === "Conduit Market")
  )
}

function isValidAllowedAnonZapTag(
  tag: string[],
  options: AnonZapValidationOptions
): boolean {
  const [name, ...values] = tag
  if (name === "p") {
    return tag.length === 2 && isHexPubkey(values[0])
  }
  if (name === "amount") {
    const amount = Number(values[0])
    return tag.length === 2 && Number.isSafeInteger(amount) && amount > 0
  }
  if (name === "lnurl") {
    return tag.length === 2 && /^lnurl/i.test(values[0] ?? "")
  }
  if (name === "relays") {
    return tag.length >= 2 && values.every(isAllowedRelayUrl)
  }
  if (name === "client") {
    return isAllowedClientTag(tag, options)
  }
  if (name === "omf") {
    return tag.length === 2 && values[0] === "zapout"
  }
  if (name === "omf_provider") {
    return tag.length === 2 && isHexPubkey(values[0])
  }
  if (name === ANON_ZAP_PROVIDER_ATTESTATION_TAG) {
    return (
      tag.length === 3 &&
      /^[A-Za-z0-9_-]{1,32}$/.test(values[0] ?? "") &&
      /^[0-9a-f]{128}$/.test(values[1] ?? "")
    )
  }
  return false
}

function providerAttestationDigest(draft: AnonZapRequestDraft): Uint8Array {
  const publicDraft = [
    draft.kind,
    draft.createdAt,
    draft.content,
    draft.tags.filter((tag) => tag[0] !== ANON_ZAP_PROVIDER_ATTESTATION_TAG),
  ]
  return sha256(
    new TextEncoder().encode(
      `${ANON_ZAP_PROVIDER_ATTESTATION_DOMAIN}.${JSON.stringify(publicDraft)}`
    )
  )
}

export function getAnonZapProviderAttestationPublicKey(
  privateKeyHex: string
): string | null {
  if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) return null
  try {
    return bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)))
  } catch {
    return null
  }
}

export function parseAnonZapProviderAttestationPublicKeys(
  raw: string | undefined
): ReadonlyMap<string, string> | null {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0 || entries.length > 16) return null
  const keys = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf(":")
    const keyId = entry.slice(0, separator)
    const pubkey = entry.slice(separator + 1).toLowerCase()
    if (
      separator < 1 ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      keys.has(keyId)
    ) {
      return null
    }
    keys.set(keyId, pubkey)
  }
  return keys
}

export function createAnonZapProviderAttestation(
  draft: AnonZapRequestDraft,
  keyId: string,
  privateKeyHex: string
): string[] {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) {
    throw new Error("Provider attestation key id is invalid.")
  }
  if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) {
    throw new Error("Provider attestation private key is invalid.")
  }
  const signature = schnorr.sign(
    providerAttestationDigest(draft),
    hexToBytes(privateKeyHex)
  )
  return [ANON_ZAP_PROVIDER_ATTESTATION_TAG, keyId, bytesToHex(signature)]
}

export type AnonZapProviderAttestationVerification =
  "verified" | "invalid" | "unknown_key" | "unconfigured"

export function verifyAnonZapProviderAttestation(
  draft: AnonZapRequestDraft,
  rawPublicKeys: string | undefined
): AnonZapProviderAttestationVerification {
  const tag = getSingleTag(draft.tags, ANON_ZAP_PROVIDER_ATTESTATION_TAG)
  if (
    tag?.length !== 3 ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(tag[1] ?? "") ||
    !/^[0-9a-f]{128}$/.test(tag[2] ?? "")
  ) {
    return "invalid"
  }
  const publicKeys = parseAnonZapProviderAttestationPublicKeys(rawPublicKeys)
  if (!publicKeys) return "unconfigured"
  const publicKey = publicKeys.get(tag[1]!)
  if (!publicKey) return "unknown_key"
  try {
    return schnorr.verify(
      hexToBytes(tag[2]!),
      providerAttestationDigest(draft),
      hexToBytes(publicKey)
    )
      ? "verified"
      : "invalid"
  } catch {
    return "invalid"
  }
}

export function getAnonZapDraftTag(
  draft: AnonZapRequestDraft,
  name: string
): string[] | null {
  return getSingleTag(draft.tags, name)
}

export function validateAnonZapRequestDraft(
  draft: AnonZapRequestDraft,
  options: AnonZapValidationOptions = {}
): AnonZapValidationResult {
  if (draft.kind !== EVENT_KINDS.ZAP_REQUEST) {
    return { ok: false, reason: "Anon signer only accepts kind 9734." }
  }
  if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt <= 0) {
    return { ok: false, reason: "Zap request timestamp is invalid." }
  }
  if (typeof draft.content !== "string" || draft.content.length > 280) {
    return { ok: false, reason: "Public zap comment is too long." }
  }
  if (!Array.isArray(draft.tags)) {
    return { ok: false, reason: "Zap request tags are invalid." }
  }

  for (const tag of draft.tags) {
    if (
      !Array.isArray(tag) ||
      tag.length === 0 ||
      !tag.every((value) => typeof value === "string")
    ) {
      return { ok: false, reason: "Zap request tags are invalid." }
    }
    if (!ANON_ZAP_ALLOWED_TAGS.has(tag[0])) {
      return { ok: false, reason: "Zap request contains private tags." }
    }
    if (!isValidAllowedAnonZapTag(tag, options)) {
      return { ok: false, reason: "Zap request tag payload is invalid." }
    }
  }

  if (countTags(draft.tags, "p") !== 1) {
    return { ok: false, reason: "Zap request must target one merchant." }
  }
  if (countTags(draft.tags, "amount") !== 1) {
    return { ok: false, reason: "Zap request amount is missing." }
  }
  if (countTags(draft.tags, "lnurl") !== 1) {
    return { ok: false, reason: "Zap request LNURL is missing." }
  }
  if (countTags(draft.tags, "relays") !== 1) {
    return { ok: false, reason: "Zap request relay list is missing." }
  }
  const omfMarkerCount = countTags(draft.tags, "omf")
  const omfProviderCount = countTags(draft.tags, "omf_provider")
  const omfAttestationCount = countTags(
    draft.tags,
    ANON_ZAP_PROVIDER_ATTESTATION_TAG
  )
  if (omfMarkerCount > 1 || omfProviderCount > 1 || omfAttestationCount > 1) {
    return { ok: false, reason: "Zap request provider authority is invalid." }
  }
  if (omfProviderCount === 1 && omfMarkerCount !== 1) {
    return { ok: false, reason: "Zap request provider authority is missing." }
  }
  if (omfAttestationCount === 1 && omfMarkerCount !== 1) {
    return { ok: false, reason: "Zap request provider attestation is invalid." }
  }

  const amount = Number(getSingleTag(draft.tags, "amount")?.[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, reason: "Zap request amount is invalid." }
  }
  if (!isHexPubkey(getSingleTag(draft.tags, "p")?.[1])) {
    return { ok: false, reason: "Zap request merchant pubkey is missing." }
  }
  const lnurl = getSingleTag(draft.tags, "lnurl")?.[1]
  if (!lnurl || !/^lnurl/i.test(lnurl)) {
    return { ok: false, reason: "Zap request LNURL is missing." }
  }
  const relayTag = getSingleTag(draft.tags, "relays")
  if (!relayTag || relayTag.length < 2) {
    return { ok: false, reason: "Zap request relay list is empty." }
  }
  if (!relayTag.slice(1).every(isAllowedRelayUrl)) {
    return { ok: false, reason: "Zap request relay list is invalid." }
  }

  return { ok: true }
}
