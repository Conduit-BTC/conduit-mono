import { formatNpub, getProfileName, type Profile } from "@conduit/core"

export interface EventActorRelayHintEntry {
  pubkey: string | null | undefined
  relayUrls: readonly string[] | undefined
}

export function groupEventActorRelayHints(
  entries: readonly EventActorRelayHintEntry[]
): Record<string, string[]> {
  const result: Record<string, string[]> = {}

  for (const entry of entries) {
    const pubkey = entry.pubkey?.trim().toLowerCase()
    if (!pubkey) continue
    const relayUrls = result[pubkey] ?? []
    const seen = new Set(relayUrls)
    for (const relayUrl of entry.relayUrls ?? []) {
      if (seen.has(relayUrl)) continue
      seen.add(relayUrl)
      relayUrls.push(relayUrl)
    }
    if (relayUrls.length > 0) result[pubkey] = relayUrls
  }

  return result
}

export function getEventActorDisplayName(
  pubkey: string,
  profile?: Profile
): string {
  const profileMatchesActor =
    profile?.pubkey.toLowerCase() === pubkey.toLowerCase()
  const profileName = profileMatchesActor ? getProfileName(profile) : null

  return profileName ?? formatNpub(pubkey, 8)
}
