import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { Profile } from "../types"
import { db, type CachedProfile } from "../db"
import { normalizePublicMediaUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import { getProfiles } from "./commerce"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { getNdk } from "./ndk"
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

function parseProfilePublishContent(
  content: string | null | undefined
): Record<string, string> {
  if (!content) return {}
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )
  } catch {
    return {}
  }
}

export function parseProfileEvent(
  event: Pick<NDKEvent, "content" | "pubkey">
): Profile {
  let raw: RawProfileContent = {}
  try {
    const parsed = JSON.parse(event.content || "{}") as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as RawProfileContent
    }
  } catch {
    // malformed content — return bare profile
  }

  const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined

  return {
    pubkey: event.pubkey,
    name: stringValue(raw.name),
    displayName: stringValue(raw.display_name ?? raw.displayName),
    about: stringValue(raw.about),
    picture: normalizePublicMediaUrl(raw.picture) ?? undefined,
    banner: normalizePublicMediaUrl(raw.banner) ?? undefined,
    nip05: stringValue(raw.nip05),
    lud16: stringValue(raw.lud16),
    website: stringValue(raw.website),
  }
}

export async function fetchProfile(
  pubkey: string,
  opts?: {
    authenticatedPubkey?: string | null
    skipCache?: boolean
    priority?: "visible" | "background"
  }
): Promise<Profile> {
  const result = await getProfiles({
    pubkeys: [pubkey],
    authenticatedPubkey: opts?.authenticatedPubkey,
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

export function buildProfileUpdatePayload(
  profile: Omit<Profile, "pubkey">,
  latestProfile?: Profile | null
): Omit<Profile, "pubkey"> {
  return Object.fromEntries(
    PROFILE_CONTENT_FIELDS.flatMap(([profileField]) => {
      if (!hasOwnProfileField(profile, profileField)) return []
      const nextValue = profile[profileField] || undefined
      const latestValue = latestProfile?.[profileField] || undefined
      return nextValue === latestValue ? [] : [[profileField, nextValue]]
    })
  ) as Omit<Profile, "pubkey">
}

export function buildNip01ProfilePublishContent({
  profile,
  latestProfile,
  latestContent,
}: {
  profile: Omit<Profile, "pubkey">
  latestProfile?: Profile
  latestContent?: string
}): Record<string, string> {
  const hasProfileInput = PROFILE_CONTENT_FIELDS.some(([profileField]) =>
    hasOwnProfileField(profile, profileField)
  )

  if (!hasProfileInput) return buildNip01ProfileContent(profile)

  const content = latestContent
    ? parseProfilePublishContent(latestContent)
    : buildNip01ProfileContent(latestProfile ?? {})
  for (const [profileField, contentKey] of PROFILE_CONTENT_FIELDS) {
    if (!hasOwnProfileField(profile, profileField)) continue
    if (profileField === "displayName") delete content.displayName
    let value = profile[profileField]
    if (
      (profileField === "picture" || profileField === "banner") &&
      value?.trim()
    ) {
      const safeUrl = normalizePublicMediaUrl(value)
      if (!safeUrl) {
        throw new Error(
          `Profile ${profileField} URL must use a public http or https destination`
        )
      }
      value = safeUrl
    }
    setProfileContentField(content, contentKey, value)
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

export function getNextProfileEventCreatedAt(
  latestCreatedAt: number | undefined,
  nowMs = Date.now()
): number {
  const nowSeconds = Math.floor(nowMs / 1_000)
  if (
    typeof latestCreatedAt !== "number" ||
    !Number.isSafeInteger(latestCreatedAt) ||
    latestCreatedAt < 0
  ) {
    return nowSeconds
  }
  return Math.max(nowSeconds, latestCreatedAt + 1)
}

export async function publishProfile(
  profile: Omit<Profile, "pubkey">,
  appId: ConduitAppId
): Promise<Profile> {
  const validatedProfile = { ...profile }
  for (const field of ["picture", "banner"] as const) {
    const value = profile[field]
    if (!value?.trim()) continue
    const safeUrl = normalizePublicMediaUrl(value)
    if (!safeUrl) {
      throw new Error(
        `Profile ${field} URL must use a public http or https destination`
      )
    }
    validatedProfile[field] = safeUrl
  }
  const ndk = getNdk()
  if (!ndk.signer) throw new Error("Signer not connected")

  const user = await ndk.signer.user()
  const pubkey = user.pubkey
  const latestProfile = await fetchProfile(pubkey, {
    authenticatedPubkey: pubkey,
    skipCache: true,
    priority: "visible",
  })
  let latestRow: CachedProfile | undefined
  try {
    latestRow = await db.profiles.get(pubkey)
  } catch {
    throw new Error(
      "Cannot safely publish a profile update while durable profile context is unavailable"
    )
  }

  // Build NIP-01 snake_case content, merging partial edits onto loaded context.
  const content = buildNip01ProfilePublishContent({
    profile: validatedProfile,
    latestProfile,
    latestContent: latestRow?.rawContent,
  })
  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.PROFILE
  event.created_at = getNextProfileEventCreatedAt(latestRow?.eventCreatedAt)
  event.content = JSON.stringify(content)
  event.tags = appendConduitClientTag([], appId)

  assertSafeReplaceablePublish(event)
  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: pubkey,
    authenticatedPubkey: pubkey,
  })

  const publishedProfile = parseProfileEvent({ pubkey, content: event.content })

  // Update local cache
  await db.profiles.put({
    ...publishedProfile,
    rawContent: event.content,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    sourceRelayUrls: [],
    cachedAt: Date.now(),
  })

  return publishedProfile
}
