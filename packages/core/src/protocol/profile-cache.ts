import { db, type CachedProfile } from "../db"
import type { Profile } from "../types"
import { getProfileName } from "../utils"
import { normalizePublicMediaUrl } from "../network-target-safety"
import { isValidLud16Address } from "./lightning"

export type ProfileMap = Record<string, Profile | undefined>

export interface CachedProfileRetentionResult {
  rows: CachedProfile[]
  displacedPubkeys: Set<string>
}

function profileFrontierCreatedAt(row: CachedProfile): number | undefined {
  return typeof row.eventCreatedAt === "number" &&
    Number.isSafeInteger(row.eventCreatedAt) &&
    row.eventCreatedAt >= 0
    ? row.eventCreatedAt
    : undefined
}

/**
 * Compare cached kind-0 frontiers using NIP-01 replacement ordering.
 * A positive result means `candidate` wins; a negative result means `current`
 * wins. Known frontiers always dominate legacy projection-only rows.
 */
export function compareCachedProfileFrontiers(
  candidate: CachedProfile,
  current: CachedProfile
): -1 | 0 | 1 {
  const candidateCreatedAt = profileFrontierCreatedAt(candidate)
  const currentCreatedAt = profileFrontierCreatedAt(current)

  if (candidateCreatedAt === undefined && currentCreatedAt === undefined)
    return 0
  if (candidateCreatedAt === undefined) return -1
  if (currentCreatedAt === undefined) return 1
  if (candidateCreatedAt > currentCreatedAt) return 1
  if (candidateCreatedAt < currentCreatedAt) return -1

  const candidateId = candidate.eventId || undefined
  const currentId = current.eventId || undefined
  if (candidateId === currentId) return 0
  if (!candidateId) return -1
  if (!currentId) return 1
  return candidateId < currentId ? 1 : -1
}

function uniqueProfileSourceRelayUrls(
  current: readonly string[] | undefined,
  candidate: readonly string[] | undefined
): string[] | undefined {
  const urls = Array.from(new Set([...(current ?? []), ...(candidate ?? [])]))
  return urls.length > 0 ? urls : undefined
}

export function projectCachedProfile(row: CachedProfile): Profile {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined
  return {
    pubkey: row.pubkey,
    name: text(row.name),
    displayName: text(row.displayName),
    about: text(row.about),
    picture: normalizePublicMediaUrl(row.picture) ?? undefined,
    banner: normalizePublicMediaUrl(row.banner) ?? undefined,
    nip05: text(row.nip05),
    lud16: text(row.lud16),
    website: text(row.website),
  }
}

export function projectProfileContent(
  pubkey: string,
  content: string | null | undefined
): Profile {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(content || "{}") as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  } catch {
    // Malformed content projects to a bare profile.
  }

  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined

  return {
    pubkey,
    name: text(raw.name),
    displayName: text(raw.display_name ?? raw.displayName),
    about: text(raw.about),
    picture: normalizePublicMediaUrl(raw.picture) ?? undefined,
    banner: normalizePublicMediaUrl(raw.banner) ?? undefined,
    nip05: text(raw.nip05),
    lud16: text(raw.lud16),
    website: text(raw.website),
  }
}

export function areProfileProjectionsEqual(
  left: Profile,
  right: Profile
): boolean {
  return (
    left.pubkey === right.pubkey &&
    left.name === right.name &&
    left.displayName === right.displayName &&
    left.about === right.about &&
    left.picture === right.picture &&
    left.banner === right.banner &&
    left.nip05 === right.nip05 &&
    left.lud16 === right.lud16 &&
    left.website === right.website
  )
}

function mergeSameCachedProfileFrontier(
  current: CachedProfile,
  candidate: CachedProfile
): CachedProfile {
  const sameKnownEvent =
    profileFrontierCreatedAt(current) !== undefined &&
    profileFrontierCreatedAt(current) === profileFrontierCreatedAt(candidate) &&
    !!current.eventId &&
    current.eventId === candidate.eventId
  const authoritativeRawContent = sameKnownEvent
    ? (candidate.rawContent ?? current.rawContent)
    : undefined
  const candidateProjection = projectCachedProfile(candidate)
  const candidateRawProjection =
    sameKnownEvent && candidate.rawContent !== undefined
      ? projectProfileContent(candidate.pubkey, candidate.rawContent)
      : undefined
  const candidateIsIntentionallyEnriched =
    !!candidateRawProjection &&
    !areProfileProjectionsEqual(candidateProjection, candidateRawProjection)
  const profile = candidateIsIntentionallyEnriched
    ? candidateProjection
    : authoritativeRawContent !== undefined
      ? projectProfileContent(current.pubkey, authoritativeRawContent)
      : (mergeRicherProfile(
          projectCachedProfile(current),
          candidateProjection
        ) ?? { pubkey: current.pubkey })

  return {
    ...current,
    name: profile.name,
    displayName: profile.displayName,
    about: profile.about,
    picture: profile.picture,
    banner: profile.banner,
    nip05: profile.nip05,
    lud16: profile.lud16,
    website: profile.website,
    rawContent: sameKnownEvent
      ? (candidate.rawContent ?? current.rawContent)
      : (current.rawContent ?? candidate.rawContent),
    eventId: current.eventId ?? candidate.eventId,
    eventCreatedAt: current.eventCreatedAt ?? candidate.eventCreatedAt,
    sourceRelayUrls: uniqueProfileSourceRelayUrls(
      current.sourceRelayUrls,
      candidate.sourceRelayUrls
    ),
    cachedAt: Math.max(current.cachedAt, candidate.cachedAt),
  }
}

export function retainStrongestCachedProfileRow(
  current: CachedProfile | undefined,
  candidate: CachedProfile
): CachedProfile {
  if (!current) return candidate

  const comparison = compareCachedProfileFrontiers(candidate, current)
  if (comparison < 0) return current
  if (comparison > 0) return candidate
  return mergeSameCachedProfileFrontier(current, candidate)
}

function cachedProfileRowsEqual(
  left: CachedProfile | undefined,
  right: CachedProfile
): boolean {
  return !!left && JSON.stringify(left) === JSON.stringify(right)
}

export function reduceCachedProfileRows(
  candidates: readonly CachedProfile[],
  currentRows: readonly (CachedProfile | undefined)[]
): CachedProfileRetentionResult & { updates: CachedProfile[] } {
  const pubkeys = Array.from(
    new Set(candidates.map((candidate) => candidate.pubkey))
  )
  const originalRows = new Map<string, CachedProfile | undefined>(
    pubkeys.map((pubkey) => [pubkey, undefined])
  )
  for (const row of currentRows) {
    if (row && originalRows.has(row.pubkey)) originalRows.set(row.pubkey, row)
  }
  const selectedRows = new Map(originalRows)
  const displacedPubkeys = new Set<string>()

  for (const candidate of candidates) {
    const current = selectedRows.get(candidate.pubkey)
    if (current && compareCachedProfileFrontiers(candidate, current) < 0) {
      displacedPubkeys.add(candidate.pubkey)
    }
    selectedRows.set(
      candidate.pubkey,
      retainStrongestCachedProfileRow(current, candidate)
    )
  }

  const rows = pubkeys.map((pubkey) => selectedRows.get(pubkey)!)
  const updates = rows.filter(
    (row) => !cachedProfileRowsEqual(originalRows.get(row.pubkey), row)
  )
  return { rows, updates, displacedPubkeys }
}

/**
 * Atomically retain the kind-0 winner against the row current at commit time.
 * IndexedDB serializes overlapping read/write transactions across tabs.
 */
export async function retainStrongestCachedProfiles(
  candidates: readonly CachedProfile[]
): Promise<CachedProfileRetentionResult> {
  if (candidates.length === 0) {
    return { rows: [], displacedPubkeys: new Set() }
  }

  const pubkeys = Array.from(
    new Set(candidates.map((candidate) => candidate.pubkey))
  )
  return db.transaction("rw", db.profiles, async () => {
    const currentRows = await db.profiles.bulkGet(pubkeys)
    const { rows, updates, displacedPubkeys } = reduceCachedProfileRows(
      candidates,
      currentRows
    )
    if (updates.length > 0) await db.profiles.bulkPut(updates)
    return { rows, displacedPubkeys }
  })
}

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

export type ProfileFrontierState =
  | "not_observed"
  | "observed_valid"
  | "observed_malformed"
  | "retained_valid"
  | "retained_malformed"

export interface SelectedProfileContext {
  profile: Profile
  frontier?: {
    eventId: string
    eventCreatedAt: number
    rawContent: string
    validity: "valid" | "malformed"
  }
  freshness: "observed" | "retained" | "unobserved"
  persistence: "durable" | "session" | "unknown" | "unavailable"
  /** Complete bounded network evidence; never a claim of global absence. */
  readComplete: boolean
}

type ProfileCacheTestOverrides = {
  getCachedProfiles?: (
    pubkeys: string[]
  ) => Promise<Array<CachedProfile | undefined>>
  putCachedProfiles?: (rows: CachedProfile[]) => Promise<void>
}
let profileCacheTestOverrides: ProfileCacheTestOverrides = {}
let profileCacheWriteLock: Promise<void> = Promise.resolve()
// Failed writes remain until equal or stronger durable evidence is confirmed.
const unpersistedProfileRows = new Map<string, CachedProfile>()

export function __setProfileCacheTestOverrides(
  overrides: ProfileCacheTestOverrides
): void {
  profileCacheTestOverrides = { ...profileCacheTestOverrides, ...overrides }
}

export function __resetProfileCacheTestOverrides(): void {
  profileCacheTestOverrides = {}
  profileCacheWriteLock = Promise.resolve()
  unpersistedProfileRows.clear()
}

/** Build projection, exact frontier, and provenance from one selected row. */
export function createSelectedProfileContext(input: {
  pubkey: string
  row?: CachedProfile
  profile?: Profile
  observed?: boolean
  readComplete?: boolean
  storageAvailable?: boolean
  persistence?: SelectedProfileContext["persistence"]
}): SelectedProfileContext {
  const { row } = input
  const known = hasKnownProfileFrontier(row)
  const pending = unpersistedProfileRows.get(input.pubkey)
  return {
    profile:
      known && hasValidProfileEventContent(row.rawContent)
        ? projectProfileContent(row.pubkey, row.rawContent)
        : row
          ? projectProfilePaymentAuthority(row)
          : (input.profile ?? { pubkey: input.pubkey }),
    ...(known
      ? {
          frontier: {
            eventId: row.eventId,
            eventCreatedAt: row.eventCreatedAt,
            rawContent: row.rawContent,
            validity: hasValidProfileEventContent(row.rawContent)
              ? ("valid" as const)
              : ("malformed" as const),
          },
        }
      : {}),
    freshness: known
      ? input.observed
        ? "observed"
        : "retained"
      : "unobserved",
    persistence:
      input.persistence ??
      (known
        ? pending && compareCachedProfileFrontiers(pending, row) >= 0
          ? "session"
          : "durable"
        : input.storageAvailable === false
          ? "unavailable"
          : "unknown"),
    readComplete: input.readComplete ?? false,
  }
}

/** Compare selected contexts using the same NIP-01 frontier order as persistence. */
export function compareSelectedProfileContexts(
  candidate: SelectedProfileContext,
  current: SelectedProfileContext
): -1 | 0 | 1 {
  return compareCachedProfileFrontiers(
    { pubkey: candidate.profile.pubkey, ...candidate.frontier, cachedAt: 0 },
    { pubkey: current.profile.pubkey, ...current.frontier, cachedAt: 0 }
  )
}

/** Read the same selected owner context without adding a network availability gate. */
export async function loadSelectedProfileContext(
  pubkey: string
): Promise<SelectedProfileContext> {
  const snapshot = await loadProfileCacheSnapshot([pubkey])
  if (!snapshot.storageAvailable && !snapshot.rows[0]) {
    throw new Error("Retained profile context is unavailable.")
  }
  return createSelectedProfileContext({
    pubkey,
    row: snapshot.rows[0],
    storageAvailable: snapshot.storageAvailable,
  })
}

export function getProfilePaymentAddress(
  context: SelectedProfileContext | undefined
): string | undefined {
  if (!context?.frontier || context.frontier.validity !== "valid")
    return undefined
  const address = projectProfileContent(
    context.profile.pubkey,
    context.frontier.rawContent
  ).lud16?.trim()
  return address && isValidLud16Address(address) ? address : undefined
}

export function hasFreshProfilePaymentAddress(
  context: SelectedProfileContext | undefined
): boolean {
  return (
    context?.freshness === "observed" && !!getProfilePaymentAddress(context)
  )
}

export function hasValidProfileEventContent(
  content: string | null | undefined
): boolean {
  if (typeof content !== "string") return false
  try {
    const parsed = JSON.parse(content) as unknown
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
  } catch {
    return false
  }
}

export function hasKnownProfileFrontier(
  row: CachedProfile | undefined
): row is CachedProfile & {
  rawContent: string
  eventId: string
  eventCreatedAt: number
} {
  return (
    !!row?.eventId &&
    typeof row.rawContent === "string" &&
    Number.isSafeInteger(row.eventCreatedAt) &&
    row.eventCreatedAt! >= 0
  )
}

export function projectProfilePaymentAuthority(row: CachedProfile): Profile {
  const profile = projectCachedProfile(row)
  if (!hasKnownProfileFrontier(row)) return profile
  return {
    ...profile,
    lud16: hasValidProfileEventContent(row.rawContent)
      ? projectProfileContent(row.pubkey, row.rawContent).lud16
      : undefined,
  }
}

export function retainedProfileFrontierState(
  row: CachedProfile | undefined
): ProfileFrontierState {
  return !hasKnownProfileFrontier(row)
    ? "not_observed"
    : hasValidProfileEventContent(row.rawContent)
      ? "retained_valid"
      : "retained_malformed"
}

export async function loadProfileCacheSnapshot(pubkeys: string[]): Promise<{
  rows: Array<CachedProfile | undefined>
  storageAvailable: boolean
}> {
  let storageAvailable = true
  let rows: Array<CachedProfile | undefined>
  try {
    rows = profileCacheTestOverrides.getCachedProfiles
      ? await profileCacheTestOverrides.getCachedProfiles(pubkeys)
      : await db.profiles.bulkGet(pubkeys)
  } catch {
    storageAvailable = false
    rows = []
  }
  const selected = pubkeys.map((pubkey, index) => {
    const durable = rows[index]
    const pending = unpersistedProfileRows.get(pubkey)
    if (!pending) return durable
    if (!hasKnownProfileFrontier(durable)) return pending
    if (compareCachedProfileFrontiers(durable, pending) >= 0) {
      unpersistedProfileRows.delete(pubkey)
    }
    return retainStrongestCachedProfileRow(durable, pending)
  })
  return { rows: selected, storageAvailable }
}

export async function loadRetainedProfileRows(
  pubkeys: string[]
): Promise<Array<CachedProfile | undefined>> {
  return (await loadProfileCacheSnapshot(pubkeys)).rows
}

export async function retainSelectedProfileRows(
  rows: CachedProfile[]
): Promise<CachedProfileRetentionResult & { persistenceFailed?: boolean }> {
  let retention: CachedProfileRetentionResult
  let persistenceFailed = false
  try {
    retention = await persistCachedProfiles(rows)
    for (const row of retention.rows) {
      const pending = unpersistedProfileRows.get(row.pubkey)
      if (
        pending &&
        hasKnownProfileFrontier(row) &&
        compareCachedProfileFrontiers(row, pending) >= 0
      ) {
        unpersistedProfileRows.delete(row.pubkey)
      }
    }
  } catch {
    persistenceFailed = true
    // A failed cache write must not erase signed evidence already received.
    // Reconcile once more in case another reader committed a stronger row.
    const current = await loadRetainedProfileRows(rows.map((row) => row.pubkey))
    retention = reduceCachedProfileRows(rows, current)
    for (const row of retention.rows) {
      if (hasKnownProfileFrontier(row)) {
        unpersistedProfileRows.set(
          row.pubkey,
          retainStrongestCachedProfileRow(
            unpersistedProfileRows.get(row.pubkey),
            row
          )
        )
      }
    }
  }
  // An overlapping failed write can outlive this request's durable write.
  const effective = reduceCachedProfileRows(
    retention.rows,
    retention.rows.map((row) => unpersistedProfileRows.get(row.pubkey))
  )
  return {
    rows: effective.rows,
    displacedPubkeys: new Set([
      ...retention.displacedPubkeys,
      ...effective.displacedPubkeys,
    ]),
    persistenceFailed,
  }
}

async function persistCachedProfiles(
  rows: CachedProfile[]
): Promise<CachedProfileRetentionResult> {
  if (rows.length === 0) {
    return { rows: [], displacedPubkeys: new Set() }
  }

  if (
    profileCacheTestOverrides.getCachedProfiles ||
    profileCacheTestOverrides.putCachedProfiles
  ) {
    const previous = profileCacheWriteLock
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    profileCacheWriteLock = previous.catch(() => undefined).then(() => gate)

    await previous.catch(() => undefined)
    try {
      const pubkeys = Array.from(new Set(rows.map((row) => row.pubkey)))
      const currentRows = profileCacheTestOverrides.getCachedProfiles
        ? await profileCacheTestOverrides.getCachedProfiles(pubkeys)
        : pubkeys.map(() => undefined)
      const retention = reduceCachedProfileRows(rows, currentRows)
      if (
        retention.updates.length > 0 &&
        profileCacheTestOverrides.putCachedProfiles
      ) {
        await profileCacheTestOverrides.putCachedProfiles(retention.updates)
      }
      return {
        rows: retention.rows,
        displacedPubkeys: retention.displacedPubkeys,
      }
    } finally {
      release()
    }
  }

  return await retainStrongestCachedProfiles(rows)
}
