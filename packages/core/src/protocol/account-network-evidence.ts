import type {
  NetworkPreferenceReadbackStatus,
  NetworkPreferenceRelayOutcome,
} from "../db"
import type { OwnerRelayListResolution } from "./owner-relay-list-evidence"
import type { InboxDeclarationResolution } from "./private-message-routing"
import type {
  PublicRelayReadDiagnosticsResult,
  PublicRelayReadResult,
} from "./relay-reader"
import { getEventSourceRelayUrls } from "./relay-reader"
import type { SignedPublicNostrEvent } from "./signed-event"
import { isVerifiedNostrEvent } from "./verified-public-event"

/** Account Network meaning, independent of transport, persistence and UI. */
export type AccountNetworkCoverage = "complete" | "partial" | "unavailable"
export type AccountNetworkReadAvailability =
  | "complete"
  | "partial"
  | "auth_required"
  | "timed_out"
  | "verification_unavailable"
  | "unavailable"
  | "policy_blocked"
  | "cancelled"

export interface AccountNetworkReadEvidence {
  coverage: AccountNetworkCoverage
  sources: Array<{
    relayUrl: string
    availability: AccountNetworkReadAvailability
  }>
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  cappedRelayUrls: string[]
  /** Coverage is scoped to admitted targets; policy-blocked targets remain explicit. */
  scopeRelayUrls: string[]
}

type ReadObservation = Partial<PublicRelayReadDiagnosticsResult> &
  Pick<PublicRelayReadResult, "events">

/** Positive means candidate wins the NIP-01 replaceable frontier. */
export function compareAccountNetworkRevisions(
  candidate: { id: string; created_at: number },
  current: { id: string; created_at: number }
): -1 | 0 | 1 {
  if (candidate.created_at !== current.created_at)
    return candidate.created_at > current.created_at ? 1 : -1
  return candidate.id === current.id ? 0 : candidate.id < current.id ? 1 : -1
}

export interface AccountNetworkLookup {
  observedAt: number
  coverage: AccountNetworkCoverage
  hadEvent: boolean
  eventId?: string
  sources?: AccountNetworkReadEvidence["sources"]
}

/** Equal-time concurrent observations retain uncertainty, never invented freshness. */
export function mergeAccountNetworkLookup<T extends AccountNetworkLookup>(
  current: T | undefined,
  candidate: T,
  currentEventId?: string
): T {
  if (!current || candidate.observedAt > current.observedAt)
    return structuredClone(candidate)
  if (candidate.observedAt < current.observedAt) return structuredClone(current)
  const sourceRank: Record<AccountNetworkReadAvailability, number> = {
    complete: 0,
    partial: 1,
    policy_blocked: 2,
    cancelled: 3,
    unavailable: 4,
    timed_out: 5,
    auth_required: 6,
    verification_unavailable: 7,
  }
  const sources = new Map<string, AccountNetworkReadAvailability>()
  for (const source of [
    ...(current.sources ?? []),
    ...(candidate.sources ?? []),
  ]) {
    const prior = sources.get(source.relayUrl)
    if (!prior || sourceRank[source.availability] > sourceRank[prior])
      sources.set(source.relayUrl, source.availability)
  }
  const clone = (winner: T): T => ({
    ...structuredClone(winner),
    ...(sources.size
      ? {
          sources: [...sources]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([relayUrl, availability]) => ({ relayUrl, availability })),
        }
      : {}),
  })
  const confirms = (lookup: T) =>
    lookup.coverage === "complete" &&
    lookup.hadEvent &&
    lookup.eventId === currentEventId
  if (confirms(current) !== confirms(candidate))
    return clone(confirms(current) ? candidate : current)
  const rank = { complete: 0, partial: 1, unavailable: 2 }
  if (rank[candidate.coverage] !== rank[current.coverage])
    return clone(
      rank[candidate.coverage] > rank[current.coverage] ? candidate : current
    )
  if (candidate.hadEvent !== current.hadEvent)
    return clone(candidate.hadEvent ? current : candidate)
  return clone(
    (candidate.eventId ?? "") < (current.eventId ?? "") ? candidate : current
  )
}

/**
 * Interpret the full requested candidates against the actual admitted scope.
 * Only a completed, verified bounded query establishes scoped absence.
 */
export function interpretAccountNetworkRead(
  candidateRelayUrls: readonly string[],
  result: ReadObservation | null,
  verificationComplete = result?.events.every(isVerifiedNostrEvent) ?? true
): AccountNetworkReadEvidence {
  const planned = [...new Set(candidateRelayUrls)]
  const byRelay = new Map(
    result?.relays?.map((relay) => [relay.relayUrl, relay])
  )
  const successful = new Set(result?.successfulRelayUrls ?? [])
  const failed = new Set(result?.failedRelayUrls ?? [])
  const capped = new Set(result?.cappedRelayUrls ?? [])
  const admitted =
    result?.admittedRelayUrls && new Set(result.admittedRelayUrls)
  const attempted = new Set(
    result?.attemptedRelayUrls ?? [...byRelay.keys(), ...successful, ...failed]
  )
  const sources = planned.map((relayUrl) => {
    const relay = byRelay.get(relayUrl)
    let availability: AccountNetworkReadAvailability
    if (!verificationComplete || relay?.outcome === "verification_failed")
      availability = "verification_unavailable"
    else if (relay?.outcome === "auth_required") availability = "auth_required"
    else if (
      relay?.outcome === "timeout" ||
      relay?.outcome === "connect_timeout"
    )
      availability = "timed_out"
    else if (
      relay?.outcome === "cancelled" ||
      result?.readCoverage === "cancelled"
    )
      availability = "cancelled"
    else if (admitted && !admitted.has(relayUrl))
      availability = "policy_blocked"
    else if (
      capped.has(relayUrl) ||
      (relay?.rejectedEventCount ?? 0) > 0 ||
      relay?.status === "partial"
    )
      availability = "partial"
    else if (
      !failed.has(relayUrl) &&
      (relay?.status === "success" || (!relay && successful.has(relayUrl)))
    )
      availability = "complete"
    else availability = "unavailable"
    return { relayUrl, availability }
  })
  const scoped = sources.filter(
    (source) => source.availability !== "policy_blocked"
  )
  const complete =
    scoped.length > 0 &&
    scoped.every((source) => source.availability === "complete")
  const usable = sources.some(
    (source) =>
      source.availability === "complete" || source.availability === "partial"
  )
  return {
    coverage: complete ? "complete" : usable ? "partial" : "unavailable",
    sources,
    scopeRelayUrls: scoped.map((source) => source.relayUrl),
    attemptedRelayUrls: planned.filter((url) => attempted.has(url)),
    successfulRelayUrls: sources.flatMap((source) =>
      source.availability === "complete" || source.availability === "partial"
        ? [source.relayUrl]
        : []
    ),
    failedRelayUrls: sources.flatMap((source) =>
      source.availability === "complete" ? [] : [source.relayUrl]
    ),
    cappedRelayUrls: planned.filter((url) => capped.has(url)),
  }
}

/** Preserve detailed transport outcomes while constraining provenance to the plan. */
export function reconcileAccountNetworkReadDiagnostics<
  T extends ReadObservation,
>(
  result: T,
  plannedRelayUrls: readonly string[]
): T & AccountNetworkReadEvidence {
  return { ...result, ...interpretAccountNetworkRead(plannedRelayUrls, result) }
}

export interface AccountNetworkPreferenceFacts {
  state:
    | "declared"
    | "signed_empty"
    | "malformed"
    | "not_observed"
    | "lookup_partial"
    | "lookup_unavailable"
  currentUsable: boolean
  retainedUsable: boolean
  distributionPending: boolean
  currentObserved: boolean
  stale: boolean
  scopedAbsent: boolean
  coverage: AccountNetworkCoverage
  currentEventId?: string
}

export function interpretAccountNetworkPreference(input: {
  current?: {
    eventId: string
    state: "declared" | "signed_empty" | "malformed"
    completeObservedAt?: number
  }
  lastUsableEventId?: string
  pendingEventId?: string
  lookup?: {
    coverage: AccountNetworkCoverage
    hadEvent: boolean
    eventId?: string
    observedAt?: number
  }
}): AccountNetworkPreferenceFacts {
  const lookup =
    input.current?.completeObservedAt !== undefined &&
    (!input.lookup ||
      (input.lookup.observedAt ?? 0) < input.current.completeObservedAt)
      ? {
          coverage: "complete" as const,
          hadEvent: true,
          eventId: input.current.eventId,
        }
      : input.lookup
  const coverage = lookup?.coverage ?? "unavailable"
  const currentObserved = Boolean(
    input.current &&
    lookup?.hadEvent &&
    lookup.eventId === input.current.eventId
  )
  const distributionPending = Boolean(
    input.current && input.pendingEventId === input.current.eventId
  )
  const scopedAbsent =
    !input.current &&
    !input.lastUsableEventId &&
    !input.pendingEventId &&
    coverage === "complete" &&
    !lookup?.hadEvent
  return {
    ...(input.current ? { currentEventId: input.current.eventId } : {}),
    state:
      input.current?.state ??
      (scopedAbsent
        ? "not_observed"
        : coverage === "partial"
          ? "lookup_partial"
          : "lookup_unavailable"),
    currentUsable: input.current?.state === "declared",
    retainedUsable: Boolean(input.lastUsableEventId),
    distributionPending,
    currentObserved,
    stale: Boolean(
      input.current &&
      (coverage !== "complete" ||
        !currentObserved ||
        input.current.state === "malformed")
    ),
    scopedAbsent,
    coverage,
  }
}

export function ownerRelayListEvidenceFacts(
  resolution: Pick<
    OwnerRelayListResolution,
    "current" | "lastUsable" | "pendingDistribution" | "lookup"
  >
): AccountNetworkPreferenceFacts {
  return interpretAccountNetworkPreference({
    current: resolution.current && {
      eventId: resolution.current.signedEvent.id,
      state: resolution.current.state,
      completeObservedAt: resolution.current.completeObservedAt,
    },
    lastUsableEventId: resolution.lastUsable?.signedEvent.id,
    pendingEventId: resolution.pendingDistribution?.signedEvent.id,
    lookup: resolution.lookup,
  })
}

export function inboxDeclarationEvidenceFacts(
  resolution: InboxDeclarationResolution
): AccountNetworkPreferenceFacts {
  if (resolution.evidence) return resolution.evidence
  const state = resolution.state
  return interpretAccountNetworkPreference({
    current:
      resolution.eventId &&
      (state === "declared" ||
        state === "signed_empty" ||
        state === "malformed")
        ? { eventId: resolution.eventId, state }
        : undefined,
    lastUsableEventId:
      (resolution.retainedReadRelayUrls?.length ?? 0) > 0
        ? "retained"
        : undefined,
    pendingEventId:
      (resolution.pendingPublishRelayUrls?.length ?? 0) > 0
        ? resolution.eventId
        : undefined,
    lookup: resolution.observation
      ? {
          ...resolution.observation,
          hadEvent: Boolean(resolution.observation.eventId),
        }
      : undefined,
  })
}

export function classifyAccountNetworkReadback(input: {
  relayUrl: string
  signedEvent: Pick<SignedPublicNostrEvent, "id" | "sig">
  result: ReadObservation | null
  verificationComplete?: boolean
}): Exclude<NetworkPreferenceReadbackStatus, "pending"> {
  const { result, relayUrl, signedEvent } = input
  if (!result) return "unavailable"
  const exact = result.events.some(
    (event) =>
      isVerifiedNostrEvent(event) &&
      event.id === signedEvent.id &&
      event.sig === signedEvent.sig &&
      (
        result.eventSourceRelayUrls?.[event.id] ??
        getEventSourceRelayUrls(event)
      ).includes(relayUrl)
  )
  if (exact) return "observed"
  const source = interpretAccountNetworkRead(
    [relayUrl],
    result,
    input.verificationComplete ??
      result?.events.every(isVerifiedNostrEvent) ??
      false
  ).sources[0]
  if (source?.availability === "complete") return "absent"
  return source?.availability === "partial"
    ? "unavailable"
    : (source?.availability ?? "unavailable")
}

export const NETWORK_PREFERENCE_READBACK_STATUSES: readonly NetworkPreferenceReadbackStatus[] =
  [
    "pending",
    "observed",
    "absent",
    "timed_out",
    "auth_required",
    "verification_unavailable",
    "unavailable",
    "policy_blocked",
    "cancelled",
  ]

export interface AccountNetworkInboxRecovery {
  relayUrl: string
  phase: "awaiting_confirmation" | "grace"
  expiresAt?: number
}

/** Retained evidence alone is never a cutover; only an explicit batch owns a clock. */
export function interpretAccountNetworkInboxRecovery(
  batches: readonly {
    relayUrls: readonly string[]
    readbackObservedAt?: number
    expiresAt?: number
    policyBlockedRelayUrls?: readonly string[]
  }[],
  now: number
): AccountNetworkInboxRecovery[] {
  const byRelay = new Map<string, AccountNetworkInboxRecovery>()
  for (const batch of batches) {
    if (batch.expiresAt !== undefined && now >= batch.expiresAt) continue
    const blocked = new Set(batch.policyBlockedRelayUrls ?? [])
    for (const relayUrl of batch.relayUrls) {
      if (blocked.has(relayUrl)) continue
      const current = byRelay.get(relayUrl)
      const pending =
        batch.readbackObservedAt === undefined || batch.expiresAt === undefined
      if (pending || current?.phase === "awaiting_confirmation") {
        byRelay.set(relayUrl, { relayUrl, phase: "awaiting_confirmation" })
      } else
        byRelay.set(relayUrl, {
          relayUrl,
          phase: "grace",
          expiresAt: Math.max(current?.expiresAt ?? 0, batch.expiresAt!),
        })
    }
  }
  return [...byRelay.values()]
}

export function hasCompleteAccountNetworkSetupAbsence(
  owner: Pick<
    OwnerRelayListResolution,
    "current" | "lastUsable" | "pendingDistribution" | "lookup"
  >,
  inbox: InboxDeclarationResolution
): boolean {
  return (
    ownerRelayListEvidenceFacts(owner).scopedAbsent &&
    inboxDeclarationEvidenceFacts(inbox).scopedAbsent &&
    (inbox.cutoverRecoveryRelayUrls?.length ?? 0) === 0 &&
    (inbox.pendingRelayUrls?.length ?? 0) === 0 &&
    (inbox.pendingPublishRelayUrls?.length ?? 0) === 0
  )
}

export function summarizeAccountNetworkReadback(
  outcomes: readonly Pick<
    NetworkPreferenceRelayOutcome,
    "relayUrl" | "readbackStatus"
  >[],
  excludedRelayUrls: readonly string[] = []
) {
  const excluded = new Set(excludedRelayUrls)
  const eligible = outcomes.filter((outcome) => !excluded.has(outcome.relayUrl))
  const exactReadbackCount = eligible.filter(
    (outcome) => outcome.readbackStatus === "observed"
  ).length
  const absentCount = eligible.filter(
    (outcome) => outcome.readbackStatus === "absent"
  ).length
  const unresolvedCount = eligible.length - exactReadbackCount - absentCount
  const excludedTargetCount = outcomes.length - eligible.length
  const confirmed =
    outcomes.length > 0 &&
    exactReadbackCount > 0 &&
    unresolvedCount === 0 &&
    excludedTargetCount === 0
  return {
    confirmationState: confirmed
      ? ("exact_confirmed" as const)
      : eligible.length === 0 ||
          (excludedTargetCount > 0 && unresolvedCount === 0)
        ? ("policy_blocked" as const)
        : ("readback_pending" as const),
    eligibleTargetCount: eligible.length,
    exactReadbackCount,
    absentCount,
    unresolvedCount,
    excludedTargetCount,
    authRequiredCount: eligible.filter(
      (outcome) => outcome.readbackStatus === "auth_required"
    ).length,
    confirmed,
  }
}
