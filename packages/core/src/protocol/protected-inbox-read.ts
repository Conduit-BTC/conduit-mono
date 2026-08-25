import {
  commerceRelayExecutor,
  type CommerceRelayExecutor,
  type RelayAuthOutcome,
  type RelayQueryResult,
} from "./relay-executor"
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
  relayUrls: string[]
  limit: number
  until?: number
  authorization: ProtectedReadAuthorization | null
  executor?: CommerceRelayExecutor
  signal?: AbortSignal
  connectTimeoutMs?: number
  queryTimeoutMs?: number
  authTimeoutMs?: number
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

  const executor = options.executor ?? commerceRelayExecutor
  const relayResult = await executor.query(
    {
      relayUrls: options.relayUrls,
      filters: [
        {
          kinds: [1_059],
          "#p": [principalPubkey],
          limit: options.limit,
          ...(options.until === undefined ? {} : { until: options.until }),
        },
      ],
      operation: "private_inbox_read",
    },
    {
      signal: options.signal,
      authorization: options.authorization,
      connectTimeoutMs: options.connectTimeoutMs,
      queryTimeoutMs: options.queryTimeoutMs,
      authTimeoutMs: options.authTimeoutMs,
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
