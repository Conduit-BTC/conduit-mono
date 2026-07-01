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
  | { ok: true }
  | { ok: false; reason: string }

export const ANON_ZAP_ALLOWED_TAGS = new Set([
  "p",
  "amount",
  "lnurl",
  "relays",
  "client",
  "omf",
])

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

export function getAnonZapDraftTag(
  draft: AnonZapRequestDraft,
  name: string
): string[] | null {
  return getSingleTag(draft.tags, name)
}

export function validateAnonZapRequestDraft(
  draft: AnonZapRequestDraft
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
