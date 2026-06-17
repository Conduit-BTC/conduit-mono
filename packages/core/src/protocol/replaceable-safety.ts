import { EVENT_KINDS } from "./kinds"

const PROFILE_FIELD_KEYS = new Map<string, string>([
  ["name", "name"],
  ["display_name", "display_name"],
  ["displayName", "display_name"],
  ["about", "about"],
  ["picture", "picture"],
  ["banner", "banner"],
  ["nip05", "nip05"],
  ["lud06", "lud06"],
  ["lud16", "lud16"],
  ["website", "website"],
])

export class ReplaceablePublishSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReplaceablePublishSafetyError"
  }
}

export interface ReplaceablePublishSafetyOptions {
  contactList?: {
    enforceMinimumPubkeys?: boolean
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function normalizeHexPubkey(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed || !/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

export function countMeaningfulProfileFields(
  content: string | undefined
): number {
  let parsed: unknown

  try {
    parsed = JSON.parse(content || "{}")
  } catch {
    return 0
  }

  if (!isRecord(parsed)) return 0

  const fields = new Set<string>()
  for (const [rawKey, normalizedKey] of PROFILE_FIELD_KEYS) {
    if (hasText(parsed[rawKey])) fields.add(normalizedKey)
  }

  return fields.size
}

export function countDistinctContactListPubkeys(
  tags: readonly string[][] | undefined
): number {
  const pubkeys = new Set<string>()

  for (const tag of tags ?? []) {
    if (tag[0] !== "p") continue
    const pubkey = normalizeHexPubkey(tag[1])
    if (pubkey) pubkeys.add(pubkey)
  }

  return pubkeys.size
}

function normalizeRelayTagUrl(url: string): string | null {
  try {
    const trimmed = url.trim()
    if (!trimmed) return null
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `wss://${trimmed}`
    const parsed = new URL(withScheme)

    if (parsed.protocol === "http:") parsed.protocol = "ws:"
    if (parsed.protocol === "https:") parsed.protocol = "wss:"
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null
    if (!parsed.hostname) return null

    parsed.hash = ""
    parsed.search = ""

    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

export function countActiveRelayListTags(
  tags: readonly string[][] | undefined
): number {
  const relayUrls = new Set<string>()

  for (const tag of tags ?? []) {
    if (tag[0] !== "r" || !tag[1]) continue
    const url = normalizeRelayTagUrl(tag[1])
    if (url) relayUrls.add(url)
  }

  return relayUrls.size
}

export function countDmRelayListTags(
  tags: readonly string[][] | undefined
): number {
  const relayUrls = new Set<string>()

  for (const tag of tags ?? []) {
    if (tag[0] !== "relay" || !tag[1]) continue
    const url = normalizeRelayTagUrl(tag[1])
    if (url) relayUrls.add(url)
  }

  return relayUrls.size
}

export function assertSafeReplaceablePublish(
  event: {
    kind?: number | null
    content?: string
    tags?: readonly string[][]
  },
  options: ReplaceablePublishSafetyOptions = {}
): void {
  switch (event.kind) {
    case EVENT_KINDS.PROFILE: {
      const fieldCount = countMeaningfulProfileFields(event.content)
      if (fieldCount <= 1) {
        throw new ReplaceablePublishSafetyError(
          "Refusing to publish a tiny Nostr profile. Wait for the existing profile to load or fill at least two profile fields before saving."
        )
      }
      return
    }

    case EVENT_KINDS.CONTACT_LIST: {
      const followCount = countDistinctContactListPubkeys(event.tags)
      const enforceMinimumPubkeys =
        options.contactList?.enforceMinimumPubkeys ?? true
      if (enforceMinimumPubkeys && followCount <= 1) {
        throw new ReplaceablePublishSafetyError(
          "Refusing to publish a tiny follow list. Load the existing follow list before changing follows."
        )
      }
      return
    }

    case EVENT_KINDS.RELAY_LIST: {
      const relayCount = countActiveRelayListTags(event.tags)
      if (relayCount <= 1) {
        throw new ReplaceablePublishSafetyError(
          "Refusing to publish a tiny NIP-65 relay list. Load or add at least two active relays before publishing."
        )
      }
      return
    }

    case EVENT_KINDS.DM_RELAY_LIST: {
      const relayCount = countDmRelayListTags(event.tags)
      if (relayCount < 1) {
        throw new ReplaceablePublishSafetyError(
          "Refusing to publish an empty NIP-17 inbox relay list."
        )
      }
      return
    }

    default:
      return
  }
}
