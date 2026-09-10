import {
  db,
  type DeclaredInboxDeclarationEventEvidence,
  type InboxDeclarationEventEvidence,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceState,
  type InboxDeclarationCutoverConfirmationAttempt,
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
  type NetworkPreferenceReadbackObservation,
} from "./network-preference-delivery"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  tryNormalizeRelayUrl,
} from "./relay-settings"

export type {
  DeclaredInboxDeclarationEventEvidence,
  InboxDeclarationEventEvidence,
  InboxDeclarationEvidenceRecord,
  InboxDeclarationEvidenceState,
  InboxDeclarationCutoverConfirmationAttempt,
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
  /** Canonical shared subset whose exact readback starts this cutover's grace. */
  confirmationRelayUrls?: readonly string[]
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

export interface RestageInboxDeclarationDistributionInput {
  pubkey: string
  signedEvent: SignedPublicNostrEvent
  expectedPublishRelayUrls: readonly string[]
  publishRelayUrls: readonly string[]
  relayOutcomes?: readonly NetworkPreferenceRelayOutcome[]
  /** Local wall-clock time when the replacement plan became restart-durable. */
  stagedAt?: number
  /** Local persistence time in milliseconds. */
  cachedAt?: number
}

export interface RecordInboxDeclarationCutoverRecoveryReadbackInput {
  pubkey: string
  replacementEventId: string
  replacementEventSig: string
  readback: readonly NetworkPreferenceReadbackObservation[]
  observedAt: number
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
  /** Atomically update readback on an existing locally planned recovery batch. */
  recordCutoverRecoveryReadback(
    input: RecordInboxDeclarationCutoverRecoveryReadbackInput
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

/**
 * Canonicalize durable evidence without granting relay-I/O authority. Every
 * executor still applies its source-aware admission rule before connecting.
 */
function normalizeRetainedRelayUrls(relayUrls: readonly string[]): string[] {
  return normalizeOwnerSelectedRelayUrls(relayUrls)
}

/** Return a mutation-safe copy suitable for route/read-state projection. */
export function cloneInboxDeclarationEventEvidence<
  T extends InboxDeclarationEventEvidence,
>(evidence: T): T {
  return structuredClone(evidence)
}

function assertCanonicalStoredEventEvidence(
  pubkey: NormalizedInboxDeclarationPubkey,
  evidence: InboxDeclarationEventEvidence
): void {
  assertValidDeclarationEvent(pubkey, evidence.signedEvent)
  const sourceRelayUrls = normalizeRetainedRelayUrls(evidence.sourceRelayUrls)
  if (!sameOrderedStrings(evidence.sourceRelayUrls, sourceRelayUrls)) {
    throw new Error(
      "Retained inbox declaration sources must remain canonical and ordered"
    )
  }
  const sharedSourceRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    evidence.sharedSourceRelayUrls ?? []
  )
  if (
    evidence.sharedSourceRelayUrls &&
    !sameOrderedStrings(evidence.sharedSourceRelayUrls, sharedSourceRelayUrls)
  ) {
    throw new Error(
      "Retained shared inbox declaration sources must remain canonical and ordered"
    )
  }
  const sourceRelayUrlSet = new Set(sourceRelayUrls)
  if (
    sharedSourceRelayUrls.some((relayUrl) => !sourceRelayUrlSet.has(relayUrl))
  ) {
    throw new Error(
      "Retained shared inbox declaration sources must also be event sources"
    )
  }
  const observedAt = assertLocalTimestamp(
    evidence.observedAt,
    "Retained inbox declaration observedAt"
  )
  if (evidence.completeObservedAt !== undefined) {
    const completeObservedAt = assertLocalTimestamp(
      evidence.completeObservedAt,
      "Retained inbox declaration completeObservedAt"
    )
    if (completeObservedAt > observedAt) {
      throw new Error(
        "Retained inbox declaration completeObservedAt cannot exceed observedAt"
      )
    }
  }
}

/** Return a mutation-safe copy suitable for route/read-state projection. */
export function cloneInboxDeclarationEvidenceRecord<
  T extends InboxDeclarationEvidenceRecord,
>(record: T): T {
  const cloned = structuredClone(record)
  const pubkey = normalizeInboxDeclarationEvidencePubkey(cloned.pubkey)
  if (!pubkey || pubkey !== cloned.pubkey) {
    throw new Error(
      "Retained inbox declaration evidence requires a canonical account pubkey"
    )
  }
  assertCanonicalStoredEventEvidence(pubkey, cloned.current)
  if (cloned.lastUsable) {
    assertCanonicalStoredEventEvidence(pubkey, cloned.lastUsable)
    if (cloned.lastUsable.state !== "declared") {
      throw new Error(
        "Retained last-usable inbox declaration must remain declared"
      )
    }
  }
  cloned.cachedAt = assertLocalTimestamp(
    cloned.cachedAt,
    "Retained inbox declaration cachedAt"
  )
  if (cloned.latestLookup) {
    createLookupEvidence(cloned.latestLookup)
  }
  if (cloned.pendingDistribution) {
    if (
      !areSameSignedInboxDeclarationEvent(
        cloned.pendingDistribution.signedEvent,
        cloned.current.signedEvent
      )
    ) {
      throw new Error(
        "Pending inbox declaration distribution must match its signed frontier"
      )
    }
    const publishRelayUrls = normalizeRetainedRelayUrls(
      cloned.pendingDistribution.publishRelayUrls
    )
    if (
      publishRelayUrls.length === 0 ||
      !sameOrderedStrings(
        cloned.pendingDistribution.publishRelayUrls,
        publishRelayUrls
      )
    ) {
      throw new Error(
        "Retained pending inbox declaration targets must remain canonical and ordered"
      )
    }
    cloned.pendingDistribution.publishRelayUrls = publishRelayUrls
    if (cloned.pendingDistribution.confirmationRelayUrls) {
      cloned.pendingDistribution.confirmationRelayUrls =
        normalizeConfirmationRelayUrls(
          publishRelayUrls,
          cloned.pendingDistribution.confirmationRelayUrls
        )
    }
    if (cloned.pendingDistribution.relayOutcomes) {
      cloned.pendingDistribution.relayOutcomes = normalizeRelayOutcomes(
        publishRelayUrls,
        cloned.pendingDistribution.relayOutcomes
      )
    }
    cloned.pendingDistribution.stagedAt = assertLocalTimestamp(
      cloned.pendingDistribution.stagedAt,
      "Inbox declaration distribution stagedAt"
    )
  }
  const cutoverRecoveries = normalizeCutoverRecoveries({
    ...cloned,
    pendingDistribution: cloned.pendingDistribution,
  })
  const canonical = { ...cloned }
  delete canonical.cutoverRecovery
  delete canonical.cutoverRecoveries
  return {
    ...canonical,
    ...(cutoverRecoveries.length > 0 ? { cutoverRecoveries } : {}),
  } as T
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
  cutoverRecoveries?: InboxDeclarationCutoverRecovery[]
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
  // Preserve every syntactically valid signed declaration target as evidence.
  // Whether this account owns the declaration is decided by projection, and
  // source-aware executors never infer contact permission from this array.
  const secureRelayUrls = normalizeRetainedRelayUrls(
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
  const sourceRelayUrls = normalizeRetainedRelayUrls(
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
  let cutoverRecoveries: InboxDeclarationCutoverRecovery[] = []
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
    const publishRelayUrls = normalizeRetainedRelayUrls(
      requestedPending.publishRelayUrls
    )
    if (publishRelayUrls.length === 0) {
      throw new Error(
        "Pending inbox declaration distribution requires valid publish targets"
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
      ...(requestedPending.confirmationRelayUrls
        ? {
            confirmationRelayUrls: normalizeConfirmationRelayUrls(
              publishRelayUrls,
              requestedPending.confirmationRelayUrls
            ),
          }
        : {}),
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
        normalizeRetainedRelayUrls(pendingInput.excludedRelayUrls ?? [])
      )
      const currentRelayUrls = new Set(secureRelayUrls)
      const relayUrls = normalizeRetainedRelayUrls(
        pendingInput.previousRelayUrls
      ).filter((relayUrl) => !currentRelayUrls.has(relayUrl))
      if (relayUrls.length > 0) {
        const confirmationRelayUrls = normalizeConfirmationRelayUrls(
          publishRelayUrls,
          pendingInput.confirmationRelayUrls ?? publishRelayUrls
        )
        pendingDistribution.confirmationRelayUrls = confirmationRelayUrls
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
        cutoverRecoveries = mergeCutoverRecoveries(cutoverRecoveries, [
          {
            policyVersion,
            replacementEventId: input.signedEvent.id,
            relayUrls,
            replacementEventSig: input.signedEvent.sig,
            policyBlockedRelayUrls: relayUrls.filter((relayUrl) =>
              excluded.has(relayUrl)
            ),
            confirmationAttempts: [
              {
                relayUrls: confirmationRelayUrls,
                stagedAt: pendingDistribution.stagedAt,
              },
            ],
          },
        ])
      }
    }
  }

  if (state === "declared") {
    return {
      pubkey,
      current: { ...base, state, secureRelayUrls },
      pendingDistribution,
      ...(cutoverRecoveries.length > 0 ? { cutoverRecoveries } : {}),
      latestLookup,
      cachedAt,
    }
  }

  return {
    pubkey,
    current: { ...base, state, secureRelayUrls: [] },
    pendingDistribution,
    ...(cutoverRecoveries.length > 0 ? { cutoverRecoveries } : {}),
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

function normalizeConfirmationRelayUrls(
  publishRelayUrls: readonly string[],
  confirmationRelayUrls: readonly string[]
): string[] {
  const publishRelayUrlSet = new Set(publishRelayUrls)
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls(
    confirmationRelayUrls
  ).sort()
  if (
    normalized.length === 0 ||
    normalized.some((relayUrl) => !publishRelayUrlSet.has(relayUrl))
  ) {
    throw new Error(
      "Inbox cutover confirmation relays must be a non-empty subset of its publish plan"
    )
  }
  return normalized
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
    const normalizedRelayUrl = tryNormalizeRelayUrl(outcome.relayUrl)
    const relayUrl = normalizedRelayUrl.ok ? normalizedRelayUrl.url : undefined
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

function mergeRetainedSourceRelayUrls(
  current: readonly string[],
  candidate: readonly string[]
): string[] {
  return normalizeRetainedRelayUrls([...current, ...candidate]).sort()
}

function mergeSharedSourceRelayUrls(
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

function normalizedPendingConfirmationRelayUrls(
  pending: PendingInboxDeclarationDistribution
): string[] {
  return normalizeConfirmationRelayUrls(
    pending.publishRelayUrls,
    pending.confirmationRelayUrls ?? pending.publishRelayUrls
  )
}

function confirmationAttemptKey(relayUrls: readonly string[]): string {
  return JSON.stringify(relayUrls)
}

function normalizeConfirmationAttempt(
  attempt: InboxDeclarationCutoverConfirmationAttempt,
  matchingPending?: PendingInboxDeclarationDistribution
): InboxDeclarationCutoverConfirmationAttempt | undefined {
  const relayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    attempt.relayUrls
  ).sort()
  if (relayUrls.length === 0) return undefined
  const relayUrlSet = new Set(relayUrls)
  const pendingMatches = Boolean(
    matchingPending &&
    sameOrderedStrings(
      relayUrls,
      normalizedPendingConfirmationRelayUrls(matchingPending)
    )
  )
  const matchingOutcomes = pendingMatches
    ? (matchingPending?.relayOutcomes ?? [])
    : []
  const completedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls([
    ...(attempt.completedRelayUrls ?? []),
    ...matchingOutcomes.flatMap((outcome) =>
      relayUrlSet.has(outcome.relayUrl) &&
      (outcome.readbackStatus === "observed" ||
        outcome.readbackStatus === "absent")
        ? [outcome.relayUrl]
        : []
    ),
  ]).sort()
  const observedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls([
    ...(attempt.observedRelayUrls ?? []),
    ...matchingOutcomes.flatMap((outcome) =>
      relayUrlSet.has(outcome.relayUrl) && outcome.readbackStatus === "observed"
        ? [outcome.relayUrl]
        : []
    ),
  ]).sort()
  if (
    [...completedRelayUrls, ...observedRelayUrls].some(
      (relayUrl) => !relayUrlSet.has(relayUrl)
    ) ||
    observedRelayUrls.some((relayUrl) => !completedRelayUrls.includes(relayUrl))
  ) {
    throw new Error(
      "Inbox cutover confirmation must stay within its immutable relay set"
    )
  }
  const stagedAt =
    attempt.stagedAt === undefined
      ? undefined
      : assertLocalTimestamp(
          attempt.stagedAt,
          "Inbox cutover confirmation stagedAt"
        )
  return {
    relayUrls,
    ...(completedRelayUrls.length > 0 ? { completedRelayUrls } : {}),
    ...(observedRelayUrls.length > 0 ? { observedRelayUrls } : {}),
    ...(stagedAt !== undefined ? { stagedAt } : {}),
  }
}

function mergeConfirmationAttempts(
  attempts: readonly InboxDeclarationCutoverConfirmationAttempt[]
): InboxDeclarationCutoverConfirmationAttempt[] {
  const byPlan = new Map<string, InboxDeclarationCutoverConfirmationAttempt>()
  for (const attempt of attempts) {
    const key = confirmationAttemptKey(attempt.relayUrls)
    const retained = byPlan.get(key)
    if (!retained) {
      byPlan.set(key, structuredClone(attempt))
      continue
    }
    const completedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls([
      ...(retained.completedRelayUrls ?? []),
      ...(attempt.completedRelayUrls ?? []),
    ]).sort()
    const observedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls([
      ...(retained.observedRelayUrls ?? []),
      ...(attempt.observedRelayUrls ?? []),
    ]).sort()
    const stagedAt =
      retained.stagedAt === undefined
        ? attempt.stagedAt
        : attempt.stagedAt === undefined
          ? retained.stagedAt
          : Math.min(retained.stagedAt, attempt.stagedAt)
    byPlan.set(key, {
      relayUrls: [...retained.relayUrls],
      ...(completedRelayUrls.length > 0 ? { completedRelayUrls } : {}),
      ...(observedRelayUrls.length > 0 ? { observedRelayUrls } : {}),
      ...(stagedAt !== undefined ? { stagedAt } : {}),
    })
  }
  return [...byPlan.values()].sort((left, right) => {
    const staged = (left.stagedAt ?? 0) - (right.stagedAt ?? 0)
    return staged !== 0
      ? staged
      : confirmationAttemptKey(left.relayUrls).localeCompare(
          confirmationAttemptKey(right.relayUrls)
        )
  })
}

function normalizeCutoverRecovery(
  recovery: InboxDeclarationCutoverRecovery | undefined,
  pendingDistribution?: PendingInboxDeclarationDistribution
): InboxDeclarationCutoverRecovery | undefined {
  if (!recovery) return undefined
  if (!/^[0-9a-f]{64}$/.test(recovery.replacementEventId)) {
    return undefined
  }
  const relayUrls = normalizeRetainedRelayUrls(recovery.relayUrls).sort()
  if (relayUrls.length === 0) return undefined
  const matchingPending =
    pendingDistribution?.signedEvent.id === recovery.replacementEventId
      ? pendingDistribution
      : undefined
  const replacementEventSig =
    recovery.replacementEventSig ?? matchingPending?.signedEvent.sig
  if (
    replacementEventSig !== undefined &&
    !/^[0-9a-f]{128}$/.test(replacementEventSig)
  ) {
    throw new Error("Inbox cutover replacement signature is invalid")
  }
  const rawAttempts =
    recovery.confirmationAttempts ??
    (recovery.confirmationRelayUrls || matchingPending
      ? [
          {
            relayUrls:
              recovery.confirmationRelayUrls ??
              normalizedPendingConfirmationRelayUrls(matchingPending!),
            ...(recovery.completedRelayUrls
              ? { completedRelayUrls: recovery.completedRelayUrls }
              : {}),
            ...(recovery.observedRelayUrls
              ? { observedRelayUrls: recovery.observedRelayUrls }
              : {}),
            ...(matchingPending?.stagedAt !== undefined
              ? { stagedAt: matchingPending.stagedAt }
              : {}),
          },
        ]
      : [])
  const confirmationAttempts = mergeConfirmationAttempts(
    rawAttempts.flatMap((attempt) => {
      const normalized = normalizeConfirmationAttempt(attempt, matchingPending)
      return normalized ? [normalized] : []
    })
  )
  const policyBlockedRelayUrls = normalizeRetainedRelayUrls(
    recovery.policyBlockedRelayUrls ?? []
  ).sort()
  const historicalRelayUrlSet = new Set([
    ...relayUrls,
    ...confirmationAttempts.flatMap((attempt) => attempt.relayUrls),
  ])
  if (
    policyBlockedRelayUrls.some(
      (relayUrl) => !historicalRelayUrlSet.has(relayUrl)
    )
  ) {
    throw new Error(
      "Inbox cutover policy blocks must stay within immutable recovery evidence"
    )
  }
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
    ...(replacementEventSig ? { replacementEventSig } : {}),
    ...(confirmationAttempts.length > 0 ? { confirmationAttempts } : {}),
    ...(policyBlockedRelayUrls.length > 0 ? { policyBlockedRelayUrls } : {}),
    ...(readbackObservedAt === undefined
      ? {}
      : { readbackObservedAt, expiresAt }),
  }
}

function normalizeCutoverRecoveries(input: {
  cutoverRecoveries?: readonly InboxDeclarationCutoverRecovery[]
  cutoverRecovery?: InboxDeclarationCutoverRecovery
  pendingDistribution?: PendingInboxDeclarationDistribution
}): InboxDeclarationCutoverRecovery[] {
  const source =
    input.cutoverRecoveries !== undefined
      ? input.cutoverRecoveries
      : input.cutoverRecovery
        ? [input.cutoverRecovery]
        : []
  const byReplacement = new Map<string, InboxDeclarationCutoverRecovery>()
  for (const entry of source) {
    const recovery = normalizeCutoverRecovery(entry, input.pendingDistribution)
    if (!recovery) continue
    const retained = byReplacement.get(recovery.replacementEventId)
    if (!retained) {
      byReplacement.set(recovery.replacementEventId, recovery)
      continue
    }
    if (!sameOrderedStrings(retained.relayUrls, recovery.relayUrls)) {
      throw new Error(
        "Inbox cutover recovery relay set changed for one replacement"
      )
    }
    if (
      retained.replacementEventSig &&
      recovery.replacementEventSig &&
      retained.replacementEventSig !== recovery.replacementEventSig
    ) {
      throw new Error(
        "Inbox cutover replacement signature changed for one replacement"
      )
    }
    const replacementEventSig =
      retained.replacementEventSig ?? recovery.replacementEventSig
    const confirmationAttempts = mergeConfirmationAttempts([
      ...(retained.confirmationAttempts ?? []),
      ...(recovery.confirmationAttempts ?? []),
    ])
    const policyBlockedRelayUrls = normalizeRetainedRelayUrls([
      ...(retained.policyBlockedRelayUrls ?? []),
      ...(recovery.policyBlockedRelayUrls ?? []),
    ]).sort()
    const active = [retained, recovery]
      .filter((candidate) => candidate.readbackObservedAt !== undefined)
      .sort(
        (left, right) => left.readbackObservedAt! - right.readbackObservedAt!
      )[0]
    byReplacement.set(recovery.replacementEventId, {
      policyVersion: retained.policyVersion,
      replacementEventId: retained.replacementEventId,
      relayUrls: retained.relayUrls,
      ...(replacementEventSig ? { replacementEventSig } : {}),
      ...(confirmationAttempts.length > 0 ? { confirmationAttempts } : {}),
      ...(policyBlockedRelayUrls.length > 0 ? { policyBlockedRelayUrls } : {}),
      ...(active
        ? {
            readbackObservedAt: active.readbackObservedAt,
            expiresAt: active.expiresAt,
          }
        : {}),
    })
  }
  return [...byReplacement.values()].sort((left, right) =>
    left.replacementEventId.localeCompare(right.replacementEventId)
  )
}

function mergeCutoverRecoveries(
  existing: readonly InboxDeclarationCutoverRecovery[] | undefined,
  candidate: readonly InboxDeclarationCutoverRecovery[] | undefined
): InboxDeclarationCutoverRecovery[] {
  return normalizeCutoverRecoveries({
    cutoverRecoveries: [...(existing ?? []), ...(candidate ?? [])],
  })
}

function completeCutoverRecoveryReadback(input: {
  recoveries: readonly InboxDeclarationCutoverRecovery[]
  candidate: InboxDeclarationEvidenceCandidate
  pendingDistribution?: PendingInboxDeclarationDistribution
}): InboxDeclarationCutoverRecovery[] {
  return normalizeCutoverRecoveries({
    cutoverRecoveries: input.recoveries.map((recovery) => {
      if (
        recovery.replacementEventId !==
          input.candidate.current.signedEvent.id ||
        recovery.readbackObservedAt !== undefined
      ) {
        return recovery
      }
      const confirmationAttempts = recovery.confirmationAttempts ?? []
      if (confirmationAttempts.length === 0) return recovery
      const policyBlockedRelayUrlSet = new Set(
        recovery.policyBlockedRelayUrls ?? []
      )
      const matchingPending =
        input.pendingDistribution?.signedEvent.id ===
        recovery.replacementEventId
          ? input.pendingDistribution
          : undefined
      const matchingPendingConfirmationRelayUrls = matchingPending
        ? normalizedPendingConfirmationRelayUrls(matchingPending)
        : undefined
      const candidateSharedSourceRelayUrls =
        !recovery.replacementEventSig ||
        recovery.replacementEventSig === input.candidate.current.signedEvent.sig
          ? (input.candidate.current.sharedSourceRelayUrls ?? [])
          : []
      const nextAttempts = confirmationAttempts.map((attempt) => {
        const relayUrlSet = new Set(attempt.relayUrls)
        const pendingMatches = Boolean(
          matchingPendingConfirmationRelayUrls &&
          sameOrderedStrings(
            attempt.relayUrls,
            matchingPendingConfirmationRelayUrls
          )
        )
        const matchingOutcomes = pendingMatches
          ? (matchingPending?.relayOutcomes ?? [])
          : []
        const completedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls([
          ...(attempt.completedRelayUrls ?? []),
          ...matchingOutcomes.flatMap((outcome) =>
            relayUrlSet.has(outcome.relayUrl) &&
            !policyBlockedRelayUrlSet.has(outcome.relayUrl) &&
            (outcome.readbackStatus === "observed" ||
              outcome.readbackStatus === "absent")
              ? [outcome.relayUrl]
              : []
          ),
          ...candidateSharedSourceRelayUrls.filter(
            (relayUrl) =>
              relayUrlSet.has(relayUrl) &&
              !policyBlockedRelayUrlSet.has(relayUrl)
          ),
        ]).sort()
        const observedRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls([
          ...(attempt.observedRelayUrls ?? []),
          ...matchingOutcomes.flatMap((outcome) =>
            relayUrlSet.has(outcome.relayUrl) &&
            !policyBlockedRelayUrlSet.has(outcome.relayUrl) &&
            outcome.readbackStatus === "observed"
              ? [outcome.relayUrl]
              : []
          ),
          ...candidateSharedSourceRelayUrls.filter(
            (relayUrl) =>
              relayUrlSet.has(relayUrl) &&
              !policyBlockedRelayUrlSet.has(relayUrl)
          ),
        ]).sort()
        return {
          ...attempt,
          ...(completedRelayUrls.length > 0 ? { completedRelayUrls } : {}),
          ...(observedRelayUrls.length > 0 ? { observedRelayUrls } : {}),
        }
      })
      const completeAttempt = nextAttempts.some((attempt) => {
        const completedRelayUrlSet = new Set(attempt.completedRelayUrls ?? [])
        return (
          attempt.relayUrls.every(
            (relayUrl) =>
              !policyBlockedRelayUrlSet.has(relayUrl) &&
              completedRelayUrlSet.has(relayUrl)
          ) && (attempt.observedRelayUrls?.length ?? 0) > 0
        )
      })
      const updated = {
        ...recovery,
        confirmationAttempts: nextAttempts,
      }
      return completeAttempt
        ? {
            ...updated,
            readbackObservedAt: input.candidate.current.observedAt,
            expiresAt:
              input.candidate.current.observedAt +
              cutoverGraceMsForPolicyVersion(recovery.policyVersion),
          }
        : updated
    }),
  })
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
  if (
    !areSameSignedInboxDeclarationEvent(
      pending.signedEvent,
      candidate.current.signedEvent
    )
  ) {
    return false
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
  const sourceRelayUrls = mergeRetainedSourceRelayUrls(
    existing.current.sourceRelayUrls,
    candidate.current.sourceRelayUrls
  )
  const sharedSourceRelayUrls = mergeSharedSourceRelayUrls(
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
  const pendingDistribution = exactSharedSetReadbackCompleted
    ? undefined
    : selectedPending
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
  return {
    pubkey: existing.pubkey,
    current,
    lastUsable,
    pendingDistribution,
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
        sourceRelayUrls: mergeRetainedSourceRelayUrls(
          prior.sourceRelayUrls,
          candidate.current.sourceRelayUrls
        ),
        sharedSourceRelayUrls: mergeSharedSourceRelayUrls(
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
    ...(existing.cutoverRecoveries
      ? { cutoverRecoveries: structuredClone(existing.cutoverRecoveries) }
      : {}),
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
  return {
    pubkey: candidate.pubkey,
    current,
    lastUsable,
    pendingDistribution,
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
  const canonicalExisting = existing
    ? cloneInboxDeclarationEvidenceRecord(existing)
    : undefined
  const merged = applyEventEvidenceMerge(canonicalExisting, candidate)
  const readbackPending = selectEarlierPendingDistribution(
    canonicalExisting?.pendingDistribution,
    candidate.pendingDistribution,
    candidate.current.signedEvent.id
  )
  const cutoverRecoveries = completeCutoverRecoveryReadback({
    recoveries: mergeCutoverRecoveries(
      canonicalExisting?.cutoverRecoveries,
      candidate.cutoverRecoveries
    ),
    candidate,
    pendingDistribution: readbackPending,
  })
  const latestLookup = mergeLatestLookupEvidence(
    canonicalExisting?.latestLookup,
    candidate.latestLookup,
    merged.current.signedEvent.id
  )
  const canonical: InboxDeclarationEvidenceRecord = {
    ...merged,
    latestLookup,
    cachedAt: Math.max(canonicalExisting?.cachedAt ?? 0, candidate.cachedAt),
  }
  delete canonical.cutoverRecovery
  delete canonical.cutoverRecoveries
  if (cutoverRecoveries.length > 0) {
    canonical.cutoverRecoveries = cutoverRecoveries
  }
  return canonical
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
    ) ||
    (!(
      record.pendingDistribution?.confirmationRelayUrls === undefined &&
      pending.confirmationRelayUrls === undefined
    ) &&
      !sameOrderedStrings(
        record.pendingDistribution?.confirmationRelayUrls,
        pending.confirmationRelayUrls
      ))
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

/**
 * Atomically replace an exact declaration's delivery plan after its current
 * immutable plan has been honored. Existing recovery batches are never minted
 * here; an awaiting matching batch only gains one immutable shared attempt.
 */
export function applyInboxDeclarationDistributionRestage(
  existing: InboxDeclarationEvidenceRecord,
  input: RestageInboxDeclarationDistributionInput,
  now: () => number = Date.now
): InboxDeclarationEvidenceRecord {
  const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
  if (!pubkey || pubkey !== existing.pubkey) {
    throw new Error("Inbox redistribution requires its retained account")
  }
  assertValidDeclarationEvent(pubkey, input.signedEvent)
  if (
    existing.current.state !== "declared" ||
    !areSameSignedInboxDeclarationEvent(
      existing.current.signedEvent,
      input.signedEvent
    )
  ) {
    throw new InboxDeclarationDistributionConflictError()
  }
  const expectedPublishRelayUrls = normalizeRetainedRelayUrls(
    input.expectedPublishRelayUrls
  )
  const existingPending = existing.pendingDistribution
  if (
    existingPending &&
    (!areSameSignedInboxDeclarationEvent(
      existingPending.signedEvent,
      input.signedEvent
    ) ||
      !sameOrderedStrings(
        existingPending.publishRelayUrls,
        expectedPublishRelayUrls
      ))
  ) {
    throw new InboxDeclarationDistributionConflictError()
  }
  const publishRelayUrls = normalizeSecureOrIsolatedE2eRelayUrls(
    input.publishRelayUrls
  )
  if (publishRelayUrls.length === 0) {
    throw new Error("Inbox redistribution requires secure publish targets")
  }
  const stagedAt = assertLocalTimestamp(
    input.stagedAt ?? now(),
    "Inbox redistribution stagedAt"
  )
  const relayOutcomes = input.relayOutcomes
    ? normalizeRelayOutcomes(publishRelayUrls, input.relayOutcomes)
    : publishRelayUrls.map((relayUrl) => ({
        relayUrl,
        publishStatus: "pending" as const,
        publishAttemptCount: 0,
        readbackStatus: "pending" as const,
        readbackAttemptCount: 0,
      }))
  const next = cloneInboxDeclarationEvidenceRecord(existing)
  next.pendingDistribution = {
    signedEvent: cloneSignedEvent(input.signedEvent),
    publishRelayUrls,
    confirmationRelayUrls: [...publishRelayUrls].sort(),
    relayOutcomes,
    stagedAt,
  }
  next.cachedAt = Math.max(
    next.cachedAt,
    assertLocalTimestamp(
      input.cachedAt ?? stagedAt,
      "Inbox redistribution cachedAt"
    )
  )
  const recovery = next.cutoverRecoveries?.find(
    (candidate) =>
      candidate.replacementEventId === input.signedEvent.id &&
      candidate.replacementEventSig === input.signedEvent.sig &&
      candidate.readbackObservedAt === undefined
  )
  if (recovery) {
    recovery.confirmationAttempts = mergeConfirmationAttempts([
      ...(recovery.confirmationAttempts ?? []),
      {
        relayUrls: [...publishRelayUrls].sort(),
        stagedAt,
      },
    ])
  }
  return cloneInboxDeclarationEvidenceRecord(next)
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
  const confirmationRelayUrlSet = new Set(
    normalizedPendingConfirmationRelayUrls(pending)
  )
  const exactSharedSourceRelayUrls = exactSourceRelayUrls.filter((relayUrl) =>
    confirmationRelayUrlSet.has(relayUrl)
  )
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
        sharedSourceRelayUrls: exactSharedSourceRelayUrls,
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

/** Policy-block whole-setup exclusions without rewriting immutable history. */
export function applyInboxDeclarationCutoverExclusions(
  record: InboxDeclarationEvidenceRecord,
  excludedRelayUrls: readonly string[],
  excludedAt: number = Date.now()
): InboxDeclarationEvidenceRecord {
  const excluded = new Set(normalizeRetainedRelayUrls(excludedRelayUrls))
  const next = cloneInboxDeclarationEvidenceRecord(record)
  if (excluded.size === 0 || !next.cutoverRecoveries) return next
  assertLocalTimestamp(excludedAt, "Inbox cutover exclusion observedAt")
  const cutoverRecoveries = next.cutoverRecoveries.map((recovery) => {
    const historicalRelayUrls = [
      ...recovery.relayUrls,
      ...(recovery.confirmationAttempts?.flatMap(
        (attempt) => attempt.relayUrls
      ) ?? []),
    ]
    const policyBlockedRelayUrls = normalizeRetainedRelayUrls([
      ...(recovery.policyBlockedRelayUrls ?? []),
      ...historicalRelayUrls.filter((relayUrl) => excluded.has(relayUrl)),
    ]).sort()
    return {
      ...recovery,
      ...(policyBlockedRelayUrls.length > 0 ? { policyBlockedRelayUrls } : {}),
    }
  })
  next.cutoverRecoveries = cutoverRecoveries
  return cloneInboxDeclarationEvidenceRecord(next)
}

/** Apply exact-id readback evidence to one locally planned recovery batch. */
export function applyInboxDeclarationCutoverRecoveryReadback(
  record: InboxDeclarationEvidenceRecord,
  input: {
    replacementEventId: string
    replacementEventSig: string
    readback: readonly NetworkPreferenceReadbackObservation[]
    observedAt: number
  }
): InboxDeclarationEvidenceRecord {
  const observedAt = assertLocalTimestamp(
    input.observedAt,
    "Inbox cutover readback observedAt"
  )
  const next = cloneInboxDeclarationEvidenceRecord(record)
  const recovery = next.cutoverRecoveries?.find(
    (candidate) => candidate.replacementEventId === input.replacementEventId
  )
  if (
    !recovery ||
    !recovery.replacementEventSig ||
    recovery.replacementEventSig !== input.replacementEventSig ||
    !recovery.confirmationAttempts?.length
  ) {
    throw new Error(
      "Inbox cutover readback must match a locally planned replacement"
    )
  }
  if (recovery.readbackObservedAt !== undefined) return next
  const policyBlockedRelayUrls = new Set(recovery.policyBlockedRelayUrls ?? [])
  const seen = new Set<string>()
  const observations: Array<{
    relayUrl: string
    status: "observed" | "absent" | "timed_out"
  }> = []
  for (const observation of input.readback) {
    const relayUrl = normalizeSecureOrIsolatedE2eRelayUrls([
      observation.relayUrl,
    ])[0]
    if (
      !relayUrl ||
      policyBlockedRelayUrls.has(relayUrl) ||
      seen.has(relayUrl) ||
      !["observed", "absent", "timed_out"].includes(observation.status) ||
      !recovery.confirmationAttempts.some((attempt) =>
        attempt.relayUrls.includes(relayUrl)
      )
    ) {
      throw new Error(
        "Inbox cutover readback must target its immutable shared set"
      )
    }
    seen.add(relayUrl)
    observations.push({ relayUrl, status: observation.status })
  }
  recovery.confirmationAttempts = recovery.confirmationAttempts.map(
    (attempt) => {
      const plan = new Set(attempt.relayUrls)
      const completedRelayUrls = [...(attempt.completedRelayUrls ?? [])]
      const observedRelayUrls = [...(attempt.observedRelayUrls ?? [])]
      for (const observation of observations) {
        if (!plan.has(observation.relayUrl)) continue
        if (observation.status === "observed") {
          observedRelayUrls.push(observation.relayUrl)
          completedRelayUrls.push(observation.relayUrl)
        } else if (observation.status === "absent") {
          completedRelayUrls.push(observation.relayUrl)
        }
      }
      return {
        ...attempt,
        ...(completedRelayUrls.length > 0
          ? {
              completedRelayUrls:
                normalizeSecureOrIsolatedE2eRelayUrls(
                  completedRelayUrls
                ).sort(),
            }
          : {}),
        ...(observedRelayUrls.length > 0
          ? {
              observedRelayUrls:
                normalizeSecureOrIsolatedE2eRelayUrls(observedRelayUrls).sort(),
            }
          : {}),
      }
    }
  )
  const completedAttempt = recovery.confirmationAttempts.some((attempt) => {
    const completedRelayUrls = new Set(attempt.completedRelayUrls ?? [])
    return (
      (attempt.observedRelayUrls?.length ?? 0) > 0 &&
      attempt.relayUrls.every(
        (relayUrl) =>
          !policyBlockedRelayUrls.has(relayUrl) &&
          completedRelayUrls.has(relayUrl)
      )
    )
  })
  if (completedAttempt) {
    recovery.readbackObservedAt = observedAt
    recovery.expiresAt =
      observedAt + cutoverGraceMsForPolicyVersion(recovery.policyVersion)
  }
  return cloneInboxDeclarationEvidenceRecord(next)
}

/** Read-only cutover relays whose exact-readback grace has not expired. */
export function getActiveInboxCutoverRecoveryRelayUrls(
  record: InboxDeclarationEvidenceRecord | null | undefined,
  now: number = Date.now()
): string[] {
  if (!record) return []
  const recoveries = normalizeCutoverRecoveries(record)
  return normalizeRetainedRelayUrls(
    recoveries.flatMap((recovery) =>
      recovery.expiresAt !== undefined && now >= recovery.expiresAt
        ? []
        : recovery.relayUrls.filter(
            (relayUrl) => !recovery.policyBlockedRelayUrls?.includes(relayUrl)
          )
    )
  )
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
): InboxDeclarationEvidenceRepository {
  const recordCutoverRecoveryReadback = async (
    input: RecordInboxDeclarationCutoverRecoveryReadbackInput
  ): Promise<InboxDeclarationEvidenceRecord> => {
    const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
    if (!pubkey) {
      throw new Error("Inbox declaration evidence requires a valid hex pubkey")
    }
    return db.transaction("rw", db.inboxDeclarationEvidence, async () => {
      const existing = await db.inboxDeclarationEvidence.get(pubkey)
      if (!existing) {
        throw new Error(
          "Inbox cutover readback requires an existing locally planned batch"
        )
      }
      let finalRecord = applyInboxDeclarationCutoverRecoveryReadback(
        existing,
        input
      )
      const pending = finalRecord.pendingDistribution
      if (
        pending?.signedEvent.id === input.replacementEventId &&
        pending.signedEvent.sig === input.replacementEventSig
      ) {
        const publishRelayUrls = new Set(pending.publishRelayUrls)
        const readback = input.readback.filter((observation) =>
          publishRelayUrls.has(observation.relayUrl)
        )
        if (readback.length > 0) {
          finalRecord = applyInboxDeclarationDistributionOutcomes(finalRecord, {
            readback,
            observedAt: input.observedAt,
          })
        }
      }
      if (JSON.stringify(existing) !== JSON.stringify(finalRecord)) {
        await db.inboxDeclarationEvidence.put(
          cloneInboxDeclarationEvidenceRecord(finalRecord)
        )
      }
      return cloneInboxDeclarationEvidenceRecord(finalRecord)
    })
  }

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
      return db.transaction("rw", db.inboxDeclarationEvidence, async () => {
        const stored = await db.inboxDeclarationEvidence.get(pubkey)
        if (!stored) return undefined
        const canonical = cloneInboxDeclarationEvidenceRecord(stored)
        if (JSON.stringify(stored) !== JSON.stringify(canonical)) {
          await db.inboxDeclarationEvidence.put(canonical)
        }
        return cloneInboxDeclarationEvidenceRecord(canonical)
      })
    },

    merge: (input) => mergeBatch([input]),
    mergeBatch,
    recordCutoverRecoveryReadback,
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
  >(initial.map((record) => [record.pubkey, structuredClone(record)]))

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

  const recordCutoverRecoveryReadback = async (
    input: RecordInboxDeclarationCutoverRecoveryReadbackInput
  ): Promise<InboxDeclarationEvidenceRecord> => {
    const pubkey = normalizeInboxDeclarationEvidencePubkey(input.pubkey)
    if (!pubkey) {
      throw new Error("Inbox declaration evidence requires a valid hex pubkey")
    }
    const existing = records.get(pubkey)
    if (!existing) {
      throw new Error(
        "Inbox cutover readback requires an existing locally planned batch"
      )
    }
    let merged = applyInboxDeclarationCutoverRecoveryReadback(existing, input)
    const pending = merged.pendingDistribution
    if (
      pending?.signedEvent.id === input.replacementEventId &&
      pending.signedEvent.sig === input.replacementEventSig
    ) {
      const publishRelayUrls = new Set(pending.publishRelayUrls)
      const readback = input.readback.filter((observation) =>
        publishRelayUrls.has(observation.relayUrl)
      )
      if (readback.length > 0) {
        merged = applyInboxDeclarationDistributionOutcomes(merged, {
          readback,
          observedAt: input.observedAt,
        })
      }
    }
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
    recordCutoverRecoveryReadback,
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

/** Atomically update readback for an existing locally planned recovery batch. */
export async function recordInboxDeclarationCutoverRecoveryReadback(
  input: RecordInboxDeclarationCutoverRecoveryReadbackInput,
  repository: InboxDeclarationEvidenceRepository = dexieInboxDeclarationEvidenceRepository
): Promise<InboxDeclarationEvidenceRecord> {
  const record = await repository.recordCutoverRecoveryReadback(input)
  return cloneInboxDeclarationEvidenceRecord(record)
}
