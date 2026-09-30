import { normalizePublicRelayHints, pubkeyToNpub } from "@conduit/core"
import { nip19 } from "@nostr-dev-kit/ndk"

type ResolvedProfileReference = {
  pubkey: string
  relayHints: string[]
}

let recentRelayHints: {
  pubkey: string
  relayHints: string[]
  expiresAt: number
} | null = null

/** Carry an nprofile's discovery hints through a same-page canonical URL replace. */
export function rememberProfileRelayHints(
  pubkey: string,
  relayHints: readonly string[]
): void {
  if (relayHints.length === 0) return
  recentRelayHints = {
    pubkey,
    relayHints: [...relayHints],
    expiresAt: Date.now() + 60_000,
  }
}

export function getRememberedProfileRelayHints(pubkey: string): string[] {
  return recentRelayHints?.pubkey === pubkey &&
    recentRelayHints.expiresAt > Date.now()
    ? recentRelayHints.relayHints
    : []
}

function stripNostrScheme(value: string): string {
  return value.replace(/^(?:web\+)?nostr:/i, "")
}

export function resolveProfileReference(
  value: string
): ResolvedProfileReference | null {
  const trimmed = stripNostrScheme(value.trim())
  if (trimmed.length > 5_000) return null

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return { pubkey: trimmed.toLowerCase(), relayHints: [] }
  }

  if (!/^(npub|nprofile)1/i.test(trimmed)) {
    return null
  }

  try {
    const decoded = nip19.decode(trimmed)
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return { pubkey: decoded.data.toLowerCase(), relayHints: [] }
    }
    if (
      decoded.type === "nprofile" &&
      decoded.data &&
      typeof decoded.data === "object" &&
      "pubkey" in decoded.data
    ) {
      const pubkey = decoded.data.pubkey
      if (typeof pubkey === "string" && /^[0-9a-f]{64}$/i.test(pubkey)) {
        const relays =
          "relays" in decoded.data && Array.isArray(decoded.data.relays)
            ? decoded.data.relays.filter(
                (relay: unknown): relay is string => typeof relay === "string"
              )
            : []
        return {
          pubkey: pubkey.toLowerCase(),
          relayHints: normalizePublicRelayHints(relays).slice(0, 8),
        }
      }
    }
  } catch {
    return null
  }

  return null
}

export function getIdentityPath(pubkey: string): string {
  return `/${pubkeyToNpub(pubkey)}`
}
