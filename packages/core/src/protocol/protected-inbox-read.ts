import {
  commerceRelayExecutor,
  type CommerceRelayExecutor,
  type RelayAuthOutcome,
  type RelayQueryResult,
} from "./relay-executor"
import {
  filterEligibleAccountRelayTargets,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import {
  mergeRelayTargets,
  selectRelayTargets,
  type RelayTarget,
} from "./relay-authority"
import type { SignedNostrEvent } from "./nostr-event-signer"
import type { ProtectedReadAuthorization } from "./protected-read-authorization"

export type ProtectedInboxCoverage = "complete" | "partial" | "unavailable"

export interface ProtectedInboxAuthSummary {
  state: "not_challenged" | "authenticated" | "partial" | "unavailable"
  challengedCount: number
  succeededCount: number
  failedCount: number
  failure?: Exclude<RelayAuthOutcome, "not_challenged" | "succeeded">
}

export interface ProtectedInboxReadResult {
  events: SignedNostrEvent[]
  coverage: ProtectedInboxCoverage
  auth: ProtectedInboxAuthSummary
  relayResult: Omit<RelayQueryResult, "events">
}

export interface ReadProtectedInboxOptions {
  principalPubkey: string
  transport?: "nip17" | "nip04_incoming" | "nip04_outgoing"
  relayUrls: string[]
  /** Exact read grants; required for account-scoped protected I/O. */
  relayTargets?: readonly RelayTarget[]
  /** Optional full signed event ID; only narrows the protected kind-1059/#p read. */
  eventId?: string
  /** Inclusive NIP-01 time bounds for bounded recipient-scoped history reads. */
  since?: number
  until?: number
  limit: number
  authorization: ProtectedReadAuthorization | null
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  ownerRelayListEvidenceRepository?: Parameters<
    typeof filterEligibleAccountRelayTargets
  >[0]["ownerRelayListEvidenceRepository"]
  inboxDeclarationEvidenceRepository?: Parameters<
    typeof filterEligibleAccountRelayTargets
  >[0]["inboxDeclarationEvidenceRepository"]
  executor?: CommerceRelayExecutor
  signal?: AbortSignal
  connectTimeoutMs?: number
  queryTimeoutMs?: number
  authTimeoutMs?: number
  /** Called per valid recipient wrapper; caller must still treat coverage separately. */
  onEvent?: (event: SignedNostrEvent) => void
}

function emptyUnavailableResult(
  relayCount: number,
  failure: "signer_unavailable" | "authority_changed"
): ProtectedInboxReadResult {
  const authFailure: ProtectedInboxAuthSummary["failure"] = failure
  return {
    events: [],
    coverage: "unavailable",
    auth: {
      state: "unavailable",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: relayCount,
      failure: authFailure,
    },
    relayResult: {
      status: "unavailable",
      observations: [],
      relays: [],
      attemptedCount: 0,
      completedCount: 0,
      failedCount: relayCount,
      authoritativeEmpty: false,
    },
  }
}

function summarizeAuthentication(
  result: RelayQueryResult
): ProtectedInboxAuthSummary {
  const challengedRelayIndexes = new Set(
    result.observations.flatMap((observation) =>
      observation.type === "auth" &&
      observation.state !== "not_challenged" &&
      observation.state !== "authentication_required"
        ? [observation.relayIndex]
        : []
    )
  )
  const challenged = result.relays.filter((relay) =>
    challengedRelayIndexes.has(relay.relayIndex)
  )
  const succeededCount = result.relays.filter(
    (relay) => relay.auth === "succeeded"
  ).length
  const failed = result.relays.filter(
    (relay) =>
      relay.auth !== "not_challenged" &&
      relay.auth !== "succeeded" &&
      relay.auth !== "authentication_pending"
  )
  const failure = failed[0]?.auth as ProtectedInboxAuthSummary["failure"]
  if (challenged.length === 0 && succeededCount === 0 && failed.length === 0) {
    return {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    }
  }
  return {
    state:
      failed.length === 0 && succeededCount > 0
        ? "authenticated"
        : succeededCount > 0
          ? "partial"
          : "unavailable",
    challengedCount: challengedRelayIndexes.size,
    succeededCount,
    failedCount: failed.length,
    failure,
  }
}

/**
 * The first NDK-neutral protected-read service. Its only legal filter is the
 * active account's recipient-scoped kind-1059 inbox.
 */
export async function readProtectedInbox(
  options: ReadProtectedInboxOptions
): Promise<ProtectedInboxReadResult> {
  const principalPubkey = options.principalPubkey.trim().toLowerCase()
  const eventId = options.eventId?.trim().toLowerCase()
  if (eventId !== undefined && !/^[0-9a-f]{64}$/.test(eventId)) {
    throw new Error("Protected inbox event ID is invalid.")
  }
  if (
    (options.since !== undefined &&
      (!Number.isSafeInteger(options.since) || options.since < 0)) ||
    (options.until !== undefined &&
      (!Number.isSafeInteger(options.until) || options.until < 0)) ||
    (options.since !== undefined &&
      options.until !== undefined &&
      options.since > options.until)
  ) {
    throw new Error("Protected inbox time range is invalid.")
  }
  if (!/^[0-9a-f]{64}$/.test(principalPubkey)) {
    return emptyUnavailableResult(options.relayUrls.length, "authority_changed")
  }
  if (
    !options.authorization ||
    options.authorization.expectedPubkey !== principalPubkey
  ) {
    return emptyUnavailableResult(
      options.relayUrls.length,
      "signer_unavailable"
    )
  }

  // Whole-relay removal is an account-local authority cutoff. Re-read it at
  // the last admission boundary so another tab can stop future protected
  // reads without interrupting work that was already admitted.
  const protectedTargets = mergeRelayTargets(options.relayTargets ?? []).map(
    (target) => ({
      url: target.url,
      grants: target.grants.filter((grant) =>
        options.transport && options.transport !== "nip17"
          ? grant.kind === "owner_nip65" ||
            grant.kind === "app" ||
            (grant.kind === "compatibility" && grant.policy === "inbox_read")
          : grant.kind === "owner_nip17" ||
            grant.kind === "retained_inbox" ||
            grant.kind === "recovery" ||
            (grant.kind === "app" && grant.bucket === "inbox_read") ||
            (grant.kind === "compatibility" && grant.policy === "inbox_read")
      ),
    })
  )
  const eligibleRelayTargets = await filterEligibleAccountRelayTargets({
    accountPubkey: principalPubkey,
    authenticatedPubkey: options.authorization.expectedPubkey,
    targets: selectRelayTargets(protectedTargets, options.relayUrls),
    operation: "read",
    repository: options.accountNetworkLocalStateRepository,
    ownerRelayListEvidenceRepository: options.ownerRelayListEvidenceRepository,
    inboxDeclarationEvidenceRepository:
      options.inboxDeclarationEvidenceRepository,
  })
  const eligibleRelayUrls = eligibleRelayTargets.map((target) => target.url)
  if (eligibleRelayUrls.length === 0) {
    return emptyUnavailableResult(0, "authority_changed")
  }

  const executor = options.executor ?? commerceRelayExecutor
  const relayResult = await executor.query(
    {
      relayUrls: eligibleRelayUrls,
      filters: [
        {
          kinds: [
            options.transport && options.transport !== "nip17" ? 4 : 1_059,
          ],
          ...(options.transport === "nip04_outgoing"
            ? { authors: [principalPubkey] }
            : { "#p": [principalPubkey] }),
          ...(eventId ? { ids: [eventId] } : {}),
          ...(options.since === undefined ? {} : { since: options.since }),
          ...(options.until === undefined ? {} : { until: options.until }),
          limit: options.limit,
          ...(options.since === undefined ? {} : { since: options.since }),
          ...(options.until === undefined ? {} : { until: options.until }),
        },
      ],
      operation:
        options.transport && options.transport !== "nip17"
          ? "legacy_inbox_read"
          : "private_inbox_read",
    },
    {
      signal: options.signal,
      authorization: options.authorization,
      admitRelay: async (relayUrl) =>
        (
          await filterEligibleAccountRelayTargets({
            accountPubkey: principalPubkey,
            authenticatedPubkey: options.authorization!.expectedPubkey,
            targets: eligibleRelayTargets.filter(
              (target) => target.url === relayUrl
            ),
            operation: "read",
            repository: options.accountNetworkLocalStateRepository,
            ownerRelayListEvidenceRepository:
              options.ownerRelayListEvidenceRepository,
            inboxDeclarationEvidenceRepository:
              options.inboxDeclarationEvidenceRepository,
          })
        ).length > 0,
      connectTimeoutMs: options.connectTimeoutMs,
      queryTimeoutMs: options.queryTimeoutMs,
      authTimeoutMs: options.authTimeoutMs,
      onProtectedEvent: options.onEvent,
    }
  )
  const { events, ...relayDiagnostics } = relayResult
  return {
    events,
    coverage:
      relayResult.status === "success"
        ? "complete"
        : relayResult.status === "partial"
          ? "partial"
          : "unavailable",
    auth: summarizeAuthentication(relayResult),
    relayResult: relayDiagnostics,
  }
}
