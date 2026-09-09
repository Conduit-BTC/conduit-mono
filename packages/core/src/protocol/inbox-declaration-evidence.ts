import {
  db,
  type DeclaredInboxDeclarationEventEvidence,
  type InboxDeclarationEventEvidence,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceState,
  type InboxDeclarationCutoverRecovery,
  type InboxDeclarationLookupCoverage,
  type InboxDeclarationLookupEvidence,
  type NetworkPreferenceRelayOutcome,
  type NormalizedInboxDeclarationPubkey,
  type PendingInboxDeclarationDistribution,
} from "../db"
import { EVENT_KINDS } from "./kinds"
import {
  applyNetworkPreferenceDistributionOutcomes,
  hasCompletedExactNetworkPreferenceReadback,
  type NetworkPreferenceDistributionOutcomeUpdate,
} from "./network-preference-delivery"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"

export type {
  DeclaredInboxDeclarationEventEvidence,
  InboxDeclarationEventEvidence,
  InboxDeclarationEvidenceRecord,
  InboxDeclarationEvidenceState,
  InboxDeclarationCutoverRecovery,
  InboxDeclarationLookupCoverage,
  InboxDeclarationLookupEvidence,
  NormalizedInboxDeclarationPubkey,
  NetworkPreferenceRelayOutcome,
  PendingInboxDeclarationDistribution,
} from "../db"

const HEX_PUBKEY = /^[0-9a-f]{64}$/
export const INBOX_DECLARATION_CUTOVER_POLICY_VERSION = 1
export const INBOX_DECLARATION_CUTOVER_GRACE_MS = 7 * 24 * 60 * 60 * 1_000

export interface MergeInboxDeclarationEvidenceInput {
  pubkey: string
  signedEvent: SignedPublicNostrEvent
  sourceRelayUrls?: readonly string[]
  /** Shared discovery sources that returned this exact signed event. */
  sharedSourceRelayUrls?: readonly string[]
  /** Existing exact pending work carried across process/durable reconciliation. */
  pendingDistribution?: PendingInboxDeclarationDistribution
  /** Existing ordinary cutover recovery carried with the current frontier. */
  cutoverRecovery?: InboxDeclarationCutoverRecovery
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

export interface StageInboxDeclarationDistributionInput {
  pubkey: string
  signedEvent: SignedPublicNostrEvent
  publishRelayUrls: readonly string[]
  relayOutcomes?: readonly NetworkPreferenceRelayOutcome[]
  /** Prior usable inboxes retained read-only until exact shared readback + grace. */
  previousRelayUrls?: readonly string[]
  /** Whole-relay exclusions terminate matching recovery at the local commit. */
  excludedRelayUrls?: readonly string[]
  cutoverPolicyVersion?: number
  cutoverGraceMs?: number
  /** Durable frontier observed before signing; null means no retained row. */
  expectedCurrentEventId: string | null
  /** Local wall-clock time when the exact event became restart-durable. */
  stagedAt?: number
  /** Local persistence time in milliseconds. */
  cachedAt?: number
}

export class InboxDeclarationDistributionConflictError extends Error {
  readonly code = "staged_event_lost_frontier" as const

  constructor() {
    super(
      "A newer inbox declaration was retained before this signed event could be staged"
    )
    this.name = "InboxDeclarationDistributionConflictError"
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

export interface InboxDeclarationDistributionRepository extends InboxDeclarationEvidenceRepository {
  /** Atomically persist an exact signed event and immutable publish plan. */
  stageDistribution(
    input: StageInboxDeclarationDistributionInput
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

interface InboxDeclarationEvidenceCandidate {
  pubkey: NormalizedInboxDeclarationPubkey
  current: InboxDeclarationEventEvidence
  pendingDistribution?: PendingInboxDeclarationDistribution
  cutoverRecovery?: InboxDeclarationCutoverRecovery
  latestLookup?: InboxDeclarationLookupEvidence
  cachedAt: number
}

function createEventEvidence(
  input: MergeInboxDeclarationEvidenceInput,
  now: () => number,
  pendingInput?: StageInboxDeclarationDistributionInput
): InboxDeclarationEvidenceCandidate {
  const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
  if (!pubkey) {
    throw new Error("Inbox declaration evidence requires a valid hex pubkey")
  }

  assertValidDeclarationEvent(pubkey, input.signedEvent)

  const relayTags = input.signedEvent.tags.filter((tag) => tag[0] === "relay")
  const secureRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
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
  const sourceRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    input.sourceRelayUrls ?? []
  )
  const sharedSourceRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    input.sharedSourceRelayUrls ?? []
  )
  const sourceRelayUrlSet = new Set(sourceRelayUrls)
  if (sharedSourceRelayUrls.some((url) => !sourceRelayUrlSet.has(url))) {
    throw new Error(
      "Inbox declaration shared sources must also be event source relays"
    )
  }
  const latestLookup = createLookupEvidence(input.lookup)
  const base = {
    signedEvent: cloneSignedEvent(input.signedEvent),
    sourceRelayUrls,
    sharedSourceRelayUrls,
    observedAt,
    completeObservedAt,
  }
  let pendingDistribution: PendingInboxDeclarationDistribution | undefined
  let cutoverRecovery = normalizeCutoverRecovery(
    input.cutoverRecovery,
    input.signedEvent.id
  )
  const requestedPending = pendingInput ?? input.pendingDistribution
  if (requestedPending) {
    if (state !== "declared") {
      throw new Error(
        "Pending inbox declaration distribution requires usable relay tags"
      )
    }
    if (
      !areSameSignedInboxDeclarationEvent(
        requestedPending.signedEvent,
        input.signedEvent
      )
    ) {
      throw new Error(
        "Pending inbox declaration distribution must match its signed frontier"
      )
    }
    const publishRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
      requestedPending.publishRelayUrls
    )
    if (publishRelayUrls.length === 0) {
      throw new Error(
        "Pending inbox declaration distribution requires secure publish targets"
      )
    }
    if (
      input.pendingDistribution &&
      !sameOrderedStrings(
        input.pendingDistribution.publishRelayUrls,
        publishRelayUrls
      )
    ) {
      throw new Error(
        "Retained pending inbox declaration targets must remain canonical and ordered"
      )
    }
    pendingDistribution = {
      signedEvent: cloneSignedEvent(input.signedEvent),
      publishRelayUrls,
      ...(requestedPending.relayOutcomes
        ? {
            relayOutcomes: normalizeRelayOutcomes(
              publishRelayUrls,
              requestedPending.relayOutcomes
            ),
          }
        : {}),
      stagedAt: assertLocalTimestamp(
        requestedPending.stagedAt ?? now(),
        "Inbox declaration distribution stagedAt"
      ),
    }
    if (pendingInput?.previousRelayUrls) {
      const excluded = new Set(
        normalizeSecureOrIsolatedE2eRelayUrls(
          pendingInput.excludedRelayUrls ?? []
        )
      )
      const currentRelayUrls = new Set(secureRelayUrls)
      const relayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
        pendingInput.previousRelayUrls
      ).filter(
        (relayUrl) => !currentRelayUrls.has(relayUrl) && !excluded.has(relayUrl)
      )
      if (relayUrls.length > 0) {
        const policyVersion = assertPositiveInteger(
          pendingInput.cutoverPolicyVersion,
          "Inbox cutover policy version"
        )
        const graceMs = assertPositiveInteger(
          pendingInput.cutoverGraceMs,
          "Inbox cutover grace"
        )
        if (graceMs !== cutoverGraceMsForPolicyVersion(policyVersion)) {
          throw new Error(
            "Inbox cutover grace does not match its durable policy version"
          )
        }
        cutoverRecovery = {
          policyVersion,
          replacementEventId: input.signedEvent.id,
          relayUrls,
        }
      }
    }
  }

  if (state === "declared") {
    return {
      pubkey,
      current: { ...base, state, secureRelayUrls },
      pendingDistribution,
      cutoverRecovery,
      latestLookup,
      cachedAt,
    }
  }

  return {
    pubkey,
    current: { ...base, state, secureRelayUrls: [] },
    pendingDistribution,
    cutoverRecovery,
    latestLookup,
    cachedAt,
  }
}

function assertPositiveInteger(
  value: number | undefined,
  label: string
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value!
}

function cutoverGraceMsForPolicyVersion(policyVersion: number): number {
  if (policyVersion !== INBOX_DECLARATION_CUTOVER_POLICY_VERSION) {
    throw new Error("Inbox cutover policy version is unsupported")
  }
  return INBOX_DECLARATION_CUTOVER_GRACE_MS
}

function normalizeRelayOutcomes(
  publishRelayUrls: readonly string[],
  outcomes: readonly NetworkPreferenceRelayOutcome[]
): NetworkPreferenceRelayOutcome[] {
  if (outcomes.length !== publishRelayUrls.length) {
    throw new Error(
      "Inbox declaration outcomes must match the immutable publish plan"
    )
  }
  const publishStatuses = new Set(["pending", "acked", "rejected", "timed_out"])
  const readbackStatuses = new Set([
    "pending",
    "observed",
    "absent",
    "timed_out",
  ])
  return outcomes.map((outcome, index) => {
    const relayUrl = normalizeSecureOrIsolatedE2eRelayUrls([
      outcome.relayUrl,
    ])[0]
    if (
      !relayUrl ||
      relayUrl !== publishRelayUrls[index] ||
      !publishStatuses.has(outcome.publishStatus) ||
      !readbackStatuses.has(outcome.readbackStatus) ||
      !Number.isSafeInteger(outcome.publishAttemptCount) ||
      outcome.publishAttemptCount < 0 ||
      !Number.isSafeInteger(outcome.readbackAttemptCount) ||
      outcome.readbackAttemptCount < 0
    ) {
      throw new Error("Inbox declaration outcomes are invalid")
    }
    for (const [value, label] of [
      [outcome.publishAttemptedAt, "publishAttemptedAt"],
      [outcome.readbackAttemptedAt, "readbackAttemptedAt"],
      [outcome.observedAt, "observedAt"],
    ] as const) {
      if (value !== undefined) assertLocalTimestamp(value, label)
    }
    return { ...outcome, relayUrl }
  })
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
  return normalizeSecureOrIsolatedE2eRelayUrls([
    ...current,
    ...candidate,
  ]).sort()
}

function maxOptionalTimestamp(
  current: number | undefined,
  candidate: number | undefined
): number | undefined {
  return current === undefined && candidate === undefined
    ? undefined
    : Math.max(current ?? 0, candidate ?? 0)
}

function hasSharedConfirmation(
  evidence: InboxDeclarationEventEvidence
): boolean {
  return (evidence.sharedSourceRelayUrls?.length ?? 0) > 0
}

function pendingForCurrent(
  pending: PendingInboxDeclarationDistribution | undefined,
  currentEventId: string
): PendingInboxDeclarationDistribution | undefined {
  return pending?.signedEvent.id === currentEventId
    ? structuredClone(pending)
    : undefined
}

function selectEarlierPendingDistribution(
  existing: PendingInboxDeclarationDistribution | undefined,
  candidate: PendingInboxDeclarationDistribution | undefined,
  currentEventId: string
): PendingInboxDeclarationDistribution | undefined {
  const left = pendingForCurrent(existing, currentEventId)
  const right = pendingForCurrent(candidate, currentEventId)
  if (!left) return right
  if (!right) return left
  if (left.stagedAt !== right.stagedAt) {
    return left.stagedAt < right.stagedAt ? left : right
  }
  return JSON.stringify(left.publishRelayUrls) <=
    JSON.stringify(right.publishRelayUrls)
    ? left
    : right
}

function normalizeCutoverRecovery(
  recovery: InboxDeclarationCutoverRecovery | undefined,
  currentEventId: string
): InboxDeclarationCutoverRecovery | undefined {
  if (!recovery) return undefined
  if (
    recovery.replacementEventId !== currentEventId ||
    !/^[0-9a-f]{64}$/.test(recovery.replacementEventId)
  ) {
    return undefined
  }
  const relayUrls = normalizeSecureOrIsolatedE2eRelayUrls(recovery.relayUrls)
  if (relayUrls.length === 0) return undefined
  const policyVersion = assertPositiveInteger(
    recovery.policyVersion,
    "Inbox cutover policy version"
  )
  const graceMs = cutoverGraceMsForPolicyVersion(policyVersion)
  const readbackObservedAt =
    recovery.readbackObservedAt === undefined
      ? undefined
      : assertLocalTimestamp(
          recovery.readbackObservedAt,
          "Inbox cutover readbackObservedAt"
        )
  const expiresAt =
    recovery.expiresAt === undefined
      ? undefined
      : assertLocalTimestamp(recovery.expiresAt, "Inbox cutover expiresAt")
  if (
    (readbackObservedAt === undefined) !== (expiresAt === undefined) ||
    (readbackObservedAt !== undefined &&
      expiresAt !== readbackObservedAt + graceMs)
  ) {
    throw new Error("Inbox cutover expiry must follow exact shared readback")
  }
  return {
    policyVersion,
    replacementEventId: recovery.replacementEventId,
    relayUrls,
    ...(readbackObservedAt === undefined
      ? {}
      : { readbackObservedAt, expiresAt }),
  }
}

function mergeCutoverRecovery(input: {
  existing?: InboxDeclarationCutoverRecovery
  candidate?: InboxDeclarationCutoverRecovery
  current: InboxDeclarationEventEvidence
  exactSharedSetReadbackCompleted: boolean
  candidateObservedAt: number
}): InboxDeclarationCutoverRecovery | undefined {
  const recovery = normalizeCutoverRecovery(
    input.candidate ?? input.existing,
    input.current.signedEvent.id
  )
  if (!recovery || recovery.readbackObservedAt !== undefined) return recovery
  if (!input.exactSharedSetReadbackCompleted) return recovery
  return {
    ...recovery,
    readbackObservedAt: input.candidateObservedAt,
    expiresAt:
      input.candidateObservedAt +
      cutoverGraceMsForPolicyVersion(recovery.policyVersion),
  }
}

function completesExactPendingReadback(
  pending: PendingInboxDeclarationDistribution | undefined,
  candidate: InboxDeclarationEvidenceCandidate
): boolean {
  if (!pending) return false
  if (
    pending.relayOutcomes &&
    hasCompletedExactNetworkPreferenceReadback(pending.relayOutcomes)
  ) {
    return true
  }
  if (candidate.current.completeObservedAt === undefined) return false
  const exactSharedSources = new Set(
    candidate.current.sharedSourceRelayUrls ?? []
  )
  return pending.publishRelayUrls.every((relayUrl) =>
    exactSharedSources.has(relayUrl)
  )
}

function enrichSameEvent(
  existing: InboxDeclarationEvidenceRecord,
  candidate: InboxDeclarationEvidenceCandidate
): InboxDeclarationEvidenceRecord {
  const observedAt = Math.max(
    existing.current.observedAt,
    candidate.current.observedAt
  )
  const completeObservedAt = maxOptionalTimestamp(
    existing.current.completeObservedAt,
    candidate.current.completeObservedAt
  )
  const sourceRelayUrls = mergeSourceRelayUrls(
    existing.current.sourceRelayUrls,
    candidate.current.sourceRelayUrls
  )
  const sharedSourceRelayUrls = mergeSourceRelayUrls(
    existing.current.sharedSourceRelayUrls ?? [],
    candidate.current.sharedSourceRelayUrls ?? []
  )
  const current = {
    ...cloneInboxDeclarationEventEvidence(existing.current),
    sourceRelayUrls,
    sharedSourceRelayUrls,
    observedAt,
    completeObservedAt,
  } as InboxDeclarationEventEvidence
  let lastUsable = existing.lastUsable
    ? cloneInboxDeclarationEventEvidence(existing.lastUsable)
    : undefined
  const selectedPending = selectEarlierPendingDistribution(
    existing.pendingDistribution,
    candidate.pendingDistribution,
    current.signedEvent.id
  )
  const exactSharedSetReadbackCompleted = completesExactPendingReadback(
    selectedPending,
    candidate
  )
  // An explicit same-event redistribution can begin after earlier shared
  // evidence already exists. Its new immutable plan remains pending until its
  // own tracked readback completes; historical provenance cannot complete it.
  const pendingDistribution =
    exactSharedSetReadbackCompleted ? undefined : selectedPending
  // The event id commits to the body but not to its Schnorr signature. When
  // concurrent copies retain different valid signatures for the same body,
  // the staged distribution bytes are the restart contract and therefore own
  // the canonical current representation until shared confirmation clears it.
  if (pendingDistribution) {
    current.signedEvent = cloneSignedEvent(pendingDistribution.signedEvent)
  }

  if (
    lastUsable &&
    lastUsable.signedEvent.id === existing.current.signedEvent.id
  ) {
    lastUsable.sourceRelayUrls = [...sourceRelayUrls]
    lastUsable.sharedSourceRelayUrls = [...sharedSourceRelayUrls]
    lastUsable.observedAt = observedAt
    lastUsable.completeObservedAt = completeObservedAt
  }
  if (current.state === "declared" && hasSharedConfirmation(current)) {
    lastUsable = cloneInboxDeclarationEventEvidence(current)
  }
  const cutoverRecovery = mergeCutoverRecovery({
    existing: existing.cutoverRecovery,
    candidate: candidate.cutoverRecovery,
    current,
    exactSharedSetReadbackCompleted,
    candidateObservedAt: candidate.current.observedAt,
  })

  return {
    pubkey: existing.pubkey,
    current,
    lastUsable,
    pendingDistribution,
    cutoverRecovery,
    cachedAt: Math.max(existing.cachedAt, candidate.cachedAt),
  }
}

function mergeHistoricalUsableEvidence(
  existing: InboxDeclarationEvidenceRecord,
  candidate: InboxDeclarationEvidenceCandidate
): InboxDeclarationEvidenceRecord {
  const existingCurrentPending = Boolean(
    pendingForCurrent(
      existing.pendingDistribution,
      existing.current.signedEvent.id
    )
  )
  if (
    (existing.current.state === "declared" && !existingCurrentPending) ||
    candidate.current.state !== "declared" ||
    candidate.pendingDistribution
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
        sharedSourceRelayUrls: mergeSourceRelayUrls(
          prior.sharedSourceRelayUrls ?? [],
          candidate.current.sharedSourceRelayUrls ?? []
        ),
        observedAt: Math.max(prior.observedAt, candidate.current.observedAt),
        completeObservedAt: maxOptionalTimestamp(
          prior.completeObservedAt,
          candidate.current.completeObservedAt
        ),
      }
    }
  }

  return {
    pubkey: existing.pubkey,
    current: cloneInboxDeclarationEventEvidence(existing.current),
    lastUsable,
    pendingDistribution: pendingForCurrent(
      existing.pendingDistribution,
      existing.current.signedEvent.id
    ),
    cutoverRecovery: normalizeCutoverRecovery(
      existing.cutoverRecovery,
      existing.current.signedEvent.id
    ),
    cachedAt: Math.max(existing.cachedAt, candidate.cachedAt),
  }
}

function applyEventEvidenceMerge(
  existing: InboxDeclarationEvidenceRecord | undefined,
  candidate: InboxDeclarationEvidenceCandidate
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
      return enrichSameEvent(existing, candidate)
    }
  }

  const current = cloneInboxDeclarationEventEvidence(candidate.current)
  const selectedPending = pendingForCurrent(
    candidate.pendingDistribution,
    current.signedEvent.id
  )
  const exactSharedSetReadbackCompleted = completesExactPendingReadback(
    selectedPending,
    candidate
  )
  const pendingDistribution = exactSharedSetReadbackCompleted
    ? undefined
    : selectedPending
  let lastUsable: DeclaredInboxDeclarationEventEvidence | undefined
  if (current.state === "declared" && !pendingDistribution) {
    lastUsable = cloneInboxDeclarationEventEvidence(current)
  } else if (existing?.lastUsable) {
    lastUsable = cloneInboxDeclarationEventEvidence(existing.lastUsable)
  } else if (
    existing?.current.state === "declared" &&
    !pendingForCurrent(
      existing.pendingDistribution,
      existing.current.signedEvent.id
    )
  ) {
    lastUsable = cloneInboxDeclarationEventEvidence(existing.current)
  }
  const cutoverRecovery = mergeCutoverRecovery({
    existing: undefined,
    candidate: candidate.cutoverRecovery,
    current,
    exactSharedSetReadbackCompleted,
    candidateObservedAt: candidate.current.observedAt,
  })

  return {
    pubkey: candidate.pubkey,
    current,
    lastUsable,
    pendingDistribution,
    cutoverRecovery,
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
  candidate: InboxDeclarationEvidenceCandidate
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

function createStagedCandidate(
  input: StageInboxDeclarationDistributionInput,
  now: () => number
): InboxDeclarationEvidenceCandidate {
  const stagedAt = input.stagedAt ?? now()
  return createEventEvidence(
    {
      pubkey: input.pubkey,
      signedEvent: input.signedEvent,
      sourceRelayUrls: [],
      sharedSourceRelayUrls: [],
      observedAt: stagedAt,
      cachedAt: input.cachedAt ?? stagedAt,
    },
    now,
    { ...input, stagedAt }
  )
}

function requireExpectedDistributionFrontier(
  existing: InboxDeclarationEvidenceRecord | undefined,
  expectedCurrentEventId: string | null
): void {
  const currentEventId = existing?.current.signedEvent.id ?? null
  if (currentEventId !== expectedCurrentEventId) {
    throw new InboxDeclarationDistributionConflictError()
  }
}

function requireStagedCandidateWon(
  record: InboxDeclarationEvidenceRecord,
  candidate: InboxDeclarationEvidenceCandidate
): void {
  const pending = candidate.pendingDistribution
  if (
    !pending ||
    !areSameSignedInboxDeclarationEvent(
      record.current.signedEvent,
      candidate.current.signedEvent
    ) ||
    !areSameSignedInboxDeclarationEvent(
      record.pendingDistribution?.signedEvent,
      pending.signedEvent
    ) ||
    !sameOrderedStrings(
      record.pendingDistribution?.publishRelayUrls,
      pending.publishRelayUrls
    )
  ) {
    throw new InboxDeclarationDistributionConflictError()
  }
}

/** Pure per-kind stage used by the cross-kind account transaction. */
export function applyInboxDeclarationDistributionStage(
  existing: InboxDeclarationEvidenceRecord | undefined,
  input: StageInboxDeclarationDistributionInput,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  const candidate = createStagedCandidate(input, now)
  requireExpectedDistributionFrontier(existing, input.expectedCurrentEventId)
  const merged = applyEvidenceMerge(existing, candidate)
  requireStagedCandidateWon(merged, candidate)
  return cloneInboxDeclarationEvidenceRecord(merged)
}

/** Apply retry evidence while retaining the exact staged bytes and plan. */
export function applyInboxDeclarationDistributionOutcomes(
  existing: InboxDeclarationEvidenceRecord,
  update: NetworkPreferenceDistributionOutcomeUpdate
): InboxDeclarationEvidenceRecord {
  const pending = existing.pendingDistribution
  if (!pending?.relayOutcomes) {
    throw new Error("Inbox declaration distribution outcomes are not pending")
  }
  const relayOutcomes = applyNetworkPreferenceDistributionOutcomes(
    pending.relayOutcomes,
    update
  )
  const exactSourceRelayUrls = relayOutcomes.flatMap((outcome) =>
    outcome.readbackStatus === "observed" ? [outcome.relayUrl] : []
  )
  const completed = hasCompletedExactNetworkPreferenceReadback(relayOutcomes)
  const retained = cloneInboxDeclarationEvidenceRecord(existing)
  retained.pendingDistribution = {
    ...pending,
    relayOutcomes,
  }
  return applyEvidenceMerge(
    retained,
    createEventEvidence(
      {
        pubkey: retained.pubkey,
        signedEvent: pending.signedEvent,
        sourceRelayUrls: exactSourceRelayUrls,
        sharedSourceRelayUrls: completed ? exactSourceRelayUrls : [],
        observedAt: update.observedAt,
        ...(completed ? { completeObservedAt: update.observedAt } : {}),
        cachedAt: update.observedAt,
        lookup: {
          observedAt: update.observedAt,
          coverage: completed
            ? "complete"
            : exactSourceRelayUrls.length > 0
              ? "partial"
              : "unavailable",
          hadEvent: exactSourceRelayUrls.length > 0,
          ...(exactSourceRelayUrls.length > 0
            ? { eventId: pending.signedEvent.id }
            : {}),
        },
      },
      Date.now
    )
  )
}

/** Remove whole-setup exclusions from the ordinary cutover recovery lane. */
export function applyInboxDeclarationCutoverExclusions(
  record: InboxDeclarationEvidenceRecord,
  excludedRelayUrls: readonly string[]
): InboxDeclarationEvidenceRecord {
  const excluded = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(excludedRelayUrls)
  )
  const recovery = normalizeCutoverRecovery(
    record.cutoverRecovery,
    record.current.signedEvent.id
  )
  if (!recovery || excluded.size === 0) {
    return cloneInboxDeclarationEvidenceRecord(record)
  }
  const relayUrls = recovery.relayUrls.filter(
    (relayUrl) => !excluded.has(relayUrl)
  )
  const next = cloneInboxDeclarationEvidenceRecord(record)
  if (relayUrls.length === 0) delete next.cutoverRecovery
  else next.cutoverRecovery = { ...recovery, relayUrls }
  return next
}

/** Read-only cutover relays whose exact-readback grace has not expired. */
export function getActiveInboxCutoverRecoveryRelayUrls(
  record: InboxDeclarationEvidenceRecord | null | undefined,
  now: number = Date.now()
): string[] {
  if (!record?.cutoverRecovery) return []
  const recovery = normalizeCutoverRecovery(
    record.cutoverRecovery,
    record.current.signedEvent.id
  )
  if (!recovery) return []
  if (recovery.expiresAt !== undefined && now >= recovery.expiresAt) return []
  return [...recovery.relayUrls]
}

export function areSameSignedInboxDeclarationEvent(
  left: SignedPublicNostrEvent | undefined,
  right: SignedPublicNostrEvent | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.pubkey === right.pubkey &&
    left.created_at === right.created_at &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.sig === right.sig &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  )
}

function sameOrderedStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function createDexieRepository(
  now: () => number = Date.now
): InboxDeclarationDistributionRepository {
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

  const stageDistribution = async (
    input: StageInboxDeclarationDistributionInput
  ): Promise<InboxDeclarationEvidenceRecord> => {
    const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
    if (!pubkey) {
      throw new Error("Inbox declaration evidence requires a valid hex pubkey")
    }
    return db.transaction("rw", db.inboxDeclarationEvidence, async () => {
      const existing = await db.inboxDeclarationEvidence.get(pubkey)
      const finalRecord = applyInboxDeclarationDistributionStage(
        existing,
        input,
        now
      )
      if (
        !existing ||
        JSON.stringify(existing) !== JSON.stringify(finalRecord)
      ) {
        await db.inboxDeclarationEvidence.put(
          cloneInboxDeclarationEvidenceRecord(finalRecord)
        )
      }
      return cloneInboxDeclarationEvidenceRecord(finalRecord)
    })
  }

  return {
    async get(pubkey) {
      const record = await db.inboxDeclarationEvidence.get(pubkey)
      return record ? cloneInboxDeclarationEvidenceRecord(record) : undefined
    },

    merge: (input) => mergeBatch([input]),
    mergeBatch,
    stageDistribution,
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
): InboxDeclarationDistributionRepository {
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

  const stageDistribution = async (
    input: StageInboxDeclarationDistributionInput
  ): Promise<InboxDeclarationEvidenceRecord> => {
    const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
    if (!pubkey) {
      throw new Error("Inbox declaration evidence requires a valid hex pubkey")
    }
    const existing = records.get(pubkey)
    const merged = applyInboxDeclarationDistributionStage(existing, input, now)
    records.set(pubkey, cloneInboxDeclarationEvidenceRecord(merged))
    return cloneInboxDeclarationEvidenceRecord(merged)
  }

  return {
    async get(pubkey) {
      const record = records.get(pubkey)
      return record ? cloneInboxDeclarationEvidenceRecord(record) : undefined
    },

    merge: (input) => mergeBatch([input]),
    mergeBatch,
    stageDistribution,
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

/** Persist exact signed work before its first network delivery attempt. */
export async function stageInboxDeclarationDistribution(
  input: StageInboxDeclarationDistributionInput,
  repository: InboxDeclarationDistributionRepository = dexieInboxDeclarationEvidenceRepository
): Promise<InboxDeclarationEvidenceRecord> {
  const record = await repository.stageDistribution(input)
  return cloneInboxDeclarationEvidenceRecord(record)
}
