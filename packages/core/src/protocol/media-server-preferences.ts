import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayTarget,
} from "./relay-authority"
import {
  compareAccountNetworkRevisions,
  interpretAccountNetworkRead,
  interpretAccountNetworkPreference,
  mergeAccountNetworkLookup,
  classifyAccountNetworkReadback,
  summarizeAccountNetworkReadback,
  NETWORK_PREFERENCE_READBACK_STATUSES,
} from "./account-network-evidence"
import {
  applyNetworkPreferenceDistributionOutcomes,
  type NetworkPreferenceReadbackObservation,
} from "./network-preference-delivery"
import { kinds, type Filter } from "nostr-tools"
import { normalizePublicHttpsUrl } from "../network-target-safety"
import {
  filterEligibleAccountRelayTargets,
  orderEquivalentAccountRelayOperations,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { getRelayLists } from "./relay-list"
import {
  fetchSignedEventsFanoutDetailed,
  type SignedEventRelayReadResult,
  verifySignedEvents,
} from "./relay-reader"
import {
  admitPublicEvent,
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"
import {
  DEFAULT_READ_FANOUT,
  planPublicEventReadbackTargets,
  planRelayReads,
  type RelayReadPlan,
} from "./relay-planner"
import {
  planPublishRelays,
  publishSignedEventToRelay,
  type ExclusiveRelayPublishStatus,
  type PublishWithPlannerInput,
} from "./relay-publish"
import {
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  tryNormalizeRelayUrl,
  type RelaySettingsPlanningSnapshot,
} from "./relay-settings"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
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
  tags: readonly (readonly string[])[]
  content: string
}

export interface SelectedMediaServerPreferenceEvent {
  event: VerifiedNostrEvent
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
  sources?: import("./account-network-evidence").AccountNetworkReadEvidence["sources"]
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
  /** Exact read observations remain separate from publication ACKs. */
  readback?: NetworkPreferenceReadbackObservation[]
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
  /** Exact signed frontier, including empty or malformed replacements. */
  frontierEvent?: SignedPublicNostrEvent
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
  /** Explicit authenticated account. The requested preference owner is not proof. */
  authenticatedPubkey?: string | null
  readRelayUrls?: readonly string[]
  getRelayLists?: typeof getRelayLists
  planReads?: typeof planRelayReads
  fetchEvents?: typeof fetchSignedEventsFanoutDetailed
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  ownerRelayListEvidenceRepository?: Parameters<
    typeof filterEligibleAccountRelayTargets
  >[0]["ownerRelayListEvidenceRepository"]
  /** Live caller authority for final account-scoped relay admission. */
  shouldContinue?: () => boolean
  /** Injectable durable owner-authority reader for deterministic tests. */
  readAccountRelaySettingsPlanningSnapshot?: typeof readDurableAccountRelaySettingsPlanningSnapshot
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
  const copied = structuredClone(value)
  if (
    value &&
    typeof value === "object" &&
    copied &&
    typeof copied === "object"
  ) {
    const source = value as Record<string, unknown>
    const target = copied as Record<string, unknown>
    if (isVerifiedNostrEvent(source.signedEvent)) {
      target.signedEvent = source.signedEvent
    }
    if (isVerifiedNostrEvent(source.frontierEvent)) {
      target.frontierEvent = source.frontierEvent
    }
    for (const key of ["published", "pending"] as const) {
      const sourcePart = source[key]
      const targetPart = target[key]
      if (
        sourcePart &&
        typeof sourcePart === "object" &&
        targetPart &&
        typeof targetPart === "object"
      ) {
        const signedEvent = (sourcePart as { signedEvent?: unknown })
          .signedEvent
        if (isVerifiedNostrEvent(signedEvent)) {
          ;(targetPart as { signedEvent?: unknown }).signedEvent = signedEvent
        }
      }
    }
  }
  return copied
}

/** Canonicalize relay evidence without granting permission for network I/O. */
function normalizeRetainedRelayUrls(relayUrls: readonly string[]): string[] {
  const normalizedUrls: string[] = []
  const seen = new Set<string>()
  if (!Array.isArray(relayUrls)) return normalizedUrls
  for (const relayUrl of relayUrls) {
    if (typeof relayUrl !== "string") continue
    const normalized = tryNormalizeRelayUrl(relayUrl)
    if (!normalized.ok || seen.has(normalized.url)) continue
    seen.add(normalized.url)
    normalizedUrls.push(normalized.url)
  }
  return normalizedUrls
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

function normalizeAuthenticatedMediaServerPreferenceOwner(
  owner: string | null | undefined
): string | null {
  if (!owner) return null
  try {
    return normalizeMediaServerPreferenceOwner(owner)
  } catch {
    return null
  }
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
  tags: readonly (readonly string[])[]
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
  return -compareAccountNetworkRevisions(left, right)
}

function matchingOwnerEvents(
  events: readonly VerifiedNostrEvent[],
  owner: string
): VerifiedNostrEvent[] {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  return events
    .filter(
      (event) =>
        isVerifiedNostrEvent(event) &&
        event.kind === BLOSSOM_SERVER_LIST_KIND &&
        event.pubkey.trim().toLowerCase() === normalizedOwner
    )
    .sort(compareReplaceable)
}

export function selectLatestValidBlossomServerListEvent(
  events: readonly VerifiedNostrEvent[],
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
  events: readonly VerifiedNostrEvent[],
  owner: string
): VerifiedNostrEvent | null {
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

function validSignedFrontierEvent(
  event: SignedPublicNostrEvent,
  owner: string,
  displayOnly = false
): { event: SignedPublicNostrEvent; parsed: ParsedMediaServerTags } | null {
  if (
    (!displayOnly && !isVerifiedNostrEvent(event)) ||
    !event ||
    typeof event !== "object" ||
    typeof event.id !== "string" ||
    typeof event.sig !== "string" ||
    typeof event.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(event.id) ||
    !/^[0-9a-f]{128}$/.test(event.sig) ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    typeof event.content !== "string" ||
    !Array.isArray(event.tags) ||
    event.tags.some(
      (tag) =>
        !Array.isArray(tag) ||
        tag.length === 0 ||
        tag.some((value) => typeof value !== "string")
    ) ||
    event.kind !== BLOSSOM_SERVER_LIST_KIND ||
    event.pubkey !== owner ||
    event.id !== event.id.toLowerCase() ||
    event.pubkey !== event.pubkey.toLowerCase() ||
    event.sig !== event.sig.toLowerCase()
  ) {
    return null
  }
  return { event, parsed: parseBlossomServerListTags(event.tags) }
}

function validSignedPreferenceEvent(
  event: SignedPublicNostrEvent,
  owner: string,
  displayOnly = false
): { event: SignedPublicNostrEvent; serverUrls: string[] } | null {
  const frontier = validSignedFrontierEvent(event, owner, displayOnly)
  return frontier?.parsed.state === "valid"
    ? { event: frontier.event, serverUrls: frontier.parsed.serverUrls }
    : null
}

function validStoredTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function sanitizeStoredRecord(
  value: unknown,
  owner: string,
  displayOnly = false
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
      owner,
      displayOnly
    )
    if (valid && validStoredTimestamp(candidate.published.observedAt)) {
      record.published = {
        signedEvent: valid.event,
        serverUrls: valid.serverUrls,
        sourceRelayUrls: normalizeRetainedRelayUrls(
          candidate.published.sourceRelayUrls ?? []
        ),
        observedAt: candidate.published.observedAt,
        ...(validStoredTimestamp(candidate.published.completeObservedAt) &&
        candidate.published.completeObservedAt <= candidate.published.observedAt
          ? { completeObservedAt: candidate.published.completeObservedAt }
          : {}),
      }
    }
  }
  if (
    candidate.frontier &&
    typeof candidate.frontier.eventId === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.frontier.eventId) &&
    validStoredTimestamp(candidate.frontier.createdAt) &&
    ["valid", "empty", "malformed"].includes(candidate.frontier.state)
  ) {
    record.frontier = {
      eventId: candidate.frontier.eventId,
      createdAt: candidate.frontier.createdAt,
      state: candidate.frontier.state,
    }
    if (candidate.frontierEvent) {
      const signed = validSignedFrontierEvent(
        candidate.frontierEvent,
        owner,
        displayOnly
      )
      if (
        signed &&
        signed.event.id === record.frontier.eventId &&
        signed.event.created_at === record.frontier.createdAt &&
        signed.parsed.state === record.frontier.state
      ) {
        record.frontierEvent = signed.event
      }
    }
  }
  const lookup = candidate.latestLookup
  if (
    lookup &&
    validStoredTimestamp(lookup.observedAt) &&
    ["complete", "partial", "unavailable"].includes(lookup.coverage) &&
    typeof lookup.hadEvent === "boolean" &&
    [
      lookup.plannedRelayCount,
      lookup.successfulRelayCount,
      lookup.partialRelayCount,
      lookup.failedRelayCount,
      lookup.rejectedEventCount,
    ].every(validStoredTimestamp) &&
    (lookup.eventId === undefined ||
      (typeof lookup.eventId === "string" &&
        /^[0-9a-f]{64}$/.test(lookup.eventId)))
  ) {
    record.latestLookup = {
      observedAt: lookup.observedAt,
      coverage: lookup.coverage,
      plannedRelayCount: lookup.plannedRelayCount,
      successfulRelayCount: lookup.successfulRelayCount,
      partialRelayCount: lookup.partialRelayCount,
      failedRelayCount: lookup.failedRelayCount,
      rejectedEventCount: lookup.rejectedEventCount,
      hadEvent: lookup.hadEvent,
      ...(lookup.sources ? { sources: clone(lookup.sources) } : {}),
      ...(lookup.eventId ? { eventId: lookup.eventId } : {}),
    }
  }
  if (candidate.pending) {
    const valid = validSignedPreferenceEvent(
      candidate.pending.signedEvent,
      owner,
      displayOnly
    )
    const publishRelayUrls = normalizeRetainedRelayUrls(
      candidate.pending.publishRelayUrls ?? []
    )
    if (
      valid &&
      publishRelayUrls.length > 0 &&
      validStoredTimestamp(candidate.pending.stagedAt)
    ) {
      const targetSet = new Set(publishRelayUrls)
      const withinPlan = (urls: readonly string[]) =>
        normalizeRetainedRelayUrls(urls).filter((url) => targetSet.has(url))
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
        ...(Array.isArray(candidate.pending.readback)
          ? {
              readback: candidate.pending.readback
                .filter(
                  (observation) =>
                    targetSet.has(observation.relayUrl) &&
                    NETWORK_PREFERENCE_READBACK_STATUSES.includes(
                      observation.status
                    )
                )
                .map((observation) => ({ ...observation })),
            }
          : {}),
        stagedAt: candidate.pending.stagedAt,
      }
    }
  }
  if (candidate.draft && validStoredTimestamp(candidate.draft.updatedAt)) {
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
          (typeof candidate.draft.baseEventId === "string" &&
            /^[0-9a-f]{64}$/.test(candidate.draft.baseEventId))
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

async function loadAdmittedMediaServerPreferenceRecord(
  owner: string,
  storage: MediaServerPreferencesStorage | null
): Promise<
  MediaServerPreferenceEvidenceRecord & {
    unverifiedPriorFrontier?: MediaServerFrontierEvidence
  }
> {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  const key = getMediaServerPreferencesStorageKey(normalizedOwner)
  let raw: unknown = inMemoryRecords.get(key)
  if (storage) {
    try {
      const stored = storage.getItem(key)
      if (stored) raw = JSON.parse(stored)
    } catch {
      // Keep the process checkpoint when storage is unavailable.
    }
  }
  if (!raw || typeof raw !== "object") {
    return {
      version: MEDIA_SERVER_PREFERENCES_STORAGE_VERSION,
      owner: normalizedOwner,
    }
  }
  const candidate = clone(raw as MediaServerPreferenceEvidenceRecord)
  const signedFields = ["published", "pending"] as const
  const admissions = await Promise.all(
    signedFields.map(async (field) =>
      candidate[field]
        ? await admitPublicEvent(candidate[field].signedEvent)
        : null
    )
  )
  for (const [index, field] of signedFields.entries()) {
    const evidence = candidate[field]
    if (!evidence) continue
    const admission = admissions[index]
    if (admission?.status === "verified") {
      evidence.signedEvent = admission.event
    } else if (admission?.status === "invalid") {
      delete candidate[field]
    } else {
      throw new MediaServerPreferencesError(
        "evidence_unavailable",
        "Retained media server evidence cannot currently be verified. Its saved bytes were preserved."
      )
    }
  }
  if (candidate.frontierEvent) {
    const admission = await admitPublicEvent(candidate.frontierEvent)
    if (admission.status === "verified")
      candidate.frontierEvent = admission.event
    else if (admission.status === "invalid") delete candidate.frontierEvent
    else
      throw new MediaServerPreferencesError(
        "evidence_unavailable",
        "Retained media server evidence cannot currently be verified. Its saved bytes were preserved."
      )
  }
  const sanitized = sanitizeStoredRecord(candidate, normalizedOwner)
  if (!sanitized) {
    return {
      version: MEDIA_SERVER_PREFERENCES_STORAGE_VERSION,
      owner: normalizedOwner,
    }
  }
  if (
    sanitized.frontier &&
    sanitized.frontier.eventId !== sanitized.published?.signedEvent.id &&
    sanitized.frontier.eventId !== sanitized.pending?.signedEvent.id &&
    sanitized.frontier.eventId !== sanitized.frontierEvent?.id
  ) {
    const unverifiedPriorFrontier = sanitized.frontier
    delete sanitized.frontier
    return { ...sanitized, unverifiedPriorFrontier }
  }
  return sanitized
}

export function loadMediaServerPreferenceRecord(
  owner: string,
  storage: MediaServerPreferencesStorage | null = getDefaultStorage()
): MediaServerPreferenceEvidenceRecord {
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  const key = getMediaServerPreferencesStorageKey(normalizedOwner)
  const memory = inMemoryRecords.get(key)
  if (memory) {
    const display = sanitizeStoredRecord(memory, normalizedOwner, true)
    if (display) return clone(display)
  }

  if (storage) {
    try {
      const raw = storage.getItem(key)
      const parsed = raw
        ? (JSON.parse(raw) as MediaServerPreferenceEvidenceRecord)
        : null
      if (
        parsed?.version === MEDIA_SERVER_PREFERENCES_STORAGE_VERSION &&
        parsed.owner === normalizedOwner
      ) {
        // This synchronous projection is display-only. Async operations re-admit
        // the exact stored event before using it as a signed frontier.
        inMemoryRecords.set(key, clone(parsed))
        const display = sanitizeStoredRecord(parsed, normalizedOwner, true)
        if (display) return clone(display)
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
  const normalizedOwner = normalizeMediaServerPreferenceOwner(owner)
  const key = getMediaServerPreferencesStorageKey(normalizedOwner)
  const targetStorage = storage === undefined ? getDefaultStorage() : storage
  const normalizedDraft: MediaServerDraftRecord = {
    serverUrls: normalizeMediaServerPreferenceList(draft.serverUrls, {
      allowEmpty: true,
    }),
    baseServerUrls: normalizeMediaServerPreferenceList(draft.baseServerUrls, {
      allowEmpty: true,
    }),
    baseEventId: draft.baseEventId,
    updatedAt: draft.updatedAt,
  }
  let raw: unknown = inMemoryRecords.get(key)
  try {
    const stored = targetStorage?.getItem(key)
    if (stored) raw = JSON.parse(stored)
  } catch {
    // The process checkpoint remains usable when storage is unavailable.
  }
  const record: MediaServerPreferenceEvidenceRecord =
    raw &&
    typeof raw === "object" &&
    (raw as { version?: unknown }).version ===
      MEDIA_SERVER_PREFERENCES_STORAGE_VERSION &&
    (raw as { owner?: unknown }).owner === normalizedOwner
      ? clone(raw as MediaServerPreferenceEvidenceRecord)
      : {
          version: MEDIA_SERVER_PREFERENCES_STORAGE_VERSION,
          owner: normalizedOwner,
        }
  record.draft = normalizedDraft
  inMemoryRecords.set(key, clone(record))
  try {
    targetStorage?.setItem(key, JSON.stringify(record))
  } catch {
    // Keep the draft in process memory.
  }
  return clone(normalizedDraft)
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
  observedAt: number,
  verificationComplete = true
): MediaServerLookupEvidence {
  const evidence = interpretAccountNetworkRead(
    plannedRelayUrls,
    result,
    verificationComplete
  )
  return {
    observedAt,
    coverage: evidence.coverage,
    sources: evidence.sources,
    plannedRelayCount: evidence.scopeRelayUrls.length,
    successfulRelayCount: evidence.sources.filter(
      (source) => source.availability === "complete"
    ).length,
    partialRelayCount: evidence.sources.filter(
      (source) => source.availability === "partial"
    ).length,
    failedRelayCount: evidence.sources.filter(
      (source) =>
        source.availability !== "complete" &&
        source.availability !== "partial" &&
        source.availability !== "policy_blocked"
    ).length,
    rejectedEventCount: (result?.relays ?? []).reduce(
      (count, relay) => count + (relay.rejectedEventCount ?? 0),
      0
    ),
    hadEvent: (result?.events.length ?? 0) > 0,
  }
}

interface ResolvedMediaServerReadPlan {
  plan: RelayReadPlan
  authenticatedPubkey: string | null
}

async function readOwnerRelayAuthority(
  owner: string,
  dependencies: ReadMediaServerPreferencesDependencies
): Promise<{
  snapshot: RelaySettingsPlanningSnapshot | null
  readRelayUrls: string[]
  writeRelayUrls: string[]
}> {
  try {
    const snapshot = await (
      dependencies.readAccountRelaySettingsPlanningSnapshot ??
      readDurableAccountRelaySettingsPlanningSnapshot
    )(owner, {
      evidenceRepository: dependencies.ownerRelayListEvidenceRepository,
    })
    return {
      snapshot,
      readRelayUrls: normalizeOwnerSelectedRelayUrls(
        snapshot.settings.entries.flatMap((entry) =>
          entry.readEnabled ? [entry.url] : []
        )
      ),
      writeRelayUrls: normalizeOwnerSelectedRelayUrls(
        snapshot.settings.entries.flatMap((entry) =>
          entry.writeEnabled ? [entry.url] : []
        )
      ),
    }
  } catch (error) {
    if (dependencies.shouldContinue?.() === false) {
      throw new NostrSignerError("authority_changed")
    }
    if (
      error instanceof NostrSignerError &&
      error.code === "authority_changed"
    ) {
      throw error
    }
    return { snapshot: null, readRelayUrls: [], writeRelayUrls: [] }
  }
}

function applyOwnerTransportAuthority(
  relayUrls: readonly string[],
  ownerSelectedRelayUrls: readonly string[]
): string[] {
  const ownerSelected = new Set(
    normalizeOwnerSelectedRelayUrls(ownerSelectedRelayUrls)
  )
  const remotelyEligible = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
  )
  return normalizeRetainedRelayUrls(relayUrls).filter(
    (relayUrl) => ownerSelected.has(relayUrl) || remotelyEligible.has(relayUrl)
  )
}

async function resolveReadPlan(
  owner: string,
  dependencies: ReadMediaServerPreferencesDependencies
): Promise<ResolvedMediaServerReadPlan> {
  const authenticatedPubkey = normalizeAuthenticatedMediaServerPreferenceOwner(
    dependencies.authenticatedPubkey
  )
  const authority =
    authenticatedPubkey === owner
      ? await readOwnerRelayAuthority(owner, dependencies)
      : { snapshot: null, readRelayUrls: [], writeRelayUrls: [] }
  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls([
    ...authority.readRelayUrls,
    ...authority.writeRelayUrls,
  ])
  if (dependencies.readRelayUrls) {
    const relayUrls = applyOwnerTransportAuthority(
      dependencies.readRelayUrls,
      ownerSelectedRelayUrls
    ).slice(0, MAX_MEDIA_SERVER_READ_RELAYS)
    return {
      plan: {
        intent: "general",
        relayUrls,
        candidateRelayUrls: relayUrls,
        relayTargets: mergeRelayTargets(
          relayTargetsFromUrls(relayUrls, {
            kind: "public_hint",
            operation: "read",
          }),
          relayTargetsFromUrls(
            authority.readRelayUrls.filter((url) => relayUrls.includes(url)),
            {
              kind: "owner_nip65",
              operation: "read",
              ownerPubkey: owner,
              selection: "read",
            }
          ),
          relayTargetsFromUrls(
            authority.writeRelayUrls.filter((url) => relayUrls.includes(url)),
            {
              kind: "owner_nip65",
              operation: "read",
              ownerPubkey: owner,
              selection: "write",
            }
          )
        ),
        maxRelayAttempts: MAX_MEDIA_SERVER_READ_RELAYS,
        parkedRelayUrls: [],
        hintRelayUrls: [],
        independentRelayUrls: [],
      },
      authenticatedPubkey,
    }
  }
  const relayListReadPlan = (dependencies.planReads ?? planRelayReads)({
    intent: "relay_lists",
    authenticatedPubkey,
    ownerSelectedRelayUrls: authority.readRelayUrls,
    maxRelays: MAX_MEDIA_SERVER_READ_RELAYS,
    skipHealthFilter: true,
    settings: authority.snapshot?.settings,
    signedRelayListAuthoritative:
      authority.snapshot?.signedRelayListAuthoritative,
  })
  const relayLists = await (dependencies.getRelayLists ?? getRelayLists)(
    [owner],
    {
      cacheOnly: false,
      relayUrls: relayListReadPlan.candidateRelayUrls,
      relayTargets: relayListReadPlan.relayTargets,
      maxRelayAttempts: relayListReadPlan.maxRelayAttempts,
      allowInsecureRelayUrlsForPubkey:
        authenticatedPubkey === owner ? owner : undefined,
      accountPubkey: authenticatedPubkey,
      authenticatedPubkey,
      ownerSelectedRelayUrls: relayListReadPlan.ownerSelectedRelayUrls,
      appRelayUrls: relayListReadPlan.appRelayUrls,
      personalRelayUrls: relayListReadPlan.personalRelayUrls,
      independentRelayUrls: relayListReadPlan.independentRelayUrls,
      accountNetworkLocalStateRepository:
        dependencies.accountNetworkLocalStateRepository,
      shouldContinue: dependencies.shouldContinue,
    }
  )
  const planned = (dependencies.planReads ?? planRelayReads)({
    intent: "general",
    authors: [owner],
    relayLists,
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    maxRelays: MAX_MEDIA_SERVER_READ_RELAYS,
    skipHealthFilter: true,
    settings: authority.snapshot?.settings,
    signedRelayListAuthoritative:
      authority.snapshot?.signedRelayListAuthoritative,
  })
  const candidateRelayUrls = applyOwnerTransportAuthority(
    planned.candidateRelayUrls,
    ownerSelectedRelayUrls
  )
  const relayUrls = applyOwnerTransportAuthority(
    planned.relayUrls,
    ownerSelectedRelayUrls
  )
  return {
    plan: { ...planned, relayUrls, candidateRelayUrls },
    authenticatedPubkey,
  }
}

function mergeRelaySources(
  left: readonly string[],
  right: readonly string[]
): string[] {
  return normalizeRetainedRelayUrls([...left, ...right]).sort()
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
    candidate.frontierEvent = current.frontierEvent
      ? clone(current.frontierEvent)
      : undefined
  } else if (
    current.frontierEvent &&
    current.frontier?.eventId === candidate.frontier?.eventId &&
    !candidate.frontierEvent
  ) {
    candidate.frontierEvent = clone(current.frontierEvent)
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

  if (current.latestLookup)
    candidate.latestLookup = mergeAccountNetworkLookup(
      candidate.latestLookup,
      current.latestLookup,
      candidate.frontier?.eventId
    )
}

/** BUD-03 maps its tag states onto the same Account Network evidence contract. */
export function mediaServerPreferenceEvidenceFacts(
  resolution: MediaServerPreferenceResolution
) {
  const candidates = [
    resolution.frontier,
    resolution.publishedRevision && {
      ...resolution.publishedRevision,
      state: "valid" as const,
    },
    resolution.pending && {
      eventId: resolution.pending.signedEvent.id,
      createdAt: resolution.pending.signedEvent.created_at,
      state: "valid" as const,
    },
  ].filter((value): value is MediaServerFrontierEvidence => Boolean(value))
  const frontier = candidates.sort(
    (left, right) =>
      -compareAccountNetworkRevisions(
        { id: left.eventId, created_at: left.createdAt },
        { id: right.eventId, created_at: right.createdAt }
      )
  )[0]
  return interpretAccountNetworkPreference({
    current: frontier && {
      eventId: frontier.eventId,
      state:
        frontier.state === "valid"
          ? "declared"
          : frontier.state === "empty"
            ? "signed_empty"
            : "malformed",
    },
    lastUsableEventId: resolution.publishedRevision?.eventId,
    pendingEventId: resolution.pending?.signedEvent.id,
    lookup: { ...resolution.lookup, coverage: resolution.coverage },
  })
}

/** Prepared preference use; consumers do not infer authority from display status. */
export function selectMediaServerPreferenceUse(
  resolution: MediaServerPreferenceResolution
):
  | { kind: "configured"; serverUrls: string[] }
  | { kind: "incomplete" | "malformed" | "fallback" } {
  const facts = mediaServerPreferenceEvidenceFacts(resolution)
  const serverUrls =
    facts.currentUsable &&
    resolution.pending &&
    facts.currentEventId === resolution.pending.signedEvent.id
      ? resolution.pending.serverUrls
      : resolution.publishedRevision
        ? resolution.publishedServerUrls
        : []
  if (facts.state !== "signed_empty" && serverUrls.length > 0)
    return { kind: "configured", serverUrls: [...serverUrls] }
  if (facts.coverage !== "complete") return { kind: "incomplete" }
  if (facts.state === "malformed") return { kind: "malformed" }
  return facts.scopedAbsent || facts.state === "signed_empty"
    ? { kind: "fallback" }
    : { kind: "incomplete" }
}

/** A sanitized display projection never supplies signed action authority. */
function unavailableMediaServerResolution(
  owner: string,
  storage: MediaServerPreferencesStorage | null,
  observedAt: number
): MediaServerPreferenceResolution {
  const display = loadMediaServerPreferenceRecord(owner, storage)
  return {
    owner,
    status: "lookup_unavailable",
    coverage: "unavailable",
    publishedServerUrls: [...(display.published?.serverUrls ?? [])],
    publishedRevision: null,
    frontier: null,
    sourceRelayUrls: [],
    observedAt,
    completeObservedAt: null,
    stale: true,
    retained: !!display.published,
    lookup: {
      observedAt,
      coverage: "unavailable",
      plannedRelayCount: 0,
      successfulRelayCount: 0,
      partialRelayCount: 0,
      failedRelayCount: 0,
      rejectedEventCount: 0,
      hadEvent: false,
    },
    pending: null,
  }
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
  let retainedRecord: Awaited<
    ReturnType<typeof loadAdmittedMediaServerPreferenceRecord>
  >
  try {
    retainedRecord = await loadAdmittedMediaServerPreferenceRecord(
      normalizedOwner,
      storage
    )
  } catch (error) {
    if (
      !(error instanceof MediaServerPreferencesError) ||
      error.code !== "evidence_unavailable"
    )
      throw error
    if (dependencies.shouldContinue?.() === false) {
      throw new NostrSignerError("authority_changed")
    }
    return unavailableMediaServerResolution(
      normalizedOwner,
      storage,
      observedAt
    )
  }
  let resolvedPlan: ResolvedMediaServerReadPlan
  let result: SignedEventRelayReadResult | null = null
  let verificationComplete = true
  try {
    resolvedPlan = await resolveReadPlan(normalizedOwner, dependencies)
    result = await (
      dependencies.fetchEvents ?? fetchSignedEventsFanoutDetailed
    )(
      {
        kinds: [BLOSSOM_SERVER_LIST_KIND],
        authors: [normalizedOwner],
        limit: 24,
      } satisfies Filter,
      {
        relayUrls: resolvedPlan.plan.candidateRelayUrls,
        relayTargets: resolvedPlan.plan.relayTargets,
        maxRelayAttempts: resolvedPlan.plan.maxRelayAttempts,
        accountPubkey: resolvedPlan.authenticatedPubkey,
        authenticatedPubkey: resolvedPlan.authenticatedPubkey,
        accountNetworkLocalStateRepository:
          dependencies.accountNetworkLocalStateRepository,
        ownerRelayListEvidenceRepository:
          dependencies.ownerRelayListEvidenceRepository,
        shouldContinue: dependencies.shouldContinue,
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 6_000,
        skipHealthFilter: true,
      }
    )
    const rawEventCount = result.events.length
    const verification = await verifySignedEvents(result.events, {
      maxEvents: rawEventCount,
    })
    verificationComplete =
      !verification.truncated && verification.events.length === rawEventCount
    result = { ...result, events: verification.events }
  } catch (error) {
    if (dependencies.shouldContinue?.() === false) {
      throw new NostrSignerError("authority_changed")
    }
    if (
      error instanceof NostrSignerError &&
      error.code === "authority_changed"
    ) {
      throw error
    }
    resolvedPlan = {
      plan: {
        intent: "general",
        relayUrls: [],
        relayTargets: [],
        candidateRelayUrls: [],
        parkedRelayUrls: [],
        hintRelayUrls: [],
        independentRelayUrls: [],
      },
      authenticatedPubkey: null,
    }
  }

  const plan = resolvedPlan.plan
  const lookup = readCoverage(
    plan.relayUrls,
    result,
    observedAt,
    verificationComplete
  )
  const admittedRelayUrls = result?.admittedRelayUrls ?? plan.relayUrls
  const events = result?.events ?? []
  const networkFrontierEvent = selectLatestObservedBlossomServerListEvent(
    events,
    normalizedOwner
  )
  const networkValid = selectLatestValidBlossomServerListEvent(
    events,
    normalizedOwner
  )
  const unverifiedPriorFrontier = retainedRecord.unverifiedPriorFrontier
  if (
    unverifiedPriorFrontier &&
    (!networkFrontierEvent ||
      strongerRevision(
        {
          id: unverifiedPriorFrontier.eventId,
          created_at: unverifiedPriorFrontier.createdAt,
        },
        networkFrontierEvent
      ))
  ) {
    lookup.coverage =
      lookup.coverage === "unavailable" ? "unavailable" : "partial"
  }
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
      record.frontierEvent = networkFrontierEvent
    }
    lookup.eventId = networkFrontierEvent.id
  }

  if (networkValid) {
    const signedEvent = networkValid.event as SignedPublicNostrEvent
    const sourceRelayUrls = uniqueWithinPlan(
      result?.eventSourceRelayUrls[signedEvent.id] ?? [],
      admittedRelayUrls
    )
    if (strongerRevision(signedEvent, record.published?.signedEvent)) {
      record.published = {
        signedEvent,
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
  try {
    preserveCurrentRecordState(
      record,
      await loadAdmittedMediaServerPreferenceRecord(normalizedOwner, storage)
    )
  } catch (error) {
    if (
      !(error instanceof MediaServerPreferencesError) ||
      error.code !== "evidence_unavailable"
    )
      throw error
    if (dependencies.shouldContinue?.() === false) {
      throw new NostrSignerError("authority_changed")
    }
    return unavailableMediaServerResolution(
      normalizedOwner,
      storage,
      observedAt
    )
  }
  const saved = saveMediaServerPreferenceRecord(record, storage)
  const networkPublishedSelected =
    !!networkValid && saved.published?.signedEvent.id === networkValid.event.id
  const publishedRevision = saved.published
    ? {
        eventId: saved.published.signedEvent.id,
        createdAt: saved.published.signedEvent.created_at,
      }
    : null
  const effectiveLookup = saved.latestLookup ?? lookup
  const resolution: MediaServerPreferenceResolution = {
    owner: normalizedOwner,
    status: "lookup_unavailable",
    coverage: effectiveLookup.coverage,
    publishedServerUrls: [...(saved.published?.serverUrls ?? [])],
    publishedRevision,
    frontier: saved.frontier ? clone(saved.frontier) : null,
    sourceRelayUrls: [...(saved.published?.sourceRelayUrls ?? [])],
    observedAt,
    completeObservedAt: saved.published?.completeObservedAt ?? null,
    stale: true,
    retained: !!saved.published && !networkPublishedSelected,
    lookup: clone(effectiveLookup),
    pending: saved.pending ? clone(saved.pending) : null,
  }
  const facts = mediaServerPreferenceEvidenceFacts(resolution)
  resolution.status =
    facts.coverage === "unavailable"
      ? "lookup_unavailable"
      : facts.coverage === "partial"
        ? "lookup_partial"
        : facts.state === "declared"
          ? "published"
          : facts.state === "signed_empty"
            ? "empty"
            : facts.state === "malformed"
              ? "malformed"
              : "not_observed"
  resolution.stale = facts.coverage !== "complete" || facts.stale
  return resolution
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
): Promise<{
  relayUrls: string[]
  relayTargets: RelayTarget[]
}> {
  const authenticatedPubkey = normalizeAuthenticatedMediaServerPreferenceOwner(
    dependencies.authenticatedPubkey
  )
  const input: PublishWithPlannerInput = {
    intent: "author_event",
    authorPubkey: owner,
    authenticatedPubkey,
    accountPubkey: owner,
    accountNetworkLocalStateRepository:
      dependencies.accountNetworkLocalStateRepository,
    ownerRelayListEvidenceRepository:
      dependencies.ownerRelayListEvidenceRepository,
    refreshRelayLists: true,
    skipHealthFilter: true,
    shouldContinue: dependencies.shouldContinue,
  }
  const plan = await (dependencies.planPublish ?? planPublishRelays)(input)
  const targets = mergeRelayTargets(
    plan.primaryRelayTargets ?? [],
    plan.broadcastRelayTargets ?? []
  )
  const targetUrls = new Set(targets.map((target) => target.url))
  const relayUrls = normalizeRetainedRelayUrls(
    dependencies.publishRelayUrls ?? [
      ...plan.primaryRelayUrls,
      ...plan.broadcastRelayUrls,
    ]
  )
    .filter((url) => targetUrls.has(url))
    .slice(0, MAX_MEDIA_SERVER_PUBLISH_RELAYS)
  return {
    relayUrls,
    relayTargets: targets.filter((target) => relayUrls.includes(target.url)),
  }
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
  const planSet = new Set(normalizeRetainedRelayUrls(plan))
  return normalizeRetainedRelayUrls(urls).filter((url) => planSet.has(url))
}

async function verifyPreferenceReadBack(input: {
  owner: string
  pending: PendingMediaServerPublish
  authorizedTargets: readonly RelayTarget[]
  dependencies: PublishMediaServerPreferencesDependencies
}): Promise<{
  confirmed: boolean
  sourceRelayUrls: string[]
  complete: boolean
  observations: NetworkPreferenceReadbackObservation[]
}> {
  const acknowledged = input.pending.acknowledgedRelayUrls
  if (acknowledged.length === 0) {
    return {
      confirmed: false,
      sourceRelayUrls: [],
      complete: false,
      observations: [],
    }
  }
  input.dependencies.onPhase?.("confirming")
  const readbackTargets = planPublicEventReadbackTargets(
    input.authorizedTargets.filter((target) =>
      acknowledged.includes(target.url)
    )
  )
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
        relayTargets: readbackTargets,
        accountPubkey: input.owner,
        authenticatedPubkey: input.dependencies.authenticatedPubkey,
        accountNetworkLocalStateRepository:
          input.dependencies.accountNetworkLocalStateRepository,
        ownerRelayListEvidenceRepository:
          input.dependencies.ownerRelayListEvidenceRepository,
        shouldContinue: input.dependencies.shouldContinue,
        connectTimeoutMs: 4_000,
        fetchTimeoutMs: 6_000,
        skipHealthFilter: true,
      }
    )
    const verification = await verifySignedEvents(result.events, {
      maxEvents: result.events.length,
    })
    if (
      verification.truncated ||
      verification.events.length !== result.events.length
    ) {
      return {
        confirmed: false,
        sourceRelayUrls: [],
        complete: false,
        observations: acknowledged.map((relayUrl) => ({
          relayUrl,
          status: "verification_unavailable",
        })),
      }
    }
    const outcomes = acknowledged.map((relayUrl) => ({
      relayUrl,
      readbackStatus: classifyAccountNetworkReadback({
        relayUrl,
        signedEvent: input.pending.signedEvent,
        result: { ...result, events: verification.events },
      }),
    }))
    const summary = summarizeAccountNetworkReadback(outcomes)
    return {
      confirmed: summary.confirmed,
      sourceRelayUrls: outcomes.flatMap((outcome) =>
        outcome.readbackStatus === "observed" ? [outcome.relayUrl] : []
      ),
      complete: summary.unresolvedCount === 0,
      observations: outcomes.map((outcome) => ({
        relayUrl: outcome.relayUrl,
        status:
          outcome.readbackStatus as NetworkPreferenceReadbackObservation["status"],
      })),
    }
  } catch {
    return {
      confirmed: false,
      sourceRelayUrls: [],
      complete: false,
      observations: acknowledged.map((relayUrl) => ({
        relayUrl,
        status: "unavailable",
      })),
    }
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
  const authorizedPlan = await resolvePublishTargets(
    input.owner,
    input.dependencies
  )
  const authorizedTargets = authorizedPlan.relayTargets
  input.dependencies.onPhase?.("publishing")
  const publishToRelay =
    input.dependencies.publishToRelay ?? publishSignedEventToRelay
  const orderedUnresolved = await orderEquivalentAccountRelayOperations({
    accountPubkey: input.owner,
    operations: unresolved.map((relayUrl) => ({
      relayUrl,
      equivalenceKey: "exact-media-preference-retry",
      value: relayUrl,
    })),
    repository: input.dependencies.accountNetworkLocalStateRepository,
  })
  const outcomes = await Promise.all(
    orderedUnresolved.map(async ({ value: relayUrl }) => {
      assertContinue(input.dependencies.shouldContinue)
      const eligibleRelayUrls = await filterEligibleAccountRelayTargets({
        accountPubkey: input.owner,
        authenticatedPubkey: input.dependencies.authenticatedPubkey,
        targets: authorizedTargets.filter((target) => target.url === relayUrl),
        operation: "write",
        repository: input.dependencies.accountNetworkLocalStateRepository,
        ownerRelayListEvidenceRepository:
          input.dependencies.ownerRelayListEvidenceRepository,
      })
      if (eligibleRelayUrls.length === 0) return null
      assertContinue(input.dependencies.shouldContinue)
      try {
        const status = await publishToRelay({
          signedEvent: pending.signedEvent,
          relayTarget: eligibleRelayUrls[0],
          authorPubkey: input.owner,
          relayUrl,
          authenticatedPubkey: input.dependencies.authenticatedPubkey,
          accountPubkey: input.owner,
          accountNetworkLocalStateRepository:
            input.dependencies.accountNetworkLocalStateRepository,
          ownerRelayListEvidenceRepository:
            input.dependencies.ownerRelayListEvidenceRepository,
          shouldContinue: input.dependencies.shouldContinue,
        })
        return [relayUrl, status] as const
      } catch {
        const stillEligible = await filterEligibleAccountRelayTargets({
          accountPubkey: input.owner,
          authenticatedPubkey: input.dependencies.authenticatedPubkey,
          targets: authorizedTargets.filter(
            (target) => target.url === relayUrl
          ),
          operation: "write",
          repository: input.dependencies.accountNetworkLocalStateRepository,
          ownerRelayListEvidenceRepository:
            input.dependencies.ownerRelayListEvidenceRepository,
        })
        if (stillEligible.length === 0) return null
        return [relayUrl, "timed_out" as ExclusiveRelayPublishStatus] as const
      }
    })
  )
  assertContinue(input.dependencies.shouldContinue)

  const rejected = new Set(pending.rejectedRelayUrls)
  const timedOut = new Set(pending.timedOutRelayUrls)
  for (const outcome of outcomes) {
    if (!outcome) continue
    const [relayUrl, status] = outcome
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
    await loadAdmittedMediaServerPreferenceRecord(input.owner, input.storage)
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
    authorizedTargets,
    dependencies: input.dependencies,
  })
  const priorReadback = new Map(
    pending.readback?.map((observation) => [
      observation.relayUrl,
      observation.status,
    ])
  )
  pending.readback = applyNetworkPreferenceDistributionOutcomes(
    pending.publishRelayUrls.map((relayUrl) => ({
      relayUrl,
      publishStatus: "pending",
      publishAttemptCount: 0,
      readbackStatus: priorReadback.get(relayUrl) ?? "pending",
      readbackAttemptCount: 0,
    })),
    {
      readback: readBack.observations,
      observedAt: (input.dependencies.now ?? Date.now)(),
    }
  ).flatMap((outcome) =>
    outcome.readbackStatus === "pending"
      ? []
      : [{ relayUrl: outcome.relayUrl, status: outcome.readbackStatus }]
  )
  const outcome = publishOutcome({ pending, confirmed: readBack.confirmed })
  const allAccepted =
    pending.acknowledgedRelayUrls.length === pending.publishRelayUrls.length

  preserveCurrentRecordState(
    input.record,
    await loadAdmittedMediaServerPreferenceRecord(input.owner, input.storage)
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
      signedEvent: pending.signedEvent,
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
    signedEvent: pending.signedEvent,
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
  const record = await loadAdmittedMediaServerPreferenceRecord(owner, storage)
  if (record.pending) {
    throw new MediaServerPreferencesError(
      "pending_publish",
      "A signed media server update is still pending. Retry that exact update before signing another."
    )
  }
  const publishPlan = await resolvePublishTargets(owner, dependencies)
  if (publishPlan.relayUrls.length === 0) {
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
  const admission = await admitPublicEvent(signedEvent)
  assertContinue(dependencies.shouldContinue)
  if (admission.status !== "verified") {
    throw new MediaServerPreferencesError(
      "invalid_signature",
      "The signer returned an event that could not be admitted."
    )
  }
  const latestRecord = await loadAdmittedMediaServerPreferenceRecord(
    owner,
    storage
  )
  const reviewedFrontierEventId = current.frontier?.eventId ?? null
  const latestFrontierEventId = latestRecord.frontier?.eventId ?? null
  if (
    latestRecord.pending ||
    latestRecord.unverifiedPriorFrontier ||
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
      signedEvent: admission.event,
      serverUrls,
      publishRelayUrls: publishPlan.relayUrls,
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
  const retainedRecord = await loadAdmittedMediaServerPreferenceRecord(
    owner,
    storage
  )
  if (!retainedRecord.pending) {
    throw new MediaServerPreferencesError(
      "missing_pending_publish",
      "No signed media server update is waiting to be retried."
    )
  }
  dependencies.onPhase?.("checking")
  await readMediaServerPreferences(owner, dependencies)
  const record = await loadAdmittedMediaServerPreferenceRecord(owner, storage)
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
