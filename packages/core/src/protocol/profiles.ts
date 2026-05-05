import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { Profile } from "../types"
import { db } from "../db"
import { EVENT_KINDS } from "./kinds"
import { getProfiles } from "./commerce"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { requireNdkConnected } from "./ndk"
import { publishWithPlanner } from "./relay-publish"

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

export async function publishProfile(
  profile: Omit<Profile, "pubkey">,
  appId: ConduitAppId
): Promise<void> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")

  const user = await ndk.signer.user()
  const pubkey = user.pubkey
  const hasSubmittedContent = [
    profile.name,
    profile.displayName,
    profile.about,
    profile.picture,
    profile.banner,
    profile.nip05,
    profile.lud16,
    profile.website,
  ].some((value) => typeof value === "string" && value.trim().length > 0)

  if (!hasSubmittedContent) {
    throw new Error(
      "Refusing to publish an empty profile. Wait for the profile to load or add profile details before saving."
    )
  }

  // Build NIP-01 snake_case content, omitting empty/undefined fields
  const content: Record<string, string> = {}
  if (profile.name) content.name = profile.name
  if (profile.displayName) content.display_name = profile.displayName
  if (profile.about) content.about = profile.about
  if (profile.picture) content.picture = profile.picture
  if (profile.banner) content.banner = profile.banner
  if (profile.nip05) content.nip05 = profile.nip05
  if (profile.lud16) content.lud16 = profile.lud16
  if (profile.website) content.website = profile.website

  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.PROFILE
  event.created_at = Math.floor(Date.now() / 1000)
  event.content = JSON.stringify(content)
  event.tags = appendConduitClientTag([], appId)

  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: pubkey,
  })

  // Update local cache
  await db.profiles.put({
    pubkey,
    name: profile.name,
    displayName: profile.displayName,
    about: profile.about,
    picture: profile.picture,
    banner: profile.banner,
    nip05: profile.nip05,
    lud16: profile.lud16,
    website: profile.website,
    cachedAt: Date.now(),
  })
}
