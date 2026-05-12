import type { Profile } from "../types"
import { getProfileName } from "../utils"

export type ProfileMap = Record<string, Profile | undefined>

export function hasProfileContent(profile: Profile | undefined): boolean {
  if (!profile) return false
  return [
    profile.name,
    profile.displayName,
    profile.about,
    profile.picture,
    profile.banner,
    profile.nip05,
    profile.lud16,
    profile.website,
  ].some((value) => typeof value === "string" && value.trim().length > 0)
}

export function getProfileRichness(profile: Profile | undefined): number {
  if (!profile) return -1

  const fields = [
    profile.about,
    profile.picture,
    profile.banner,
    profile.nip05,
    profile.lud16,
    profile.website,
  ].filter((value) => typeof value === "string" && value.trim().length > 0)

  return (getProfileName(profile) ? 100 : 0) + fields.length
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0
}

function mergeTextField(
  current: string | undefined,
  incoming: string | undefined
): string | undefined {
  return hasText(incoming) ? incoming : current
}

export function mergeRicherProfile(
  current: Profile | undefined,
  incoming: Profile | undefined
): Profile | undefined {
  if (!incoming) return current
  if (!current) return incoming

  const currentHasContent = hasProfileContent(current)
  const incomingHasContent = hasProfileContent(incoming)

  if (!incomingHasContent) {
    return currentHasContent ? current : incoming
  }

  if (!currentHasContent) {
    return incoming
  }

  return {
    pubkey: incoming.pubkey || current.pubkey,
    name: mergeTextField(current.name, incoming.name),
    displayName: mergeTextField(current.displayName, incoming.displayName),
    about: mergeTextField(current.about, incoming.about),
    picture: mergeTextField(current.picture, incoming.picture),
    banner: mergeTextField(current.banner, incoming.banner),
    nip05: mergeTextField(current.nip05, incoming.nip05),
    lud16: mergeTextField(current.lud16, incoming.lud16),
    website: mergeTextField(current.website, incoming.website),
  }
}

export function mergeRicherProfiles(
  current: ProfileMap,
  incoming: ProfileMap | undefined
): ProfileMap {
  if (!incoming) return current

  const next = { ...current }
  for (const [pubkey, profile] of Object.entries(incoming)) {
    next[pubkey] = mergeRicherProfile(next[pubkey], profile)
  }

  return next
}
