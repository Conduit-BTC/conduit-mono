import {
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"
import type { SignedPublicNostrEvent } from "./signed-event"
import type { Profile } from "../types"
import type { ProfileFormValues } from "../schemas"
import type { CachedProfile } from "../db"
import { normalizePublicMediaUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import { getProfiles, type ProfileBatchQuery } from "./commerce"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { getAccountSigner } from "./session-signer"
import type { UnsignedNostrEvent } from "./nostr-event-signer"
import {
  projectProfileContent,
  createSelectedProfileContext,
  retainSelectedProfileRows,
  type SelectedProfileContext,
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

function parseProfilePublishContent(content: string | null | undefined): {
  content: Record<string, unknown>
  validObject: boolean
} {
  if (!content) return { content: {}, validObject: false }
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { content: {}, validObject: false }
    }
    return {
      content: Object.fromEntries(Object.entries(parsed)),
      validObject: true,
    }
  } catch (error) {
    if (cannotPreserveNumber) throw error
    return { content: {}, validObject: false }
  }
}

export function parseProfileEvent(event: VerifiedNostrEvent): Profile {
  if (!isVerifiedNostrEvent(event))
    throw new Error("Profile event must be admitted")
  return projectProfileContent(event.pubkey, event.content)
}

export type ProfileFetchOptions = Omit<
  ProfileBatchQuery,
  "pubkeys" | "onProgress"
>

export async function fetchProfileContext(
  pubkey: string,
  opts: ProfileFetchOptions = {}
): Promise<SelectedProfileContext> {
  const key = pubkey.trim()
  const result = await getProfiles({ ...opts, pubkeys: [key] })
  return (
    result.profileContexts[key] ?? createSelectedProfileContext({ pubkey: key })
  )
}

/** Display-only compatibility wrapper. Actions should consume the selected context. */
export async function fetchProfile(
  pubkey: string,
  opts: ProfileFetchOptions = {}
): Promise<Profile> {
  const key = pubkey.trim()
  const result = await getProfiles({ ...opts, pubkeys: [key] })
  return result.data[key] ?? { pubkey: key }
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

/** Profile details never own the public receiving address; Wallets owns it. */
export function buildProfileDetailsUpdatePayload(
  profile: Omit<Profile, "pubkey">,
  latestProfile?: Profile | null
): Omit<Profile, "pubkey"> {
  const { lud16: _address, ...details } = profile
  return buildProfileUpdatePayload(details, latestProfile)
}

export class ProfileAddressChangedError extends Error {
  constructor() {
    super(
      "Your public Lightning address changed. Review the current address before replacing it."
    )
    this.name = "ProfileAddressChangedError"
  }
}

export function assertProfileAddressChoice(
  content: string | undefined,
  expected: string
): void {
  const current: Record<string, unknown> | null = content
    ? parseProfilePublishContent(content).content
    : {}
  const address =
    typeof current?.lud16 === "string" && current.lud16.trim()
      ? current.lud16.trim()
      : typeof current?.lud06 === "string"
        ? current.lud06.trim()
        : ""
  if (address !== expected) throw new ProfileAddressChangedError()
}

/** Rebase unchanged details onto the latest projection while retaining local edits. */
export function reconcileProfileFormDraft(
  draft: ProfileFormValues,
  editBaseline: ProfileFormValues,
  latest: ProfileFormValues
): ProfileFormValues {
  return Object.fromEntries(
    PROFILE_CONTENT_FIELDS.map(([field]) => [
      field,
      draft[field] === editBaseline[field] ? latest[field] : draft[field],
    ])
  ) as ProfileFormValues
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

  const parsedLatestContent = latestContent
    ? parseProfilePublishContent(latestContent)
    : undefined
  // A malformed latest frontier is not an implicit request to erase the
  // owner's last readable identity. Rebuild a valid object from the safe
  // projection shown in the repair form, then apply the explicit edits. A
  // valid signed empty object remains authoritative and does not take this
  // fallback.
  const content = parsedLatestContent?.validObject
    ? parsedLatestContent.content
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
  publishedEvent: Pick<SignedPublicNostrEvent, "id" | "created_at">
): void {
  if (
    retainedProfile?.eventId !== publishedEvent.id ||
    retainedProfile.eventCreatedAt !== publishedEvent.created_at
  ) {
    throw new ProfilePublishSupersededError()
  }
}

export type PublishProfileOptions = {
  authenticatedPubkey?: string | null
  shouldContinue?: () => boolean
  expectedLightningAddress?: string
}

export async function publishProfile(
  profile: Omit<Profile, "pubkey">,
  appId: ConduitAppId,
  options: PublishProfileOptions = {}
): Promise<Profile> {
  return (await publishProfileContext(profile, appId, options)).profile
}

let profileWriteTail: Promise<unknown> = Promise.resolve()
export async function publishProfileContext(
  profile: Omit<Profile, "pubkey">,
  appId: ConduitAppId,
  options: PublishProfileOptions = {}
): Promise<SelectedProfileContext> {
  const signer = getAccountSigner()
  if (!signer) throw new Error("Signer not connected")
  const owner = await signer.getPublicKey()
  const run = () =>
    publishProfileContextUnlocked(profile, appId, {
      ...options,
      shouldContinue: () =>
        getAccountSigner() === signer && options.shouldContinue?.() !== false,
    })
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(`conduit:profile-write:${owner}`, run)
  const pending = profileWriteTail.then(run, run)
  profileWriteTail = pending.catch(() => undefined)
  return pending
}

async function publishProfileContextUnlocked(
  profile: Omit<Profile, "pubkey">,
  appId: ConduitAppId,
  options: PublishProfileOptions = {}
): Promise<SelectedProfileContext> {
  buildNip01ProfilePublishContent({ profile })
  const signer = getAccountSigner()
  if (!signer) throw new Error("Signer not connected")
  const assertCurrentSession = () => {
    if (options.shouldContinue?.() === false || getAccountSigner() !== signer) {
      throw new Error(
        "The connected account changed. Review the profile before saving again."
      )
    }
  }
  assertCurrentSession()
  const pubkey = await signer.getPublicKey()
  assertCurrentSession()
  const authenticatedPubkey =
    options.authenticatedPubkey?.trim().toLowerCase() === pubkey.toLowerCase()
      ? pubkey
      : null
  const latest = await fetchProfileContext(pubkey, {
    authenticatedPubkey,
    accountPubkey: authenticatedPubkey,
    shouldContinue: options.shouldContinue,
    skipCache: true,
    priority: "visible",
    requireCompleteEvidence: true,
    evidenceScope: "profile_edit",
  })
  assertCurrentSession()
  const observed = latest.freshness === "observed" && !!latest.frontier
  const newProfile =
    latest.freshness === "unobserved" &&
    latest.readComplete &&
    latest.persistence !== "unavailable"
  if (
    (!observed && !newProfile) ||
    (latest.frontier?.validity === "malformed" && !latest.readComplete)
  ) {
    throw new Error(
      "The current profile could not be confirmed. Refresh it before saving."
    )
  }

  if (options.expectedLightningAddress !== undefined) {
    // Address-only edits must never repair malformed profile content by erasing
    // unknown fields. A separate profile repair remains an explicit operation.
    if (latest.frontier?.validity === "malformed")
      throw new Error(
        "Repair your profile before changing its Lightning address."
      )
    assertProfileAddressChoice(
      latest.frontier?.rawContent,
      options.expectedLightningAddress
    )
  }

  // Build NIP-01 snake_case content, merging partial edits onto loaded context.
  const content = buildNip01ProfilePublishContent({
    profile,
    latestProfile: latest.profile,
    latestContent: latest.frontier?.rawContent,
  })
  const draft: UnsignedNostrEvent = {
    kind: EVENT_KINDS.PROFILE,
    pubkey: pubkey,
    created_at: getNextProfileEventCreatedAt(latest.frontier?.eventCreatedAt),
    tags: appendConduitClientTag([], appId),
    content: JSON.stringify(content),
  }
  const replaceableSafety =
    options.expectedLightningAddress === undefined
      ? undefined
      : {
          profileAddressPatch: {
            previousContent: latest.frontier?.rawContent ?? "{}",
            nextContent: draft.content,
          },
        }
  assertSafeReplaceablePublish(draft, replaceableSafety)
  assertCurrentSession()
  const event = await signer.signEvent(draft)
  assertCurrentSession()
  if (options.expectedLightningAddress !== undefined) {
    const current = await fetchProfileContext(pubkey, {
      authenticatedPubkey,
      accountPubkey: authenticatedPubkey,
      shouldContinue: options.shouldContinue,
      skipCache: true,
      priority: "visible",
      requireCompleteEvidence: true,
      evidenceScope: "profile_edit",
    })
    assertCurrentSession()
    if (
      (!current.frontier &&
        (!current.readComplete || current.persistence === "unavailable")) ||
      current.frontier?.eventId !== latest.frontier?.eventId ||
      current.freshness !== latest.freshness
    )
      throw new ProfilePublishSupersededError()
  }
  await publishWithPlanner(event, {
    replaceableSafety,
    intent: "author_event",
    authorPubkey: pubkey,
    authenticatedPubkey,
    accountPubkey: authenticatedPubkey,
    shouldContinue: options.shouldContinue,
  })
  assertCurrentSession()

  const publishedProfile = projectProfileContent(pubkey, event.content)

  // Reconcile against the commit-time frontier so a concurrent tab cannot
  // replace stronger profile evidence with this row after the network step.
  const retention = await retainSelectedProfileRows([
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

  return createSelectedProfileContext({
    pubkey,
    row: retainedProfile,
    observed: true,
  })
}
