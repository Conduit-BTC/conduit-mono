import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import {
  db,
  type NormalizedOwnerRelayListPubkey,
  type OwnerRelayListEvidenceRecord,
  type OwnerRelayListEventEvidence,
  type OwnerRelayListLookupCoverage,
  type OwnerRelayListLookupEvidence,
} from "../db"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanoutWithDiagnostics,
  getEventSourceRelayUrls,
  type FetchEventsFanoutDiagnosticsResult,
} from "./ndk"
import {
  normalizePublicOrIsolatedE2eRelayHints,
  tryNormalizeRelayUrl,
  type RelayPreference,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type {
  NormalizedOwnerRelayListPubkey,
  OwnerRelayListEvidenceRecord,
  OwnerRelayListEventEvidence,
  OwnerRelayListEvidenceState,
  OwnerRelayListLookupCoverage,
  OwnerRelayListLookupEvidence,
} from "../db"

const HEX_PUBKEY = /^[0-9a-f]{64}$/
const MAX_OWNER_NETWORK_DISCOVERY_RELAYS = 8
const OWNER_RELAY_LIST_FETCH_LIMIT = 10

export interface OwnerRelayListEventObservation {
  signedEvent: SignedPublicNostrEvent
  sourceRelayUrls?: readonly string[]
  observedAt?: number
  completeObservedAt?: number
}

export interface ReconcileOwnerRelayListEvidenceInput {
  pubkey: string
  observations?: readonly OwnerRelayListEventObservation[]
  lookup: {
    observedAt: number
    coverage: OwnerRelayListLookupCoverage
    hadEvent: boolean
    eventId?: string
  }
  cachedAt?: number
}

export interface OwnerRelayListEvidenceRepository {
  get(
    pubkey: NormalizedOwnerRelayListPubkey
  ): Promise<OwnerRelayListEvidenceRecord | undefined>
  reconcile(
    input: ReconcileOwnerRelayListEvidenceInput
  ): Promise<OwnerRelayListEvidenceRecord>
}

export type OwnerRelayListResolutionState =
  | "declared"
  | "signed_empty"
  | "malformed"
  | "not_observed"
  | "lookup_partial"
  | "lookup_unavailable"

export interface OwnerRelayListObservation {
  coverage: OwnerRelayListLookupCoverage
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  cappedRelayUrls: string[]
  eventId?: string
  eventSourceRelayUrls: string[]
}

export interface OwnerRelayListResolution {
  pubkey: NormalizedOwnerRelayListPubkey
  state: OwnerRelayListResolutionState
  preferences: RelayPreference[]
  stale: boolean
  current?: OwnerRelayListEventEvidence
  lookup: OwnerRelayListLookupEvidence
  observation: OwnerRelayListObservation
}

export interface ResolveOwnerRelayListOptions {
  relayUrls?: readonly string[]
  fetchEventsWithDiagnostics?: typeof fetchEventsFanoutWithDiagnostics
  evidenceRepository?: OwnerRelayListEvidenceRepository
  now?: () => number
}

interface ParsedRelayPreferences {
  preferences: RelayPreference[]
  relayTagCount: number
  invalidRelayTagCount: number
  duplicateRelayTagCount: number
}

const processEvidence = new Map<
  NormalizedOwnerRelayListPubkey,
  OwnerRelayListEvidenceRecord
>()
const reconciliationTails = new Map<string, Promise<void>>()

export function normalizeOwnerRelayListPubkey(
  pubkey: string
): NormalizedOwnerRelayListPubkey | null {
  const normalized = pubkey.trim().toLowerCase()
  return HEX_PUBKEY.test(normalized)
    ? (normalized as NormalizedOwnerRelayListPubkey)
    : null
}

function cloneRecord(
  record: OwnerRelayListEvidenceRecord
): OwnerRelayListEvidenceRecord {
  return structuredClone(record)
}

function assertTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`)
  }
  return value
}

function normalizeSourceRelayUrls(urls: readonly string[]): string[] {
  return normalizePublicOrIsolatedE2eRelayHints(urls).sort()
}

function parseOwnerRelayPreferences(
  tags: readonly string[][]
): ParsedRelayPreferences {
  const byUrl = new Map<string, RelayPreference>()
  let relayTagCount = 0
  let invalidRelayTagCount = 0
  let duplicateRelayTagCount = 0

  for (const tag of tags) {
    if (tag[0] !== "r") continue
    relayTagCount += 1
    if (typeof tag[1] !== "string" || !tag[1].trim()) {
      invalidRelayTagCount += 1
      continue
    }
    const normalized = tryNormalizeRelayUrl(tag[1])
    if (!normalized.ok) {
      invalidRelayTagCount += 1
      continue
    }

    const marker = tag[2]?.trim().toLowerCase()
    if (marker && marker !== "read" && marker !== "write") {
      invalidRelayTagCount += 1
      continue
    }
    const readEnabled = marker !== "write"
    const writeEnabled = marker !== "read"
    const existing = byUrl.get(normalized.url)
    if (existing) duplicateRelayTagCount += 1
    byUrl.set(normalized.url, {
      url: normalized.url,
      readEnabled: (existing?.readEnabled ?? false) || readEnabled,
      writeEnabled: (existing?.writeEnabled ?? false) || writeEnabled,
    })
  }

  return {
    preferences: Array.from(byUrl.values()),
    relayTagCount,
    invalidRelayTagCount,
    duplicateRelayTagCount,
  }
}

/**
 * Project the same signed kind-10002 role semantics used by durable owner
 * evidence. Signed-empty and wholly malformed lists are authoritative empty
 * projections; usable valid tags remain available when sibling tags are bad.
 */
export function projectOwnerRelayPreferencesFromSignedTags(
  tags: readonly string[][]
): RelayPreference[] {
  const parsed = parseOwnerRelayPreferences(tags)
  return parsed.preferences.length > 0
    ? structuredClone(parsed.preferences)
    : []
}

function assertOwnerRelayListEvent(
  pubkey: NormalizedOwnerRelayListPubkey,
  event: SignedPublicNostrEvent
): void {
  if (!isValidSignedPublicNostrEvent(event)) {
    throw new Error("Owner relay-list evidence requires a valid signed event")
  }
  if (
    event.id !== event.id.toLowerCase() ||
    event.pubkey !== event.pubkey.toLowerCase() ||
    event.sig !== event.sig.toLowerCase()
  ) {
    throw new Error(
      "Owner relay-list evidence requires canonical lowercase hex"
    )
  }
  if (event.kind !== EVENT_KINDS.RELAY_LIST) {
    throw new Error("Owner relay-list evidence requires a kind-10002 event")
  }
  if (event.pubkey !== pubkey) {
    throw new Error("Owner relay-list evidence author does not match account")
  }
}

function eventEvidenceFromObservation(
  pubkey: NormalizedOwnerRelayListPubkey,
  observation: OwnerRelayListEventObservation,
  now: () => number
): OwnerRelayListEventEvidence {
  assertOwnerRelayListEvent(pubkey, observation.signedEvent)
  const parsed = parseOwnerRelayPreferences(observation.signedEvent.tags)
  const observedAt = assertTimestamp(
    observation.observedAt ?? now(),
    "Owner relay-list observedAt"
  )
  const completeObservedAt =
    observation.completeObservedAt === undefined
      ? undefined
      : assertTimestamp(
          observation.completeObservedAt,
          "Owner relay-list completeObservedAt"
        )
  return {
    state:
      parsed.preferences.length > 0
        ? "declared"
        : parsed.relayTagCount === 0
          ? "signed_empty"
          : "malformed",
    signedEvent: structuredClone(observation.signedEvent),
    preferences: parsed.preferences,
    sourceRelayUrls: normalizeSourceRelayUrls(
      observation.sourceRelayUrls ?? []
    ),
    observedAt,
    completeObservedAt,
    invalidRelayTagCount: parsed.invalidRelayTagCount,
    duplicateRelayTagCount: parsed.duplicateRelayTagCount,
  }
}

function compareReplaceableFrontier(
  candidate: SignedPublicNostrEvent,
  current: SignedPublicNostrEvent
): -1 | 0 | 1 {
  if (candidate.created_at > current.created_at) return 1
  if (candidate.created_at < current.created_at) return -1
  if (candidate.id === current.id) return 0
  return candidate.id < current.id ? 1 : -1
}

function mergeSameEvent(
  current: OwnerRelayListEventEvidence,
  candidate: OwnerRelayListEventEvidence
): OwnerRelayListEventEvidence {
  return {
    ...structuredClone(current),
    sourceRelayUrls: normalizeSourceRelayUrls([
      ...current.sourceRelayUrls,
      ...candidate.sourceRelayUrls,
    ]),
    observedAt: Math.max(current.observedAt, candidate.observedAt),
    completeObservedAt:
      current.completeObservedAt === undefined &&
      candidate.completeObservedAt === undefined
        ? undefined
        : Math.max(
            current.completeObservedAt ?? 0,
            candidate.completeObservedAt ?? 0
          ),
  }
}

function mergeEventEvidence(
  current: OwnerRelayListEventEvidence | undefined,
  candidate: OwnerRelayListEventEvidence
): OwnerRelayListEventEvidence {
  if (!current) return structuredClone(candidate)
  const comparison = compareReplaceableFrontier(
    candidate.signedEvent,
    current.signedEvent
  )
  if (comparison < 0) return structuredClone(current)
  if (comparison === 0) return mergeSameEvent(current, candidate)
  return structuredClone(candidate)
}

function createLookupEvidence(
  input: ReconcileOwnerRelayListEvidenceInput["lookup"]
): OwnerRelayListLookupEvidence {
  const observedAt = assertTimestamp(
    input.observedAt,
    "Owner relay-list lookup observedAt"
  )
  if (input.eventId !== undefined && !/^[0-9a-f]{64}$/.test(input.eventId)) {
    throw new Error(
      "Owner relay-list lookup eventId must be canonical lowercase hex"
    )
  }
  if (!input.hadEvent && input.eventId !== undefined) {
    throw new Error(
      "Owner relay-list lookup without an event cannot include an eventId"
    )
  }
  return { ...input, observedAt }
}

function mergeLookupEvidence(
  current: OwnerRelayListLookupEvidence | undefined,
  candidate: OwnerRelayListLookupEvidence,
  currentEventId: string | undefined
): OwnerRelayListLookupEvidence {
  if (!current) return { ...candidate }
  if (candidate.observedAt > current.observedAt) return { ...candidate }
  if (candidate.observedAt < current.observedAt) return { ...current }

  const confirmsCurrent = (lookup: OwnerRelayListLookupEvidence): boolean =>
    lookup.coverage === "complete" &&
    lookup.hadEvent &&
    lookup.eventId === currentEventId
  const currentConfirms = confirmsCurrent(current)
  const candidateConfirms = confirmsCurrent(candidate)
  if (currentConfirms !== candidateConfirms) {
    return currentConfirms ? { ...candidate } : { ...current }
  }
  const rank: Record<OwnerRelayListLookupCoverage, number> = {
    complete: 0,
    partial: 1,
    unavailable: 2,
  }
  if (rank[candidate.coverage] !== rank[current.coverage]) {
    return rank[candidate.coverage] > rank[current.coverage]
      ? { ...candidate }
      : { ...current }
  }
  if (candidate.hadEvent !== current.hadEvent) {
    return candidate.hadEvent ? { ...current } : { ...candidate }
  }
  return (candidate.eventId ?? "") < (current.eventId ?? "")
    ? { ...candidate }
    : { ...current }
}

function validateRetainedRecord(
  record: OwnerRelayListEvidenceRecord,
  pubkey: NormalizedOwnerRelayListPubkey,
  now: () => number
): OwnerRelayListEvidenceRecord {
  if (record.pubkey !== pubkey) {
    throw new Error("Owner relay-list reconciliation cannot cross accounts")
  }
  const current = record.current
    ? eventEvidenceFromObservation(
        pubkey,
        {
          signedEvent: record.current.signedEvent,
          sourceRelayUrls: record.current.sourceRelayUrls,
          observedAt: record.current.observedAt,
          completeObservedAt: record.current.completeObservedAt,
        },
        now
      )
    : undefined
  return {
    pubkey,
    current,
    latestLookup: createLookupEvidence(record.latestLookup),
    cachedAt: assertTimestamp(record.cachedAt, "Owner relay-list cachedAt"),
  }
}

export function applyOwnerRelayListEvidenceReconciliation(
  existing: OwnerRelayListEvidenceRecord | undefined,
  input: ReconcileOwnerRelayListEvidenceInput,
  now: () => number = Date.now
): OwnerRelayListEvidenceRecord {
  const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
  if (!pubkey) {
    throw new Error("Owner relay-list evidence requires a valid hex pubkey")
  }
  const retained = existing
    ? validateRetainedRecord(existing, pubkey, now)
    : undefined
  const lookup = createLookupEvidence(input.lookup)
  let current = retained?.current
    ? structuredClone(retained.current)
    : undefined
  for (const observation of input.observations ?? []) {
    current = mergeEventEvidence(
      current,
      eventEvidenceFromObservation(pubkey, observation, now)
    )
  }
  const latestLookup = mergeLookupEvidence(
    retained?.latestLookup,
    lookup,
    current?.signedEvent.id
  )
  return {
    pubkey,
    current,
    latestLookup,
    cachedAt: Math.max(
      retained?.cachedAt ?? 0,
      assertTimestamp(
        input.cachedAt ?? lookup.observedAt,
        "Owner relay-list cachedAt"
      )
    ),
  }
}

function applyRepositoryReconciliation(
  existing: OwnerRelayListEvidenceRecord | undefined,
  input: ReconcileOwnerRelayListEvidenceInput
): OwnerRelayListEvidenceRecord {
  try {
    return applyOwnerRelayListEvidenceReconciliation(existing, input)
  } catch (error) {
    if (!existing) throw error
    // A valid newly observed signed frontier may repair a corrupted local row.
    // Re-validate the input from scratch; invalid input still throws here.
    return applyOwnerRelayListEvidenceReconciliation(undefined, input)
  }
}

function createDexieRepository(): OwnerRelayListEvidenceRepository {
  return {
    async get(pubkey) {
      const record = await db.ownerRelayListEvidence.get(pubkey)
      return record ? cloneRecord(record) : undefined
    },
    async reconcile(input) {
      const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
      if (!pubkey) {
        throw new Error("Owner relay-list evidence requires a valid hex pubkey")
      }
      return await db.transaction("rw", db.ownerRelayListEvidence, async () => {
        const existing = await db.ownerRelayListEvidence.get(pubkey)
        const record = applyRepositoryReconciliation(existing, input)
        if (!existing || JSON.stringify(existing) !== JSON.stringify(record)) {
          await db.ownerRelayListEvidence.put(cloneRecord(record))
        }
        return cloneRecord(record)
      })
    },
  }
}

export const dexieOwnerRelayListEvidenceRepository = createDexieRepository()

export function createInMemoryOwnerRelayListEvidenceRepository(
  initial: readonly OwnerRelayListEvidenceRecord[] = []
): OwnerRelayListEvidenceRepository {
  const records = new Map(
    initial.map((record) => [record.pubkey, cloneRecord(record)] as const)
  )
  return {
    async get(pubkey) {
      const record = records.get(pubkey)
      return record ? cloneRecord(record) : undefined
    },
    async reconcile(input) {
      const pubkey = normalizeOwnerRelayListPubkey(input.pubkey)
      if (!pubkey) {
        throw new Error("Owner relay-list evidence requires a valid hex pubkey")
      }
      const record = applyRepositoryReconciliation(records.get(pubkey), input)
      records.set(pubkey, cloneRecord(record))
      return cloneRecord(record)
    },
  }
}

async function withReconciliationLock<T>(
  pubkey: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = reconciliationTails.get(pubkey) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  reconciliationTails.set(pubkey, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (reconciliationTails.get(pubkey) === tail) {
      reconciliationTails.delete(pubkey)
    }
  }
}

function recordObservation(
  record: OwnerRelayListEvidenceRecord | undefined
): OwnerRelayListEventObservation[] {
  if (!record?.current) return []
  return [
    {
      signedEvent: record.current.signedEvent,
      sourceRelayUrls: record.current.sourceRelayUrls,
      observedAt: record.current.observedAt,
      completeObservedAt: record.current.completeObservedAt,
    },
  ]
}

function mergeEvidenceRecords(
  current: OwnerRelayListEvidenceRecord | undefined,
  candidate: OwnerRelayListEvidenceRecord
): OwnerRelayListEvidenceRecord {
  return applyOwnerRelayListEvidenceReconciliation(current, {
    pubkey: candidate.pubkey,
    observations: recordObservation(candidate),
    lookup: candidate.latestLookup,
    cachedAt: candidate.cachedAt,
  })
}

export async function getOwnerRelayListEvidence(
  pubkey: string,
  repository: OwnerRelayListEvidenceRepository = dexieOwnerRelayListEvidenceRepository
): Promise<OwnerRelayListEvidenceRecord | null> {
  const normalized = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalized) return null
  let durable: OwnerRelayListEvidenceRecord | undefined
  try {
    durable = await repository.get(normalized)
  } catch {
    // IndexedDB may be unavailable; process evidence remains usable.
    durable = undefined
  }
  const process = processEvidence.get(normalized)
  let merged: OwnerRelayListEvidenceRecord | undefined
  try {
    merged = durable
      ? mergeEvidenceRecords(process, durable)
      : process
        ? cloneRecord(process)
        : undefined
  } catch {
    // Ignore a malformed persisted row instead of projecting unverified data.
    merged = process ? cloneRecord(process) : undefined
  }
  if (merged) processEvidence.set(normalized, cloneRecord(merged))
  return merged ? cloneRecord(merged) : null
}

export async function reconcileOwnerRelayListEvidence(
  input: ReconcileOwnerRelayListEvidenceInput,
  repository: OwnerRelayListEvidenceRepository = dexieOwnerRelayListEvidenceRepository
): Promise<OwnerRelayListEvidenceRecord> {
  const normalized = normalizeOwnerRelayListPubkey(input.pubkey)
  if (!normalized) {
    throw new Error("Owner relay-list evidence requires a valid hex pubkey")
  }
  return await withReconciliationLock(normalized, async () => {
    const process = processEvidence.get(normalized)
    let baseline = process ? cloneRecord(process) : undefined
    try {
      const readableDurable = await repository.get(normalized)
      if (readableDurable) {
        baseline = mergeEvidenceRecords(baseline, readableDurable)
      }
    } catch {
      // A missing or malformed durable row cannot displace valid process
      // evidence. The transactional reconcile below may still repair it.
    }
    const durableInput: ReconcileOwnerRelayListEvidenceInput = {
      ...input,
      pubkey: normalized,
      observations: [
        ...recordObservation(baseline),
        ...(input.observations ?? []),
      ],
    }
    let record: OwnerRelayListEvidenceRecord
    try {
      const durable = await repository.reconcile(durableInput)
      record = baseline ? mergeEvidenceRecords(baseline, durable) : durable
    } catch {
      record = applyOwnerRelayListEvidenceReconciliation(baseline, input)
    }
    processEvidence.set(normalized, cloneRecord(record))
    return cloneRecord(record)
  })
}

export function accountNetworkDiscoveryRelayUrls(): string[] {
  return normalizePublicOrIsolatedE2eRelayHints([
    ...config.dmDeclarationDiscoveryRelayUrls,
    ...config.defaultRelays,
  ]).slice(0, MAX_OWNER_NETWORK_DISCOVERY_RELAYS)
}

function normalizeDiagnostics(
  result: FetchEventsFanoutDiagnosticsResult,
  plannedRelayUrls: readonly string[]
): FetchEventsFanoutDiagnosticsResult {
  const planned = normalizePublicOrIsolatedE2eRelayHints(plannedRelayUrls)
  const plannedSet = new Set(planned)
  const attemptedSet = new Set(
    normalizePublicOrIsolatedE2eRelayHints([
      ...result.attemptedRelayUrls,
      ...result.successfulRelayUrls,
      ...result.failedRelayUrls,
    ]).filter((url) => plannedSet.has(url))
  )
  const successfulSet = new Set(
    normalizePublicOrIsolatedE2eRelayHints(result.successfulRelayUrls).filter(
      (url) => plannedSet.has(url)
    )
  )
  const failedSet = new Set(
    normalizePublicOrIsolatedE2eRelayHints(result.failedRelayUrls).filter(
      (url) => plannedSet.has(url)
    )
  )
  for (const relayUrl of planned) {
    if (!attemptedSet.has(relayUrl)) failedSet.add(relayUrl)
  }
  return {
    events: result.events,
    attemptedRelayUrls: planned.filter((url) => attemptedSet.has(url)),
    successfulRelayUrls: planned.filter((url) => successfulSet.has(url)),
    failedRelayUrls: planned.filter((url) => failedSet.has(url)),
    cappedRelayUrls: normalizePublicOrIsolatedE2eRelayHints(
      result.cappedRelayUrls ?? []
    ).filter((url) => plannedSet.has(url)),
  }
}

function deriveCoverage(
  result: FetchEventsFanoutDiagnosticsResult,
  plannedRelayUrls: readonly string[]
): OwnerRelayListLookupCoverage {
  if (result.successfulRelayUrls.length === 0) return "unavailable"
  const successful = new Set(result.successfulRelayUrls)
  const failed = new Set(result.failedRelayUrls)
  const capped = new Set(result.cappedRelayUrls ?? [])
  return plannedRelayUrls.length > 0 &&
    plannedRelayUrls.every(
      (url) => successful.has(url) && !failed.has(url) && !capped.has(url)
    )
    ? "complete"
    : "partial"
}

function toSignedOwnerRelayListEvent(
  event: NDKEvent,
  pubkey: NormalizedOwnerRelayListPubkey
): SignedPublicNostrEvent | null {
  try {
    if (!event.sig) return null
    const signed: SignedPublicNostrEvent = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at ?? 0,
      kind: event.kind ?? 0,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    }
    return signed.pubkey === pubkey &&
      signed.kind === EVENT_KINDS.RELAY_LIST &&
      signed.id === signed.id.toLowerCase() &&
      signed.pubkey === signed.pubkey.toLowerCase() &&
      signed.sig === signed.sig.toLowerCase() &&
      isValidSignedPublicNostrEvent(signed)
      ? signed
      : null
  } catch {
    return null
  }
}

function newestEvent(
  events: readonly SignedPublicNostrEvent[]
): SignedPublicNostrEvent | undefined {
  return [...events].sort((left, right) => {
    const createdAt = right.created_at - left.created_at
    return createdAt !== 0 ? createdAt : left.id.localeCompare(right.id)
  })[0]
}

function eventSourceRelayUrls(
  event: NDKEvent,
  successfulRelayUrls: readonly string[]
): string[] {
  const successful = new Set(normalizeSourceRelayUrls(successfulRelayUrls))
  return normalizeSourceRelayUrls(getEventSourceRelayUrls(event)).filter(
    (url) => successful.has(url)
  )
}

function resolutionFromRecord(
  record: OwnerRelayListEvidenceRecord,
  observation: OwnerRelayListObservation
): OwnerRelayListResolution {
  const current = record.current
  const confirmsCurrent = Boolean(
    current &&
    record.latestLookup.coverage === "complete" &&
    record.latestLookup.hadEvent &&
    record.latestLookup.eventId === current.signedEvent.id
  )
  const state: OwnerRelayListResolutionState = current
    ? current.state
    : record.latestLookup.coverage === "complete"
      ? "not_observed"
      : record.latestLookup.coverage === "partial"
        ? "lookup_partial"
        : "lookup_unavailable"
  return {
    pubkey: record.pubkey,
    state,
    preferences:
      current?.state === "declared" ? structuredClone(current.preferences) : [],
    stale: Boolean(current && !confirmsCurrent),
    current: current ? structuredClone(current) : undefined,
    lookup: { ...record.latestLookup },
    observation,
  }
}

export async function resolveOwnerRelayList(
  pubkey: string,
  options: ResolveOwnerRelayListOptions = {}
): Promise<OwnerRelayListResolution> {
  const normalized = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalized) throw new Error("Owner relay-list lookup requires a pubkey")
  const now = options.now ?? Date.now
  const observedAt = now()
  const relayUrls = normalizePublicOrIsolatedE2eRelayHints(
    options.relayUrls ?? accountNetworkDiscoveryRelayUrls()
  )
  const fetchEvents =
    options.fetchEventsWithDiagnostics ?? fetchEventsFanoutWithDiagnostics
  let result: FetchEventsFanoutDiagnosticsResult
  if (relayUrls.length === 0) {
    result = {
      events: [],
      attemptedRelayUrls: [],
      successfulRelayUrls: [],
      failedRelayUrls: [],
      cappedRelayUrls: [],
    }
  } else {
    try {
      result = await fetchEvents(
        {
          kinds: [EVENT_KINDS.RELAY_LIST],
          authors: [normalized],
          limit: OWNER_RELAY_LIST_FETCH_LIMIT,
        },
        {
          relayUrls,
          connectTimeoutMs: 4_000,
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
        cappedRelayUrls: [],
      }
    }
  }
  result = normalizeDiagnostics(result, relayUrls)
  const coverage = deriveCoverage(result, relayUrls)
  const signedById = new Map<string, SignedPublicNostrEvent>()
  const sourceRelayUrlsById = new Map<string, string[]>()
  for (const event of result.events) {
    if (
      event.kind !== EVENT_KINDS.RELAY_LIST ||
      event.pubkey?.trim().toLowerCase() !== normalized
    ) {
      continue
    }
    const signed = toSignedOwnerRelayListEvent(event, normalized)
    if (!signed) continue
    signedById.set(signed.id, signed)
    sourceRelayUrlsById.set(
      signed.id,
      eventSourceRelayUrls(event, result.successfulRelayUrls)
    )
  }
  const signedEvents = Array.from(signedById.values())
  const newest = newestEvent(signedEvents)
  const observations: OwnerRelayListEventObservation[] = signedEvents.map(
    (signedEvent) => ({
      signedEvent,
      sourceRelayUrls: sourceRelayUrlsById.get(signedEvent.id) ?? [],
      observedAt,
      completeObservedAt:
        coverage === "complete" && newest?.id === signedEvent.id
          ? observedAt
          : undefined,
    })
  )
  const record = await reconcileOwnerRelayListEvidence(
    {
      pubkey: normalized,
      observations,
      lookup: {
        observedAt,
        coverage,
        hadEvent: Boolean(newest),
        eventId: newest?.id,
      },
      cachedAt: observedAt,
    },
    options.evidenceRepository
  )
  const observation: OwnerRelayListObservation = {
    coverage,
    attemptedRelayUrls: [...result.attemptedRelayUrls],
    successfulRelayUrls: [...result.successfulRelayUrls],
    failedRelayUrls: [...result.failedRelayUrls],
    cappedRelayUrls: [...(result.cappedRelayUrls ?? [])],
    eventId: newest?.id,
    eventSourceRelayUrls: newest
      ? [...(sourceRelayUrlsById.get(newest.id) ?? [])]
      : [],
  }
  return resolutionFromRecord(record, observation)
}

export function __resetOwnerRelayListEvidenceForTests(): void {
  processEvidence.clear()
  reconciliationTails.clear()
}
