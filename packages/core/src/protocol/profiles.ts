import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { Profile } from "../types"
import { db } from "../db"
import { EVENT_KINDS } from "./kinds"
import { requireNdkConnected } from "./ndk"

const CACHE_TTL_MS = 5 * 60_000

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
  opts?: { skipCache?: boolean }
): Promise<Profile> {
  if (!opts?.skipCache) {
    const cached = await db.profiles.get(pubkey)
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return {
        pubkey: cached.pubkey,
        name: cached.name,
        displayName: cached.displayName,
        about: cached.about,
        picture: cached.picture,
        banner: cached.banner,
        nip05: cached.nip05,
        lud16: cached.lud16,
        website: cached.website,
      }
    }
  }

  const ndk = await requireNdkConnected()
  const events = await ndk.fetchEvents({
    kinds: [EVENT_KINDS.PROFILE],
    authors: [pubkey],
    limit: 1,
  })

  const event = Array.from(events)[0] as NDKEvent | undefined
  if (!event) {
    // No profile on relays — return bare profile
    const bare: Profile = { pubkey }
    await db.profiles.put({ pubkey, cachedAt: Date.now() })
    return bare
  }

  const profile = parseProfileEvent(event)

  await db.profiles.put({
    pubkey: profile.pubkey,
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

  return profile
}

export async function publishProfile(
  profile: Omit<Profile, "pubkey">
): Promise<void> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")

  const user = await ndk.signer.user()
  const pubkey = user.pubkey

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
  event.tags = []

  await event.sign(ndk.signer)
  await event.publish()

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
