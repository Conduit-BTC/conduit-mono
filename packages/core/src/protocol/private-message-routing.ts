import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import {
  applyInboxDeclarationEvidenceMerge,
  cloneInboxDeclarationEvidenceRecord,
  getInboxDeclarationEvidence,
  mergeInboxDeclarationEvidenceBatch as mergeInboxDeclarationEvidenceBatchDurably,
  normalizeInboxDeclarationEvidencePubkey,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceRepository,
  type MergeInboxDeclarationEvidenceInput,
} from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanoutWithDiagnostics,
  getEventSourceRelayUrls,
} from "./ndk"
import {
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizeSecureOrIsolatedE2eRelayUrls,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export { normalizeSecureRelayUrls as secureRelayUrls } from "./relay-settings"

/**
 * Shared NIP-17 inbox routing boundary (CND-208).
 *
 * Canonical behavior stays NIP-17: a valid kind-10050 declaration is the
 * preferred and eventual exclusive delivery route. This module adds the typed
 * declaration/readiness model plus the named temporary validated-order
 * compatibility route for kind-16 order traffic during
 * migration. See docs/knowledge/nip17-inbox-bootstrap-migration.md.
 */

/** Typed result of a kind-10050 declaration lookup. */
export type InboxDeclarationState =
  | "declared"
  | "distribution_pending"
  | "signed_empty"
  | "not_observed"
  | "lookup_partial"
  | "lookup_unavailable"
  | "malformed"

/** How much of a fanout read actually completed. */
export type InboxReadCoverage = "complete" | "partial" | "unavailable"

/** Where a private-message read relay came from. */
export type InboxReadSource =
  "declared" | "local_in" | "compatibility" | "mixed" | "cache"

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
  pubkey: string
  state: InboxDeclarationState
  /** Secure declared inbox relays; empty unless state is "declared". */
  relayUrls: string[]
  /** Last usable declaration retained only for permissive inbox reads. */
  retainedReadRelayUrls?: string[]
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
  /** Diagnostics for this invocation's network observation. */
  observation?: InboxDeclarationObservation
}

export interface InboxDeclarationObservation {
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
  fetchEventsWithDiagnostics?: typeof fetchEventsFanoutWithDiagnostics
  /** Discovery relays; defaults to local reads + compatibility reads. */
  relayUrls?: readonly string[]
  now?: () => number
  /** Freshness window override in ms (tests). */
  freshnessMs?: number
  /** Durable evidence seam (tests/non-browser adapters). */
  evidenceRepository?: InboxDeclarationEvidenceRepository
  /** Sources whose exact-event readback proves cross-client distribution. */
  sharedConfirmationRelayUrls?: readonly string[]
  /** Preserve local/private WSS only while inspecting this authenticated owner. */
  allowLocalRelayUrlsForPubkey?: string | null
}

/** Positive declarations stay fresh for this long before a re-fetch. */
export const INBOX_DECLARATION_FRESHNESS_MS = 5 * 60_000

const declarationCache = new Map<string, InboxDeclarationResolution>()
const declarationEvidenceCache = new Map<
  string,
  InboxDeclarationEvidenceRecord
>()
const declarationEvidenceMergeTails = new Map<string, Promise<void>>()
const invalidatedDeclarationKeys = new Set<string>()

function hasCurrentCompleteLookup(
  record: InboxDeclarationEvidenceRecord
): boolean {
  const completeObservedAt = record.current.completeObservedAt
  if (completeObservedAt === undefined) return false
  const latestLookup = record.latestLookup
  if (!latestLookup) return true
  if (latestLookup.observedAt < completeObservedAt) return true
  return (
    latestLookup.coverage === "complete" &&
    latestLookup.hadEvent &&
    latestLookup.eventId === record.current.signedEvent.id
  )
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
  const merged = mergeEvidenceRecords(
    declarationEvidenceCache.get(key),
    record,
    now
  )
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

  const persisted = await getInboxDeclarationEvidence(
    key,
    options.evidenceRepository
  )
  if (!persisted) return null

  const durable = mergeEvidenceRecords(
    undefined,
    backfillLegacySharedSourceProvenance(
      persisted,
      new Set(sharedInboxDiscoveryRelayUrls())
    ),
    options.now
  )
  const process = declarationEvidenceCache.get(key)
  if (process) {
    const strongest = mergeEvidenceRecords(durable, process, options.now)
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

function evidenceMergeInputs(
  record: InboxDeclarationEvidenceRecord
): MergeInboxDeclarationEvidenceInput[] {
  const evidence = []
  if (
    record.lastUsable &&
    record.lastUsable.signedEvent.id !== record.current.signedEvent.id
  ) {
    evidence.push(record.lastUsable)
  }
  evidence.push(record.current)
  return evidence.map((entry) => ({
    pubkey: record.pubkey,
    signedEvent: entry.signedEvent,
    sourceRelayUrls: entry.sourceRelayUrls,
    sharedSourceRelayUrls: entry.sharedSourceRelayUrls ?? [],
    pendingDistribution:
      entry.signedEvent.id === record.current.signedEvent.id
        ? record.pendingDistribution
        : undefined,
    observedAt: entry.observedAt,
    completeObservedAt: entry.completeObservedAt,
    cachedAt: record.cachedAt,
    lookup: record.latestLookup ? { ...record.latestLookup } : undefined,
  }))
}

function mergeEvidenceRecords(
  existing: InboxDeclarationEvidenceRecord | undefined,
  candidate: InboxDeclarationEvidenceRecord,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  let merged = existing
    ? cloneInboxDeclarationEvidenceRecord(existing)
    : undefined
  for (const input of evidenceMergeInputs(candidate)) {
    merged = applyInboxDeclarationEvidenceMerge(merged, input, now)
  }
  return merged!
}

function backfillLegacySharedSourceProvenance(
  record: InboxDeclarationEvidenceRecord,
  sharedRelayUrlSet: ReadonlySet<string>
): InboxDeclarationEvidenceRecord {
  const migrated = cloneInboxDeclarationEvidenceRecord(record)
  const backfill = (evidence: InboxDeclarationEvidenceRecord["current"]) => {
    if (evidence.sharedSourceRelayUrls !== undefined) return
    evidence.sharedSourceRelayUrls = ownerRelayUrls(
      evidence.sourceRelayUrls
    ).filter((relayUrl) => sharedRelayUrlSet.has(relayUrl))
  }
  backfill(migrated.current)
  if (migrated.lastUsable) backfill(migrated.lastUsable)
  return migrated
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
async function reconcileInboxDeclarationEvidenceBatch(
  pubkey: string,
  inputs: readonly MergeInboxDeclarationEvidenceInput[],
  repository: InboxDeclarationEvidenceRepository | undefined,
  now: () => number
): Promise<InboxDeclarationEvidenceRecord> {
  const key = cacheKey(pubkey)
  return withDeclarationEvidenceMergeLock(key, async () => {
    let record = declarationEvidenceCache.get(key)
    try {
      // When IndexedDB recovers, seed it with the strongest process evidence
      // before applying a newly fetched (possibly older) relay view.
      const orderedInputs = [...inputs].sort((left, right) => {
        const createdAt =
          left.signedEvent.created_at - right.signedEvent.created_at
        return createdAt !== 0
          ? createdAt
          : right.signedEvent.id.localeCompare(left.signedEvent.id)
      })
      const durableInputs = [
        ...(record ? evidenceMergeInputs(record) : []),
        ...orderedInputs,
      ]
      if (durableInputs.length > 0) {
        const persisted = await mergeInboxDeclarationEvidenceBatchDurably(
          durableInputs,
          repository
        )
        record = mergeEvidenceRecords(record, persisted, now)
      }
      for (const input of orderedInputs) {
        record = applyInboxDeclarationEvidenceMerge(record, input, now)
      }
    } catch {
      // Re-read the shared map after the await: another resolver may have
      // advanced it while this repository call was pending.
      const latest = declarationEvidenceCache.get(key)
      if (latest) {
        record = record ? mergeEvidenceRecords(latest, record, now) : latest
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
          ownerRelayUrls(existingEvidence?.sharedSourceRelayUrls ?? [])
        )
        const fallbackInput = {
          ...input,
          sharedSourceRelayUrls: ownerRelayUrls(
            input.sharedSourceRelayUrls ?? []
          ).filter((relayUrl) => retainedSharedSourceRelayUrlSet.has(relayUrl)),
        }
        record = applyInboxDeclarationEvidenceMerge(record, fallbackInput, now)
      }
    }

    if (!record) throw new Error("Inbox declaration evidence merge failed")
    const latest = declarationEvidenceCache.get(key)
    if (latest) record = mergeEvidenceRecords(latest, record, now)
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

function currentEvidenceWasObservedAt(
  resolution: InboxDeclarationResolution
): number {
  return resolution.fetchedAt
}

async function projectAndCacheInboxDeclarationResolution(
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
      ? mergeEvidenceRecords(record, latest, now)
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

function cacheKey(pubkey: string): string {
  return pubkey.trim().toLowerCase()
}

function allowsLocalRelayUrls(
  pubkey: string,
  allowLocalRelayUrlsForPubkey: string | null | undefined
): boolean {
  const allowedOwner = cacheKey(allowLocalRelayUrlsForPubkey ?? "")
  return !!allowedOwner && allowedOwner === cacheKey(pubkey)
}

function ownerRelayUrls(relayUrls: readonly string[]): string[] {
  return normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
}

export function publicRelayHintUrls(relayUrls: readonly string[]): string[] {
  return normalizePublicOrIsolatedE2eRelayHints(relayUrls)
}

function declarationForContext(
  declaration: InboxDeclarationResolution,
  allowLocalRelayUrls: boolean
): InboxDeclarationResolution {
  const projectRelayUrls = allowLocalRelayUrls
    ? ownerRelayUrls
    : publicRelayHintUrls
  const projected = {
    ...declaration,
    relayUrls: projectRelayUrls(declaration.relayUrls),
    retainedReadRelayUrls: projectRelayUrls(
      declaration.retainedReadRelayUrls ?? []
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

function inboxDiscoveryRelayCandidates(): string[] {
  return ownerRelayUrls([
    ...sharedInboxDiscoveryRelayUrls(),
    ...getGeneralReadRelayUrls({ fallbackRelayUrls: [] }),
  ]).slice(0, MAX_INBOX_DISCOVERY_RELAYS)
}

/** Default peer discovery: shared relays first, then local secure reads. */
export function inboxDiscoveryRelayUrls(): string[] {
  return publicRelayHintUrls(inboxDiscoveryRelayCandidates())
}

/** Publish distribution: reserve shared relays before owner-local OUT relays. */
export function inboxDeclarationPublishRelayUrls(
  ownerWriteRelayUrls: readonly string[] = getGeneralWriteRelayUrls({})
): string[] {
  return ownerRelayUrls([
    ...sharedInboxDiscoveryRelayUrls(),
    ...ownerWriteRelayUrls,
  ]).slice(0, MAX_INBOX_DISCOVERY_RELAYS)
}

function declarationEventsNewestFirst(
  events: readonly NDKEvent[],
  pubkey: string
): NDKEvent[] {
  return events
    .filter(
      (event) =>
        event.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS &&
        event.pubkey?.trim().toLowerCase() === pubkey
    )
    .sort((left, right) => {
      const createdAt = (right.created_at ?? 0) - (left.created_at ?? 0)
      return createdAt !== 0
        ? createdAt
        : (left.id ?? "").localeCompare(right.id ?? "")
    })
}

function toSignedDeclarationEvent(
  event: NDKEvent,
  pubkey: string
): SignedPublicNostrEvent | null {
  try {
    const signed =
      typeof event.rawEvent === "function"
        ? (event.rawEvent() as SignedPublicNostrEvent)
        : (event as unknown as SignedPublicNostrEvent)
    const canonical =
      signed.pubkey === pubkey &&
      signed.pubkey === signed.pubkey.toLowerCase() &&
      signed.id === signed.id.toLowerCase() &&
      signed.sig === signed.sig.toLowerCase() &&
      /^[0-9a-f]{64}$/.test(signed.pubkey) &&
      /^[0-9a-f]{64}$/.test(signed.id) &&
      /^[0-9a-f]{128}$/.test(signed.sig)
    return canonical && isValidSignedPublicNostrEvent(signed) ? signed : null
  } catch {
    return null
  }
}

function resolutionFromEvidence(
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
  const state: InboxDeclarationState = pendingDistribution
    ? "distribution_pending"
    : current.state
  const declaredRelayUrls =
    state === "declared" ? ownerRelayUrls(current.secureRelayUrls) : []
  const pendingRelayUrls =
    state === "distribution_pending" && current.state === "declared"
      ? ownerRelayUrls(current.secureRelayUrls)
      : []
  const retainedReadRelayUrls =
    state === "declared"
      ? []
      : ownerRelayUrls([
          ...pendingRelayUrls,
          ...(record.lastUsable?.secureRelayUrls ?? []),
        ])
  return {
    pubkey: record.pubkey,
    state,
    relayUrls: declaredRelayUrls,
    retainedReadRelayUrls,
    stale: input.stale,
    fetchedAt: input.fetchedAt,
    eventId: current.signedEvent.id,
    eventCreatedAt: current.signedEvent.created_at,
    sourceRelayUrls: [...current.sourceRelayUrls],
    sharedSourceRelayUrls: [...(current.sharedSourceRelayUrls ?? [])],
    pendingRelayUrls,
    pendingPublishRelayUrls: [...(pendingDistribution?.publishRelayUrls ?? [])],
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
    sourceRelayUrls: [...(cached.sourceRelayUrls ?? [])],
    sharedSourceRelayUrls: [...(cached.sharedSourceRelayUrls ?? [])],
    pendingRelayUrls: [...(cached.pendingRelayUrls ?? [])],
    pendingPublishRelayUrls: [...(cached.pendingPublishRelayUrls ?? [])],
    stale: true,
    fetchedAt: now,
    observation,
  }
}

async function persistCachedLookupOutcome(
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

function declarationEventSourceRelayUrls(
  event: NDKEvent,
  successfulRelayUrls: readonly string[]
): string[] {
  const successful = ownerRelayUrls(successfulRelayUrls)
  const successfulSet = new Set(successful)
  const attached = ownerRelayUrls(getEventSourceRelayUrls(event))
  if (attached.length > 0) {
    return attached.filter((url) => successfulSet.has(url))
  }
  // Completion diagnostics alone do not prove which relay returned an event.
  // Native fanout attaches per-event source provenance before aggregation.
  return []
}

function reconcileInboxReadDiagnostics(
  result: Awaited<ReturnType<typeof fetchEventsFanoutWithDiagnostics>>,
  relayUrls: readonly string[]
): Awaited<ReturnType<typeof fetchEventsFanoutWithDiagnostics>> {
  const planned = ownerRelayUrls(relayUrls)
  const plannedSet = new Set(planned)
  const successfulSet = new Set(
    ownerRelayUrls(result.successfulRelayUrls).filter((url) =>
      plannedSet.has(url)
    )
  )
  const reportedFailedSet = new Set(
    ownerRelayUrls(result.failedRelayUrls).filter((url) => plannedSet.has(url))
  )
  const attemptedSet = new Set(
    ownerRelayUrls([
      ...result.attemptedRelayUrls,
      ...result.successfulRelayUrls,
      ...result.failedRelayUrls,
    ]).filter((url) => plannedSet.has(url))
  )
  const failedSet = new Set(reportedFailedSet)
  for (const relayUrl of planned) {
    if (!attemptedSet.has(relayUrl)) failedSet.add(relayUrl)
  }
  return {
    events: result.events,
    attemptedRelayUrls: planned.filter((url) => attemptedSet.has(url)),
    successfulRelayUrls: planned.filter((url) => successfulSet.has(url)),
    failedRelayUrls: planned.filter((url) => failedSet.has(url)),
  }
}

/**
 * Resolve a pubkey's kind-10050 declaration with typed, retryable outcomes.
 *
 * - All discovery relays failed never reports "not_observed"; it is
 *   "lookup_unavailable" (or the stale cached declaration when one exists).
 * - Partial coverage with no event stays "lookup_partial".
 * - Signed empty and structurally malformed events remain distinct blocking
 *   frontier states; either may supersede an older declared route.
 * - Every validated signed frontier is cached durably with account-scoped
 *   freshness, while older usable predecessors remain read-only evidence.
 */
export async function resolveInboxDeclaration(
  pubkey: string,
  options: ResolveInboxDeclarationOptions = {}
): Promise<InboxDeclarationResolution> {
  const key = cacheKey(pubkey)
  const now = options.now ?? Date.now
  const freshnessMs = options.freshnessMs ?? INBOX_DECLARATION_FRESHNESS_MS
  const allowLocal = allowsLocalRelayUrls(
    key,
    options.allowLocalRelayUrlsForPubkey
  )
  const fetchedAt = now()
  const repository = options.evidenceRepository
  const canonicalSharedRelayUrlSet = new Set(sharedInboxDiscoveryRelayUrls())
  const sharedConfirmationRelayUrlSet = new Set(
    ownerRelayUrls(
      options.sharedConfirmationRelayUrls ?? [...canonicalSharedRelayUrlSet]
    ).filter((relayUrl) => canonicalSharedRelayUrlSet.has(relayUrl))
  )

  let cached = declarationCache.get(key)
  if (normalizeInboxDeclarationEvidencePubkey(key)) {
    try {
      const persisted = await getInboxDeclarationEvidence(key, repository)
      if (persisted) {
        const persistedForReconciliation = mergeEvidenceRecords(
          undefined,
          backfillLegacySharedSourceProvenance(
            persisted,
            canonicalSharedRelayUrlSet
          ),
          now
        )
        const processEvidence = declarationEvidenceCache.get(key)
        declarationEvidenceCache.set(
          key,
          processEvidence
            ? mergeEvidenceRecords(
                processEvidence,
                persistedForReconciliation,
                now
              )
            : cloneInboxDeclarationEvidenceRecord(persistedForReconciliation)
        )
        // A fresh process cache is not authoritative across browser tabs.
        // Reconcile the durable frontier before considering the TTL fast path,
        // and repair durable storage if a prior transient write failure left
        // stronger validated process evidence only in memory.
        const reconciled = await reconcileInboxDeclarationEvidenceBatch(
          key,
          evidenceMergeInputs(persistedForReconciliation),
          repository,
          now
        )
        cached = await projectAndCacheInboxDeclarationResolution(
          key,
          reconciled,
          {
            stale:
              !hasCurrentCompleteLookup(reconciled) ||
              fetchedAt - (reconciled.current.completeObservedAt ?? 0) >=
                freshnessMs,
            fetchedAt:
              reconciled.latestLookup?.observedAt ??
              reconciled.current.completeObservedAt ??
              reconciled.current.observedAt,
          },
          now
        )
      }
    } catch {
      // IndexedDB can be unavailable in privacy modes. Relay discovery remains
      // usable; the durable store is an evidence aid, not a network gate.
    }
  }
  const latestProcessEvidence = declarationEvidenceCache.get(key)
  if (
    latestProcessEvidence &&
    cached?.eventId !== latestProcessEvidence.current.signedEvent.id
  ) {
    cached = resolutionFromEvidence(latestProcessEvidence, {
      stale:
        !hasCurrentCompleteLookup(latestProcessEvidence) ||
        fetchedAt - (latestProcessEvidence.current.completeObservedAt ?? 0) >=
          freshnessMs,
      fetchedAt:
        latestProcessEvidence.latestLookup?.observedAt ??
        latestProcessEvidence.current.completeObservedAt ??
        latestProcessEvidence.current.observedAt,
    })
    declarationCache.set(key, cached)
  }
  if (
    cached &&
    !invalidatedDeclarationKeys.has(key) &&
    !cached.stale &&
    fetchedAt - currentEvidenceWasObservedAt(cached) < freshnessMs
  ) {
    return declarationForContext({ ...cached, stale: false }, allowLocal)
  }

  const fetchWithDiagnostics =
    options.fetchEventsWithDiagnostics ?? fetchEventsFanoutWithDiagnostics
  const relayCandidates =
    options.relayUrls && options.relayUrls.length > 0
      ? ownerRelayUrls(options.relayUrls)
      : inboxDiscoveryRelayCandidates()
  const relayUrls = allowLocal
    ? ownerRelayUrls(relayCandidates)
    : publicRelayHintUrls(relayCandidates)

  let result: Awaited<ReturnType<typeof fetchEventsFanoutWithDiagnostics>>
  try {
    result = await fetchWithDiagnostics(
      {
        kinds: [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
        authors: [key],
        limit: 1,
      },
      {
        relayUrls,
        connectTimeoutMs: 3_000,
        fetchTimeoutMs: 6_000,
        skipHealthFilter: true,
      }
    )
  } catch {
    result = {
      events: [],
      attemptedRelayUrls: [...relayUrls],
      successfulRelayUrls: [],
      failedRelayUrls: [...relayUrls],
    }
  }
  result = reconcileInboxReadDiagnostics(result, relayUrls)

  const observationBase: InboxDeclarationObservation = {
    coverage: deriveInboxReadCoverage(result),
    attemptedRelayUrls: ownerRelayUrls(result.attemptedRelayUrls),
    successfulRelayUrls: ownerRelayUrls(result.successfulRelayUrls),
    failedRelayUrls: ownerRelayUrls(result.failedRelayUrls),
    eventSourceRelayUrls: [],
  }

  if (result.successfulRelayUrls.length === 0) {
    const fallback = await persistCachedLookupOutcome(
      key,
      cached,
      observationBase,
      fetchedAt,
      false,
      undefined,
      repository,
      now
    )
    if (fallback) return declarationForContext(fallback, allowLocal)
    return {
      pubkey: key,
      state: "lookup_unavailable",
      relayUrls: [],
      stale: false,
      fetchedAt,
      observation: observationBase,
    }
  }

  const declarations = declarationEventsNewestFirst(result.events, key)
  const newest = declarations[0] ?? null
  if (!newest) {
    if (result.failedRelayUrls.length > 0) {
      const fallback = await persistCachedLookupOutcome(
        key,
        cached,
        observationBase,
        fetchedAt,
        false,
        undefined,
        repository,
        now
      )
      if (fallback) return declarationForContext(fallback, allowLocal)
      return {
        pubkey: key,
        state: "lookup_partial",
        relayUrls: [],
        stale: false,
        fetchedAt,
        observation: observationBase,
      }
    }
    const fallback = await persistCachedLookupOutcome(
      key,
      cached,
      observationBase,
      fetchedAt,
      false,
      undefined,
      repository,
      now
    )
    if (fallback) return declarationForContext(fallback, allowLocal)
    return {
      pubkey: key,
      state: "not_observed",
      relayUrls: [],
      stale: false,
      fetchedAt,
      observation: observationBase,
    }
  }

  const signedDeclarations = declarations.flatMap((event) => {
    const signedEvent = toSignedDeclarationEvent(event, key)
    return signedEvent ? [{ event, signedEvent }] : []
  })
  const signedEvent = signedDeclarations[0]?.signedEvent ?? null
  if (!signedEvent) {
    const invalidObservation = {
      ...observationBase,
      eventId: newest.id || undefined,
      eventSourceRelayUrls: declarationEventSourceRelayUrls(
        newest,
        result.successfulRelayUrls
      ),
    }
    const fallback = await persistCachedLookupOutcome(
      key,
      cached,
      invalidObservation,
      fetchedAt,
      true,
      undefined,
      repository,
      now
    )
    if (fallback) return declarationForContext(fallback, allowLocal)
    return {
      pubkey: key,
      state: "lookup_partial",
      relayUrls: [],
      stale: false,
      fetchedAt,
      observation: invalidObservation,
    }
  }

  const eventSourceRelayUrls = declarationEventSourceRelayUrls(
    signedDeclarations[0]!.event,
    result.successfulRelayUrls
  )
  const observation: InboxDeclarationObservation = {
    ...observationBase,
    eventId: signedEvent.id,
    eventSourceRelayUrls,
  }
  const record = await reconcileInboxDeclarationEvidenceBatch(
    key,
    signedDeclarations.map((candidate) => {
      const sourceRelayUrls = declarationEventSourceRelayUrls(
        candidate.event,
        result.successfulRelayUrls
      )
      return {
        pubkey: key,
        signedEvent: candidate.signedEvent,
        sourceRelayUrls,
        sharedSourceRelayUrls: sourceRelayUrls.filter((url) =>
          sharedConfirmationRelayUrlSet.has(url)
        ),
        observedAt: fetchedAt,
        completeObservedAt:
          observation.coverage === "complete" ? fetchedAt : undefined,
        cachedAt: fetchedAt,
        lookup: {
          observedAt: fetchedAt,
          coverage: observation.coverage,
          hadEvent: true,
          eventId: signedEvent.id,
        },
      }
    }),
    repository,
    now
  )

  const resolution = await projectAndCacheInboxDeclarationResolution(
    key,
    record,
    {
      stale:
        observation.coverage !== "complete" ||
        record.current.signedEvent.id !== signedEvent.id,
      fetchedAt: record.current.observedAt,
      observation,
      clearInvalidation: true,
    },
    now
  )
  return declarationForContext(resolution, allowLocal)
}

export interface InboxReadPlan {
  relayUrls: string[]
  /** Per-relay provenance for diagnostics (content-free). */
  relaySources: Record<string, Exclude<InboxReadSource, "mixed">>
  /** Aggregate provenance of the plan. */
  source: InboxReadSource
}

export interface PlanInboxReadRelaysInput {
  declaration: InboxDeclarationResolution
  /** Exact authenticated inbox owner whose private/local relays may be read. */
  authenticatedPubkey?: string | null
  /** Locally enabled secure IN relays; defaults to relay-settings reads. */
  localReadRelayUrls?: readonly string[]
  /** Bounded compatibility reads; defaults to config.commerceDmFallbackRelayUrls. */
  compatibilityRelayUrls?: readonly string[]
  /**
   * Compatibility write targets Conduit must also poll. Defaults to the
   * operator-approved order registry and may only select from the read set.
   */
  requiredCompatibilityRelayUrls?: readonly string[]
  maxRelays?: number
}

/**
 * Permissive inbox read plan: union of declared inbox relays, locally enabled
 * secure IN relays, and the bounded compatibility read set. Nonempty local
 * settings never suppress compatibility reads. Reads may consult local state;
 * writes must not (see selectPrivateMessageDeliveryRoute).
 */
export function planInboxReadRelays(
  input: PlanInboxReadRelaysInput
): InboxReadPlan {
  const allowOwnerLocalRelays = allowsLocalRelayUrls(
    input.declaration.pubkey,
    input.authenticatedPubkey
  )
  const projectOwnerRelayUrls = allowOwnerLocalRelays
    ? ownerRelayUrls
    : publicRelayHintUrls
  const declared = projectOwnerRelayUrls(
    input.declaration.state === "declared" ? input.declaration.relayUrls : []
  )
  const cachedFallback = projectOwnerRelayUrls([
    ...(input.declaration.retainedReadRelayUrls ?? []),
    ...(input.declaration.state === "lookup_partial" ||
    input.declaration.state === "lookup_unavailable"
      ? (getCachedInboxDeclaration(input.declaration.pubkey)?.relayUrls ?? [])
      : []),
  ])
  const rawLocalIn =
    input.localReadRelayUrls ??
    getGeneralReadRelayUrls({ fallbackRelayUrls: [] })
  const localIn = allowOwnerLocalRelays
    ? ownerRelayUrls(rawLocalIn)
    : publicRelayHintUrls(rawLocalIn)
  const compatibility = publicRelayHintUrls(
    input.compatibilityRelayUrls ?? config.commerceDmFallbackRelayUrls
  )
  const compatibilitySet = new Set(compatibility)
  const requiredCompatibility = publicRelayHintUrls(
    input.requiredCompatibilityRelayUrls ?? config.dmCompatibilityOrderRelayUrls
  ).filter((url) => compatibilitySet.has(url))
  const requiredCompatibilitySet = new Set(requiredCompatibility)
  const remainingCompatibility = compatibility.filter(
    (url) => !requiredCompatibilitySet.has(url)
  )

  const relaySources: InboxReadPlan["relaySources"] = {}
  const orderedUrls: string[] = []
  const add = (
    urls: readonly string[],
    source: Exclude<InboxReadSource, "mixed">
  ) => {
    for (const url of urls) {
      if (relaySources[url]) continue
      relaySources[url] = source
      orderedUrls.push(url)
    }
  }
  add(declared, "declared")
  add(cachedFallback, "cache")
  // Reserve the write/read overlap before optional local and public
  // compatibility sources so a large local IN list cannot make an order
  // unreadable in Conduit after a compatibility delivery.
  add(requiredCompatibility, "compatibility")
  add(localIn, "local_in")
  add(remainingCompatibility, "compatibility")

  const limited =
    input.maxRelays && input.maxRelays > 0
      ? orderedUrls.slice(0, input.maxRelays)
      : orderedUrls
  const usedSources = new Set(limited.map((url) => relaySources[url]))
  const source: InboxReadSource =
    usedSources.size > 1
      ? "mixed"
      : (limited[0] && relaySources[limited[0]]) || "compatibility"

  return { relayUrls: limited, relaySources, source }
}

/** Derive read coverage from fanout diagnostics. */
export function deriveInboxReadCoverage(diagnostics: {
  successfulRelayUrls: readonly string[]
  failedRelayUrls: readonly string[]
  cappedRelayUrls?: readonly string[]
}): InboxReadCoverage {
  if (diagnostics.successfulRelayUrls.length === 0) return "unavailable"
  if (
    diagnostics.failedRelayUrls.length > 0 ||
    (diagnostics.cappedRelayUrls?.length ?? 0) > 0
  ) {
    return "partial"
  }
  return "complete"
}

export interface DeliveryRouteSelection {
  route: PrivateMessageDeliveryRoute
  /** Exclusive write targets for the selected route; empty when blocked. */
  relayUrls: string[]
  /** Content-free per-target routing evidence. */
  relaySources: Record<string, "declared" | CompatibilityOrderRelaySource>
  truncated: boolean
  /** Content-free reason for a blocked route. */
  blockedReason?:
    | "recipient_not_ready"
    | "recipient_lookup_failed"
    | "declaration_distribution_pending"
    | "declaration_signed_empty"
    | "declaration_malformed"
}

export interface SelectDeliveryRouteInput {
  rumorKind: number
  declaration: InboxDeclarationResolution
  /**
   * True only for a validated kind-16 order lifecycle: locally created
   * checkout/order or a validated inbound order with matching order identity
   * and counterparty. General kind-14 DMs must pass false.
   */
  validatedOrder: boolean
  /** Deployment-profile-controlled compatibility flag; defaults to config. */
  compatibilityEnabled?: boolean
  /** Operator-approved compatibility registry; defaults to config. */
  compatibilityRelayUrls?: readonly string[]
  /** Signed recipient NIP-65 read relays may rank, but never widen, the pool. */
  recipientReadRelayUrls?: readonly string[]
  maxCompatibilityRelays?: number
}

/**
 * Build the non-standard compatibility lane used only for validated orders.
 * The operator-approved registry is the complete eligibility boundary. Signed
 * recipient NIP-65 read evidence can only move matching entries to the front;
 * arbitrary NIP-65 relays never become private-message write targets.
 */
export function planCompatibilityOrderRelays(input: {
  approvedRelayUrls: readonly string[]
  recipientReadRelayUrls?: readonly string[]
  maxRelays?: number
}): CompatibilityOrderRelayPlan {
  const approved = ownerRelayUrls(input.approvedRelayUrls)
  const approvedSet = new Set(approved)
  const recipientMatches = ownerRelayUrls(
    input.recipientReadRelayUrls ?? []
  ).filter((url) => approvedSet.has(url))
  const recipientMatchSet = new Set(recipientMatches)
  const ordered = [
    ...recipientMatches,
    ...approved.filter((url) => !recipientMatchSet.has(url)),
  ]
  const maxRelays = Math.max(
    0,
    Math.floor(input.maxRelays ?? MAX_COMPATIBILITY_ORDER_RELAYS)
  )
  const relayUrls = ordered.slice(0, maxRelays)
  const relaySources = Object.fromEntries(
    relayUrls.map((url) => [
      url,
      recipientMatchSet.has(url) ? "recipient_nip65" : "compatibility_registry",
    ])
  ) as Record<string, CompatibilityOrderRelaySource>

  return {
    relayUrls,
    relaySources,
    truncated: ordered.length > relayUrls.length,
  }
}

/**
 * Select the delivery lane for one outgoing private message.
 *
 * Invariants (docs/knowledge/nip17-inbox-bootstrap-migration.md):
 * - A valid current or cached declaration always outranks compatibility.
 * - Compatibility writes use only the explicit operator-approved registry and
 *   only for validated kind-16 order traffic while the flag is enabled.
 * - Kind-14 general DMs never use compatibility delivery.
 * - Signed malformed declarations block writes; repair happens in Network.
 */
export function selectPrivateMessageDeliveryRoute(
  input: SelectDeliveryRouteInput
): DeliveryRouteSelection {
  const declaration = input.declaration
  if (declaration.state === "declared") {
    const declaredRelayUrls = ownerRelayUrls(declaration.relayUrls)
    const relayUrls = declaredRelayUrls.slice(
      0,
      MAX_DECLARED_INBOX_WRITE_RELAYS
    )
    return {
      route: "declared_inbox",
      relayUrls,
      relaySources: Object.fromEntries(
        relayUrls.map((url) => [url, "declared"])
      ),
      truncated: declaredRelayUrls.length > relayUrls.length,
    }
  }
  if (declaration.state === "signed_empty") {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: "declaration_signed_empty",
    }
  }
  if (declaration.state === "distribution_pending") {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: "declaration_distribution_pending",
    }
  }
  if (declaration.state === "malformed") {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: "declaration_malformed",
    }
  }

  const strictBlockedReason =
    declaration.state === "not_observed"
      ? ("recipient_not_ready" as const)
      : ("recipient_lookup_failed" as const)

  const isOrderMessage = input.rumorKind === EVENT_KINDS.ORDER
  if (!isOrderMessage || !input.validatedOrder) {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: strictBlockedReason,
    }
  }

  const compatibilityEnabled =
    input.compatibilityEnabled ?? config.dmCompatibilityOrderRoutingEnabled
  const compatibilityPlan = planCompatibilityOrderRelays({
    approvedRelayUrls:
      input.compatibilityRelayUrls ?? config.dmCompatibilityOrderRelayUrls,
    recipientReadRelayUrls: input.recipientReadRelayUrls,
    maxRelays: input.maxCompatibilityRelays,
  })
  if (!compatibilityEnabled || compatibilityPlan.relayUrls.length === 0) {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: strictBlockedReason,
    }
  }

  return {
    route: "compatibility_order",
    relayUrls: compatibilityPlan.relayUrls,
    relaySources: compatibilityPlan.relaySources,
    truncated: compatibilityPlan.truncated,
  }
}
