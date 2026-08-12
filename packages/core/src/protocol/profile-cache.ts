import type { Profile } from "../types"
import { getProfileName } from "../utils"
import { normalizePublicMediaUrl } from "../network-target-safety"

export type ProfileMap = Record<string, Profile | undefined>

export function sanitizeProfileMedia(
  profile: Profile | undefined
): Profile | undefined {
  if (!profile) return undefined
  return {
    ...profile,
    picture: normalizePublicMediaUrl(profile.picture) ?? undefined,
    banner: normalizePublicMediaUrl(profile.banner) ?? undefined,
  }
}

export function hasProfileContent(profile: Profile | undefined): boolean {
  const sanitized = sanitizeProfileMedia(profile)
  if (!sanitized) return false
  return [
    sanitized.name,
    sanitized.displayName,
    sanitized.about,
    sanitized.picture,
    sanitized.banner,
    sanitized.nip05,
    sanitized.lud16,
    sanitized.website,
  ].some((value) => typeof value === "string" && value.trim().length > 0)
}

export function getProfileRichness(profile: Profile | undefined): number {
  const sanitized = sanitizeProfileMedia(profile)
  if (!sanitized) return -1

  const fields = [
    sanitized.about,
    sanitized.picture,
    sanitized.banner,
    sanitized.nip05,
    sanitized.lud16,
    sanitized.website,
  ].filter((value) => typeof value === "string" && value.trim().length > 0)

  return (getProfileName(sanitized) ? 100 : 0) + fields.length
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
  const sanitizedCurrent = sanitizeProfileMedia(current)
  const sanitizedIncoming = sanitizeProfileMedia(incoming)
  if (!sanitizedIncoming) return sanitizedCurrent
  if (!sanitizedCurrent) return sanitizedIncoming

  const currentHasContent = hasProfileContent(sanitizedCurrent)
  const incomingHasContent = hasProfileContent(sanitizedIncoming)

  if (!incomingHasContent) {
    return currentHasContent ? sanitizedCurrent : sanitizedIncoming
  }

  if (!currentHasContent) {
    return sanitizedIncoming
  }

  return {
    pubkey: sanitizedIncoming.pubkey || sanitizedCurrent.pubkey,
    name: mergeTextField(sanitizedCurrent.name, sanitizedIncoming.name),
    displayName: mergeTextField(
      sanitizedCurrent.displayName,
      sanitizedIncoming.displayName
    ),
    about: mergeTextField(sanitizedCurrent.about, sanitizedIncoming.about),
    picture: mergeTextField(
      sanitizedCurrent.picture,
      sanitizedIncoming.picture
    ),
    banner: mergeTextField(sanitizedCurrent.banner, sanitizedIncoming.banner),
    nip05: mergeTextField(sanitizedCurrent.nip05, sanitizedIncoming.nip05),
    lud16: mergeTextField(sanitizedCurrent.lud16, sanitizedIncoming.lud16),
    website: mergeTextField(
      sanitizedCurrent.website,
      sanitizedIncoming.website
    ),
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
