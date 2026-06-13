import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { Profile } from "../types"
import { db } from "../db"
import { EVENT_KINDS } from "./kinds"
import { getProfiles } from "./commerce"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { requireNdkConnected } from "./ndk"
import { publishWithPlanner } from "./relay-publish"
import {
  assertSafeReplaceablePublish,
  countMeaningfulProfileFields,
} from "./replaceable-safety"

interface RawProfileContent {
  name?: string
  display_name?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
}

const PROFILE_CONTENT_FIELDS = [
  ["name", "name"],
  ["displayName", "display_name"],
  ["about", "about"],
  ["picture", "picture"],
  ["banner", "banner"],
  ["nip05", "nip05"],
  ["lud16", "lud16"],
  ["website", "website"],
] as const satisfies readonly [keyof Omit<Profile, "pubkey">, string][]

function hasOwnProfileField(
  profile: Omit<Profile, "pubkey">,
  field: keyof Omit<Profile, "pubkey">
): boolean {
  return Object.prototype.hasOwnProperty.call(profile, field)
}

function setProfileContentField(
  content: Record<string, string>,
  key: string,
  value: string | undefined
): void {
  if (value) {
    content[key] = value
    return
  }

  delete content[key]
}

export function parseProfileEvent(
  event: Pick<NDKEvent, "content" | "pubkey">
): Profile {
  let raw: RawProfileContent = {}
  try {
    raw = JSON.parse(event.content || "{}") as RawProfileContent
  } catch {
    // malformed content — return bare profile
  }

  return {
    pubkey: event.pubkey,
    name: raw.name,
    displayName: raw.display_name ?? raw.displayName,
    about: raw.about,
    picture: raw.picture,
    banner: raw.banner,
    nip05: raw.nip05,
    lud16: raw.lud16,
    website: raw.website,
  }
}

export async function fetchProfile(
  pubkey: string,
  opts?: { skipCache?: boolean; priority?: "visible" | "background" }
): Promise<Profile> {
  const result = await getProfiles({
    pubkeys: [pubkey],
    skipCache: opts?.skipCache,
    priority: opts?.priority,
  })
  return result.data[pubkey] ?? { pubkey }
}

export function buildNip01ProfileContent(
  profile: Omit<Profile, "pubkey">
): Record<string, string> {
  const content: Record<string, string> = {}
  for (const [profileField, contentKey] of PROFILE_CONTENT_FIELDS) {
    setProfileContentField(content, contentKey, profile[profileField])
  }
  return content
}

export function buildNip01ProfilePublishContent({
  profile,
  latestProfile,
}: {
  profile: Omit<Profile, "pubkey">
  latestProfile: Profile
}): Record<string, string> {
  const hasProfileInput = PROFILE_CONTENT_FIELDS.some(([profileField]) =>
    hasOwnProfileField(profile, profileField)
  )

  if (!hasProfileInput) return buildNip01ProfileContent(profile)

  const content = buildNip01ProfileContent(latestProfile)
  for (const [profileField, contentKey] of PROFILE_CONTENT_FIELDS) {
    if (!hasOwnProfileField(profile, profileField)) continue
    setProfileContentField(content, contentKey, profile[profileField])
  }

  return content
}

export function shouldEnforceNip01ProfileMinimumFields({
  content,
}: {
  content: Record<string, string>
  latestContent?: Record<string, string>
}): boolean {
  return countMeaningfulProfileFields(JSON.stringify(content)) <= 1
}

export async function publishProfile(
  profile: Omit<Profile, "pubkey">,
  appId: ConduitAppId
): Promise<Profile> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")

  const user = await ndk.signer.user()
  const pubkey = user.pubkey
  const latestProfile = await fetchProfile(pubkey, {
    priority: "visible",
  })

  // Build NIP-01 snake_case content, merging partial edits onto loaded context.
  const content = buildNip01ProfilePublishContent({ profile, latestProfile })
  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.PROFILE
  event.created_at = Math.floor(Date.now() / 1000)
  event.content = JSON.stringify(content)
  event.tags = appendConduitClientTag([], appId)

  assertSafeReplaceablePublish(event)
  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: pubkey,
  })

  const publishedProfile = parseProfileEvent({ pubkey, content: event.content })

  // Update local cache
  await db.profiles.put({
    ...publishedProfile,
    sourceRelayUrls: [],
    cachedAt: Date.now(),
  })

  return publishedProfile
}
