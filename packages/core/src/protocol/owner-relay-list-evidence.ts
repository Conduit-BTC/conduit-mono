import { mergeRelayTargets, relayTargetsFromUrls } from "./relay-authority"
import {
  interpretAccountNetworkRead,
  reconcileAccountNetworkReadDiagnostics,
} from "./account-network-evidence"
import { type OwnerRelayListEvidenceRecord } from "../db"
import { EVENT_KINDS } from "./kinds"
import {
  fetchPublicEventsWithDiagnostics,
  type PublicRelayReadDiagnosticsResult,
} from "./relay-reader"
import { type SignedPublicNostrEvent } from "./signed-event"
import {
  OWNER_RELAY_LIST_FETCH_LIMIT,
  type OwnerRelayListEventObservation,
  type OwnerRelayListObservation,
  type OwnerRelayListResolution,
  type ResolveOwnerRelayListOptions,
  processEvidence,
  normalizeOwnerRelayListPubkey,
  OwnerRelayListEvidenceUnavailableError,
  reconcileOwnerRelayListEvidence,
  accountNetworkDiscoveryRelayUrls,
  ownerAuthorizedLookupRelayPlan,
  toSignedOwnerRelayListEvent,
  newestEvent,
  eventSourceRelayUrls,
  resolutionFromRecord,
} from "./owner-relay-list-evidence-store"
export {
  type NormalizedOwnerRelayListPubkey,
  type NetworkPreferenceRelayOutcome,
  type OwnerRelayListEvidenceRecord,
  type OwnerRelayListEventEvidence,
  type OwnerRelayListEvidenceState,
  type OwnerRelayListLookupCoverage,
  type OwnerRelayListLookupEvidence,
  type PendingOwnerRelayListDistribution,
  type OwnerRelayListEventObservation,
  type ReconcileOwnerRelayListEvidenceInput,
  type StageOwnerRelayListDistributionInput,
  OwnerRelayListDistributionConflictError,
  type OwnerRelayListEvidenceRepository,
  type OwnerRelayListResolutionState,
  type OwnerRelayListObservation,
  type OwnerRelayListResolution,
  type ResolveOwnerRelayListOptions,
  type ReadRetainedOwnerRelayListOptions,
  normalizeOwnerRelayListPubkey,
  applyOwnerRelayListEvidenceReconciliation,
  applyOwnerRelayListDistributionStage,
  applyOwnerRelayListDistributionOutcomes,
  dexieOwnerRelayListEvidenceRepository,
  createInMemoryOwnerRelayListEvidenceRepository,
  getOwnerRelayListEvidence,
  reconcileOwnerRelayListEvidence,
  accountNetworkDiscoveryRelayUrls,
  readRetainedOwnerRelayList,
  __resetOwnerRelayListEvidenceForTests,
} from "./owner-relay-list-evidence-store"

export async function resolveOwnerRelayList(
  pubkey: string,
  options: ResolveOwnerRelayListOptions = {}
): Promise<OwnerRelayListResolution> {
  const normalized = normalizeOwnerRelayListPubkey(pubkey)
  if (!normalized) throw new Error("Owner relay-list lookup requires a pubkey")
  const now = options.now ?? Date.now
  const observedAt = now()
  const lookupPlan = ownerAuthorizedLookupRelayPlan({
    ownerPubkey: normalized,
    requestingAccountPubkey: options.requestingAccountPubkey,
    authenticatedPubkey: options.authenticatedPubkey,
    candidateRelayUrls: options.relayUrls ?? accountNetworkDiscoveryRelayUrls(),
    ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
  })
  const relayUrls = lookupPlan.relayUrls
  const fetchEvents =
    options.fetchEventsWithDiagnostics ?? fetchPublicEventsWithDiagnostics
  let result: PublicRelayReadDiagnosticsResult
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
          relayTargets:
            options.relayTargets ??
            mergeRelayTargets(
              relayTargetsFromUrls(relayUrls, {
                kind: "discovery",
                operation: "read",
                registry: "owner_10002",
              }),
              relayTargetsFromUrls(lookupPlan.ownerSelectedRelayUrls, {
                kind: "owner_nip65",
                operation: "read",
                ownerPubkey: normalized,
                selection: "read",
              })
            ),
          accountPubkey: lookupPlan.accountPubkey,
          authenticatedPubkey: lookupPlan.authenticatedPubkey,
          accountNetworkLocalStateRepository:
            options.accountNetworkLocalStateRepository,
          signal: options.signal,
          shouldContinue: options.shouldContinue,
          connectTimeoutMs: 4_000,
          fetchTimeoutMs: 6_000,
          skipHealthFilter: true,
        }
      )
    } catch (error) {
      if (options.signal?.aborted || options.shouldContinue?.() === false) {
        throw error
      }
      result = {
        events: [],
        attemptedRelayUrls: [...relayUrls],
        successfulRelayUrls: [],
        failedRelayUrls: [...relayUrls],
        cappedRelayUrls: [],
      }
    }
  }
  result = reconcileAccountNetworkReadDiagnostics(result, relayUrls)
  const coverage = interpretAccountNetworkRead(relayUrls, result).coverage
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
  let record: OwnerRelayListEvidenceRecord
  try {
    record = await reconcileOwnerRelayListEvidence(
      {
        pubkey: normalized,
        observations,
        lookup: {
          observedAt,
          coverage,
          sources: interpretAccountNetworkRead(relayUrls, result).sources,
          hadEvent: Boolean(newest),
          eventId: newest?.id,
        },
        cachedAt: observedAt,
      },
      options.evidenceRepository
    )
  } catch (error) {
    if (!(error instanceof OwnerRelayListEvidenceUnavailableError)) throw error
    if (options.signal?.aborted || options.shouldContinue?.() === false)
      throw error
    // Inconclusive admission cannot authorize replacing the durable checkpoint.
    return resolutionFromRecord(
      {
        ...processEvidence.get(normalized),
        pubkey: normalized,
        latestLookup: { observedAt, coverage: "unavailable", hadEvent: false },
        cachedAt: observedAt,
      },
      {
        coverage: "unavailable",
        attemptedRelayUrls: [...result.attemptedRelayUrls],
        successfulRelayUrls: [...result.successfulRelayUrls],
        failedRelayUrls: [...result.failedRelayUrls],
        cappedRelayUrls: [...(result.cappedRelayUrls ?? [])],
        eventSourceRelayUrls: [],
      }
    )
  }
  const observation: OwnerRelayListObservation = {
    coverage,
    sources: interpretAccountNetworkRead(relayUrls, result).sources,
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
