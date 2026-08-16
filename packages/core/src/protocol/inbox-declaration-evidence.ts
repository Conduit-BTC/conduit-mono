import {
  db,
  type DeclaredInboxDeclarationEventEvidence,
  type InboxDeclarationEventEvidence,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceState,
  type InboxDeclarationLookupCoverage,
  type InboxDeclarationLookupEvidence,
  type NormalizedInboxDeclarationPubkey,
} from "../db"
import { EVENT_KINDS } from "./kinds"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { normalizeSecureRelayUrls } from "./relay-settings"

export type {
  DeclaredInboxDeclarationEventEvidence,
  InboxDeclarationEventEvidence,
  InboxDeclarationEvidenceRecord,
  InboxDeclarationEvidenceState,
  InboxDeclarationLookupCoverage,
  InboxDeclarationLookupEvidence,
  NormalizedInboxDeclarationPubkey,
} from "../db"

const HEX_PUBKEY = /^[0-9a-f]{64}$/

export interface MergeInboxDeclarationEvidenceInput {
  pubkey: string
  signedEvent: SignedPublicNostrEvent
  sourceRelayUrls?: readonly string[]
  /** Local wall-clock observation time in milliseconds. */
  observedAt?: number
  /**
   * Local wall-clock time when the bounded discovery plan completed while
   * this exact event was the winning observed frontier.
   */
  completeObservedAt?: number
  /** Local persistence time in milliseconds. */
  cachedAt?: number
  /** Latest bounded network observation associated with this merge. */
  lookup?: {
    observedAt: number
    coverage: InboxDeclarationLookupCoverage
    hadEvent: boolean
    eventId?: string
  }
}

/**
 * The atomic persistence seam used by declaration discovery.
 *
 * Implementations must apply the NIP-01 replaceable frontier inside `merge`,
 * not as a separate read followed by a write.
 */
export interface InboxDeclarationEvidenceRepository {
  get(
    pubkey: NormalizedInboxDeclarationPubkey
  ): Promise<InboxDeclarationEvidenceRecord | undefined>
  merge(
    input: MergeInboxDeclarationEvidenceInput
  ): Promise<InboxDeclarationEvidenceRecord>
  /** Atomically merge a non-empty set of observations for one account. */
  mergeBatch(
    inputs: readonly MergeInboxDeclarationEvidenceInput[]
  ): Promise<InboxDeclarationEvidenceRecord>
}

export function normalizeInboxDeclarationEvidencePubkey(
  pubkey: string
): NormalizedInboxDeclarationPubkey | null {
  const normalized = pubkey.trim().toLowerCase()
  return HEX_PUBKEY.test(normalized)
    ? (normalized as NormalizedInboxDeclarationPubkey)
    : null
}

function cloneSignedEvent<T extends SignedPublicNostrEvent>(event: T): T {
  return structuredClone(event)
}

/** Return a mutation-safe copy suitable for route/read-state projection. */
export function cloneInboxDeclarationEventEvidence<
  T extends InboxDeclarationEventEvidence,
>(evidence: T): T {
  return structuredClone(evidence)
}

/** Return a mutation-safe copy suitable for route/read-state projection. */
export function cloneInboxDeclarationEvidenceRecord<
  T extends InboxDeclarationEvidenceRecord,
>(record: T): T {
  return structuredClone(record)
}

function assertLocalTimestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp`)
  }
  return value
}

function createLookupEvidence(
  input: MergeInboxDeclarationEvidenceInput["lookup"]
): InboxDeclarationLookupEvidence | undefined {
  if (!input) return undefined
  const observedAt = assertLocalTimestamp(
    input.observedAt,
    "Inbox declaration lookup observedAt"
  )
  if (input.eventId !== undefined && !/^[0-9a-f]{64}$/.test(input.eventId)) {
    throw new Error(
      "Inbox declaration lookup eventId must be canonical lowercase hex"
    )
  }
  if (!input.hadEvent && input.eventId !== undefined) {
    throw new Error(
      "Inbox declaration lookup without an event cannot include an eventId"
    )
  }
  return {
    observedAt,
    coverage: input.coverage,
    hadEvent: input.hadEvent,
    eventId: input.eventId,
  }
}

function assertValidDeclarationEvent(
  pubkey: NormalizedInboxDeclarationPubkey,
  event: SignedPublicNostrEvent
): void {
  if (!isValidSignedPublicNostrEvent(event)) {
    throw new Error("Inbox declaration evidence requires a valid signed event")
  }
  if (
    event.id !== event.id.toLowerCase() ||
    event.pubkey !== event.pubkey.toLowerCase() ||
    event.sig !== event.sig.toLowerCase()
  ) {
    throw new Error(
      "Inbox declaration evidence requires canonical lowercase hex"
    )
  }
  if (event.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) {
    throw new Error("Inbox declaration evidence requires a kind-10050 event")
  }
  if (event.pubkey !== pubkey) {
    throw new Error(
      "Inbox declaration evidence author does not match the account"
    )
  }
}

function createEventEvidence(
  input: MergeInboxDeclarationEvidenceInput,
  now: () => number
): {
  pubkey: NormalizedInboxDeclarationPubkey
  current: InboxDeclarationEventEvidence
  latestLookup?: InboxDeclarationLookupEvidence
  cachedAt: number
} {
  const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
  if (!pubkey) {
    throw new Error("Inbox declaration evidence requires a valid hex pubkey")
  }

  assertValidDeclarationEvent(pubkey, input.signedEvent)

  const relayTags = input.signedEvent.tags.filter((tag) => tag[0] === "relay")
  const secureRelayUrls = normalizeSecureRelayUrls(
    relayTags.map((tag) => tag[1] ?? "")
  )
  const state: InboxDeclarationEvidenceState =
    secureRelayUrls.length > 0
      ? "declared"
      : relayTags.length === 0
        ? "signed_empty"
        : "malformed"
  const observedAt = assertLocalTimestamp(
    input.observedAt ?? now(),
    "Inbox declaration observedAt"
  )
  const completeObservedAt =
    input.completeObservedAt === undefined
      ? undefined
      : assertLocalTimestamp(
          input.completeObservedAt,
          "Inbox declaration completeObservedAt"
        )
  if (completeObservedAt !== undefined && completeObservedAt > observedAt) {
    throw new Error(
      "Inbox declaration completeObservedAt cannot exceed observedAt"
    )
  }
  const cachedAt = assertLocalTimestamp(
    input.cachedAt ?? observedAt,
    "Inbox declaration cachedAt"
  )
  const sourceRelayUrls = normalizeSecureRelayUrls(input.sourceRelayUrls ?? [])
  const latestLookup = createLookupEvidence(input.lookup)
  const base = {
    signedEvent: cloneSignedEvent(input.signedEvent),
    sourceRelayUrls,
    observedAt,
    completeObservedAt,
  }

  if (state === "declared") {
    return {
      pubkey,
      current: { ...base, state, secureRelayUrls },
      latestLookup,
      cachedAt,
    }
  }

  return {
    pubkey,
    current: { ...base, state, secureRelayUrls: [] },
    latestLookup,
    cachedAt,
  }
}

function compareReplaceableFrontier(
  candidate: SignedPublicNostrEvent,
  current: SignedPublicNostrEvent
): -1 | 0 | 1 {
  if (candidate.created_at > current.created_at) return 1
  if (candidate.created_at < current.created_at) return -1
  if (candidate.id === current.id) return 0
  // NIP-01 retains the lexicographically lowest id at equal timestamps.
  return candidate.id < current.id ? 1 : -1
}

function mergeSourceRelayUrls(
  current: readonly string[],
  candidate: readonly string[]
): string[] {
  return normalizeSecureRelayUrls([...current, ...candidate]).sort()
}

function enrichSameEvent(
  existing: InboxDeclarationEvidenceRecord,
  candidate: InboxDeclarationEventEvidence,
  cachedAt: number
): InboxDeclarationEvidenceRecord {
  const observedAt = Math.max(existing.current.observedAt, candidate.observedAt)
  const completeObservedAt = Math.max(
    existing.current.completeObservedAt ?? 0,
    candidate.completeObservedAt ?? 0
  )
  const sourceRelayUrls = mergeSourceRelayUrls(
    existing.current.sourceRelayUrls,
    candidate.sourceRelayUrls
  )
  const current = {
    ...cloneInboxDeclarationEventEvidence(existing.current),
    sourceRelayUrls,
    observedAt,
    completeObservedAt: completeObservedAt || undefined,
  } as InboxDeclarationEventEvidence
  const lastUsable = existing.lastUsable
    ? cloneInboxDeclarationEventEvidence(existing.lastUsable)
    : undefined

  if (
    lastUsable &&
    lastUsable.signedEvent.id === existing.current.signedEvent.id
  ) {
    lastUsable.sourceRelayUrls = [...sourceRelayUrls]
    lastUsable.observedAt = observedAt
    lastUsable.completeObservedAt = completeObservedAt || undefined
  }

  return {
    pubkey: existing.pubkey,
    current,
    lastUsable,
    cachedAt: Math.max(existing.cachedAt, cachedAt),
  }
}

function mergeHistoricalUsableEvidence(
  existing: InboxDeclarationEvidenceRecord,
  candidate: ReturnType<typeof createEventEvidence>
): InboxDeclarationEvidenceRecord {
  if (
    existing.current.state === "declared" ||
    candidate.current.state !== "declared"
  ) {
    return cloneInboxDeclarationEvidenceRecord(existing)
  }

  const prior = existing.lastUsable
  let lastUsable: DeclaredInboxDeclarationEventEvidence
  if (!prior) {
    lastUsable = cloneInboxDeclarationEventEvidence(candidate.current)
  } else {
    const frontier = compareReplaceableFrontier(
      candidate.current.signedEvent,
      prior.signedEvent
    )
    if (frontier < 0) {
      lastUsable = cloneInboxDeclarationEventEvidence(prior)
    } else if (frontier > 0) {
      lastUsable = cloneInboxDeclarationEventEvidence(candidate.current)
    } else {
      lastUsable = {
        ...cloneInboxDeclarationEventEvidence(prior),
        sourceRelayUrls: mergeSourceRelayUrls(
          prior.sourceRelayUrls,
          candidate.current.sourceRelayUrls
        ),
        observedAt: Math.max(prior.observedAt, candidate.current.observedAt),
        completeObservedAt:
          Math.max(
            prior.completeObservedAt ?? 0,
            candidate.current.completeObservedAt ?? 0
          ) || undefined,
      }
    }
  }

  return {
    pubkey: existing.pubkey,
    current: cloneInboxDeclarationEventEvidence(existing.current),
    lastUsable,
    cachedAt: Math.max(existing.cachedAt, candidate.cachedAt),
  }
}

function applyEventEvidenceMerge(
  existing: InboxDeclarationEvidenceRecord | undefined,
  candidate: ReturnType<typeof createEventEvidence>
): InboxDeclarationEvidenceRecord {
  if (existing) {
    const frontier = compareReplaceableFrontier(
      candidate.current.signedEvent,
      existing.current.signedEvent
    )
    if (frontier < 0) {
      return mergeHistoricalUsableEvidence(existing, candidate)
    }
    if (frontier === 0) {
      return enrichSameEvent(existing, candidate.current, candidate.cachedAt)
    }
  }

  const current = cloneInboxDeclarationEventEvidence(candidate.current)
  let lastUsable: DeclaredInboxDeclarationEventEvidence | undefined
  if (current.state === "declared") {
    lastUsable = cloneInboxDeclarationEventEvidence(current)
  } else if (existing?.lastUsable) {
    lastUsable = cloneInboxDeclarationEventEvidence(existing.lastUsable)
  } else if (existing?.current.state === "declared") {
    lastUsable = cloneInboxDeclarationEventEvidence(existing.current)
  }

  return {
    pubkey: candidate.pubkey,
    current,
    lastUsable,
    cachedAt: candidate.cachedAt,
  }
}

function mergeLatestLookupEvidence(
  existing: InboxDeclarationLookupEvidence | undefined,
  candidate: InboxDeclarationLookupEvidence | undefined,
  currentEventId: string
): InboxDeclarationLookupEvidence | undefined {
  if (!candidate) return existing ? { ...existing } : undefined
  if (!existing) return { ...candidate }
  if (candidate.observedAt > existing.observedAt) return { ...candidate }
  if (candidate.observedAt < existing.observedAt) return { ...existing }

  // Equal wall-clock timestamps can occur across concurrent tabs. Preserve the
  // more conservative observation so exact evidence is never made fresh by
  // scheduling order alone.
  const confirmsCurrent = (lookup: InboxDeclarationLookupEvidence): boolean =>
    lookup.coverage === "complete" &&
    lookup.hadEvent &&
    lookup.eventId === currentEventId
  const existingConfirms = confirmsCurrent(existing)
  const candidateConfirms = confirmsCurrent(candidate)
  if (existingConfirms !== candidateConfirms) {
    return existingConfirms ? { ...candidate } : { ...existing }
  }
  const coverageRank: Record<InboxDeclarationLookupCoverage, number> = {
    complete: 0,
    partial: 1,
    unavailable: 2,
  }
  if (coverageRank[candidate.coverage] !== coverageRank[existing.coverage]) {
    return coverageRank[candidate.coverage] > coverageRank[existing.coverage]
      ? { ...candidate }
      : { ...existing }
  }
  if (candidate.hadEvent !== existing.hadEvent) {
    return candidate.hadEvent ? { ...existing } : { ...candidate }
  }
  return (candidate.eventId ?? "") < (existing.eventId ?? "")
    ? { ...candidate }
    : { ...existing }
}

function applyEvidenceMerge(
  existing: InboxDeclarationEvidenceRecord | undefined,
  candidate: ReturnType<typeof createEventEvidence>
): InboxDeclarationEvidenceRecord {
  const merged = applyEventEvidenceMerge(existing, candidate)
  const latestLookup = mergeLatestLookupEvidence(
    existing?.latestLookup,
    candidate.latestLookup,
    merged.current.signedEvent.id
  )
  return {
    ...merged,
    latestLookup,
    cachedAt: Math.max(existing?.cachedAt ?? 0, candidate.cachedAt),
  }
}

/**
 * Pure validated merge for memory-only fallback when durable storage is
 * unavailable. Production repositories call the same frontier reducer.
 */
export function applyInboxDeclarationEvidenceMerge(
  existing: InboxDeclarationEvidenceRecord | undefined,
  input: MergeInboxDeclarationEvidenceInput,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  return applyEvidenceMerge(existing, createEventEvidence(input, now))
}

function createMergeCandidates(
  inputs: readonly MergeInboxDeclarationEvidenceInput[],
  now: () => number
): Array<ReturnType<typeof createEventEvidence>> {
  if (inputs.length === 0) {
    throw new Error("Inbox declaration evidence batch cannot be empty")
  }
  const candidates = inputs.map((input) => createEventEvidence(input, now))
  const pubkey = candidates[0]!.pubkey
  if (candidates.some((candidate) => candidate.pubkey !== pubkey)) {
    throw new Error("Inbox declaration evidence batch must target one account")
  }
  return candidates
}

function createDexieRepository(
  now: () => number = Date.now
): InboxDeclarationEvidenceRepository {
  const mergeBatch = async (
    inputs: readonly MergeInboxDeclarationEvidenceInput[]
  ): Promise<InboxDeclarationEvidenceRecord> => {
    const candidates = createMergeCandidates(inputs, now)
    return db.transaction("rw", db.inboxDeclarationEvidence, async () => {
      const existing = await db.inboxDeclarationEvidence.get(
        candidates[0]!.pubkey
      )
      let finalRecord = existing
      for (const candidate of candidates) {
        finalRecord = applyEvidenceMerge(finalRecord, candidate)
      }
      if (
        !existing ||
        JSON.stringify(existing) !== JSON.stringify(finalRecord!)
      ) {
        await db.inboxDeclarationEvidence.put(
          cloneInboxDeclarationEvidenceRecord(finalRecord!)
        )
      }
      return cloneInboxDeclarationEvidenceRecord(finalRecord!)
    })
  }

  return {
    async get(pubkey) {
      const record = await db.inboxDeclarationEvidence.get(pubkey)
      return record ? cloneInboxDeclarationEvidenceRecord(record) : undefined
    },

    merge: (input) => mergeBatch([input]),
    mergeBatch,
  }
}

/** Production repository backed by the account-scoped Dexie v11 table. */
export const dexieInboxDeclarationEvidenceRepository = createDexieRepository()

/**
 * Deterministic repository for tests and non-browser adapters.
 * All reads and writes are cloned to model IndexedDB's structured-clone edge.
 */
export function createInMemoryInboxDeclarationEvidenceRepository(
  initial: readonly InboxDeclarationEvidenceRecord[] = [],
  now: () => number = Date.now
): InboxDeclarationEvidenceRepository {
  const records = new Map<
    NormalizedInboxDeclarationPubkey,
    InboxDeclarationEvidenceRecord
  >(
    initial.map((record) => [
      record.pubkey,
      cloneInboxDeclarationEvidenceRecord(record),
    ])
  )

  const mergeBatch = async (
    inputs: readonly MergeInboxDeclarationEvidenceInput[]
  ): Promise<InboxDeclarationEvidenceRecord> => {
    const candidates = createMergeCandidates(inputs, now)
    const pubkey = candidates[0]!.pubkey
    let merged = records.get(pubkey)
    for (const candidate of candidates) {
      merged = applyEvidenceMerge(merged, candidate)
    }
    records.set(pubkey, cloneInboxDeclarationEvidenceRecord(merged!))
    return cloneInboxDeclarationEvidenceRecord(merged!)
  }

  return {
    async get(pubkey) {
      const record = records.get(pubkey)
      return record ? cloneInboxDeclarationEvidenceRecord(record) : undefined
    },

    merge: (input) => mergeBatch([input]),
    mergeBatch,
  }
}

export async function getInboxDeclarationEvidence(
  pubkey: string,
  repository: InboxDeclarationEvidenceRepository = dexieInboxDeclarationEvidenceRepository
): Promise<InboxDeclarationEvidenceRecord | null> {
  const normalized = normalizeInboxDeclarationEvidencePubkey(pubkey)
  if (!normalized) return null
  const record = await repository.get(normalized)
  return record ? cloneInboxDeclarationEvidenceRecord(record) : null
}

export async function mergeInboxDeclarationEvidence(
  input: MergeInboxDeclarationEvidenceInput,
  repository: InboxDeclarationEvidenceRepository = dexieInboxDeclarationEvidenceRepository
): Promise<InboxDeclarationEvidenceRecord> {
  const record = await repository.merge(input)
  return cloneInboxDeclarationEvidenceRecord(record)
}

/** Atomically merge a non-empty declaration observation batch. */
export async function mergeInboxDeclarationEvidenceBatch(
  inputs: readonly MergeInboxDeclarationEvidenceInput[],
  repository: InboxDeclarationEvidenceRepository = dexieInboxDeclarationEvidenceRepository
): Promise<InboxDeclarationEvidenceRecord> {
  const record = await repository.mergeBatch(inputs)
  return cloneInboxDeclarationEvidenceRecord(record)
}
