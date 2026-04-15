import { nip19 } from "@nostr-dev-kit/ndk"

type ResolvedProfileReference = {
  pubkey: string
}

function stripNostrScheme(value: string): string {
  return value.replace(/^(?:web\+)?nostr:/i, "")
}

export function resolveProfileReference(
  value: string
): ResolvedProfileReference | null {
  const trimmed = stripNostrScheme(value.trim())

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return { pubkey: trimmed.toLowerCase() }
  }

  if (!/^(npub|nprofile)1/i.test(trimmed)) {
    return null
  }

  try {
    const decoded = nip19.decode(trimmed)
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return { pubkey: decoded.data.toLowerCase() }
    }
    if (
      decoded.type === "nprofile" &&
      decoded.data &&
      typeof decoded.data === "object" &&
      "pubkey" in decoded.data
    ) {
      const pubkey = decoded.data.pubkey
      if (typeof pubkey === "string") {
        return { pubkey: pubkey.toLowerCase() }
      }
    }
  } catch {
    return null
  }

  return null
}
