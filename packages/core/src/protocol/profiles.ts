import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { Profile } from "../types"
import { db, type CachedProfile } from "../db"
import { normalizePublicMediaUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import { getProfiles } from "./commerce"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { getNdk } from "./ndk"
import {
  projectCachedProfile,
  projectProfileContent,
  retainStrongestCachedProfiles,
} from "./profile-cache"
import { publishWithPlanner } from "./relay-publish"
import {
  assertSafeReplaceablePublish,
  countMeaningfulProfileFields,
} from "./replaceable-safety"

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
  content: Record<string, unknown>,
  key: string,
  value: string | undefined
): void {
  if (value) {
    content[key] = value
    return
  }

  delete content[key]
}

function hasNonRoundTrippableJsonNumber(content: string): boolean {
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character !== "-" && (character < "0" || character > "9")) continue

    const token = content
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0]
    if (!token) continue
    if (JSON.stringify(Number(token)) !== token) return true
    index += token.length - 1
  }

  return false
}

function parseProfilePublishContent(
  content: string | null | undefined
): Record<string, unknown> {
  if (!content) return {}
  const parse = JSON.parse as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string }
    ) => unknown
  ) => unknown
  const rawJSON = (
    JSON as typeof JSON & { rawJSON?: (source: string) => unknown }
  ).rawJSON
  const hasNonRoundTrippableNumber = hasNonRoundTrippableJsonNumber(content)
  let observedNumberSource = false
  let cannotPreserveNumber = false

  try {
    const parsed = parse(content, (_key, value, context) => {
      if (typeof value === "number" && context?.source) {
        observedNumberSource = true
        if (JSON.stringify(value) !== context.source) {
          if (rawJSON) return rawJSON(context.source)
          cannotPreserveNumber = true
        }
      }
      return value
    })
    if (hasNonRoundTrippableNumber && !observedNumberSource) {
      cannotPreserveNumber = true
    }
    if (cannotPreserveNumber) {
      throw new Error("This browser cannot preserve profile numeric metadata")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    return Object.fromEntries(Object.entries(parsed))
  } catch (error) {
    if (cannotPreserveNumber) throw error
    return {}
  }
}

export function parseProfileEvent(
  event: Pick<NDKEvent, "content" | "pubkey">
): Profile {
  return projectProfileContent(event.pubkey, event.content)
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
}): Record<string, unknown> {
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
  content: Record<string, unknown>
  latestContent?: Record<string, unknown>
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

export class ProfilePublishSupersededError extends Error {
  readonly code = "profile_publish_superseded" as const

  constructor() {
    super(
      "Another profile update took precedence while this one was publishing. The retained profile was kept; review it and retry."
    )
    this.name = "ProfilePublishSupersededError"
  }
}

export function assertProfilePublishRetained(
  retainedProfile:
    Pick<CachedProfile, "eventId" | "eventCreatedAt"> | undefined,
  publishedEvent: Pick<NDKEvent, "id" | "created_at">
): void {
  if (
    retainedProfile?.eventId !== publishedEvent.id ||
    retainedProfile.eventCreatedAt !== publishedEvent.created_at
  ) {
    throw new ProfilePublishSupersededError()
  }
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

  // Reconcile against the commit-time frontier so a concurrent tab cannot
  // replace stronger profile evidence with this row after the network step.
  const retention = await retainStrongestCachedProfiles([
    {
      ...publishedProfile,
      rawContent: event.content,
      eventId: event.id,
      eventCreatedAt: event.created_at,
      sourceRelayUrls: [],
      cachedAt: Date.now(),
    },
  ])
  const retainedProfile = retention.rows[0]
  assertProfilePublishRetained(retainedProfile, event)

  return projectCachedProfile(retainedProfile)
}
