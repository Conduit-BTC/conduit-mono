// One owner for retained inbox evidence and process caches. Transport workflows
// in private-message-routing and final grant checks share these exact bindings.
import { getEventSourceRelayUrls } from "./relay-read-provenance"
import { type RelayTarget } from "./relay-authority"
import {
  interpretAccountNetworkPreference,
  interpretAccountNetworkInboxRecovery,
  compareAccountNetworkRevisions,
} from "./account-network-evidence"
import { config } from "../config"
import {
  applyInboxDeclarationEvidenceMerge,
  cloneInboxDeclarationEvidenceRecord,
  getActiveInboxCutoverRecoveryRelayUrls,
  getInboxDeclarationEvidence,
  InboxDeclarationEvidenceUnavailableError,
  mergeInboxDeclarationEvidenceBatch as mergeInboxDeclarationEvidenceBatchDurably,
  normalizeInboxDeclarationEvidencePubkey,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceRepository,
  type MergeInboxDeclarationEvidenceInput,
  type NetworkPreferenceRelayOutcome,
} from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  type fetchPublicEventsWithDiagnostics,
  type PublicRelayReadOptions,
} from "./relay-reader"
import {
  normalizeOwnerSelectedRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizeSecureOrIsolatedE2eRelayUrls,
} from "./relay-settings"
import {
  readRetainedOwnerRelayList,
  type OwnerRelayListEvidenceRepository,
} from "./owner-relay-list-evidence-store"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"

export { normalizeSecureRelayUrls as secureRelayUrls } from "./relay-settings"

/**
 * Shared NIP-17 inbox routing boundary (CND-208).
 *
 * Canonical behavior stays NIP-17: a valid kind-10050 declaration is the
 * preferred and eventual exclusive delivery route. This module adds the typed
 * declaration/readiness model plus the named temporary validated-order
 * compatibility route for kind-16 order traffic during
 * migration.
 */

/** Typed result of a kind-10050 declaration lookup. */
export type InboxDeclarationState =
  | "declared"
  | "signed_empty"
  | "not_observed"
  | "lookup_partial"
  | "lookup_unavailable"
  | "malformed"

/** How much of a fanout read actually completed. */
export type InboxReadCoverage = "complete" | "partial" | "unavailable"

/** Where a private-message read relay came from. */
export type InboxReadSource =
  "declared" | "cutover_recovery" | "compatibility" | "mixed" | "cache"

/** Delivery lane for an outgoing private message. */
export type PrivateMessageDeliveryRoute =
  "declared_inbox" | "compatibility_order" | "blocked"

export type CompatibilityOrderRelaySource =
  "recipient_nip65" | "compatibility_registry"

export interface CompatibilityOrderRelayPlan {
  relayUrls: string[]
  relaySources: Record<string, CompatibilityOrderRelaySource>
  truncated: boolean
}

export const MAX_COMPATIBILITY_ORDER_RELAYS = 3
export const MAX_DECLARED_INBOX_WRITE_RELAYS = 3
export const MAX_SHARED_INBOX_DISCOVERY_RELAYS = 5
export const MAX_INBOX_DISCOVERY_RELAYS = 8
// Preserve the former limit-one read's raw-event budget without a query limit
// that makes every positive replaceable declaration look potentially capped.
export const MAX_INBOX_DECLARATION_READ_EVENTS = 256

export interface PrivateMessageRelays {
  pubkey: string
  relayUrls: string[]
}

/**
 * Parse a kind-10050 private-message relay list into recipient inbox relays.
 * An absent or unusable declaration means the recipient is not NIP-17 ready;
 * general relay lists and configured relays are not delivery fallbacks.
 */
export function parsePrivateMessageRelays(event: {
  kind?: number
  pubkey?: string
  tags?: string[][]
}): PrivateMessageRelays | null {
  if (event.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) return null
  const seen = new Set<string>()
  const relayUrls: string[] = []
  for (const tag of event.tags ?? []) {
    if (tag[0] !== "relay" || typeof tag[1] !== "string") continue
    const url = tag[1].trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    relayUrls.push(url)
  }
  return { pubkey: event.pubkey ?? "", relayUrls }
}

export interface InboxDeclarationResolution {
  evidence?: import("./account-network-evidence").AccountNetworkPreferenceFacts
  pubkey: string
  state: InboxDeclarationState
  /** Context-eligible declared inbox relays; empty unless state is "declared". */
  relayUrls: string[]
  /** Last usable declaration retained only for permissive inbox reads. */
  retainedReadRelayUrls?: string[]
  /** Previous inboxes retained read-only during a confirmed cutover grace. */
  cutoverRecoveryRelayUrls?: string[]
  recovery?: import("./account-network-evidence").AccountNetworkInboxRecovery[]
  /** True when served from cache past its freshness window. */
  stale: boolean
  fetchedAt: number
  /** Signed event identity when a declaration was resolved or primed. */
  eventId?: string
  /** Signed event replaceable frontier, when evidence exists. */
  eventCreatedAt?: number
  /** Relays that have yielded the exact current signed event over time. */
  sourceRelayUrls?: string[]
  /** Shared discovery relays that returned the exact current event. */
  sharedSourceRelayUrls?: string[]
  /** Usable relay tags in the staged declaration; never write-authorizing. */
  pendingRelayUrls?: string[]
  /** Immutable targets for retrying the exact staged event. */
  pendingPublishRelayUrls?: string[]
  /** Per-target truth for the exact staged event; absent on legacy rows. */
  pendingRelayOutcomes?: NetworkPreferenceRelayOutcome[]
  /** Exact shared-set confirmation retained for restart-safe recovery cleanup. */
  cutoverRecoveryReadbackObservedAt?: number
  cutoverRecoveryExpiresAt?: number
  /** Current exact event needs a fresh signer-free shared-set attempt. */
  cutoverRecoveryNeedsRedistribution?: boolean
  /** Diagnostics for this invocation's network observation. */
  observation?: InboxDeclarationObservation
}

export interface InboxDeclarationObservation {
  sources?: import("./account-network-evidence").AccountNetworkReadEvidence["sources"]
  coverage: InboxReadCoverage
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  /** Exact event observed during this invocation, before frontier merging. */
  eventId?: string
  /** Relays that returned the exact event during this invocation. */
  eventSourceRelayUrls: string[]
}

export interface ResolveInboxDeclarationOptions {
  fetchEventsWithDiagnostics?: typeof fetchPublicEventsWithDiagnostics
  /** Discovery relays; defaults to local reads + compatibility reads. */
  relayUrls?: readonly string[]
  relayTargets?: readonly RelayTarget[]
  now?: () => number
  /** Freshness window override in ms (tests). */
  freshnessMs?: number
  /** Durable evidence seam (tests/non-browser adapters). */
  evidenceRepository?: InboxDeclarationEvidenceRepository
  /** Sources whose exact-event readback proves cross-client distribution. */
  sharedConfirmationRelayUrls?: readonly string[]
  /** Project all valid signed targets only while inspecting this owner. */
  allowLocalRelayUrlsForPubkey?: string | null
  /** Account on whose behalf this discovery I/O is admitted. */
  requestingAccountPubkey?: string | null
  /**
   * Active authenticated account. This is never inferred from the requested
   * declaration owner or the account whose local exclusions are being applied.
   */
  authenticatedPubkey?: string | null
  /**
   * Exact discovery targets selected in the authenticated account's Network
   * settings. This explicit authority may include ws://; relay hints may not.
   */
  ownerSelectedRelayUrls?: readonly string[]
  accountNetworkLocalStateRepository?: PublicRelayReadOptions["accountNetworkLocalStateRepository"]
  /** Cancels queued or in-flight lookup I/O when account authority changes. */
  signal?: AbortSignal
  /** Live account session authority for non-signal declaration reads. */
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
  /** Durable owner kind-10002 evidence seam (tests/non-browser adapters). */
  ownerRelayListEvidenceRepository?: OwnerRelayListEvidenceRepository
}

/** Positive declarations stay fresh for this long before a re-fetch. */
export const INBOX_DECLARATION_FRESHNESS_MS = 5 * 60_000

export const declarationCache = new Map<string, InboxDeclarationResolution>()
export const declarationEvidenceCache = new Map<
  string,
  InboxDeclarationEvidenceRecord
>()
const declarationEvidenceMergeTails = new Map<string, Promise<void>>()
export const invalidatedDeclarationKeys = new Set<string>()

export function hasCurrentCompleteLookup(
  record: InboxDeclarationEvidenceRecord
): boolean {
  const facts = interpretAccountNetworkPreference({
    current: {
      eventId: record.current.signedEvent.id,
      state: record.current.state,
      completeObservedAt: record.current.completeObservedAt,
    },
    lookup: record.latestLookup,
  })
  return facts.currentObserved && facts.coverage === "complete"
}

/** Reset the kind-10050 declaration cache (tests). */
export function __resetInboxDeclarationCache(): void {
  declarationCache.clear()
  declarationEvidenceCache.clear()
  declarationEvidenceMergeTails.clear()
  invalidatedDeclarationKeys.clear()
}

/** Expire freshness without deleting monotonic declaration evidence. */
export function invalidateInboxDeclaration(pubkey: string): void {
  const key = cacheKey(pubkey)
  invalidatedDeclarationKeys.add(key)
  const cached = declarationCache.get(key)
  if (cached) declarationCache.set(key, { ...cached, stale: true })
}

/** Seed the cache after an intentional declaration publish. */
export function primeInboxDeclarationCache(
  pubkey: string,
  relayUrls: readonly string[],
  now: () => number = Date.now,
  eventId?: string
): void {
  declarationCache.set(cacheKey(pubkey), {
    pubkey: cacheKey(pubkey),
    state: "declared",
    relayUrls: [...relayUrls],
    stale: false,
    fetchedAt: now(),
    eventId,
  })
  invalidatedDeclarationKeys.delete(cacheKey(pubkey))
}

/** Project a validated durable merge into the process cache after publish. */
export function primeInboxDeclarationEvidence(
  record: InboxDeclarationEvidenceRecord,
  now: () => number = Date.now
): InboxDeclarationResolution {
  const key = record.pubkey
  const process = declarationEvidenceCache.get(key)
  const merged = process
    ? mergeRecordEventEvidence(record, process, now)
    : cloneInboxDeclarationEvidenceRecord(record)
  declarationEvidenceCache.set(key, cloneInboxDeclarationEvidenceRecord(merged))
  const resolution = resolutionFromEvidence(merged, {
    stale: !hasCurrentCompleteLookup(merged),
    fetchedAt:
      merged.current.completeObservedAt ?? merged.current.observedAt ?? now(),
  })
  declarationCache.set(key, resolution)
  invalidatedDeclarationKeys.delete(key)
  return resolution
}

/** Return the exact validated process evidence used by explicit redistribution. */
export function getCachedInboxDeclarationEvidence(
  pubkey: string
): InboxDeclarationEvidenceRecord | undefined {
  const record = declarationEvidenceCache.get(cacheKey(pubkey))
  return record ? cloneInboxDeclarationEvidenceRecord(record) : undefined
}

export interface ReadRetainedInboxDeclarationOptions {
  /** Durable evidence seam (tests/non-browser adapters). */
  evidenceRepository?: InboxDeclarationEvidenceRepository
  durableEvidenceRepository?: Pick<InboxDeclarationEvidenceRepository, "get">
  now?: () => number
}

/**
 * Read the retained declaration frontier without relay traffic.
 *
 * This is the send-time safety boundary: another tab's durable frontier must
 * be consulted immediately before a kind-14 send, while a stronger
 * process-only frontier fails closed until it is durably reconciled.
 */
export async function readRetainedInboxDeclarationEvidence(
  pubkey: string,
  options: ReadRetainedInboxDeclarationOptions = {}
): Promise<InboxDeclarationEvidenceRecord | null> {
  const key = cacheKey(pubkey)
  if (!normalizeInboxDeclarationEvidencePubkey(key)) return null

  let persisted: InboxDeclarationEvidenceRecord | null | undefined
  try {
    persisted = options.durableEvidenceRepository
      ? await options.durableEvidenceRepository.get(
          normalizeInboxDeclarationEvidencePubkey(key)!
        )
      : await getInboxDeclarationEvidence(key, options.evidenceRepository)
  } catch (error) {
    // Keep an already-admitted process frontier usable during a storage or
    // verification outage. A readable durable frontier always wins below.
    const process = declarationEvidenceCache.get(key)
    if (!process) throw error
    try {
      return canonicalizeRetainedInboxDeclarationEvidence(
        cloneInboxDeclarationEvidenceRecord(process),
        options.now
      )
    } catch {
      throw error
    }
  }
  if (!persisted) return null

  const durable = canonicalizeRetainedInboxDeclarationEvidence(
    backfillLegacySharedSourceProvenance(
      persisted,
      new Set(sharedInboxDiscoveryRelayUrls())
    ),
    options.now
  )
  const process = declarationEvidenceCache.get(key)
  if (process) {
    const strongest = mergeRecordEventEvidence(durable, process, options.now)
    if (strongest.current.signedEvent.id !== durable.current.signedEvent.id) {
      return null
    }
  }

  return cloneInboxDeclarationEvidenceRecord(durable)
}

export async function readRetainedInboxDeclaration(
  pubkey: string,
  options: ReadRetainedInboxDeclarationOptions = {}
): Promise<InboxDeclarationResolution | null> {
  const durable = await readRetainedInboxDeclarationEvidence(pubkey, options)
  if (!durable) return null

  return resolutionFromEvidence(durable, {
    stale: !hasCurrentCompleteLookup(durable),
    fetchedAt:
      durable.latestLookup?.observedAt ??
      durable.current.completeObservedAt ??
      durable.current.observedAt,
  })
}

/** Validated monotonic process fallback when IndexedDB is unavailable. */
export function mergeInboxDeclarationEvidenceInMemory(
  input: MergeInboxDeclarationEvidenceInput,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  const key = cacheKey(input.pubkey)
  const merged = applyInboxDeclarationEvidenceMerge(
    declarationEvidenceCache.get(key),
    input,
    now
  )
  primeInboxDeclarationEvidence(merged, now)
  return cloneInboxDeclarationEvidenceRecord(merged)
}

export function mergeRecordEventEvidence(
  base: InboxDeclarationEvidenceRecord,
  observations: InboxDeclarationEvidenceRecord,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  let merged = cloneInboxDeclarationEvidenceRecord(base)
  const evidence =
    observations.lastUsable &&
    observations.lastUsable.signedEvent.id !==
      observations.current.signedEvent.id
      ? [observations.lastUsable, observations.current]
      : [observations.current]
  for (const entry of evidence) {
    merged = applyInboxDeclarationEvidenceMerge(
      merged,
      {
        pubkey: observations.pubkey,
        signedEvent: entry.signedEvent,
        sourceRelayUrls: entry.sourceRelayUrls,
        sharedSourceRelayUrls: entry.sharedSourceRelayUrls,
        observedAt: entry.observedAt,
        completeObservedAt: entry.completeObservedAt,
        cachedAt: observations.cachedAt,
        ...(entry.signedEvent.id === observations.current.signedEvent.id &&
        observations.latestLookup
          ? { lookup: observations.latestLookup }
          : {}),
      },
      now
    )
  }
  return merged
}

function recordEventMergeInputs(
  record: InboxDeclarationEvidenceRecord
): MergeInboxDeclarationEvidenceInput[] {
  const evidence =
    record.lastUsable &&
    record.lastUsable.signedEvent.id !== record.current.signedEvent.id
      ? [record.lastUsable, record.current]
      : [record.current]
  return evidence.map((entry) => {
    return {
      pubkey: record.pubkey,
      signedEvent: entry.signedEvent,
      sourceRelayUrls: entry.sourceRelayUrls,
      sharedSourceRelayUrls: entry.sharedSourceRelayUrls,
      observedAt: entry.observedAt,
      completeObservedAt: entry.completeObservedAt,
      cachedAt: record.cachedAt,
      ...(entry.signedEvent.id === record.current.signedEvent.id &&
      record.latestLookup
        ? { lookup: { ...record.latestLookup } }
        : {}),
    }
  })
}

export function backfillLegacySharedSourceProvenance(
  record: InboxDeclarationEvidenceRecord,
  sharedRelayUrlSet: ReadonlySet<string>
): InboxDeclarationEvidenceRecord {
  const migrated = cloneInboxDeclarationEvidenceRecord(record)
  const backfill = (evidence: InboxDeclarationEvidenceRecord["current"]) => {
    if (evidence.sharedSourceRelayUrls !== undefined) return
    evidence.sharedSourceRelayUrls = secureAutomaticRelayUrls(
      evidence.sourceRelayUrls
    ).filter((relayUrl) => sharedRelayUrlSet.has(relayUrl))
  }
  backfill(migrated.current)
  if (migrated.lastUsable) backfill(migrated.lastUsable)
  return migrated
}

export function canonicalizeRetainedInboxDeclarationEvidence(
  record: InboxDeclarationEvidenceRecord,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  let canonical: InboxDeclarationEvidenceRecord | undefined
  for (const input of recordEventMergeInputs(record)) {
    canonical = applyInboxDeclarationEvidenceMerge(
      canonical,
      input.signedEvent.id === record.current.signedEvent.id &&
        record.pendingDistribution
        ? { ...input, pendingDistribution: record.pendingDistribution }
        : input,
      now
    )
  }
  if (
    !canonical ||
    canonical.current.signedEvent.id !== record.current.signedEvent.id ||
    canonical.current.signedEvent.sig !== record.current.signedEvent.sig ||
    (record.lastUsable &&
      canonical.lastUsable?.signedEvent.id !== record.lastUsable.signedEvent.id)
  ) {
    throw new Error("Retained inbox declaration evidence is inconsistent")
  }

  // This validates the immutable recovery shape without making it an input to
  // the generic event merge Interface. Only the repository's narrow staging
  // and readback transitions may create or advance these batches.
  getActiveInboxCutoverRecoveryRelayUrls(record, now())
  const cutoverRecoveries =
    record.cutoverRecoveries ??
    (record.cutoverRecovery ? [record.cutoverRecovery] : [])
  if (cutoverRecoveries.length > 0) {
    canonical.cutoverRecoveries = structuredClone(cutoverRecoveries)
  }
  return canonical
}

async function withDeclarationEvidenceMergeLock<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = declarationEvidenceMergeTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  declarationEvidenceMergeTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (declarationEvidenceMergeTails.get(key) === tail) {
      declarationEvidenceMergeTails.delete(key)
    }
  }
}

/**
 * Reconcile process and durable frontiers atomically per account. If durable
 * storage is unavailable, the same validated reducer remains the process-local
 * fallback without allowing concurrent older reads to replace newer evidence.
 */
export async function reconcileInboxDeclarationEvidenceBatch(
  pubkey: string,
  inputs: readonly MergeInboxDeclarationEvidenceInput[],
  repository: InboxDeclarationEvidenceRepository | undefined,
  now: () => number
): Promise<InboxDeclarationEvidenceRecord> {
  const key = cacheKey(pubkey)
  return withDeclarationEvidenceMergeLock(key, async () => {
    let record = declarationEvidenceCache.get(key)
    try {
      // A process observation is never written back as a broad record. Only
      // its validated signed-event evidence crosses the repository's batch
      // Interface; local recovery plans require their narrow atomic APIs.
      const orderedInputs = [...inputs].sort((left, right) => {
        const createdAt =
          left.signedEvent.created_at - right.signedEvent.created_at
        return createdAt !== 0
          ? createdAt
          : right.signedEvent.id.localeCompare(left.signedEvent.id)
      })
      const durableInputs = [
        ...(record ? recordEventMergeInputs(record) : []),
        ...orderedInputs,
      ]
      if (durableInputs.length > 0) {
        const persisted = await mergeInboxDeclarationEvidenceBatchDurably(
          durableInputs,
          repository
        )
        record = record
          ? mergeRecordEventEvidence(persisted, record, now)
          : persisted
      }
      for (const input of orderedInputs) {
        record = applyInboxDeclarationEvidenceMerge(record, input, now)
      }
    } catch (error) {
      if (error instanceof InboxDeclarationEvidenceUnavailableError) throw error
      // Re-read the shared map after the await: another resolver may have
      // advanced it while this repository call was pending.
      const latest = declarationEvidenceCache.get(key)
      if (latest) {
        record = record ? mergeRecordEventEvidence(record, latest, now) : latest
      }
      for (const input of inputs) {
        // A live relay observation is not durable confirmation when the
        // repository rejected the merge. Preserve only shared provenance that
        // was already held for this exact event; otherwise a restart could
        // regress from ready back to pending.
        const existingEvidence =
          record?.current.signedEvent.id === input.signedEvent.id
            ? record.current
            : record?.lastUsable?.signedEvent.id === input.signedEvent.id
              ? record.lastUsable
              : undefined
        const retainedSharedSourceRelayUrlSet = new Set(
          secureAutomaticRelayUrls(
            existingEvidence?.sharedSourceRelayUrls ?? []
          )
        )
        const fallbackInput = {
          ...input,
          sharedSourceRelayUrls: secureAutomaticRelayUrls(
            input.sharedSourceRelayUrls ?? []
          ).filter((relayUrl) => retainedSharedSourceRelayUrlSet.has(relayUrl)),
        }
        record = applyInboxDeclarationEvidenceMerge(record, fallbackInput, now)
      }
    }

    if (!record) throw new Error("Inbox declaration evidence merge failed")
    const latest = declarationEvidenceCache.get(key)
    if (latest) record = mergeRecordEventEvidence(record, latest, now)
    declarationEvidenceCache.set(
      key,
      cloneInboxDeclarationEvidenceRecord(record)
    )
    return cloneInboxDeclarationEvidenceRecord(record)
  })
}

/** Persist one signed declaration while preserving any stronger process state. */
export function mergeInboxDeclarationEvidenceDurably(
  input: MergeInboxDeclarationEvidenceInput,
  repository?: InboxDeclarationEvidenceRepository,
  now: () => number = Date.now
): Promise<InboxDeclarationEvidenceRecord> {
  return reconcileInboxDeclarationEvidenceBatch(
    input.pubkey,
    [input],
    repository,
    now
  )
}

export function currentEvidenceWasObservedAt(
  resolution: InboxDeclarationResolution
): number {
  return resolution.fetchedAt
}

export async function projectAndCacheInboxDeclarationResolution(
  pubkey: string,
  record: InboxDeclarationEvidenceRecord,
  input: {
    stale: boolean
    fetchedAt: number
    observation?: InboxDeclarationObservation
    clearInvalidation?: boolean
  },
  now: () => number
): Promise<InboxDeclarationResolution> {
  const key = cacheKey(pubkey)
  return withDeclarationEvidenceMergeLock(key, async () => {
    const latest = declarationEvidenceCache.get(key)
    const strongest = latest
      ? mergeRecordEventEvidence(record, latest, now)
      : record
    const sameFrontier =
      strongest.current.signedEvent.id === record.current.signedEvent.id
    const sameLookup =
      JSON.stringify(strongest.latestLookup) ===
      JSON.stringify(record.latestLookup)
    declarationEvidenceCache.set(
      key,
      cloneInboxDeclarationEvidenceRecord(strongest)
    )
    const resolution = resolutionFromEvidence(strongest, {
      stale:
        !sameFrontier ||
        !hasCurrentCompleteLookup(strongest) ||
        (sameLookup && input.stale),
      fetchedAt:
        sameFrontier && sameLookup
          ? input.fetchedAt
          : (strongest.latestLookup?.observedAt ??
            strongest.current.completeObservedAt ??
            strongest.current.observedAt),
      observation: sameFrontier && sameLookup ? input.observation : undefined,
    })
    declarationCache.set(key, resolution)
    if (input.clearInvalidation) invalidatedDeclarationKeys.delete(key)
    return resolution
  })
}

/** Read the cached declaration without any relay traffic. */
export function getCachedInboxDeclaration(
  pubkey: string
): InboxDeclarationResolution | null {
  return declarationCache.get(cacheKey(pubkey)) ?? null
}

export function cacheKey(pubkey: string): string {
  return pubkey.trim().toLowerCase()
}

export function allowsLocalRelayUrls(
  pubkey: string,
  allowLocalRelayUrlsForPubkey: string | null | undefined
): boolean {
  const allowedOwner = cacheKey(allowLocalRelayUrlsForPubkey ?? "")
  return !!allowedOwner && allowedOwner === cacheKey(pubkey)
}

/** Canonical evidence representation only; this does not grant I/O authority. */
export function retainedRelayUrls(relayUrls: readonly string[]): string[] {
  return normalizeOwnerSelectedRelayUrls(relayUrls)
}

/** Automatic shared, compatibility, and remote-derived targets stay secure. */
export function secureAutomaticRelayUrls(
  relayUrls: readonly string[]
): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
}

/**
 * Admit secure targets plus the exact candidate subset carrying authenticated
 * owner-selection provenance. A remote ws:// hint never enters the owner set.
 */
export function ownerAuthorizedDiscoveryRelayTargets(
  candidateRelayUrls: readonly string[],
  ownerSelectedRelayUrls: readonly string[]
): string[] {
  const candidates = retainedRelayUrls(candidateRelayUrls)
  const secure = new Set(publicRelayHintUrls(candidates))
  const ownerSelected = new Set(retainedRelayUrls(ownerSelectedRelayUrls))
  return candidates.filter(
    (relayUrl) => secure.has(relayUrl) || ownerSelected.has(relayUrl)
  )
}

export function publicRelayHintUrls(relayUrls: readonly string[]): string[] {
  return normalizePublicOrIsolatedE2eRelayHints(relayUrls)
}

export function declarationForContext(
  declaration: InboxDeclarationResolution,
  allowLocalRelayUrls: boolean
): InboxDeclarationResolution {
  const projectRelayUrls = allowLocalRelayUrls
    ? retainedRelayUrls
    : publicRelayHintUrls
  const projected = {
    ...declaration,
    relayUrls: projectRelayUrls(declaration.relayUrls),
    retainedReadRelayUrls: projectRelayUrls(
      declaration.retainedReadRelayUrls ?? []
    ),
    cutoverRecoveryRelayUrls: projectRelayUrls(
      declaration.cutoverRecoveryRelayUrls ?? []
    ),
    sourceRelayUrls: projectRelayUrls(declaration.sourceRelayUrls ?? []),
    sharedSourceRelayUrls: publicRelayHintUrls(
      declaration.sharedSourceRelayUrls ?? []
    ),
    pendingRelayUrls: projectRelayUrls(declaration.pendingRelayUrls ?? []),
    pendingPublishRelayUrls: projectRelayUrls(
      declaration.pendingPublishRelayUrls ?? []
    ),
  }
  if (declaration.state !== "declared") return projected

  const relayUrls = projected.relayUrls
  if (relayUrls.length === 0) {
    return { ...projected, state: "malformed", relayUrls: [] }
  }
  return projected
}

/** Stable shared relays used to make declarations discoverable cross-client. */
export function sharedInboxDiscoveryRelayUrls(): string[] {
  return publicRelayHintUrls(config.dmDeclarationDiscoveryRelayUrls).slice(
    0,
    MAX_SHARED_INBOX_DISCOVERY_RELAYS
  )
}

export function inboxDiscoveryRelayCandidates(
  ownerReadRelayUrls: readonly string[] = []
): string[] {
  return retainedRelayUrls([
    ...sharedInboxDiscoveryRelayUrls(),
    ...ownerReadRelayUrls,
  ]).slice(0, MAX_INBOX_DISCOVERY_RELAYS)
}

/** Default peer discovery uses only the shared, code-owned relay set. */
export function inboxDiscoveryRelayUrls(): string[] {
  return publicRelayHintUrls(inboxDiscoveryRelayCandidates())
}

/** Publish distribution: reserve shared relays before owner-local OUT relays. */
export function inboxDeclarationPublishRelayUrls(
  ownerWriteRelayUrls: readonly string[] = []
): string[] {
  return retainedRelayUrls([
    ...sharedInboxDiscoveryRelayUrls(),
    ...ownerWriteRelayUrls,
  ]).slice(0, MAX_INBOX_DISCOVERY_RELAYS)
}

export async function readDurableOwnerReadRelayUrls(
  pubkey: string | null | undefined,
  evidenceRepository?: OwnerRelayListEvidenceRepository
): Promise<string[]> {
  if (!pubkey) return []
  try {
    const retained = await readRetainedOwnerRelayList(pubkey, {
      evidenceRepository,
      durableOnly: true,
    })
    return retainedRelayUrls(
      (retained?.preferences ?? [])
        .filter((preference) => preference.readEnabled)
        .map((preference) => preference.url)
    )
  } catch {
    return []
  }
}

export function declarationEventsNewestFirst(
  events: readonly VerifiedNostrEvent[],
  pubkey: string
): VerifiedNostrEvent[] {
  return events
    .filter(
      (event) =>
        event.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS &&
        event.pubkey?.trim().toLowerCase() === pubkey
    )
    .sort((left, right) => -compareAccountNetworkRevisions(left, right))
}

export function toSignedDeclarationEvent(
  event: VerifiedNostrEvent,
  pubkey: string
): VerifiedNostrEvent | null {
  try {
    const signed = event
    const canonical =
      signed.pubkey === pubkey &&
      signed.pubkey === signed.pubkey.toLowerCase() &&
      signed.id === signed.id.toLowerCase() &&
      signed.sig === signed.sig.toLowerCase() &&
      /^[0-9a-f]{64}$/.test(signed.pubkey) &&
      /^[0-9a-f]{64}$/.test(signed.id) &&
      /^[0-9a-f]{128}$/.test(signed.sig)
    return canonical && isVerifiedNostrEvent(signed) ? signed : null
  } catch {
    return null
  }
}

export function resolutionFromEvidence(
  record: InboxDeclarationEvidenceRecord,
  input: {
    stale: boolean
    fetchedAt: number
    observation?: InboxDeclarationObservation
  }
): InboxDeclarationResolution {
  const current = record.current
  const pendingDistribution =
    record.pendingDistribution?.signedEvent.id === current.signedEvent.id
      ? record.pendingDistribution
      : undefined
  const facts = interpretAccountNetworkPreference({
    current: {
      eventId: current.signedEvent.id,
      state: current.state,
      completeObservedAt: current.completeObservedAt,
    },
    lastUsableEventId: record.lastUsable?.signedEvent.id,
    pendingEventId: pendingDistribution?.signedEvent.id,
    lookup: record.latestLookup,
  })
  const state = facts.state
  const declaredRelayUrls = facts.currentUsable
    ? retainedRelayUrls(current.secureRelayUrls)
    : []
  const pendingRelayUrls = facts.distributionPending ? declaredRelayUrls : []
  const retainedReadRelayUrls = !facts.currentUsable
    ? retainedRelayUrls(record.lastUsable?.secureRelayUrls ?? [])
    : []
  const currentOrPendingRelayUrls = new Set([
    ...declaredRelayUrls,
    ...pendingRelayUrls,
  ])
  const cutoverRecoveryRelayUrls = retainedRelayUrls(
    getActiveInboxCutoverRecoveryRelayUrls(record, input.fetchedAt)
  ).filter((relayUrl) => !currentOrPendingRelayUrls.has(relayUrl))
  const currentCutoverRecovery = record.cutoverRecoveries?.find(
    (recovery) => recovery.replacementEventId === current.signedEvent.id
  )
  const blockedCurrentAttemptRelayUrls = new Set(
    retainedRelayUrls(currentCutoverRecovery?.policyBlockedRelayUrls ?? [])
  )
  const currentConfirmationAttempts =
    currentCutoverRecovery?.confirmationAttempts ??
    (currentCutoverRecovery?.confirmationRelayUrls
      ? [
          {
            relayUrls: currentCutoverRecovery.confirmationRelayUrls,
          },
        ]
      : [])
  const cutoverRecoveryNeedsRedistribution = Boolean(
    currentCutoverRecovery &&
    currentCutoverRecovery.readbackObservedAt === undefined &&
    currentConfirmationAttempts.some((attempt) =>
      secureAutomaticRelayUrls(attempt.relayUrls).some((relayUrl) =>
        blockedCurrentAttemptRelayUrls.has(relayUrl)
      )
    )
  )
  return {
    pubkey: record.pubkey,
    evidence: facts,
    state,
    relayUrls: declaredRelayUrls,
    retainedReadRelayUrls,
    cutoverRecoveryRelayUrls,
    recovery: interpretAccountNetworkInboxRecovery(
      record.cutoverRecoveries ?? [],
      input.fetchedAt
    ).filter((route) => !currentOrPendingRelayUrls.has(route.relayUrl)),
    stale: facts.stale,
    fetchedAt: input.fetchedAt,
    eventId: current.signedEvent.id,
    eventCreatedAt: current.signedEvent.created_at,
    sourceRelayUrls: [...current.sourceRelayUrls],
    sharedSourceRelayUrls: [...(current.sharedSourceRelayUrls ?? [])],
    pendingRelayUrls,
    pendingPublishRelayUrls: [...(pendingDistribution?.publishRelayUrls ?? [])],
    pendingRelayOutcomes: pendingDistribution?.relayOutcomes
      ? structuredClone(pendingDistribution.relayOutcomes)
      : undefined,
    cutoverRecoveryNeedsRedistribution,
    ...(currentCutoverRecovery
      ? {
          cutoverRecoveryReadbackObservedAt:
            currentCutoverRecovery.readbackObservedAt,
          cutoverRecoveryExpiresAt: currentCutoverRecovery.expiresAt,
        }
      : {}),
    observation: input.observation,
  }
}

function cachedFallbackResolution(
  cached: InboxDeclarationResolution | undefined,
  observation: InboxDeclarationObservation,
  now: number
): InboxDeclarationResolution | null {
  if (!cached) return null
  return {
    ...cached,
    relayUrls: [...cached.relayUrls],
    retainedReadRelayUrls: [...(cached.retainedReadRelayUrls ?? [])],
    cutoverRecoveryRelayUrls: [...(cached.cutoverRecoveryRelayUrls ?? [])],
    sourceRelayUrls: [...(cached.sourceRelayUrls ?? [])],
    sharedSourceRelayUrls: [...(cached.sharedSourceRelayUrls ?? [])],
    pendingRelayUrls: [...(cached.pendingRelayUrls ?? [])],
    pendingPublishRelayUrls: [...(cached.pendingPublishRelayUrls ?? [])],
    pendingRelayOutcomes: cached.pendingRelayOutcomes
      ? structuredClone(cached.pendingRelayOutcomes)
      : undefined,
    stale: true,
    fetchedAt: now,
    observation,
  }
}

export async function persistCachedLookupOutcome(
  pubkey: string,
  cached: InboxDeclarationResolution | undefined,
  observation: InboxDeclarationObservation,
  fetchedAt: number,
  hadEvent: boolean,
  validEventId: string | undefined,
  repository: InboxDeclarationEvidenceRepository | undefined,
  now: () => number
): Promise<InboxDeclarationResolution | null> {
  const key = cacheKey(pubkey)
  const evidence = declarationEvidenceCache.get(key)
  if (evidence) {
    const current = evidence.current
    const merged = await reconcileInboxDeclarationEvidenceBatch(
      key,
      [
        {
          pubkey: key,
          signedEvent: current.signedEvent,
          sourceRelayUrls: current.sourceRelayUrls,
          observedAt: current.observedAt,
          completeObservedAt: current.completeObservedAt,
          cachedAt: fetchedAt,
          lookup: {
            observedAt: fetchedAt,
            coverage: observation.coverage,
            sources: observation.sources,
            hadEvent,
            eventId: validEventId,
          },
        },
      ],
      repository,
      now
    )
    return await projectAndCacheInboxDeclarationResolution(
      key,
      merged,
      {
        stale: true,
        fetchedAt,
        observation,
        clearInvalidation: true,
      },
      now
    )
  }
  const fallback = cachedFallbackResolution(cached, observation, fetchedAt)
  if (fallback) {
    declarationCache.set(key, fallback)
    invalidatedDeclarationKeys.delete(key)
  }
  return fallback
}

export function declarationEventSourceRelayUrls(
  event: SignedPublicNostrEvent,
  successfulRelayUrls: readonly string[]
): string[] {
  const successful = retainedRelayUrls(successfulRelayUrls)
  const successfulSet = new Set(successful)
  const attached = retainedRelayUrls(getEventSourceRelayUrls(event))
  if (attached.length > 0) {
    return attached.filter((url) => successfulSet.has(url))
  }
  // Completion diagnostics alone do not prove which relay returned an event.
  // Native fanout attaches per-event source provenance before aggregation.
  return []
}
