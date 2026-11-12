import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayTarget,
} from "./relay-authority"
import {
  interpretAccountNetworkPreference,
  classifyAccountNetworkReadback,
  interpretAccountNetworkRead,
  reconcileAccountNetworkReadDiagnostics,
} from "./account-network-evidence"
import { config } from "../config"
import {
  cloneInboxDeclarationEvidenceRecord,
  getInboxDeclarationEvidence,
  InboxDeclarationEvidenceUnavailableError,
  normalizeInboxDeclarationEvidencePubkey,
  recordInboxDeclarationCutoverRecoveryReadback,
  type InboxDeclarationEvidenceRecord,
  type InboxDeclarationEvidenceRepository,
} from "./inbox-declaration-evidence"
import { EVENT_KINDS } from "./kinds"
import {
  fetchPublicEventsWithDiagnostics,
  type PublicRelayReadOptions,
} from "./relay-reader"
import {
  type InboxReadCoverage,
  type InboxReadSource,
  type PrivateMessageDeliveryRoute,
  type CompatibilityOrderRelaySource,
  type CompatibilityOrderRelayPlan,
  MAX_COMPATIBILITY_ORDER_RELAYS,
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  MAX_INBOX_DECLARATION_READ_EVENTS,
  type InboxDeclarationResolution,
  type InboxDeclarationObservation,
  type ResolveInboxDeclarationOptions,
  INBOX_DECLARATION_FRESHNESS_MS,
  declarationCache,
  declarationEvidenceCache,
  invalidatedDeclarationKeys,
  hasCurrentCompleteLookup,
  mergeRecordEventEvidence,
  backfillLegacySharedSourceProvenance,
  canonicalizeRetainedInboxDeclarationEvidence,
  reconcileInboxDeclarationEvidenceBatch,
  currentEvidenceWasObservedAt,
  projectAndCacheInboxDeclarationResolution,
  cacheKey,
  allowsLocalRelayUrls,
  retainedRelayUrls,
  secureAutomaticRelayUrls,
  ownerAuthorizedDiscoveryRelayTargets,
  publicRelayHintUrls,
  declarationForContext,
  sharedInboxDiscoveryRelayUrls,
  inboxDiscoveryRelayCandidates,
  readDurableOwnerReadRelayUrls,
  declarationEventsNewestFirst,
  toSignedDeclarationEvent,
  resolutionFromEvidence,
  persistCachedLookupOutcome,
  declarationEventSourceRelayUrls,
} from "./private-message-retained-evidence"
export {
  secureRelayUrls,
  type InboxDeclarationState,
  type InboxReadCoverage,
  type InboxReadSource,
  type PrivateMessageDeliveryRoute,
  type CompatibilityOrderRelaySource,
  type CompatibilityOrderRelayPlan,
  MAX_COMPATIBILITY_ORDER_RELAYS,
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  MAX_SHARED_INBOX_DISCOVERY_RELAYS,
  MAX_INBOX_DISCOVERY_RELAYS,
  type PrivateMessageRelays,
  parsePrivateMessageRelays,
  type InboxDeclarationResolution,
  type InboxDeclarationObservation,
  type ResolveInboxDeclarationOptions,
  INBOX_DECLARATION_FRESHNESS_MS,
  __resetInboxDeclarationCache,
  invalidateInboxDeclaration,
  primeInboxDeclarationCache,
  primeInboxDeclarationEvidence,
  getCachedInboxDeclarationEvidence,
  type ReadRetainedInboxDeclarationOptions,
  readRetainedInboxDeclarationEvidence,
  readRetainedInboxDeclaration,
  mergeInboxDeclarationEvidenceInMemory,
  mergeInboxDeclarationEvidenceDurably,
  getCachedInboxDeclaration,
  publicRelayHintUrls,
  sharedInboxDiscoveryRelayUrls,
  inboxDiscoveryRelayUrls,
  inboxDeclarationPublishRelayUrls,
} from "./private-message-retained-evidence"

async function reconcilePendingInboxCutoverReadbacks(input: {
  pubkey: string
  record: InboxDeclarationEvidenceRecord
  fetchWithDiagnostics: typeof fetchPublicEventsWithDiagnostics
  repository: InboxDeclarationEvidenceRepository | undefined
  requestingAccountPubkey: string | null | undefined
  authenticatedPubkey: string | null | undefined
  ownerSelectedRelayUrls: readonly string[]
  accountNetworkLocalStateRepository: PublicRelayReadOptions["accountNetworkLocalStateRepository"]
  signal?: AbortSignal
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
  observedAt: number
  now: () => number
}): Promise<InboxDeclarationEvidenceRecord> {
  let record = cloneInboxDeclarationEvidenceRecord(input.record)
  for (const recovery of record.cutoverRecoveries ?? []) {
    if (input.signal?.aborted) break
    if (
      recovery.readbackObservedAt !== undefined ||
      !recovery.replacementEventSig
    ) {
      continue
    }
    const confirmationAttempts =
      recovery.confirmationAttempts ??
      (recovery.confirmationRelayUrls
        ? [
            {
              relayUrls: recovery.confirmationRelayUrls,
              completedRelayUrls: recovery.completedRelayUrls,
              observedRelayUrls: recovery.observedRelayUrls,
            },
          ]
        : [])
    if (confirmationAttempts.length === 0) continue
    const policyBlocked = new Set(recovery.policyBlockedRelayUrls ?? [])
    const unresolved = retainedRelayUrls(
      confirmationAttempts.flatMap((attempt) => {
        const completed = new Set(attempt.completedRelayUrls ?? [])
        const eligibleRelayUrls = attempt.relayUrls.filter(
          (relayUrl) => !policyBlocked.has(relayUrl)
        )
        return (attempt.observedRelayUrls?.length ?? 0) === 0
          ? eligibleRelayUrls
          : eligibleRelayUrls.filter((relayUrl) => !completed.has(relayUrl))
      })
    )
    const authenticatedRecoveryOwner =
      cacheKey(input.authenticatedPubkey ?? "") === input.pubkey &&
      cacheKey(input.requestingAccountPubkey ?? "") === input.pubkey
    const unresolvedSet = new Set(unresolved)
    const ownerSelectedRelayUrls = authenticatedRecoveryOwner
      ? retainedRelayUrls(input.ownerSelectedRelayUrls).filter((relayUrl) =>
          unresolvedSet.has(relayUrl)
        )
      : []
    const relayUrls = ownerAuthorizedDiscoveryRelayTargets(
      unresolved,
      ownerSelectedRelayUrls
    )
    if (relayUrls.length === 0) continue

    let result: Awaited<ReturnType<typeof fetchPublicEventsWithDiagnostics>>
    try {
      result = await input.fetchWithDiagnostics(
        {
          ids: [recovery.replacementEventId],
          kinds: [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
          authors: [input.pubkey],
          limit: 1,
        },
        {
          relayUrls,
          relayTargets: relayTargetsFromUrls(relayUrls, {
            kind: "discovery",
            operation: "read",
            registry: "inbox_10050",
          }),
          accountPubkey: input.requestingAccountPubkey,
          authenticatedPubkey: input.authenticatedPubkey,
          accountNetworkLocalStateRepository:
            input.accountNetworkLocalStateRepository,
          signal: input.signal,
          shouldContinue: input.shouldContinue,
          connectTimeoutMs: 3_000,
          fetchTimeoutMs: 6_000,
          skipHealthFilter: true,
        }
      )
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false) {
        throw error
      }
      continue
    }
    result = reconcileAccountNetworkReadDiagnostics(result, relayUrls)
    if (result.successfulRelayUrls.length === 0) continue
    const readback = relayUrls.map((relayUrl) => ({
      relayUrl,
      status: classifyAccountNetworkReadback({
        relayUrl,
        signedEvent: {
          id: recovery.replacementEventId,
          sig: recovery.replacementEventSig!,
        },
        result,
      }),
    }))
    try {
      const persisted = await recordInboxDeclarationCutoverRecoveryReadback(
        {
          pubkey: input.pubkey,
          replacementEventId: recovery.replacementEventId,
          replacementEventSig: recovery.replacementEventSig,
          readback,
          observedAt: input.observedAt,
        },
        input.repository
      )
      record = mergeRecordEventEvidence(persisted, record, input.now)
    } catch {
      // Recovery becomes active only after its exact readback is durable.
    }
  }
  return record
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
    secureAutomaticRelayUrls(
      options.sharedConfirmationRelayUrls ?? [...canonicalSharedRelayUrlSet]
    ).filter((relayUrl) => canonicalSharedRelayUrlSet.has(relayUrl))
  )

  let cached = declarationCache.get(key)
  if (normalizeInboxDeclarationEvidencePubkey(key)) {
    try {
      const persisted = await getInboxDeclarationEvidence(key, repository)
      if (persisted) {
        const persistedForReconciliation =
          canonicalizeRetainedInboxDeclarationEvidence(
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
            ? mergeRecordEventEvidence(
                persistedForReconciliation,
                processEvidence,
                now
              )
            : cloneInboxDeclarationEvidenceRecord(persistedForReconciliation)
        )
        // A fresh process cache is not authoritative across browser tabs.
        // Reconcile the durable frontier before considering the TTL fast path,
        // without writing a broad process record back into durable authority.
        const reconciled = await reconcileInboxDeclarationEvidenceBatch(
          key,
          [],
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
    } catch (error) {
      if (error instanceof InboxDeclarationEvidenceUnavailableError) {
        const retained = declarationEvidenceCache.get(key)
        if (retained) {
          const lookup = {
            observedAt: fetchedAt,
            coverage: "unavailable" as const,
            hadEvent: false,
          }
          return declarationForContext(
            resolutionFromEvidence(
              { ...retained, latestLookup: lookup },
              {
                stale: true,
                fetchedAt,
                observation: {
                  coverage: "unavailable",
                  attemptedRelayUrls: [],
                  successfulRelayUrls: [],
                  failedRelayUrls: [],
                  eventSourceRelayUrls: [],
                },
              }
            ),
            allowLocal
          )
        }
        return {
          pubkey: key,
          state: "lookup_unavailable",
          relayUrls: [],
          stale: true,
          fetchedAt,
          observation: {
            coverage: "unavailable",
            attemptedRelayUrls: [],
            successfulRelayUrls: [],
            failedRelayUrls: [],
            eventSourceRelayUrls: [],
          },
        }
      }
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
    options.fetchEventsWithDiagnostics ?? fetchPublicEventsWithDiagnostics
  const pendingRecoveryEvidence = declarationEvidenceCache.get(key)
  if (pendingRecoveryEvidence) {
    const reconciled = await reconcilePendingInboxCutoverReadbacks({
      pubkey: key,
      record: pendingRecoveryEvidence,
      fetchWithDiagnostics,
      repository,
      requestingAccountPubkey: options.requestingAccountPubkey,
      authenticatedPubkey: options.authenticatedPubkey,
      ownerSelectedRelayUrls: options.ownerSelectedRelayUrls ?? [],
      accountNetworkLocalStateRepository:
        options.accountNetworkLocalStateRepository,
      signal: options.signal,
      shouldContinue: options.shouldContinue,
      observedAt: fetchedAt,
      now,
    })
    declarationEvidenceCache.set(
      key,
      cloneInboxDeclarationEvidenceRecord(reconciled)
    )
  }
  const requestingAccountPubkey = normalizeInboxDeclarationEvidencePubkey(
    cacheKey(options.requestingAccountPubkey ?? "")
  )
  const authenticatedPubkey = normalizeInboxDeclarationEvidencePubkey(
    cacheKey(options.authenticatedPubkey ?? "")
  )
  const authenticatedOwnerPubkey =
    requestingAccountPubkey && authenticatedPubkey === requestingAccountPubkey
      ? requestingAccountPubkey
      : null
  const durableOwnerReadRelayUrls = options.relayUrls
    ? []
    : await readDurableOwnerReadRelayUrls(
        authenticatedOwnerPubkey,
        options.ownerRelayListEvidenceRepository
      )
  const relayCandidates =
    options.relayUrls && options.relayUrls.length > 0
      ? retainedRelayUrls(options.relayUrls)
      : inboxDiscoveryRelayCandidates(durableOwnerReadRelayUrls)
  const ownerSelectedRelayUrls = authenticatedOwnerPubkey
    ? retainedRelayUrls([
        ...durableOwnerReadRelayUrls,
        ...(options.ownerSelectedRelayUrls ?? []),
      ])
    : []
  const relayUrls = ownerAuthorizedDiscoveryRelayTargets(
    relayCandidates,
    ownerSelectedRelayUrls
  )

  let result: Awaited<ReturnType<typeof fetchPublicEventsWithDiagnostics>>
  try {
    result = await fetchWithDiagnostics(
      {
        kinds: [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
        authors: [key],
      },
      {
        relayUrls,
        relayTargets:
          options.relayTargets ??
          mergeRelayTargets(
            relayTargetsFromUrls(relayUrls, {
              kind: "discovery",
              operation: "read",
              registry: "inbox_10050",
            }),
            relayTargetsFromUrls(
              ownerSelectedRelayUrls.filter((url) => relayUrls.includes(url)),
              {
                kind: "owner_nip65",
                operation: "read",
                ownerPubkey: authenticatedOwnerPubkey ?? "",
                selection: "read",
              }
            )
          ),
        accountPubkey: requestingAccountPubkey,
        authenticatedPubkey,
        accountNetworkLocalStateRepository:
          options.accountNetworkLocalStateRepository,
        signal: options.signal,
        shouldContinue: options.shouldContinue,
        connectTimeoutMs: 3_000,
        fetchTimeoutMs: 6_000,
        maxEventsPerRelay: MAX_INBOX_DECLARATION_READ_EVENTS,
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
    }
  }
  result = reconcileAccountNetworkReadDiagnostics(result, relayUrls)

  const observationBase: InboxDeclarationObservation = {
    coverage: interpretAccountNetworkRead(relayUrls, result).coverage,
    sources: interpretAccountNetworkRead(relayUrls, result).sources,
    attemptedRelayUrls: retainedRelayUrls(result.attemptedRelayUrls),
    successfulRelayUrls: retainedRelayUrls(result.successfulRelayUrls),
    failedRelayUrls: retainedRelayUrls(result.failedRelayUrls),
    eventSourceRelayUrls: [],
  }

  const declarations = declarationEventsNewestFirst(result.events, key)
  const newest = declarations[0] ?? null
  if (!newest) {
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
    const facts = interpretAccountNetworkPreference({
      lookup: {
        observedAt: fetchedAt,
        coverage: observationBase.coverage,
        hadEvent: false,
      },
    })
    return {
      pubkey: key,
      state: facts.state,
      relayUrls: [],
      stale: facts.stale,
      evidence: facts,
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
          sources: observation.sources,
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
  relayTargets: RelayTarget[]
  relayUrls: string[]
  /**
   * Derived owner-selected subset for diagnostics. Executable authority is
   * carried by relayTargets and revalidated at final I/O.
   */
  ownerSelectedRelayUrls: string[]
  /** Per-relay provenance for diagnostics (content-free). */
  relaySources: Record<string, Exclude<InboxReadSource, "mixed">>
  /** Aggregate provenance of the plan. */
  source: InboxReadSource
}

export interface PlanInboxReadRelaysInput {
  declaration: InboxDeclarationResolution
  /** Exact authenticated inbox owner whose private/local relays may be read. */
  authenticatedPubkey?: string | null
  /** Bounded compatibility reads; defaults to config.commerceDmFallbackRelayUrls. */
  compatibilityRelayUrls?: readonly string[]
  /**
   * Compatibility write targets Conduit must also poll. Defaults to the
   * operator-approved order registry and may only select from the read set.
   */
  requiredCompatibilityRelayUrls?: readonly string[]
  /**
   * Total fanout target for optional compatibility reads. Current,
   * retained, recovery, and required compatibility targets are
   * never truncated to satisfy this target.
   */
  maxRelays?: number
}

/**
 * Permissive inbox read plan: union of prepared current/retained inbox relays,
 * active cutover recovery, and the
 * bounded compatibility read set. NIP-65 general reads are not inbox routes.
 * Recovery is read-only; writes use selectPrivateMessageDeliveryRoute. This
 * pure planner reads no process state.
 */
export function planInboxReadRelays(
  input: PlanInboxReadRelaysInput
): InboxReadPlan {
  const allowOwnerLocalRelays = allowsLocalRelayUrls(
    input.declaration.pubkey,
    input.authenticatedPubkey
  )
  const projectOwnerRelayUrls = allowOwnerLocalRelays
    ? retainedRelayUrls
    : publicRelayHintUrls
  const declared = projectOwnerRelayUrls(
    input.declaration.state === "declared" ? input.declaration.relayUrls : []
  )
  const cachedFallback = projectOwnerRelayUrls(
    input.declaration.retainedReadRelayUrls ?? []
  )
  const cutoverRecovery = projectOwnerRelayUrls(
    input.declaration.cutoverRecoveryRelayUrls ?? []
  )
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
  add(cutoverRecovery, "cutover_recovery")
  add(cachedFallback, "cache")
  // Reserve the write/read overlap before optional compatibility sources so
  // the fanout target cannot omit an approved order-delivery destination.
  add(requiredCompatibility, "compatibility")
  const optionalCapacity =
    input.maxRelays && input.maxRelays > 0
      ? Math.max(input.maxRelays - orderedUrls.length, 0)
      : Number.POSITIVE_INFINITY
  const optionalStart = orderedUrls.length
  add(remainingCompatibility, "compatibility")
  const relayUrls = [
    ...orderedUrls.slice(0, optionalStart),
    ...orderedUrls.slice(optionalStart, optionalStart + optionalCapacity),
  ]
  for (const relayUrl of orderedUrls.slice(relayUrls.length)) {
    delete relaySources[relayUrl]
  }

  const usedSources = new Set(relayUrls.map((url) => relaySources[url]))
  const source: InboxReadSource =
    usedSources.size > 1
      ? "mixed"
      : (relayUrls[0] && relaySources[relayUrls[0]]) || "compatibility"

  const ownerSelectedRelayUrlSet = new Set(
    allowOwnerLocalRelays
      ? retainedRelayUrls([...declared, ...cutoverRecovery, ...cachedFallback])
      : []
  )
  const ownerSelectedRelayUrls = relayUrls.filter((relayUrl) =>
    ownerSelectedRelayUrlSet.has(relayUrl)
  )

  const eligibleUrls = new Set(relayUrls)
  const relayTargets = mergeRelayTargets(
    relayTargetsFromUrls(declared, {
      kind: "owner_nip17",
      operation: "read",
      ownerPubkey: input.declaration.pubkey,
    }),
    relayTargetsFromUrls(cutoverRecovery, {
      kind: "recovery",
      operation: "read",
      ownerPubkey: input.declaration.pubkey,
    }),
    relayTargetsFromUrls(cachedFallback, {
      kind: "retained_inbox",
      operation: "read",
      ownerPubkey: input.declaration.pubkey,
    }),
    relayTargetsFromUrls(
      [...requiredCompatibility, ...remainingCompatibility],
      { kind: "compatibility", operation: "read", policy: "inbox_read" }
    )
  ).filter((target) => eligibleUrls.has(target.url))
  return {
    relayUrls,
    relayTargets,
    ownerSelectedRelayUrls,
    relaySources,
    source,
  }
}

/** Derive read coverage from fanout diagnostics. */
export function deriveInboxReadCoverage(diagnostics: {
  successfulRelayUrls: readonly string[]
  failedRelayUrls: readonly string[]
  cappedRelayUrls?: readonly string[]
}): InboxReadCoverage {
  return interpretAccountNetworkRead(
    [
      ...diagnostics.successfulRelayUrls,
      ...diagnostics.failedRelayUrls,
      ...(diagnostics.cappedRelayUrls ?? []),
    ],
    {
      events: [],
      successfulRelayUrls: [...diagnostics.successfulRelayUrls],
      failedRelayUrls: [...diagnostics.failedRelayUrls],
      cappedRelayUrls: [...(diagnostics.cappedRelayUrls ?? [])],
    }
  ).coverage
}

export interface DeliveryRouteSelection {
  relayTargets: RelayTarget[]
  route: PrivateMessageDeliveryRoute
  /** Exclusive write targets for the selected route; empty when blocked. */
  relayUrls: string[]
  /** Derived diagnostic subset; relayTargets carries executable authority. */
  ownerSelectedRelayUrls: string[]
  /** Content-free per-target routing evidence. */
  relaySources: Record<string, "declared" | CompatibilityOrderRelaySource>
  truncated: boolean
  /** Content-free reason for a blocked route. */
  blockedReason?:
    | "recipient_not_ready"
    | "recipient_lookup_failed"
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
  /** Authenticated account allowed to authorize its own self-copy targets. */
  authenticatedOwnerPubkey?: string | null
  /** Exact targets explicitly selected by that authenticated owner. */
  ownerSelectedRelayUrls?: readonly string[]
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
  const approved = secureAutomaticRelayUrls(input.approvedRelayUrls)
  const approvedSet = new Set(approved)
  const recipientMatches = secureAutomaticRelayUrls(
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

/** Validate a persisted exact plan against the operator-owned write registry. */
export function isApprovedCompatibilityOrderRelayPlan(
  relayUrls: readonly string[]
): boolean {
  if (
    relayUrls.length === 0 ||
    relayUrls.length > MAX_COMPATIBILITY_ORDER_RELAYS
  ) {
    return false
  }
  const approved = new Set(
    secureAutomaticRelayUrls(config.dmCompatibilityOrderRelayUrls)
  )
  return (
    new Set(relayUrls).size === relayUrls.length &&
    relayUrls.every(
      (relayUrl) =>
        secureAutomaticRelayUrls([relayUrl])[0] === relayUrl &&
        approved.has(relayUrl)
    )
  )
}

/**
 * Select the delivery lane for one outgoing private message.
 *
 * Invariants:
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
    const ownerContext = allowsLocalRelayUrls(
      declaration.pubkey,
      input.authenticatedOwnerPubkey
    )
    const exactOwnerRelayUrls = ownerContext
      ? retainedRelayUrls(input.ownerSelectedRelayUrls ?? [])
      : []
    const exactOwnerRelayUrlSet = new Set(exactOwnerRelayUrls)
    const secureRelayUrlSet = new Set(
      secureAutomaticRelayUrls(declaration.relayUrls)
    )
    const declaredRelayUrls = retainedRelayUrls(declaration.relayUrls).filter(
      (relayUrl) =>
        secureRelayUrlSet.has(relayUrl) || exactOwnerRelayUrlSet.has(relayUrl)
    )
    if (declaredRelayUrls.length === 0) {
      return {
        relayTargets: [],
        route: "blocked",
        relayUrls: [],
        ownerSelectedRelayUrls: [],
        relaySources: {},
        truncated: false,
        blockedReason: "declaration_malformed",
      }
    }
    const relayUrls = declaredRelayUrls.slice(
      0,
      MAX_DECLARED_INBOX_WRITE_RELAYS
    )
    const ownerSelectedRelayUrls = relayUrls.filter((relayUrl) =>
      exactOwnerRelayUrlSet.has(relayUrl)
    )
    return {
      relayTargets: relayTargetsFromUrls(
        relayUrls,
        ownerContext
          ? {
              kind: "owner_nip17",
              operation: "write",
              ownerPubkey: declaration.pubkey,
            }
          : {
              kind: "recipient_nip17",
              operation: "write",
              recipientPubkey: declaration.pubkey,
              eventId: declaration.eventId,
            }
      ),
      route: "declared_inbox",
      relayUrls,
      ownerSelectedRelayUrls,
      relaySources: Object.fromEntries(
        relayUrls.map((url) => [url, "declared"])
      ),
      truncated: declaredRelayUrls.length > relayUrls.length,
    }
  }
  if (declaration.state === "signed_empty") {
    return {
      relayTargets: [],
      route: "blocked",
      relayUrls: [],
      ownerSelectedRelayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: "declaration_signed_empty",
    }
  }
  if (declaration.state === "malformed") {
    return {
      relayTargets: [],
      route: "blocked",
      relayUrls: [],
      ownerSelectedRelayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: "declaration_malformed",
    }
  }

  const strictBlockedReason =
    declaration.state === "not_observed"
      ? ("recipient_not_ready" as const)
      : ("recipient_lookup_failed" as const)

  // Compatibility is a bounded bootstrap for a complete, fresh absence only.
  // Partial or unavailable evidence cannot prove that the recipient has no
  // private inbox declaration, so it must never authorize fallback writes.
  if (declaration.state !== "not_observed") {
    return {
      relayTargets: [],
      route: "blocked",
      relayUrls: [],
      ownerSelectedRelayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: strictBlockedReason,
    }
  }

  const isOrderMessage = input.rumorKind === EVENT_KINDS.ORDER
  if (!isOrderMessage || !input.validatedOrder) {
    return {
      relayTargets: [],
      route: "blocked",
      relayUrls: [],
      ownerSelectedRelayUrls: [],
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
      relayTargets: [],
      route: "blocked",
      relayUrls: [],
      ownerSelectedRelayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: strictBlockedReason,
    }
  }

  return {
    relayTargets: relayTargetsFromUrls(compatibilityPlan.relayUrls, {
      kind: "compatibility",
      operation: "write",
      policy: "order_delivery",
    }),
    route: "compatibility_order",
    relayUrls: compatibilityPlan.relayUrls,
    ownerSelectedRelayUrls: [],
    relaySources: compatibilityPlan.relaySources,
    truncated: compatibilityPlan.truncated,
  }
}
