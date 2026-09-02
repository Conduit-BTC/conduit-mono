import { kinds, type Filter } from "nostr-tools"
import { normalizePublicHttpsUrl } from "../network-target-safety"
import { getRelayLists } from "./relay-list"
import {
  fetchSignedEventsFanoutDetailed,
  type SignedEventRelayReadResult,
} from "./relay-reader"
import {
  DEFAULT_READ_FANOUT,
  planRelayReads,
  type RelayReadPlan,
} from "./relay-planner"
import {
  planPublishRelays,
  publishSignedEventToRelay,
  type ExclusiveRelayPublishStatus,
  type PublishWithPlannerInput,
} from "./relay-publish"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { NostrSignerError, type NostrEventSigner } from "./nostr-event-signer"

/**
 * BUD-03 ordered Blossom server preferences (kind 10063).
 *
 * Blossom servers are HTTPS origins. They are deliberately kept separate
 * from Nostr relay URLs and are never probed by this module. Later upload
 * code must independently revalidate redirects and resolved network targets.
 */

export const BLOSSOM_SERVER_LIST_KIND = kinds.BlossomServerList
export const MAX_MEDIA_SERVER_READ_RELAYS = DEFAULT_READ_FANOUT
export const MAX_MEDIA_SERVER_PUBLISH_RELAYS = 6
export const MAX_MEDIA_SERVER_FUTURE_SKEW_SECONDS = 5 * 60
export const MEDIA_SERVER_PREFERENCES_STORAGE_VERSION = 1

const MEDIA_SERVER_STORAGE_PREFIX = "conduit:media-server-preferences:v1"
const HEX_PUBKEY = /^[0-9a-f]{64}$/

export type MediaServerTagParseState = "valid" | "empty" | "malformed"

export interface ParsedMediaServerTags {
  state: MediaServerTagParseState
  serverUrls: string[]
  serverTagCount: number
  malformedTagCount: number
  duplicateTagCount: number
}

export interface MediaServerPreferenceEventLike {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

export interface SelectedMediaServerPreferenceEvent {
  event: MediaServerPreferenceEventLike
  parsed: ParsedMediaServerTags & { state: "valid" }
}

export type MediaServerLookupCoverage = "complete" | "partial" | "unavailable"

export type MediaServerPreferenceStatus =
  | "published"
  | "not_observed"
  | "empty"
  | "malformed"
  | "lookup_partial"
  | "lookup_unavailable"

export interface MediaServerPreferenceRevision {
  eventId: string
  createdAt: number
}

export interface MediaServerPublishedEvidence {
  signedEvent: SignedPublicNostrEvent
  serverUrls: string[]
  sourceRelayUrls: string[]
  observedAt: number
  completeObservedAt?: number
}

export interface MediaServerFrontierEvidence {
  eventId: string
  createdAt: number
  state: MediaServerTagParseState
}

export interface MediaServerLookupEvidence {
  observedAt: number
  coverage: MediaServerLookupCoverage
  plannedRelayCount: number
  successfulRelayCount: number
  partialRelayCount: number
  failedRelayCount: number
  rejectedEventCount: number
  hadEvent: boolean
  eventId?: string
}

export interface PendingMediaServerPublish {
  signedEvent: SignedPublicNostrEvent
  serverUrls: string[]
  publishRelayUrls: string[]
  acknowledgedRelayUrls: string[]
  rejectedRelayUrls: string[]
  timedOutRelayUrls: string[]
  stagedAt: number
}

export interface MediaServerDraftRecord {
  serverUrls: string[]
  baseServerUrls: string[]
  baseEventId: string | null
  updatedAt: number
}

export interface MediaServerPreferenceEvidenceRecord {
  version: typeof MEDIA_SERVER_PREFERENCES_STORAGE_VERSION
  owner: string
  published?: MediaServerPublishedEvidence
  frontier?: MediaServerFrontierEvidence
  latestLookup?: MediaServerLookupEvidence
  pending?: PendingMediaServerPublish
  draft?: MediaServerDraftRecord
}

export interface MediaServerPreferenceResolution {
  owner: string
  status: MediaServerPreferenceStatus
  coverage: MediaServerLookupCoverage
  publishedServerUrls: string[]
  publishedRevision: MediaServerPreferenceRevision | null
  frontier: MediaServerFrontierEvidence | null
  sourceRelayUrls: string[]
  observedAt: number
  completeObservedAt: number | null
  stale: boolean
  retained: boolean
  lookup: MediaServerLookupEvidence
  pending: PendingMediaServerPublish | null
}

export interface MediaServerPreferencesStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ReadMediaServerPreferencesDependencies {
  readRelayUrls?: readonly string[]
  getRelayLists?: typeof getRelayLists
  planReads?: typeof planRelayReads
  fetchEvents?: typeof fetchSignedEventsFanoutDetailed
  storage?: MediaServerPreferencesStorage | null
  now?: () => number
}

export interface ReviewedMediaServerEvidence {
  frontierEventId: string | null
  publishedEventId: string | null
}

export type MediaServerPublishOutcome =
  "confirmed" | "partial" | "confirmation_pending" | "rejected" | "failed"

export interface MediaServerPublishResult {
  outcome: MediaServerPublishOutcome
  signedEvent: SignedPublicNostrEvent
  acceptedRelayCount: number
  rejectedRelayCount: number
  timedOutRelayCount: number
  targetRelayCount: number
  confirmed: boolean
  partialAcceptance: boolean
  retryAvailable: boolean
}

export interface PublishMediaServerPreferencesDependencies extends ReadMediaServerPreferencesDependencies {
  publishRelayUrls?: readonly string[]
  planPublish?: typeof planPublishRelays
  publishToRelay?: typeof publishSignedEventToRelay
  shouldContinue?: () => boolean
  onPhase?: (
    phase: "checking" | "awaiting_signature" | "publishing" | "confirming"
  ) => void
}

export interface PublishMediaServerPreferencesInput {
  owner: string
  serverUrls: readonly string[]
  signer: NostrEventSigner
  reviewed: ReviewedMediaServerEvidence
  dependencies?: PublishMediaServerPreferencesDependencies
}

export interface RetryMediaServerPreferencesInput {
  owner: string
  dependencies?: PublishMediaServerPreferencesDependencies
}

export class MediaServerPreferencesError extends Error {
  readonly code:
    | "invalid_owner"
    | "invalid_server"
    | "duplicate_server"
    | "empty_list"
    | "evidence_changed"
    | "evidence_unavailable"
    | "signer_mismatch"
    | "pending_publish"
    | "no_publish_targets"
    | "future_frontier"
    | "invalid_signature"
    | "missing_pending_publish"

  constructor(code: MediaServerPreferencesError["code"], message: string) {
    super(message)
    this.name = "MediaServerPreferencesError"
    this.code = code
  }
}

const inMemoryRecords = new Map<string, MediaServerPreferenceEvidenceRecord>()

function clone<T>(value: T): T {
  return structuredClone(value)
}

function getDefaultStorage(): MediaServerPreferencesStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function normalizeMediaServerPreferenceOwner(owner: string): string {
  const normalized = owner.trim().toLowerCase()
  if (!HEX_PUBKEY.test(normalized)) {
    throw new MediaServerPreferencesError(
      "invalid_owner",
      "Media server preferences require a valid connected account."
    )
  }
  return normalized
}

/** Return one canonical public HTTPS origin, without a trailing slash. */
export function normalizeBlossomServerRoot(raw: unknown): string | null {
  const safe = normalizePublicHttpsUrl(raw)
  if (!safe) return null

  try {
    const url = new URL(safe)
    if (url.pathname !== "/" || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

export function parseBlossomServerListTags(
  tags: readonly string[][]
): ParsedMediaServerTags {
  const serverUrls: string[] = []
  const seen = new Set<string>()
  let serverTagCount = 0
  let malformedTagCount = 0
  let duplicateTagCount = 0

  for (const tag of tags) {
    if (tag[0] !== "server") continue
    serverTagCount += 1
    if (tag.length < 2) {
      malformedTagCount += 1
      continue
    }
    const normalized = normalizeBlossomServerRoot(tag[1])
    if (!normalized) {
      malformedTagCount += 1
      continue
    }
    if (seen.has(normalized)) {
      duplicateTagCount += 1
      continue
    }
    seen.add(normalized)
    serverUrls.push(normalized)
  }

  const state: MediaServerTagParseState =
    serverTagCount === 0
      ? "empty"
      : malformedTagCount > 0
        ? "malformed"
        : serverUrls.length > 0
          ? "valid"
          : "malformed"

  return {
    state,
    serverUrls,
    serverTagCount,
    malformedTagCount,
    duplicateTagCount,
  }
}

export function normalizeMediaServerPreferenceList(
  serverUrls: readonly string[],
  options: { allowEmpty?: boolean } = {}
): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const raw of serverUrls) {
    const serverUrl = normalizeBlossomServerRoot(raw)
    if (!serverUrl) {
      throw new MediaServerPreferencesError(
        "invalid_server",
        "Enter a public HTTPS server root without credentials, a path, query parameters, or a fragment."
      )
    }
    if (seen.has(serverUrl)) {
      throw new MediaServerPreferencesError(
        "duplicate_server",
        "That media server is already in the ordered list."
      )
    }
    seen.add(serverUrl)
    normalized.push(serverUrl)
  }

  if (!options.allowEmpty && normalized.length === 0) {
    throw new MediaServerPreferencesError(
      "empty_list",
      "Add at least one media server before publishing."
    )
  }
  return normalized
}

export function serializeBlossomServerListTags(
  serverUrls: readonly string[]
): string[][] {
  return normalizeMediaServerPreferenceList(serverUrls).map((serverUrl) => [
    "server",
    serverUrl,
  ])
}

function compareReplaceable(
  left: Pick<MediaServerPreferenceEventLike, "created_at" | "id">,
  right: Pick<MediaServerPreferenceEventLike, "created_at" | "id">
): number {
  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at
  }
  return left.id.localeCompare(right.id)
}

function matchingOwnerEvents(
  events: readonly MediaServerPreferenceEventLike[],
  owner: string
): MediaServerPreferenceEventLike[] {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  return events
    .filter(
      (event) =>
        event.kind === BLOSSOM_SERVER_LIST_KIND &&
        event.pubkey.trim().toLowerCase() === normalizedOwner
    )
    .sort(compareReplaceable)
}

export function selectLatestValidBlossomServerListEvent(
  events: readonly MediaServerPreferenceEventLike[],
  owner: string
): SelectedMediaServerPreferenceEvent | null {
  for (const event of matchingOwnerEvents(events, owner)) {
    const parsed = parseBlossomServerListTags(event.tags)
    if (parsed.state === "valid") {
      return {
        event,
        parsed: parsed as ParsedMediaServerTags & { state: "valid" },
      }
    }
  }
  return null
}

export function selectLatestObservedBlossomServerListEvent(
  events: readonly MediaServerPreferenceEventLike[],
  owner: string
): MediaServerPreferenceEventLike | null {
  return matchingOwnerEvents(events, owner)[0] ?? null
}

function strongerRevision(
  candidate: Pick<MediaServerPreferenceEventLike, "created_at" | "id">,
  current: Pick<MediaServerPreferenceEventLike, "created_at" | "id"> | undefined
): boolean {
  return !current || compareReplaceable(candidate, current) < 0
}

function frontierRevision(
  frontier: MediaServerFrontierEvidence | undefined
): Pick<MediaServerPreferenceEventLike, "created_at" | "id"> | undefined {
  return frontier
    ? { id: frontier.eventId, created_at: frontier.createdAt }
    : undefined
}

function frontierSupersedesEvent(
  frontier: MediaServerFrontierEvidence | undefined,
  event: Pick<MediaServerPreferenceEventLike, "created_at" | "id">
): boolean {
  if (!frontier || frontier.eventId === event.id) return false
  return strongerRevision(
    { id: frontier.eventId, created_at: frontier.createdAt },
    event
  )
}

function recordSupersedesEvent(
  record: MediaServerPreferenceEvidenceRecord,
  event: Pick<MediaServerPreferenceEventLike, "created_at" | "id">
): boolean {
  return (
    frontierSupersedesEvent(record.frontier, event) ||
    (!!record.published &&
      record.published.signedEvent.id !== event.id &&
      strongerRevision(record.published.signedEvent, event))
  )
}

export function getMediaServerPreferencesStorageKey(owner: string): string {
  return `${MEDIA_SERVER_STORAGE_PREFIX}:${normalizeMediaServerPreferenceOwner(owner)}`
}

function validSignedPreferenceEvent(
  event: SignedPublicNostrEvent,
  owner: string
): { event: SignedPublicNostrEvent; serverUrls: string[] } | null {
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== BLOSSOM_SERVER_LIST_KIND ||
    event.pubkey !== owner ||
    event.id !== event.id.toLowerCase() ||
    event.pubkey !== event.pubkey.toLowerCase() ||
    event.sig !== event.sig.toLowerCase()
  ) {
    return null
  }
  const parsed = parseBlossomServerListTags(event.tags)
  return parsed.state === "valid"
    ? { event: clone(event), serverUrls: parsed.serverUrls }
    : null
}

function sanitizeStoredRecord(
  value: unknown,
  owner: string
): MediaServerPreferenceEvidenceRecord | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<MediaServerPreferenceEvidenceRecord>
  if (
    candidate.version !== MEDIA_SERVER_PREFERENCES_STORAGE_VERSION ||
    candidate.owner !== owner
  ) {
    return null
  }

  const record: MediaServerPreferenceEvidenceRecord = {
    version: MEDIA_SERVER_PREFERENCES_STORAGE_VERSION,
    owner,
  }
  if (candidate.published) {
    const valid = validSignedPreferenceEvent(
      candidate.published.signedEvent,
      owner
    )
    if (valid) {
      record.published = {
        signedEvent: valid.event,
        serverUrls: valid.serverUrls,
        sourceRelayUrls: normalizeSecureOrIsolatedE2eRelayUrls(
          candidate.published.sourceRelayUrls ?? []
        ),
        observedAt: candidate.published.observedAt,
        completeObservedAt: candidate.published.completeObservedAt,
      }
    }
  }
  if (
    candidate.frontier &&
    /^[0-9a-f]{64}$/.test(candidate.frontier.eventId) &&
    Number.isSafeInteger(candidate.frontier.createdAt) &&
    ["valid", "empty", "malformed"].includes(candidate.frontier.state)
  ) {
    record.frontier = clone(candidate.frontier)
  }
  if (candidate.latestLookup)
    record.latestLookup = clone(candidate.latestLookup)
  if (candidate.pending) {
    const valid = validSignedPreferenceEvent(
      candidate.pending.signedEvent,
      owner
    )
    const publishRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
      candidate.pending.publishRelayUrls ?? []
    )
    if (valid && publishRelayUrls.length > 0) {
      const targetSet = new Set(publishRelayUrls)
      const withinPlan = (urls: readonly string[]) =>
        normalizeSecureOrIsolatedE2eRelayUrls(urls).filter((url) =>
          targetSet.has(url)
        )
      record.pending = {
        signedEvent: valid.event,
        serverUrls: valid.serverUrls,
        publishRelayUrls,
        acknowledgedRelayUrls: withinPlan(
          candidate.pending.acknowledgedRelayUrls ?? []
        ),
        rejectedRelayUrls: withinPlan(
          candidate.pending.rejectedRelayUrls ?? []
        ),
        timedOutRelayUrls: withinPlan(
          candidate.pending.timedOutRelayUrls ?? []
        ),
        stagedAt: candidate.pending.stagedAt,
      }
    }
  }
  if (candidate.draft) {
    try {
      record.draft = {
        serverUrls: normalizeMediaServerPreferenceList(
          candidate.draft.serverUrls,
          { allowEmpty: true }
        ),
        baseServerUrls: normalizeMediaServerPreferenceList(
          candidate.draft.baseServerUrls,
          { allowEmpty: true }
        ),
        baseEventId:
          candidate.draft.baseEventId === null ||
          /^[0-9a-f]{64}$/.test(candidate.draft.baseEventId)
            ? candidate.draft.baseEventId
            : null,
        updatedAt: candidate.draft.updatedAt,
      }
    } catch {
      // Ignore a damaged local draft without discarding valid network evidence.
    }
  }
  return record
}

export function loadMediaServerPreferenceRecord(
  owner: string,
  storage: MediaServerPreferencesStorage | null = getDefaultStorage()
): MediaServerPreferenceEvidenceRecord {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  const key = getMediaServerPreferencesStorageKey(normalizedOwner)
  const memory = inMemoryRecords.get(key)
  if (memory) return clone(memory)

  if (storage) {
    try {
      const raw = storage.getItem(key)
      const parsed = raw
        ? sanitizeStoredRecord(JSON.parse(raw), normalizedOwner)
        : null
      if (parsed) {
        inMemoryRecords.set(key, clone(parsed))
        return clone(parsed)
      }
    } catch {
      // Local persistence is best-effort; the process cache remains usable.
    }
  }
  return {
    version: MEDIA_SERVER_PREFERENCES_STORAGE_VERSION,
    owner: normalizedOwner,
  }
}

function loadFreshMediaServerPreferenceRecord(
  owner: string,
  storage: MediaServerPreferencesStorage | null
): MediaServerPreferenceEvidenceRecord {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  if (storage) {
    try {
      const raw = storage.getItem(
        getMediaServerPreferencesStorageKey(normalizedOwner)
      )
      const parsed = raw
        ? sanitizeStoredRecord(JSON.parse(raw), normalizedOwner)
        : null
      if (parsed) {
        inMemoryRecords.set(
          getMediaServerPreferencesStorageKey(normalizedOwner),
          clone(parsed)
        )
        return clone(parsed)
      }
    } catch {
      // Fall back to the exact process checkpoint when storage is unavailable.
    }
  }
  return loadMediaServerPreferenceRecord(normalizedOwner, storage)
}

function saveMediaServerPreferenceRecord(
  record: MediaServerPreferenceEvidenceRecord,
  storage: MediaServerPreferencesStorage | null = getDefaultStorage()
): MediaServerPreferenceEvidenceRecord {
  const safe = sanitizeStoredRecord(record, record.owner)
  if (!safe) throw new Error("Refusing to store invalid media server evidence")
  const key = getMediaServerPreferencesStorageKey(safe.owner)
  inMemoryRecords.set(key, clone(safe))
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify(safe))
    } catch {
      // Preserve the exact process-local checkpoint when browser storage fails.
    }
  }
  return clone(safe)
}

export function loadMediaServerDraft(
  owner: string,
  storage?: MediaServerPreferencesStorage | null
): MediaServerDraftRecord | null {
  return clone(loadMediaServerPreferenceRecord(owner, storage).draft ?? null)
}

export function saveMediaServerDraft(
  owner: string,
  draft: MediaServerDraftRecord,
  storage?: MediaServerPreferencesStorage | null
): MediaServerDraftRecord {
  const record = loadMediaServerPreferenceRecord(owner, storage)
  record.draft = {
    serverUrls: normalizeMediaServerPreferenceList(draft.serverUrls, {
      allowEmpty: true,
    }),
    baseServerUrls: normalizeMediaServerPreferenceList(draft.baseServerUrls, {
      allowEmpty: true,
    }),
    baseEventId: draft.baseEventId,
    updatedAt: draft.updatedAt,
  }
  return saveMediaServerPreferenceRecord(record, storage).draft!
}

export function sameOrderedMediaServerList(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((serverUrl, index) => serverUrl === right[index])
  )
}

export function addMediaServerPreference(
  current: readonly string[],
  raw: string
): string[] {
  const serverUrl = normalizeBlossomServerRoot(raw)
  if (!serverUrl) {
    throw new MediaServerPreferencesError(
      "invalid_server",
      "Enter a public HTTPS server root without credentials, a path, query parameters, or a fragment."
    )
  }
  if (current.includes(serverUrl)) {
    throw new MediaServerPreferencesError(
      "duplicate_server",
      "That media server is already in the ordered list."
    )
  }
  return normalizeMediaServerPreferenceList([...current, serverUrl], {
    allowEmpty: true,
  })
}

export function removeMediaServerPreference(
  current: readonly string[],
  serverUrl: string
): string[] {
  return normalizeMediaServerPreferenceList(
    current.filter((entry) => entry !== serverUrl),
    { allowEmpty: true }
  )
}

export function moveMediaServerPreference(
  current: readonly string[],
  fromIndex: number,
  toIndex: number
): string[] {
  const normalized = normalizeMediaServerPreferenceList(current, {
    allowEmpty: true,
  })
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= normalized.length ||
    toIndex < 0 ||
    toIndex >= normalized.length ||
    fromIndex === toIndex
  ) {
    return normalized
  }
  const next = [...normalized]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved!)
  return next
}

function readCoverage(
  plannedRelayUrls: readonly string[],
  result: SignedEventRelayReadResult | null,
  observedAt: number
): MediaServerLookupEvidence {
  const relays = result?.relays ?? []
  const successfulRelayCount = relays.filter(
    (relay) => relay.status === "success"
  ).length
  const partialRelayCount = relays.filter(
    (relay) => relay.status === "partial"
  ).length
  const failedRelayCount = Math.max(
    relays.filter((relay) => relay.status === "failed").length,
    plannedRelayUrls.length - relays.length
  )
  const rejectedEventCount = relays.reduce(
    (count, relay) => count + (relay.rejectedEventCount ?? 0),
    0
  )
  const verified = result?.eventsVerified === true
  const allComplete =
    verified &&
    plannedRelayUrls.length > 0 &&
    plannedRelayUrls.every((relayUrl) =>
      relays.some(
        (relay) => relay.relayUrl === relayUrl && relay.status === "success"
      )
    ) &&
    rejectedEventCount === 0
  const usable =
    verified &&
    relays.some(
      (relay) => relay.status === "success" || relay.status === "partial"
    )
  return {
    observedAt,
    coverage: allComplete ? "complete" : usable ? "partial" : "unavailable",
    plannedRelayCount: plannedRelayUrls.length,
    successfulRelayCount,
    partialRelayCount,
    failedRelayCount,
    rejectedEventCount,
    hadEvent: (result?.events.length ?? 0) > 0,
  }
}

async function resolveReadPlan(
  owner: string,
  dependencies: ReadMediaServerPreferencesDependencies
): Promise<RelayReadPlan> {
  if (dependencies.readRelayUrls) {
    return {
      intent: "general",
      relayUrls: normalizeSecureOrIsolatedE2eRelayUrls(
        dependencies.readRelayUrls
      ).slice(0, MAX_MEDIA_SERVER_READ_RELAYS),
      parkedRelayUrls: [],
      hintRelayUrls: [],
    }
  }
  const relayLists = await (dependencies.getRelayLists ?? getRelayLists)(
    [owner],
    {
      cacheOnly: false,
      allowInsecureRelayUrlsForPubkey: owner,
    }
  )
  return (dependencies.planReads ?? planRelayReads)({
    intent: "general",
    authors: [owner],
    relayLists,
    authenticatedPubkey: owner,
    maxRelays: MAX_MEDIA_SERVER_READ_RELAYS,
    skipHealthFilter: true,
  })
}

function mergeRelaySources(
  left: readonly string[],
  right: readonly string[]
): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls([...left, ...right]).sort()
}

function preserveCurrentRecordState(
  candidate: MediaServerPreferenceEvidenceRecord,
  current: MediaServerPreferenceEvidenceRecord
): void {
  if (current.pending) candidate.pending = clone(current.pending)
  else delete candidate.pending

  if (current.draft) candidate.draft = clone(current.draft)
  else delete candidate.draft

  if (
    current.frontier &&
    strongerRevision(
      {
        id: current.frontier.eventId,
        created_at: current.frontier.createdAt,
      },
      frontierRevision(candidate.frontier)
    )
  ) {
    candidate.frontier = clone(current.frontier)
  }

  if (
    current.published &&
    strongerRevision(
      current.published.signedEvent,
      candidate.published?.signedEvent
    )
  ) {
    candidate.published = clone(current.published)
  } else if (
    current.published &&
    candidate.published?.signedEvent.id === current.published.signedEvent.id
  ) {
    candidate.published.sourceRelayUrls = mergeRelaySources(
      candidate.published.sourceRelayUrls,
      current.published.sourceRelayUrls
    )
    candidate.published.observedAt = Math.max(
      candidate.published.observedAt,
      current.published.observedAt
    )
    if (current.published.completeObservedAt !== undefined) {
      candidate.published.completeObservedAt = Math.max(
        candidate.published.completeObservedAt ?? 0,
        current.published.completeObservedAt
      )
    }
  }

  if (
    current.latestLookup &&
    (!candidate.latestLookup ||
      current.latestLookup.observedAt > candidate.latestLookup.observedAt)
  ) {
    candidate.latestLookup = clone(current.latestLookup)
  }
}

function resolutionStatus(
  coverage: MediaServerLookupCoverage,
  frontier: MediaServerFrontierEvidence | undefined,
  networkHadFrontier: boolean
): MediaServerPreferenceStatus {
  if (coverage === "unavailable") return "lookup_unavailable"
  if (coverage === "partial") return "lookup_partial"
  if (!networkHadFrontier || !frontier) return "not_observed"
  return frontier.state === "valid"
    ? "published"
    : frontier.state === "empty"
      ? "empty"
      : "malformed"
}

export async function readMediaServerPreferences(
  owner: string,
  dependencies: ReadMediaServerPreferencesDependencies = {}
): Promise<MediaServerPreferenceResolution> {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  const observedAt = (dependencies.now ?? Date.now)()
  const storage =
    dependencies.storage === undefined
      ? getDefaultStorage()
      : dependencies.storage
  const retainedRecord = loadMediaServerPreferenceRecord(
    normalizedOwner,
    storage
  )
  let plan: RelayReadPlan
  let result: SignedEventRelayReadResult | null = null
  try {
    plan = await resolveReadPlan(normalizedOwner, dependencies)
    result = await (
      dependencies.fetchEvents ?? fetchSignedEventsFanoutDetailed
    )(
      {
        kinds: [BLOSSOM_SERVER_LIST_KIND],
        authors: [normalizedOwner],
        limit: 24,
      } satisfies Filter,
      {
        relayUrls: plan.relayUrls,
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 6_000,
        skipHealthFilter: true,
      }
    )
  } catch {
    plan = {
      intent: "general",
      relayUrls: [],
      parkedRelayUrls: [],
      hintRelayUrls: [],
    }
  }

  const lookup = readCoverage(plan.relayUrls, result, observedAt)
  const events = result?.eventsVerified === true ? result.events : []
  const networkFrontierEvent = selectLatestObservedBlossomServerListEvent(
    events,
    normalizedOwner
  )
  const networkValid = selectLatestValidBlossomServerListEvent(
    events,
    normalizedOwner
  )
  const record = clone(retainedRecord)
  if (networkFrontierEvent) {
    const parsed = parseBlossomServerListTags(networkFrontierEvent.tags)
    const frontier: MediaServerFrontierEvidence = {
      eventId: networkFrontierEvent.id,
      createdAt: networkFrontierEvent.created_at,
      state: parsed.state,
    }
    if (
      strongerRevision(
        networkFrontierEvent,
        record.frontier
          ? {
              id: record.frontier.eventId,
              created_at: record.frontier.createdAt,
            }
          : undefined
      )
    ) {
      record.frontier = frontier
    }
    lookup.eventId = networkFrontierEvent.id
  }

  if (networkValid) {
    const signedEvent = networkValid.event as SignedPublicNostrEvent
    const sourceRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
      result?.eventSourceRelayUrls[signedEvent.id] ?? []
    )
    if (strongerRevision(signedEvent, record.published?.signedEvent)) {
      record.published = {
        signedEvent: clone(signedEvent),
        serverUrls: [...networkValid.parsed.serverUrls],
        sourceRelayUrls,
        observedAt,
        completeObservedAt:
          lookup.coverage === "complete" ? observedAt : undefined,
      }
    } else if (record.published?.signedEvent.id === signedEvent.id) {
      record.published.sourceRelayUrls = mergeRelaySources(
        record.published.sourceRelayUrls,
        sourceRelayUrls
      )
      record.published.observedAt = Math.max(
        record.published.observedAt,
        observedAt
      )
      if (lookup.coverage === "complete") {
        record.published.completeObservedAt = Math.max(
          record.published.completeObservedAt ?? 0,
          observedAt
        )
      }
    }
  }

  record.latestLookup = lookup
  preserveCurrentRecordState(
    record,
    loadMediaServerPreferenceRecord(normalizedOwner, storage)
  )
  const saved = saveMediaServerPreferenceRecord(record, storage)
  const networkPublishedSelected =
    !!networkValid && saved.published?.signedEvent.id === networkValid.event.id
  const status = resolutionStatus(
    lookup.coverage,
    saved.frontier,
    !!networkFrontierEvent
  )
  const publishedRevision = saved.published
    ? {
        eventId: saved.published.signedEvent.id,
        createdAt: saved.published.signedEvent.created_at,
      }
    : null
  const frontierMatchesPublished =
    !!saved.frontier &&
    saved.frontier.state === "valid" &&
    saved.frontier.eventId === publishedRevision?.eventId
  const stale =
    lookup.coverage !== "complete" ||
    !networkPublishedSelected ||
    !frontierMatchesPublished

  return {
    owner: normalizedOwner,
    status,
    coverage: lookup.coverage,
    publishedServerUrls: [...(saved.published?.serverUrls ?? [])],
    publishedRevision,
    frontier: saved.frontier ? clone(saved.frontier) : null,
    sourceRelayUrls: [...(saved.published?.sourceRelayUrls ?? [])],
    observedAt,
    completeObservedAt: saved.published?.completeObservedAt ?? null,
    stale,
    retained: !!saved.published && !networkPublishedSelected,
    lookup: clone(lookup),
    pending: saved.pending ? clone(saved.pending) : null,
  }
}

function reviewedEvidenceFromResolution(
  resolution: MediaServerPreferenceResolution
): ReviewedMediaServerEvidence {
  return {
    frontierEventId: resolution.frontier?.eventId ?? null,
    publishedEventId: resolution.publishedRevision?.eventId ?? null,
  }
}

function sameReviewedEvidence(
  left: ReviewedMediaServerEvidence,
  right: ReviewedMediaServerEvidence
): boolean {
  return (
    left.frontierEventId === right.frontierEventId &&
    left.publishedEventId === right.publishedEventId
  )
}

export function toReviewedMediaServerEvidence(
  resolution: MediaServerPreferenceResolution
): ReviewedMediaServerEvidence {
  return reviewedEvidenceFromResolution(resolution)
}

export function selectMediaServerPreferenceCreatedAt(input: {
  frontierCreatedAt: number | null
  nowMs?: () => number
}): number {
  const nowMs = (input.nowMs ?? Date.now)()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Media server preference clock is invalid.")
  }
  const nowSeconds = Math.floor(nowMs / 1_000)
  const createdAt =
    input.frontierCreatedAt === null
      ? nowSeconds
      : Math.max(nowSeconds, input.frontierCreatedAt + 1)
  if (
    input.frontierCreatedAt !== null &&
    createdAt > nowSeconds + MAX_MEDIA_SERVER_FUTURE_SKEW_SECONDS
  ) {
    throw new MediaServerPreferencesError(
      "future_frontier",
      "The observed media server preference is too far ahead of this device clock. Check the clock or retry later; no event was signed."
    )
  }
  return createdAt
}

async function resolvePublishTargets(
  owner: string,
  dependencies: PublishMediaServerPreferencesDependencies
): Promise<string[]> {
  if (dependencies.publishRelayUrls) {
    return normalizeSecureOrIsolatedE2eRelayUrls(
      dependencies.publishRelayUrls
    ).slice(0, MAX_MEDIA_SERVER_PUBLISH_RELAYS)
  }
  const input: PublishWithPlannerInput = {
    intent: "author_event",
    authorPubkey: owner,
    authenticatedPubkey: owner,
    refreshRelayLists: true,
    skipHealthFilter: true,
  }
  const plan = await (dependencies.planPublish ?? planPublishRelays)(input)
  return normalizeSecureOrIsolatedE2eRelayUrls([
    ...plan.primaryRelayUrls,
    ...plan.broadcastRelayUrls,
  ]).slice(0, MAX_MEDIA_SERVER_PUBLISH_RELAYS)
}

function assertContinue(shouldContinue: (() => boolean) | undefined): void {
  if (shouldContinue?.() === false) {
    throw new NostrSignerError("authority_changed")
  }
}

function stagePendingPublish(
  record: MediaServerPreferenceEvidenceRecord,
  pending: PendingMediaServerPublish,
  storage: MediaServerPreferencesStorage | null
): MediaServerPreferenceEvidenceRecord {
  record.pending = clone(pending)
  const candidateFrontier: MediaServerFrontierEvidence = {
    eventId: pending.signedEvent.id,
    createdAt: pending.signedEvent.created_at,
    state: "valid",
  }
  if (
    strongerRevision(
      pending.signedEvent,
      record.frontier
        ? { id: record.frontier.eventId, created_at: record.frontier.createdAt }
        : undefined
    )
  ) {
    record.frontier = candidateFrontier
  }
  return saveMediaServerPreferenceRecord(record, storage)
}

function uniqueWithinPlan(
  urls: readonly string[],
  plan: readonly string[]
): string[] {
  const planSet = new Set(plan)
  return normalizeSecureOrIsolatedE2eRelayUrls(urls).filter((url) =>
    planSet.has(url)
  )
}

async function verifyPreferenceReadBack(input: {
  owner: string
  pending: PendingMediaServerPublish
  dependencies: PublishMediaServerPreferencesDependencies
}): Promise<{
  confirmed: boolean
  sourceRelayUrls: string[]
  complete: boolean
}> {
  const acknowledged = input.pending.acknowledgedRelayUrls
  if (acknowledged.length === 0) {
    return { confirmed: false, sourceRelayUrls: [], complete: false }
  }
  input.dependencies.onPhase?.("confirming")
  try {
    const result = await (
      input.dependencies.fetchEvents ?? fetchSignedEventsFanoutDetailed
    )(
      {
        ids: [input.pending.signedEvent.id],
        kinds: [BLOSSOM_SERVER_LIST_KIND],
        authors: [input.owner],
        limit: 1,
      },
      {
        relayUrls: acknowledged,
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 6_000,
        skipHealthFilter: true,
      }
    )
    if (result.eventsVerified !== true) {
      return { confirmed: false, sourceRelayUrls: [], complete: false }
    }
    const observed = result.events.some(
      (event) => event.id === input.pending.signedEvent.id
    )
    const sourceRelayUrls = uniqueWithinPlan(
      result.eventSourceRelayUrls[input.pending.signedEvent.id] ?? [],
      acknowledged
    )
    const complete = acknowledged.every((relayUrl) =>
      result.relays.some(
        (relay) => relay.relayUrl === relayUrl && relay.status === "success"
      )
    )
    return {
      confirmed: observed && sourceRelayUrls.length > 0,
      sourceRelayUrls,
      complete,
    }
  } catch {
    return { confirmed: false, sourceRelayUrls: [], complete: false }
  }
}

function publishOutcome(input: {
  pending: PendingMediaServerPublish
  confirmed: boolean
}): MediaServerPublishOutcome {
  const accepted = input.pending.acknowledgedRelayUrls.length
  const targetCount = input.pending.publishRelayUrls.length
  if (accepted === targetCount && input.confirmed) return "confirmed"
  if (accepted > 0 && input.confirmed) return "partial"
  if (accepted > 0) return "confirmation_pending"
  if (
    input.pending.rejectedRelayUrls.length === targetCount &&
    targetCount > 0
  ) {
    return "rejected"
  }
  return "failed"
}

async function deliverPendingPreference(input: {
  owner: string
  record: MediaServerPreferenceEvidenceRecord
  storage: MediaServerPreferencesStorage | null
  dependencies: PublishMediaServerPreferencesDependencies
}): Promise<MediaServerPublishResult> {
  const pending = input.record.pending
  if (!pending) {
    throw new MediaServerPreferencesError(
      "missing_pending_publish",
      "No signed media server update is waiting to be retried."
    )
  }
  const acknowledged = new Set(pending.acknowledgedRelayUrls)
  const unresolved = pending.publishRelayUrls.filter(
    (relayUrl) => !acknowledged.has(relayUrl)
  )
  input.dependencies.onPhase?.("publishing")
  const publishToRelay =
    input.dependencies.publishToRelay ?? publishSignedEventToRelay
  const outcomes = await Promise.all(
    unresolved.map(async (relayUrl) => {
      assertContinue(input.dependencies.shouldContinue)
      try {
        const status = await publishToRelay({
          signedEvent: pending.signedEvent,
          authorPubkey: input.owner,
          relayUrl,
          authenticatedPubkey: input.owner,
        })
        return [relayUrl, status] as const
      } catch {
        return [relayUrl, "timed_out" as ExclusiveRelayPublishStatus] as const
      }
    })
  )
  assertContinue(input.dependencies.shouldContinue)

  const rejected = new Set(pending.rejectedRelayUrls)
  const timedOut = new Set(pending.timedOutRelayUrls)
  for (const [relayUrl, status] of outcomes) {
    rejected.delete(relayUrl)
    timedOut.delete(relayUrl)
    if (status === "acked") acknowledged.add(relayUrl)
    else if (status === "rejected") rejected.add(relayUrl)
    else timedOut.add(relayUrl)
  }
  pending.acknowledgedRelayUrls = uniqueWithinPlan(
    [...acknowledged],
    pending.publishRelayUrls
  )
  pending.rejectedRelayUrls = uniqueWithinPlan(
    [...rejected],
    pending.publishRelayUrls
  )
  pending.timedOutRelayUrls = uniqueWithinPlan(
    [...timedOut],
    pending.publishRelayUrls
  )
  preserveCurrentRecordState(
    input.record,
    loadMediaServerPreferenceRecord(input.owner, input.storage)
  )
  if (
    !input.record.pending ||
    input.record.pending.signedEvent.id !== pending.signedEvent.id
  ) {
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "The pending media server update changed during relay delivery. Its current state was preserved."
    )
  }
  if (recordSupersedesEvent(input.record, pending.signedEvent)) {
    delete input.record.pending
    saveMediaServerPreferenceRecord(input.record, input.storage)
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "A stronger owner-authored media server preference was observed during relay delivery. The older signed update will not be retried."
    )
  }
  input.record.pending = clone(pending)
  saveMediaServerPreferenceRecord(input.record, input.storage)

  const readBack = await verifyPreferenceReadBack({
    owner: input.owner,
    pending,
    dependencies: input.dependencies,
  })
  const outcome = publishOutcome({ pending, confirmed: readBack.confirmed })
  const allAccepted =
    pending.acknowledgedRelayUrls.length === pending.publishRelayUrls.length

  preserveCurrentRecordState(
    input.record,
    loadMediaServerPreferenceRecord(input.owner, input.storage)
  )
  if (
    !input.record.pending ||
    input.record.pending.signedEvent.id !== pending.signedEvent.id
  ) {
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "The pending media server update changed during read-back. Its current state was preserved."
    )
  }
  if (recordSupersedesEvent(input.record, pending.signedEvent)) {
    delete input.record.pending
    saveMediaServerPreferenceRecord(input.record, input.storage)
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "A stronger owner-authored media server preference was observed during read-back. The stronger evidence was preserved."
    )
  }

  if (readBack.confirmed) {
    const observedAt = (input.dependencies.now ?? Date.now)()
    input.record.published = {
      signedEvent: clone(pending.signedEvent),
      serverUrls: [...pending.serverUrls],
      sourceRelayUrls: [...readBack.sourceRelayUrls],
      observedAt,
      completeObservedAt: readBack.complete ? observedAt : undefined,
    }
    input.record.frontier = {
      eventId: pending.signedEvent.id,
      createdAt: pending.signedEvent.created_at,
      state: "valid",
    }
  }
  if (allAccepted && readBack.confirmed) {
    delete input.record.pending
  } else {
    input.record.pending = clone(pending)
  }
  const saved = saveMediaServerPreferenceRecord(input.record, input.storage)

  return {
    outcome,
    signedEvent: clone(pending.signedEvent),
    acceptedRelayCount: pending.acknowledgedRelayUrls.length,
    rejectedRelayCount: pending.rejectedRelayUrls.length,
    timedOutRelayCount: pending.timedOutRelayUrls.length,
    targetRelayCount: pending.publishRelayUrls.length,
    confirmed: readBack.confirmed,
    partialAcceptance: pending.acknowledgedRelayUrls.length > 0 && !allAccepted,
    retryAvailable: !!saved.pending,
  }
}

export async function publishMediaServerPreferences(
  input: PublishMediaServerPreferencesInput
): Promise<MediaServerPublishResult> {
  const owner = normalizeMediaServerPreferenceOwner(input.owner)
  const dependencies = input.dependencies ?? {}
  const storage =
    dependencies.storage === undefined
      ? getDefaultStorage()
      : dependencies.storage
  const serverUrls = normalizeMediaServerPreferenceList(input.serverUrls)
  dependencies.onPhase?.("checking")
  const current = await readMediaServerPreferences(owner, dependencies)
  if (current.coverage === "unavailable") {
    throw new MediaServerPreferencesError(
      "evidence_unavailable",
      "A fresh media server preference check is required before publishing."
    )
  }
  if (
    !sameReviewedEvidence(
      input.reviewed,
      reviewedEvidenceFromResolution(current)
    )
  ) {
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "Media server preference evidence changed after review. Review the current state and try again."
    )
  }
  const record = loadMediaServerPreferenceRecord(owner, storage)
  if (record.pending) {
    throw new MediaServerPreferencesError(
      "pending_publish",
      "A signed media server update is still pending. Retry that exact update before signing another."
    )
  }
  const publishRelayUrls = await resolvePublishTargets(owner, dependencies)
  if (publishRelayUrls.length === 0) {
    throw new MediaServerPreferencesError(
      "no_publish_targets",
      "No bounded Nostr relay targets are available for this preference update."
    )
  }
  assertContinue(dependencies.shouldContinue)
  const signerPubkey = (await input.signer.getPublicKey()).trim().toLowerCase()
  if (signerPubkey !== owner) {
    throw new MediaServerPreferencesError(
      "signer_mismatch",
      "The active signer does not match this media server preference owner."
    )
  }
  const createdAt = selectMediaServerPreferenceCreatedAt({
    frontierCreatedAt: current.frontier?.createdAt ?? null,
    nowMs: dependencies.now,
  })
  const unsigned = {
    kind: BLOSSOM_SERVER_LIST_KIND,
    pubkey: owner,
    created_at: createdAt,
    tags: serializeBlossomServerListTags(serverUrls),
    content: "",
  }
  dependencies.onPhase?.("awaiting_signature")
  const signedEvent = await input.signer.signEvent(unsigned)
  assertContinue(dependencies.shouldContinue)
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== owner ||
    signedEvent.kind !== BLOSSOM_SERVER_LIST_KIND ||
    signedEvent.created_at !== createdAt ||
    signedEvent.content !== "" ||
    JSON.stringify(signedEvent.tags) !== JSON.stringify(unsigned.tags)
  ) {
    throw new MediaServerPreferencesError(
      "invalid_signature",
      "The signer returned an invalid media server preference event."
    )
  }
  const latestRecord = loadFreshMediaServerPreferenceRecord(owner, storage)
  const reviewedFrontierEventId = current.frontier?.eventId ?? null
  const latestFrontierEventId = latestRecord.frontier?.eventId ?? null
  if (
    latestRecord.pending ||
    latestFrontierEventId !== reviewedFrontierEventId
  ) {
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "Media server preference evidence changed while the event was being signed. Nothing was sent to relays; review the current state before trying again."
    )
  }
  const staged = stagePendingPublish(
    latestRecord,
    {
      signedEvent: clone(signedEvent),
      serverUrls,
      publishRelayUrls,
      acknowledgedRelayUrls: [],
      rejectedRelayUrls: [],
      timedOutRelayUrls: [],
      stagedAt: (dependencies.now ?? Date.now)(),
    },
    storage
  )
  return await deliverPendingPreference({
    owner,
    record: staged,
    storage,
    dependencies,
  })
}

export async function retryMediaServerPreferencesPublish(
  input: RetryMediaServerPreferencesInput
): Promise<MediaServerPublishResult> {
  const owner = normalizeMediaServerPreferenceOwner(input.owner)
  const dependencies = input.dependencies ?? {}
  const storage =
    dependencies.storage === undefined
      ? getDefaultStorage()
      : dependencies.storage
  const retainedRecord = loadMediaServerPreferenceRecord(owner, storage)
  if (!retainedRecord.pending) {
    throw new MediaServerPreferencesError(
      "missing_pending_publish",
      "No signed media server update is waiting to be retried."
    )
  }
  dependencies.onPhase?.("checking")
  await readMediaServerPreferences(owner, dependencies)
  const record = loadMediaServerPreferenceRecord(owner, storage)
  if (
    record.pending &&
    recordSupersedesEvent(record, record.pending.signedEvent)
  ) {
    delete record.pending
    saveMediaServerPreferenceRecord(record, storage)
    throw new MediaServerPreferencesError(
      "evidence_changed",
      "A stronger owner-authored media server preference was observed. The older signed update was not sent again; review the current state before publishing a replacement."
    )
  }
  return await deliverPendingPreference({
    owner,
    record,
    storage,
    dependencies,
  })
}

export function __resetMediaServerPreferencesForTests(): void {
  inMemoryRecords.clear()
}
