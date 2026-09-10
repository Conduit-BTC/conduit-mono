import { formatNpub, getProfileName, type Profile } from "@conduit/core"

export interface EventActorRelayHintEntry {
  pubkey: string | null | undefined
  relayUrls: readonly string[] | undefined
}

export interface OrganizerEventActorProfileLookupPlan {
  organizerPubkeys: string[]
  participantPubkeys: string[]
  organizerRelayHintsByPubkey: Record<string, string[]>
}

export function normalizeEventActorPubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase()
}

export function groupEventActorRelayHints(
  entries: readonly EventActorRelayHintEntry[]
): Record<string, string[]> {
  const result: Record<string, string[]> = {}

  for (const entry of entries) {
    const pubkey = entry.pubkey
      ? normalizeEventActorPubkey(entry.pubkey)
      : undefined
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

/**
 * Keep organizer event-graph relays out of participant profile reads. Those
 * relays prove the organizer-owned event graph; participant profiles instead
 * use their own NIP-65 and cached product-source evidence in the shared profile
 * reader.
 */
export function planOrganizerEventActorProfileLookups(input: {
  organizerPubkey: string
  participantPubkeys: readonly (string | null | undefined)[]
  organizerRelayUrls: readonly string[]
}): OrganizerEventActorProfileLookupPlan {
  const organizerPubkey = normalizeEventActorPubkey(input.organizerPubkey)
  const participantPubkeys = Array.from(
    new Set(
      input.participantPubkeys
        .map((pubkey) =>
          pubkey ? normalizeEventActorPubkey(pubkey) : undefined
        )
        .filter(
          (pubkey): pubkey is string => !!pubkey && pubkey !== organizerPubkey
        )
    )
  )

  return {
    organizerPubkeys: organizerPubkey ? [organizerPubkey] : [],
    participantPubkeys,
    organizerRelayHintsByPubkey: groupEventActorRelayHints([
      { pubkey: organizerPubkey, relayUrls: input.organizerRelayUrls },
    ]),
  }
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
