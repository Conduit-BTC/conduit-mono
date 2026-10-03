/** Plain signed-event publication with explicit relay policy and exact wire writes. */
import { getRelayLists } from "./relay-list"
import { recordRelayFailure, recordRelaySuccess } from "./relay-health"
import {
  planRelayReads,
  planRelayWrites,
  type RelayWriteIntent,
  type RelayWritePlan,
} from "./relay-planner"
import { EVENT_KINDS } from "./kinds"
import {
  assertSafeNip65RelayTags,
  getConfiguredIsolatedE2eRelayUrl,
  loadRelaySettingsPlanningSnapshot,
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  normalizeUntrustedRelayHintsForContext,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import { config } from "../config"
import {
  assertSafeReplaceablePublish,
  type ReplaceablePublishSafetyOptions,
} from "./replaceable-safety"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import type { OwnerRelayListEvidenceRepository } from "./owner-relay-list-evidence"
import {
  publishSignedEventFrameToRelay,
  type ExactRelayWriteStatus,
} from "./relay-writer"
import type { NostrEventSigner } from "./nostr-event-signer"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import {
  dexieAccountNetworkLocalStateRepository,
  filterEligibleAccountRelayUrls,
  orderEquivalentAccountRelayOperations,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { createDefaultAccountNetworkRoutingPolicy } from "./account-network-routing-policy"

const STANDARD_PUBLISH_TIMEOUT_MS = 5_000
const CRITICAL_PUBLISH_TIMEOUT_MS = 10_000
const CRITICAL_RETRY_PUBLISH_TIMEOUT_MS = 15_000

export interface PublishWithPlannerInput {
  intent: RelayWriteIntent
  authorPubkey?: string
  /** Authenticated pubkey whose own NIP-65 local relays may be used. */
  authenticatedPubkey?: string | null
  /**
   * Explicit account whose locally removed whole relays must be excluded at
   * each network attempt. This is intentionally independent from the event
   * author, recipients, and signer authority.
   */
  accountPubkey?: string | null
  /** Injectable durable-state reader for deterministic boundary tests. */
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  recipientPubkeys?: readonly string[]
  /**
   * Extra recipient relay hints (e.g. NIP-17 kind-10050 private-message inbox
   * relays) added as delivery targets alongside the planned NIP-65 set. Public
   * wss:// URLs are accepted automatically. Private/local URLs are accepted
   * only when the authenticated planner already selected the same relay.
   */
  extraRelayUrls?: readonly string[]
  /**
   * Publish only to these relays. This bypasses NIP-65 planning and fallback
   * fanout for protocols such as NIP-17 that define an exclusive relay set.
   */
  exclusiveRelayUrls?: readonly string[]
  /** Exact exclusive targets contributed by Conduit's app-owned layer. */
  appRelayUrls?: readonly string[]
  /** Exact exclusive targets contributed by the owner's NIP-65 layer. */
  personalRelayUrls?: readonly string[]
  /** Exact exclusive targets with authority outside both local source layers. */
  independentRelayUrls?: readonly string[]
  /**
   * Exact exclusive-target subset backed by this authenticated owner's own
   * Network selection. Recipient or discovered relay URLs must never populate
   * this field.
   */
  ownerSelectedRelayUrls?: readonly string[]
  /** Fetch missing NIP-65 hints before planning instead of cache-only lookup. */
  refreshRelayLists?: boolean
  /**
   * Critical writes are user-visible delivery jobs. They fan out to every
   * intended relay and include parked relays instead of silently applying the
   * normal small-batch health/cap policy.
   */
  deliveryMode?: "standard" | "critical"
  /** Disable per-relay health filtering (last-resort retries). */
  skipHealthFilter?: boolean
  /** Context for non-destructive replaceable-event publishes. */
  replaceableSafety?: ReplaceablePublishSafetyOptions
  /** Abort before a relay attempt when the caller's authenticated session changed. */
  shouldContinue?: () => boolean
  signal?: AbortSignal
  /**
   * Foreground-only NIP-42 capability for an exact NIP-17 recipient write.
   * This never enables fallback relays or ambient/background authentication.
   */
  relayAuthentication?: {
    expectedPubkey: string
    signer: NostrEventSigner
    sessionScope: object
    waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
  }
}

function hasAuthenticatedAuthorRelayContext(
  input: Pick<PublishWithPlannerInput, "authorPubkey" | "authenticatedPubkey">
): boolean {
  const authorPubkey = input.authorPubkey?.trim().toLowerCase()
  const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
  return (
    !!authorPubkey &&
    /^[0-9a-f]{64}$/.test(authorPubkey) &&
    authorPubkey === authenticatedPubkey
  )
}

function assertPublishSessionCurrent(
  shouldContinue: (() => boolean) | undefined
): void {
  if (shouldContinue?.() === false) {
    throw new Error("Publish cancelled because the signer session changed.")
  }
}

export interface PublishWithPlannerResult {
  plan: RelayWritePlan
  /** URLs the event was actually attempted on (primary + broadcast). */
  attemptedRelayUrls: string[]
  /** URLs that acknowledged this exact event. */
  successfulRelayUrls: string[]
  /** Targets that did not acknowledge; see relayAttempts for terminal outcomes. */
  failedRelayUrls: string[]
  /** Failed URLs that explicitly rejected the event rather than timing out. */
  rejectedRelayUrls?: string[]
  admittedRelayUrls?: string[]
  relayAttempts?: ProgressiveRelayPublishAttempt[]
  /** Content-free failure descriptions. */
  relayFailureMessages: Record<string, string>
}

export type ProgressiveRelayPublishStatus = ExactRelayWriteStatus

export interface ProgressiveRelayPublishAttempt {
  relayUrl: string
  eventId?: string
  attempt: number
  status: ProgressiveRelayPublishStatus
}

/** Preserve typed outcomes when projecting transport evidence into checkpoints. */
export function getRelayPublishTargetStatus(
  delivery: PublishWithPlannerResult,
  relayUrl: string
): ProgressiveRelayPublishStatus | "pending" {
  if (delivery.successfulRelayUrls.includes(relayUrl)) return "acked"
  const attempts = delivery.relayAttempts?.filter(
    (attempt) => attempt.relayUrl === relayUrl
  )
  if (attempts?.some((attempt) => attempt.status === "acked")) return "acked"
  if (
    "pendingRelayUrls" in delivery &&
    (delivery.pendingRelayUrls as string[]).includes(relayUrl)
  )
    return "pending"
  const latest = attempts?.at(-1)
  if (latest) return latest.status
  if (
    delivery.rejectedRelayUrls?.includes(relayUrl) ||
    /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i.test(
      delivery.relayFailureMessages[relayUrl]?.trim() ?? ""
    )
  )
    return "rejected"
  return "timed_out"
}

export interface ProgressivePublishSnapshot extends PublishWithPlannerResult {
  /** Relays whose current bounded attempt has not reached an outcome yet. */
  pendingRelayUrls: string[]
  /** Relays whose final attempt returned a machine-readable NIP-01 rejection. */
  rejectedRelayUrls: string[]
  /** Relays whose final attempt did not acknowledge before its deadline. */
  timedOutRelayUrls: string[]
  /** Relays whose final attempt failed before a relay outcome was available. */
  erroredRelayUrls: string[]
  /** Ordered, content-free outcomes for every bounded exact-relay attempt. */
  relayAttempts: ProgressiveRelayPublishAttempt[]
}

/**
 * Two milestones for one immutable exact-target publish fanout. `accepted`
 * resolves after the first positive relay acknowledgement and rejects only
 * after every bounded attempt finishes with zero acknowledgements. `settled`
 * always resolves with the complete per-relay outcome history.
 */
export interface ProgressivePublishMilestones {
  accepted: Promise<ProgressivePublishSnapshot>
  settled: Promise<ProgressivePublishSnapshot>
}

export class RelayPublishDiagnosticsError extends Error {
  readonly diagnostics: PublishWithPlannerResult
  readonly cause: unknown

  constructor(
    message: string,
    diagnostics: PublishWithPlannerResult,
    cause: unknown
  ) {
    super(message)
    this.name = "RelayPublishDiagnosticsError"
    this.diagnostics = {
      ...diagnostics,
      ...(diagnostics.relayAttempts
        ? {
            relayAttempts: diagnostics.relayAttempts.map(
              ({ relayUrl, attempt, status }) => ({
                relayUrl,
                attempt,
                status,
              })
            ),
          }
        : {}),
    }
    this.cause = cause
  }
}

function assertValidSignedPublicPublish(
  rawEvent: SignedPublicNostrEvent,
  input: PublishWithPlannerInput
): void {
  if (!isValidSignedPublicNostrEvent(rawEvent)) {
    throw new Error("Refusing to publish an invalid signed Nostr event.")
  }
  if (
    input.intent !== "author_event" &&
    input.intent !== "commerce_author_event"
  ) {
    return
  }
  const expectedAuthor = input.authorPubkey?.trim().toLowerCase()
  if (!expectedAuthor || rawEvent.pubkey.toLowerCase() !== expectedAuthor) {
    throw new Error(
      "Refusing to publish an event signed by a different account."
    )
  }
}

function assertRelayAuthenticationConfiguration(
  event: SignedPublicNostrEvent,
  input: PublishWithPlannerInput
): void {
  if (!input.relayAuthentication) return

  const expectedPubkey = input.relayAuthentication.expectedPubkey
    .trim()
    .toLowerCase()
  const authorPubkey = input.authorPubkey?.trim().toLowerCase()
  const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
  const accountPubkey = input.accountPubkey?.trim().toLowerCase()
  if (
    event.kind !== EVENT_KINDS.GIFT_WRAP ||
    input.intent !== "recipient_event" ||
    !input.exclusiveRelayUrls ||
    input.deliveryMode !== "critical" ||
    !/^[0-9a-f]{64}$/.test(expectedPubkey) ||
    authorPubkey !== expectedPubkey ||
    authenticatedPubkey !== expectedPubkey ||
    accountPubkey !== expectedPubkey ||
    typeof input.relayAuthentication.sessionScope !== "object" ||
    input.relayAuthentication.sessionScope === null ||
    (input.relayAuthentication.signer.authMethod !== "nip07" &&
      input.relayAuthentication.signer.authMethod !== "nip46")
  ) {
    throw new Error(
      "Relay authentication requires an active foreground account and exact recipient relay plan."
    )
  }
}

interface RelayPublishTestOverrides {
  planPublishRelays?: (
    input: PublishWithPlannerInput
  ) => Promise<RelayWritePlan>
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  ownerRelayListEvidenceRepository?: OwnerRelayListEvidenceRepository
  publishSignedEventFrameToRelay?: typeof publishSignedEventFrameToRelay
}

let testOverrides: RelayPublishTestOverrides = {}

export function __setRelayPublishTestOverrides(
  overrides: Partial<RelayPublishTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetRelayPublishTestOverrides(): void {
  testOverrides = {}
}

function normalizeOutcomeRelayUrl(url: string): string {
  const normalized = tryNormalizeRelayUrl(url)
  return normalized.ok ? normalized.url : url
}

function mergeUnique(urls: readonly string[][]): string[] {
  return Array.from(new Set(urls.flat()))
}

function mergeRelayFailureMessages(
  messages: readonly Record<string, string>[]
): Record<string, string> {
  return Object.assign({}, ...messages)
}

function mergePublishResults(
  results: readonly {
    successfulRelayUrls: readonly string[]
    failedRelayUrls: readonly string[]
    rejectedRelayUrls?: readonly string[]
    relayFailureMessages: Record<string, string>
    admittedRelayUrls?: string[]
    relayAttempts?: ProgressiveRelayPublishAttempt[]
  }[]
): {
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  rejectedRelayUrls: string[]
  admittedRelayUrls: string[]
  relayAttempts: ProgressiveRelayPublishAttempt[]
  relayFailureMessages: Record<string, string>
} {
  const successful = new Set<string>()
  const failed = new Set<string>()
  const rejected = new Set<string>()
  const relayFailureMessages: Record<string, string> = {}

  for (const result of results) {
    for (const url of result.successfulRelayUrls) {
      successful.add(url)
      failed.delete(url)
      rejected.delete(url)
      delete relayFailureMessages[url]
    }
    for (const url of result.failedRelayUrls) {
      if (successful.has(url)) continue
      failed.add(url)
      rejected.delete(url)
      relayFailureMessages[url] =
        result.relayFailureMessages[url] ?? "No acknowledgement before timeout"
    }
    for (const url of result.rejectedRelayUrls ?? []) {
      if (successful.has(url) || !failed.has(url)) continue
      rejected.add(url)
    }
  }

  return {
    admittedRelayUrls: mergeUnique(
      results.map((r) => r.admittedRelayUrls ?? [])
    ),
    relayAttempts: numberRelayAttempts(
      results.flatMap((r) => r.relayAttempts ?? [])
    ),
    successfulRelayUrls: Array.from(successful),
    failedRelayUrls: Array.from(failed),
    rejectedRelayUrls: Array.from(rejected),
    relayFailureMessages,
  }
}

function getAuthorEventFallbackRelayUrls(input: {
  eventKind: number | undefined
  intent: RelayWriteIntent
  attemptedRelayUrls: readonly string[]
}): string[] {
  if (
    input.intent !== "author_event" &&
    input.intent !== "commerce_author_event"
  ) {
    return []
  }

  const attempted = new Set(
    input.attemptedRelayUrls.map(normalizeOutcomeRelayUrl)
  )
  const publicRelayFallbackUrls =
    input.eventKind === EVENT_KINDS.RELAY_LIST
      ? []
      : config.corePublicFallbackRelayUrls.filter(
          (url) => !attempted.has(normalizeOutcomeRelayUrl(url))
        )
  const commerceDiscoveryRelayUrls =
    input.eventKind === EVENT_KINDS.PRODUCT
      ? config.commerceDiscoveryRelayUrls.filter(
          (url) => !attempted.has(normalizeOutcomeRelayUrl(url))
        )
      : []

  return input.intent === "commerce_author_event"
    ? mergeUnique([config.commerceRelayUrls])
    : mergeUnique([
        config.appWriteRelayUrls,
        commerceDiscoveryRelayUrls,
        publicRelayFallbackUrls,
      ])
}

function getCriticalRecipientFallbackRelayUrls(input: {
  intent: RelayWriteIntent
  attemptedRelayUrls: readonly string[]
}): string[] {
  if (input.intent !== "recipient_event") return []

  const attempted = new Set(
    input.attemptedRelayUrls.map(normalizeOutcomeRelayUrl)
  )

  return mergeUnique([
    config.appWriteRelayUrls,
    config.commerceDmFallbackRelayUrls,
  ]).filter((url) => !attempted.has(normalizeOutcomeRelayUrl(url)))
}

function createAuthorFallbackPublishError(
  primaryError: unknown,
  fallbackError: unknown
): Error {
  const fallbackMessage =
    fallbackError instanceof Error
      ? fallbackError.message
      : "fallback relays did not accept the event"
  const primaryMessage =
    primaryError instanceof Error ? primaryError.message : null

  return new Error(
    primaryMessage
      ? `Could not publish to configured or fallback relays. Configured relay error: ${primaryMessage}. Fallback relay error: ${fallbackMessage}`
      : `Could not publish to configured or fallback relays. Fallback relay error: ${fallbackMessage}`
  )
}

function formatRelayListForError(urls: readonly string[]): string {
  if (urls.length === 0) return "none"
  return urls.slice(0, 8).join(", ") + (urls.length > 8 ? ", ..." : "")
}

function formatRelayFailureListForError(
  urls: readonly string[],
  messages: Record<string, string>
): string {
  if (urls.length === 0) return "none"
  const formatted = urls.slice(0, 5).map((url) => {
    const message = messages[url]?.trim()
    return message ? `${url} (${message})` : url
  })
  return formatted.join(", ") + (urls.length > 5 ? ", ..." : "")
}

function createPublishDiagnosticsError(input: {
  message: string
  plan: RelayWritePlan
  attemptedRelayUrls: readonly string[]
  successfulRelayUrls: readonly string[]
  failedRelayUrls: readonly string[]
  rejectedRelayUrls?: readonly string[]
  relayFailureMessages: Record<string, string>
  thrown: unknown
  admittedRelayUrls?: string[]
  relayAttempts?: ProgressiveRelayPublishAttempt[]
}): RelayPublishDiagnosticsError {
  const details = [
    `Attempted: ${formatRelayListForError(input.attemptedRelayUrls)}.`,
    `ACKed: ${formatRelayListForError(input.successfulRelayUrls)}.`,
    `Failed: ${formatRelayFailureListForError(input.failedRelayUrls, input.relayFailureMessages)}.`,
    input.plan.parkedRelayUrls.length > 0
      ? `Parked before this attempt: ${formatRelayListForError(input.plan.parkedRelayUrls)}.`
      : null,
  ].filter(Boolean)

  return new RelayPublishDiagnosticsError(
    `${input.message} ${details.join(" ")}`,
    {
      plan: input.plan,
      admittedRelayUrls: input.admittedRelayUrls,
      relayAttempts: input.relayAttempts,
      attemptedRelayUrls: [...input.attemptedRelayUrls],
      successfulRelayUrls: [...input.successfulRelayUrls],
      failedRelayUrls: [...input.failedRelayUrls],
      rejectedRelayUrls: [...(input.rejectedRelayUrls ?? [])],
      relayFailureMessages: { ...input.relayFailureMessages },
    },
    input.thrown
  )
}

export async function publishSignedEventPlan(input: {
  event: SignedPublicNostrEvent
  onOutcome?: (
    outcome: ProgressiveRelayPublishAttempt,
    attempted: boolean
  ) => void
  shouldAuthenticate?: () => boolean
  onSignerFailure?: () => void
  relayUrls: readonly string[]
  /** Bound attempts after live account source-policy filtering. */
  maxRelayAttempts?: number
  requiredRelayCount: number
  timeoutMs: number
  accountPubkey?: string | null
  /** Active account required to exercise owner-selected ws:// authority. */
  authenticatedPubkey?: string | null
  /** Exact target subset selected by the authenticated account owner. */
  ownerSelectedRelayUrls?: readonly string[]
  /** Exact candidates contributed by Conduit's app-owned relay layer. */
  appRelayUrls?: readonly string[]
  /** Exact candidates contributed by the owner's NIP-65 relay layer. */
  personalRelayUrls?: readonly string[]
  /** Exact candidates independently authorized outside the local source layers. */
  independentRelayUrls?: readonly string[]
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  shouldContinue?: () => boolean
  signal?: AbortSignal
  relayAuthentication?: {
    expectedPubkey: string
    signer: NostrEventSigner
    sessionScope: object
    waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
  }
}): Promise<{
  attemptedRelayUrls: string[]
  admittedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  relayFailureMessages: Record<string, string>
  rejectedRelayUrls: string[]
  relayAttempts: ProgressiveRelayPublishAttempt[]
  thrown: unknown
}> {
  const event = snapshotSignedEvent(input.event)
  assertValidSignedPublicPublish(event, { intent: "recipient_event" })
  input = {
    ...input,
    event,
    relayUrls: [...input.relayUrls],
    ownerSelectedRelayUrls: input.ownerSelectedRelayUrls && [
      ...input.ownerSelectedRelayUrls,
    ],
    appRelayUrls: input.appRelayUrls && [...input.appRelayUrls],
    personalRelayUrls: input.personalRelayUrls && [...input.personalRelayUrls],
    independentRelayUrls: input.independentRelayUrls && [
      ...input.independentRelayUrls,
    ],
  }
  assertRelayAuthenticationConfiguration(event, {
    intent: "recipient_event",
    deliveryMode: "critical",
    exclusiveRelayUrls: input.relayUrls,
    authorPubkey: input.relayAuthentication?.expectedPubkey,
    ...input,
  })
  const targets = await resolveRelayPublishTargets(input)
  const attemptedRelayUrls: string[] = []
  const relayAttempts: ProgressiveRelayPublishAttempt[] = []
  let signerFailureSuppressed = false
  const attempt = async (relayUrl: string) => {
    let status: ProgressiveRelayPublishStatus
    try {
      const fresh =
        input.shouldContinue?.() === false || input.signal?.aborted
          ? { relayUrls: [] as string[] }
          : await resolveRelayPublishTargets({
              ...input,
              relayUrls: [relayUrl],
            })
      if (input.shouldContinue?.() === false || input.signal?.aborted)
        status = "cancelled"
      else if (!fresh.relayUrls.includes(relayUrl)) status = "policy_blocked"
      else if (signerFailureSuppressed) status = "auth_required"
      else {
        attemptedRelayUrls.push(relayUrl)
        status = await (
          testOverrides.publishSignedEventFrameToRelay ??
          publishSignedEventFrameToRelay
        )({
          relayUrl,
          signedEvent: input.event,
          timeoutMs: input.timeoutMs,
          shouldContinue: input.shouldContinue,
          signal: input.signal,
          beforeSend: async () =>
            (
              await resolveRelayPublishTargets({
                ...input,
                relayUrls: [relayUrl],
              })
            ).relayUrls.includes(relayUrl),
          authorization:
            input.relayAuthentication && input.shouldAuthenticate?.() !== false
              ? {
                  expectedPubkey: input.relayAuthentication.expectedPubkey,
                  signer: input.relayAuthentication.signer,
                  sessionScope: input.relayAuthentication.sessionScope,
                  waitForSignerVisibility:
                    input.relayAuthentication.waitForSignerVisibility,
                  shouldContinue: input.shouldContinue,
                  onSignerFailure: () => {
                    signerFailureSuppressed = true
                    input.onSignerFailure?.()
                  },
                }
              : undefined,
        })
      }
    } catch {
      status =
        input.shouldContinue?.() === false || input.signal?.aborted
          ? "cancelled"
          : "error"
    }
    const outcome = { relayUrl, eventId: input.event.id, attempt: 1, status }
    relayAttempts.push(outcome)
    input.onOutcome?.(outcome, attemptedRelayUrls.includes(relayUrl))
    if (status === "acked") recordRelaySuccess(relayUrl)
    // Local policy/executor and signer failures do not describe relay health.
    else if (status === "timed_out" || status === "rejected")
      recordRelayFailure(relayUrl)
  }
  for (const relayUrl of targets.blockedRelayUrls) {
    const outcome: ProgressiveRelayPublishAttempt = {
      relayUrl,
      eventId: event.id,
      attempt: 1,
      status: "policy_blocked",
    }
    relayAttempts.push(outcome)
    input.onOutcome?.(outcome, false)
  }
  if (input.relayAuthentication) {
    for (const url of targets.relayUrls) await attempt(url)
  } else await Promise.all(targets.relayUrls.map(attempt))
  const successfulRelayUrls = relayAttempts
    .filter((a) => a.status === "acked")
    .map((a) => a.relayUrl)
  const failed = relayAttempts.filter((a) => a.status !== "acked")
  return {
    attemptedRelayUrls,
    admittedRelayUrls: targets.relayUrls,
    successfulRelayUrls,
    failedRelayUrls: failed.map((a) => a.relayUrl),
    rejectedRelayUrls: failed
      .filter((a) => a.status === "rejected")
      .map((a) => a.relayUrl),
    relayFailureMessages: Object.fromEntries(
      failed.map((a) => [a.relayUrl, writeFailureMessage(a.status)])
    ),
    relayAttempts,
    thrown:
      successfulRelayUrls.length >= input.requiredRelayCount
        ? null
        : new Error(
            targets.relayUrls.length === 0 &&
              targets.candidateRelayUrls.length > 0
              ? "Refusing to publish because no account-eligible relay target remains."
              : "No required relay acknowledged the event."
          ),
  }
}

function writeFailureMessage(status: ProgressiveRelayPublishStatus): string {
  switch (status) {
    case "rejected":
      return "Relay rejected the event"
    case "cancelled":
      return "Publish cancelled because the signer session changed"
    case "policy_blocked":
      return "Relay no longer eligible"
    case "auth_required":
      return "Relay authorization unavailable"
    case "error":
      return "Relay write failed"
    default:
      return "No acknowledgement before timeout"
  }
}

async function resolveRelayPublishTargets(input: {
  relayUrls: readonly string[]
  /** Bound attempts after live account source-policy filtering. */
  maxRelayAttempts?: number
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  ownerSelectedRelayUrls?: readonly string[]
  appRelayUrls?: readonly string[]
  personalRelayUrls?: readonly string[]
  independentRelayUrls?: readonly string[]
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
}): Promise<{
  candidateRelayUrls: string[]
  orderedCandidateRelayUrls: string[]
  blockedRelayUrls: string[]
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  relayUrls: string[]
}> {
  const candidateRelayUrls =
    config.e2eRelayIsolationEnabled && input.relayUrls.length > 0
      ? (() => {
          const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
          if (!isolatedRelayUrl) {
            throw new Error(
              "E2E relay isolation requires one configured loopback relay"
            )
          }
          return [isolatedRelayUrl]
        })()
      : mergeUnique([
          input.relayUrls.map((url) => {
            const normalized = tryNormalizeRelayUrl(url)
            return normalized.ok ? normalized.url : url
          }),
        ])
  const ownerSelected =
    input.accountPubkey &&
    input.authenticatedPubkey?.trim().toLowerCase() ===
      input.accountPubkey.trim().toLowerCase()
      ? new Set(
          normalizeOwnerSelectedRelayUrls(input.ownerSelectedRelayUrls ?? [])
        )
      : new Set<string>()
  const safeCandidateRelayUrls = candidateRelayUrls.filter((url) => {
    const normalized = tryNormalizeRelayUrl(url)
    return (
      normalized.ok &&
      (config.e2eRelayIsolationEnabled
        ? normalized.url === getConfiguredIsolatedE2eRelayUrl()
        : Boolean(normalizePublicWebSocketUrl(normalized.url)) ||
          ownerSelected.has(normalized.url))
    )
  })
  const accountNetworkLocalStateRepository =
    input.accountNetworkLocalStateRepository ??
    testOverrides.accountNetworkLocalStateRepository
  const orderedCandidateRelayUrls =
    input.accountPubkey === undefined || input.accountPubkey === null
      ? safeCandidateRelayUrls
      : (
          await orderEquivalentAccountRelayOperations({
            accountPubkey: input.accountPubkey,
            operations: safeCandidateRelayUrls.map((relayUrl) => ({
              relayUrl,
              equivalenceKey: "final-publish-fanout",
              value: relayUrl,
            })),
            repository: accountNetworkLocalStateRepository,
          })
        ).map((operation) => operation.value)
  const eligibleRelayUrls =
    orderedCandidateRelayUrls.length === 0
      ? []
      : input.accountPubkey === undefined || input.accountPubkey === null
        ? normalizeSecureOrIsolatedE2eRelayUrls(orderedCandidateRelayUrls)
        : await filterEligibleAccountRelayUrls({
            accountPubkey: input.accountPubkey,
            authenticatedPubkey: input.authenticatedPubkey,
            candidateRelayUrls: orderedCandidateRelayUrls,
            ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
            appRelayUrls: input.appRelayUrls,
            personalRelayUrls: input.personalRelayUrls,
            independentRelayUrls: input.independentRelayUrls,
            repository: accountNetworkLocalStateRepository,
            propagatePolicyReadErrors: true,
          })
  const relayUrls =
    input.maxRelayAttempts && input.maxRelayAttempts > 0
      ? eligibleRelayUrls.slice(0, input.maxRelayAttempts)
      : eligibleRelayUrls
  const eligibleSet = new Set(eligibleRelayUrls)
  return {
    candidateRelayUrls,
    orderedCandidateRelayUrls,
    accountNetworkLocalStateRepository,
    relayUrls,
    blockedRelayUrls: candidateRelayUrls.filter((url) => !eligibleSet.has(url)),
  }
}

/**
 * Publish one already-signed gift wrap to one immutable exact-target plan.
 * The first relay ACK resolves the foreground milestone while the separate
 * settlement milestone retains every bounded relay outcome. No fallback or
 * target-plan widening is permitted.
 */
export async function publishWithPlannerProgressive(
  event: SignedPublicNostrEvent,
  input: PublishWithPlannerInput
): Promise<ProgressivePublishMilestones> {
  event = snapshotSignedEvent(event)
  input = snapshotPublishInput(input)
  if (
    event.kind !== EVENT_KINDS.GIFT_WRAP ||
    input.intent !== "recipient_event"
  ) {
    throw new Error(
      "Progressive publishing is limited to recipient gift-wrap delivery."
    )
  }
  if (!input.exclusiveRelayUrls) {
    throw new Error("Progressive publishing requires an exclusive relay plan.")
  }
  if (input.deliveryMode !== "critical") {
    throw new Error("Progressive publishing requires critical delivery mode.")
  }

  assertSafeReplaceablePublish(event, input.replaceableSafety)
  assertValidSignedPublicPublish(event, input)
  assertRelayAuthenticationConfiguration(event, input)
  assertPublishSessionCurrent(input.shouldContinue)

  const plan = await planPublishRelays(input)
  const ownerSelectedRelayUrls =
    hasAuthenticatedAuthorRelayContext(input) &&
    input.accountPubkey?.trim().toLowerCase() ===
      input.authenticatedPubkey?.trim().toLowerCase()
      ? normalizeOwnerSelectedRelayUrls(input.ownerSelectedRelayUrls ?? [])
      : []
  const targetInput = {
    relayUrls: plan.primaryCandidateRelayUrls ?? plan.primaryRelayUrls,
    maxRelayAttempts: plan.maxPrimaryRelayAttempts,
    accountPubkey: input.accountPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls,
    appRelayUrls: plan.appRelayUrls,
    personalRelayUrls: plan.personalRelayUrls,
    independentRelayUrls: plan.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
  }
  const targets = await resolveRelayPublishTargets(targetInput)
  if (targets.relayUrls.length === 0) {
    throw new Error(
      targets.candidateRelayUrls.length > 0 && input.accountPubkey != null
        ? "Refusing to publish because no account-eligible relay target remains."
        : "Refusing to publish without a valid exclusive relay target."
    )
  }

  // Target policy reads above are asynchronous. Recheck the live account
  // session before exposing milestones or opening an exact relay connection.
  assertPublishSessionCurrent(input.shouldContinue)

  const statuses = new Map<string, "pending" | ProgressiveRelayPublishStatus>(
    targets.relayUrls.map((relayUrl) => [relayUrl, "pending"])
  )
  const attemptedRelayUrls = new Set<string>()
  const relayFailureMessages: Record<string, string> = {}
  const relayAttempts: ProgressiveRelayPublishAttempt[] = []
  const attemptCounts = new Map<string, number>()
  let hasAccepted = false
  let resolveAccepted!: (snapshot: ProgressivePublishSnapshot) => void
  let rejectAccepted!: (error: unknown) => void
  const accepted = new Promise<ProgressivePublishSnapshot>(
    (resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    }
  )

  const snapshot = (): ProgressivePublishSnapshot => {
    const successfulRelayUrls: string[] = []
    const rejectedRelayUrls: string[] = []
    const timedOutRelayUrls: string[] = []
    const erroredRelayUrls: string[] = []
    const pendingRelayUrls: string[] = []

    for (const [relayUrl, status] of statuses) {
      if (status === "acked") successfulRelayUrls.push(relayUrl)
      else if (status === "rejected") rejectedRelayUrls.push(relayUrl)
      else if (status === "timed_out") timedOutRelayUrls.push(relayUrl)
      else if (status === "error") erroredRelayUrls.push(relayUrl)
      else if (status === "pending") pendingRelayUrls.push(relayUrl)
      else erroredRelayUrls.push(relayUrl)
    }

    return {
      plan,
      admittedRelayUrls: [...targets.relayUrls],
      attemptedRelayUrls: [...attemptedRelayUrls],
      successfulRelayUrls,
      failedRelayUrls: [
        ...rejectedRelayUrls,
        ...timedOutRelayUrls,
        ...erroredRelayUrls,
      ],
      rejectedRelayUrls,
      timedOutRelayUrls,
      erroredRelayUrls,
      pendingRelayUrls,
      relayFailureMessages: { ...relayFailureMessages },
      relayAttempts: relayAttempts.map((attempt) => ({ ...attempt })),
    }
  }

  const markUnattemptedErrors = (
    relayUrls: readonly string[],
    message: string
  ): void => {
    for (const relayUrl of relayUrls) {
      if (statuses.get(relayUrl) !== "pending") continue
      const status =
        input.shouldContinue?.() === false || input.signal?.aborted
          ? "cancelled"
          : "error"
      statuses.set(relayUrl, status)
      relayFailureMessages[relayUrl] = message
    }
  }
  const runRound = async (
    relayUrls: readonly string[],
    timeoutMs: number
  ): Promise<void> => {
    for (const relayUrl of relayUrls) {
      statuses.set(relayUrl, "pending")
      delete relayFailureMessages[relayUrl]
    }
    await publishSignedEventPlan({
      ...targetInput,
      event,
      relayUrls,
      timeoutMs,
      requiredRelayCount: 1,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
      relayAuthentication: input.relayAuthentication,
      shouldAuthenticate: () => !hasAccepted,
      onOutcome: (outcome, attempted) => {
        const relayUrl = outcome.relayUrl
        if (attempted) attemptedRelayUrls.add(relayUrl)
        const attempt = (attemptCounts.get(relayUrl) ?? 0) + 1
        attemptCounts.set(relayUrl, attempt)
        statuses.set(relayUrl, outcome.status)
        relayAttempts.push({ ...outcome, attempt })
        if (outcome.status === "acked") {
          delete relayFailureMessages[relayUrl]
          if (!hasAccepted) {
            hasAccepted = true
            resolveAccepted(snapshot())
          }
        } else
          relayFailureMessages[relayUrl] = writeFailureMessage(outcome.status)
      },
    })
  }

  const settled = (async (): Promise<ProgressivePublishSnapshot> => {
    await runRound(
      targets.relayUrls,
      input.relayAuthentication
        ? CRITICAL_RETRY_PUBLISH_TIMEOUT_MS
        : CRITICAL_PUBLISH_TIMEOUT_MS
    )

    // Preserve the existing bounded critical retry only for a complete
    // zero-ACK unauthenticated round. Re-evaluate live exclusions and source
    // switches without changing or widening the immutable target plan.
    if (
      !hasAccepted &&
      !input.relayAuthentication &&
      input.shouldContinue?.() !== false &&
      !input.signal?.aborted
    ) {
      const retryRelayUrls = targets.relayUrls.filter(
        (relayUrl) =>
          attemptedRelayUrls.has(relayUrl) &&
          statuses.get(relayUrl) !== "acked" &&
          statuses.get(relayUrl) !== "cancelled"
      )
      if (retryRelayUrls.length > 0) {
        await runRound(retryRelayUrls, CRITICAL_RETRY_PUBLISH_TIMEOUT_MS)
      }
    }

    const finalSnapshot = snapshot()
    if (!hasAccepted) {
      rejectAccepted(
        createPublishDiagnosticsError({
          message: "Could not publish to the required exclusive relay set.",
          plan,
          attemptedRelayUrls: finalSnapshot.attemptedRelayUrls,
          admittedRelayUrls: finalSnapshot.admittedRelayUrls,
          relayAttempts: finalSnapshot.relayAttempts,
          successfulRelayUrls: finalSnapshot.successfulRelayUrls,
          failedRelayUrls: finalSnapshot.failedRelayUrls,
          rejectedRelayUrls: finalSnapshot.rejectedRelayUrls,
          relayFailureMessages: finalSnapshot.relayFailureMessages,
          thrown: new Error("No relay acknowledged the event."),
        })
      )
    }
    return finalSnapshot
  })().catch((error) => {
    markUnattemptedErrors(targets.relayUrls, "Publish session changed")
    if (!hasAccepted) rejectAccepted(error)
    return snapshot()
  })

  return { accepted, settled }
}

export type ExclusiveRelayPublishStatus = ExactRelayWriteStatus

interface ExactRelayTargetInput {
  relayUrl: string
  authorPubkey: string
  /** Authenticated account whose authority is being exercised. */
  authenticatedPubkey?: string | null
  /** Exact target subset selected by that authenticated account owner. */
  ownerSelectedRelayUrls?: readonly string[]
  /** Exact target when it belongs to Conduit's app-owned relay layer. */
  appRelayUrls?: readonly string[]
  /** Exact target when it belongs to the owner's NIP-65 relay layer. */
  personalRelayUrls?: readonly string[]
  /** Exact target when another authority independently selected it. */
  independentRelayUrls?: readonly string[]
  /** Explicit account for last-mile whole-relay exclusion enforcement. */
  accountPubkey?: string | null
  /** Injectable durable-state reader for deterministic boundary tests. */
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  /** Abort before opening the exact socket when the caller's session changed. */
  shouldContinue?: () => boolean
  signal?: AbortSignal
}

export interface ExactRelayPublishInput extends ExactRelayTargetInput {
  signedEvent: SignedPublicNostrEvent
}

function resolveExactRelayTarget(input: ExactRelayTargetInput): string {
  const normalized = tryNormalizeRelayUrl(input.relayUrl)
  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  if (config.e2eRelayIsolationEnabled) {
    if (!normalized.ok || normalized.url !== isolatedRelayUrl) {
      throw new Error("Expected the configured E2E loopback relay target.")
    }
    return normalized.url
  }
  const allowAuthenticatedOwnerSelectedRelay =
    hasAuthenticatedAuthorRelayContext({
      authorPubkey: input.authorPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
    }) &&
    input.accountPubkey?.trim().toLowerCase() ===
      input.authenticatedPubkey?.trim().toLowerCase() &&
    normalizeOwnerSelectedRelayUrls(
      input.ownerSelectedRelayUrls ?? []
    ).includes(normalized.ok ? normalized.url : "")
  if (
    !normalized.ok ||
    (!normalizePublicWebSocketUrl(normalized.url) &&
      !allowAuthenticatedOwnerSelectedRelay)
  ) {
    throw new Error("Expected one valid public or authenticated relay target.")
  }
  return normalized.url
}

/**
 * Publish one already-signed author event to one exact relay target and return
 * a structured ACK/reject/timeout result. No fallback or plan recomputation is
 * allowed. Its isolated socket does not share NDK relay/session lifecycle, so
 * ambient resets cannot interrupt a durable retry in flight.
 */
export async function publishSignedEventToRelay(
  input: ExactRelayPublishInput
): Promise<ExclusiveRelayPublishStatus> {
  assertValidSignedPublicPublish(input.signedEvent, {
    intent: "author_event",
    authorPubkey: input.authorPubkey,
  })
  const signedEvent = snapshotSignedEvent(input.signedEvent)
  const candidateRelayUrl = resolveExactRelayTarget(input)
  const relayUrl =
    input.accountPubkey === undefined || input.accountPubkey === null
      ? candidateRelayUrl
      : (
          await filterEligibleAccountRelayUrls({
            accountPubkey: input.accountPubkey,
            authenticatedPubkey: input.authenticatedPubkey,
            candidateRelayUrls: [candidateRelayUrl],
            ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
            appRelayUrls: input.appRelayUrls,
            personalRelayUrls: input.personalRelayUrls,
            independentRelayUrls: input.independentRelayUrls,
            repository: input.accountNetworkLocalStateRepository,
          })
        )[0]
  if (!relayUrl) {
    throw new Error(
      "Refusing to publish because the exact relay is not eligible for this account."
    )
  }
  assertPublishSessionCurrent(input.shouldContinue)
  const result = await publishSignedEventPlan({
    ...input,
    event: signedEvent,
    relayUrls: [relayUrl],
    requiredRelayCount: 1,
    timeoutMs: CRITICAL_PUBLISH_TIMEOUT_MS,
  })
  return result.relayAttempts[0]?.status ?? "policy_blocked"
}

/**
 * Resolve a planner-driven relay set without publishing. Useful when callers
 * need to stage an immutable target plan before network I/O.
 */
export async function planPublishRelays(
  input: PublishWithPlannerInput
): Promise<RelayWritePlan> {
  if (input.exclusiveRelayUrls) {
    const ownerSelectedRelayUrls =
      hasAuthenticatedAuthorRelayContext(input) &&
      input.accountPubkey?.trim().toLowerCase() ===
        input.authenticatedPubkey?.trim().toLowerCase()
        ? normalizeOwnerSelectedRelayUrls(input.ownerSelectedRelayUrls ?? [])
        : []
    const ownerSelectedSet = new Set(ownerSelectedRelayUrls)
    const primaryRelayUrls = mergeUnique([
      normalizeSecureOrIsolatedE2eRelayUrls(input.exclusiveRelayUrls),
      normalizeOwnerSelectedRelayUrls(input.exclusiveRelayUrls).filter(
        (relayUrl) => ownerSelectedSet.has(relayUrl)
      ),
    ])
    const primaryRelayUrlSet = new Set(primaryRelayUrls)
    return {
      intent: input.intent,
      primaryRelayUrls,
      primaryCandidateRelayUrls: primaryRelayUrls,
      maxPrimaryRelayAttempts: primaryRelayUrls.length,
      broadcastRelayUrls: [],
      broadcastCandidateRelayUrls: [],
      parkedRelayUrls: [],
      appRelayUrls: normalizeSecureOrIsolatedE2eRelayUrls(
        input.appRelayUrls ?? []
      ).filter((relayUrl) => primaryRelayUrlSet.has(relayUrl)),
      personalRelayUrls: mergeUnique([
        normalizeSecureOrIsolatedE2eRelayUrls(input.personalRelayUrls ?? []),
        normalizeOwnerSelectedRelayUrls(input.personalRelayUrls ?? []).filter(
          (relayUrl) => ownerSelectedSet.has(relayUrl)
        ),
      ]).filter((relayUrl) => primaryRelayUrlSet.has(relayUrl)),
      independentRelayUrls: normalizeSecureOrIsolatedE2eRelayUrls(
        input.independentRelayUrls ?? []
      ).filter((relayUrl) => primaryRelayUrlSet.has(relayUrl)),
    }
  }

  const hintPubkeys = Array.from(
    new Set(
      [
        ...(input.authorPubkey ? [input.authorPubkey] : []),
        ...(input.recipientPubkeys ?? []),
      ]
        .map((p) => p.trim())
        .filter(Boolean)
    )
  )

  const settingsSnapshot = input.authenticatedPubkey
    ? await readDurableAccountRelaySettingsPlanningSnapshot(
        input.authenticatedPubkey,
        {
          evidenceRepository: testOverrides.ownerRelayListEvidenceRepository,
        }
      )
    : loadRelaySettingsPlanningSnapshot()
  const authenticatedOwner = input.authenticatedPubkey?.trim().toLowerCase()
  const policyAccount = input.accountPubkey?.trim().toLowerCase()
  const hasAuthenticatedOwnerContext = Boolean(
    authenticatedOwner && authenticatedOwner === policyAccount
  )
  const routingPolicy = hasAuthenticatedOwnerContext
    ? ((
        await (
          input.accountNetworkLocalStateRepository ??
          testOverrides.accountNetworkLocalStateRepository ??
          dexieAccountNetworkLocalStateRepository
        ).get(policyAccount!)
      )?.routingPolicy ?? createDefaultAccountNetworkRoutingPolicy())
    : undefined
  const ownerSelectedReadRelayUrls = hasAuthenticatedOwnerContext
    ? normalizeOwnerSelectedRelayUrls(
        settingsSnapshot.settings.entries.flatMap((entry) =>
          entry.readEnabled ? [entry.url] : []
        )
      )
    : []
  const ownerSelectedPlanningRelayUrls = hasAuthenticatedOwnerContext
    ? normalizeOwnerSelectedRelayUrls(
        settingsSnapshot.settings.entries.flatMap((entry) =>
          entry.readEnabled || entry.writeEnabled ? [entry.url] : []
        )
      )
    : []
  const relayListReadPlan = planRelayReads({
    intent: "relay_lists",
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: ownerSelectedReadRelayUrls,
    settings: settingsSnapshot.settings,
    signedRelayListAuthoritative: settingsSnapshot.signedRelayListAuthoritative,
    routingPolicy,
  })
  const relayLists =
    hintPubkeys.length > 0
      ? await getRelayLists(hintPubkeys, {
          relayUrls: relayListReadPlan.relayUrls,
          cacheOnly: input.refreshRelayLists !== true,
          allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
          accountPubkey: input.accountPubkey,
          authenticatedPubkey: input.authenticatedPubkey,
          ownerSelectedRelayUrls: ownerSelectedReadRelayUrls,
          appRelayUrls: relayListReadPlan.appRelayUrls,
          personalRelayUrls: relayListReadPlan.personalRelayUrls,
          independentRelayUrls: relayListReadPlan.independentRelayUrls,
          accountNetworkLocalStateRepository:
            input.accountNetworkLocalStateRepository,
          shouldContinue: input.shouldContinue,
          signal: input.signal,
        })
      : undefined

  return planRelayWrites({
    intent: input.intent,
    authorPubkey: input.authorPubkey,
    recipientPubkeys: input.recipientPubkeys,
    relayLists,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: ownerSelectedPlanningRelayUrls,
    settings: settingsSnapshot.settings,
    signedRelayListAuthoritative: settingsSnapshot.signedRelayListAuthoritative,
    routingPolicy,
    maxPrimaryRelays: input.deliveryMode === "critical" ? 0 : undefined,
    maxBroadcastRelays: input.deliveryMode === "critical" ? 0 : undefined,
    skipHealthFilter:
      input.skipHealthFilter ?? input.deliveryMode === "critical",
  })
}

/**
 * Publish a signed event to a planner-resolved relay set.
 *
 * Returns the resolved plan and the URL list that was attempted so callers
 * can surface diagnostics. Every network attempt uses either the resolved
 * plan or a preselected Conduit-configured fallback.
 *
 * Primary relays are the delivery requirement. Broadcast relays are diagnostic
 * best-effort fanout and must not make a recipient delivery look successful.
 */
export async function publishWithPlanner(
  event: SignedPublicNostrEvent,
  input: PublishWithPlannerInput
): Promise<PublishWithPlannerResult> {
  event = snapshotSignedEvent(event)
  input = snapshotPublishInput(input)
  if (
    event.kind === EVENT_KINDS.GIFT_WRAP &&
    input.exclusiveRelayUrls === undefined
  ) {
    throw new Error(
      "Gift wraps require an exclusive private-message relay plan."
    )
  }
  if (event.kind === EVENT_KINDS.RELAY_LIST) {
    assertSafeNip65RelayTags(event.tags ?? [])
  }
  assertSafeReplaceablePublish(event, input.replaceableSafety)
  assertValidSignedPublicPublish(event, input)

  assertRelayAuthenticationConfiguration(event, input)

  const assertShouldContinue = () =>
    assertPublishSessionCurrent(input.shouldContinue)

  const basePlan = structuredClone(
    input.exclusiveRelayUrls
      ? await planPublishRelays(input)
      : testOverrides.planPublishRelays
        ? await testOverrides.planPublishRelays(input)
        : await planPublishRelays(input)
  )
  const ownerSelectedPublishRelayUrls =
    !input.authenticatedPubkey ||
    input.accountPubkey?.trim().toLowerCase() !==
      input.authenticatedPubkey.trim().toLowerCase() ||
    !hasAuthenticatedAuthorRelayContext(input)
      ? []
      : input.exclusiveRelayUrls
        ? (() => {
            const exclusiveRelayUrls = new Set(
              normalizeOwnerSelectedRelayUrls(input.exclusiveRelayUrls)
            )
            return normalizeOwnerSelectedRelayUrls(
              input.ownerSelectedRelayUrls ?? []
            ).filter((relayUrl) => exclusiveRelayUrls.has(relayUrl))
          })()
        : normalizeOwnerSelectedRelayUrls(
            (
              await readDurableAccountRelaySettingsPlanningSnapshot(
                input.authenticatedPubkey,
                {
                  evidenceRepository:
                    testOverrides.ownerRelayListEvidenceRepository,
                }
              )
            ).settings.entries.flatMap((entry) =>
              entry.writeEnabled ? [entry.url] : []
            )
          )
  assertShouldContinue()
  const extraPrimaryRelayUrls = input.exclusiveRelayUrls
    ? []
    : normalizeUntrustedRelayHintsForContext({
        relayUrls: input.extraRelayUrls ?? [],
        approvedRelayUrls: [
          ...basePlan.primaryRelayUrls,
          ...basePlan.broadcastRelayUrls,
        ],
        allowApprovedPrivate: !!input.authenticatedPubkey,
      })
  const expandedPlan =
    extraPrimaryRelayUrls.length > 0
      ? {
          ...basePlan,
          primaryRelayUrls: mergeUnique([
            basePlan.primaryRelayUrls,
            extraPrimaryRelayUrls,
          ]),
          primaryCandidateRelayUrls: mergeUnique([
            basePlan.primaryCandidateRelayUrls ?? basePlan.primaryRelayUrls,
            extraPrimaryRelayUrls,
          ]),
          maxPrimaryRelayAttempts: mergeUnique([
            basePlan.primaryRelayUrls,
            extraPrimaryRelayUrls,
          ]).length,
        }
      : basePlan
  let plan = config.e2eRelayIsolationEnabled
    ? (() => {
        const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
        if (!isolatedRelayUrl) {
          throw new Error(
            "E2E relay isolation requires one configured loopback relay"
          )
        }
        return {
          ...expandedPlan,
          primaryRelayUrls: [isolatedRelayUrl],
          primaryCandidateRelayUrls: [isolatedRelayUrl],
          maxPrimaryRelayAttempts: 1,
          broadcastRelayUrls: [],
          broadcastCandidateRelayUrls: [],
          parkedRelayUrls: [],
        }
      })()
    : expandedPlan
  const plannedRelayUrls = Array.from(
    new Set([
      ...(plan.primaryCandidateRelayUrls ?? plan.primaryRelayUrls),
      ...(plan.broadcastCandidateRelayUrls ?? plan.broadcastRelayUrls),
    ])
  )
  let attemptedRelayUrls: string[] = []
  const authorFallbackAllowed =
    (input.intent !== "author_event" &&
      input.intent !== "commerce_author_event") ||
    plan.signedRelayListAuthoritative !== true

  const fixedFallbackRelayUrls =
    !input.exclusiveRelayUrls && authorFallbackAllowed
      ? getAuthorEventFallbackRelayUrls({
          eventKind: event.kind,
          intent: input.intent,
          attemptedRelayUrls: [],
        })
      : []
  const fixedRecipientFallbackRelayUrls =
    !input.exclusiveRelayUrls && input.deliveryMode === "critical"
      ? getCriticalRecipientFallbackRelayUrls({
          intent: input.intent,
          attemptedRelayUrls: [],
        })
      : []
  plan = {
    ...plan,
    fallbackRelayUrls: mergeUnique([
      fixedFallbackRelayUrls,
      fixedRecipientFallbackRelayUrls,
    ]),
  }
  if (plannedRelayUrls.length === 0) {
    if (input.exclusiveRelayUrls) {
      throw new Error(
        "Refusing to publish without a valid exclusive relay target."
      )
    }
    if (!authorFallbackAllowed) {
      throw new Error(
        "Refusing to publish because signed Network settings have no usable Publish relay."
      )
    }
    const fallbackRelayUrls = fixedFallbackRelayUrls
    if (fallbackRelayUrls.length > 0) {
      assertShouldContinue()
      const fallback = await publishSignedEventPlan({
        event,
        relayUrls: fallbackRelayUrls,
        requiredRelayCount: 1,
        timeoutMs:
          input.deliveryMode === "critical"
            ? CRITICAL_RETRY_PUBLISH_TIMEOUT_MS
            : STANDARD_PUBLISH_TIMEOUT_MS,
        accountPubkey: input.accountPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        ownerSelectedRelayUrls: ownerSelectedPublishRelayUrls,
        appRelayUrls: fallbackRelayUrls,
        personalRelayUrls: [],
        accountNetworkLocalStateRepository:
          input.accountNetworkLocalStateRepository,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
        relayAuthentication: input.relayAuthentication,
      })
      attemptedRelayUrls = mergeUnique([
        attemptedRelayUrls,
        fallback.attemptedRelayUrls,
      ])
      if (fallback.thrown) {
        throw createPublishDiagnosticsError({
          message:
            "Could not publish because no fallback relay accepted the event.",
          plan,
          attemptedRelayUrls,
          admittedRelayUrls: fallback.admittedRelayUrls,
          relayAttempts: fallback.relayAttempts,
          successfulRelayUrls: fallback.successfulRelayUrls,
          failedRelayUrls: fallback.failedRelayUrls,
          rejectedRelayUrls: fallback.rejectedRelayUrls,
          relayFailureMessages: fallback.relayFailureMessages,
          thrown: fallback.thrown,
        })
      }
      return {
        plan,
        attemptedRelayUrls,
        admittedRelayUrls: fallback.admittedRelayUrls,
        relayAttempts: fallback.relayAttempts,
        successfulRelayUrls: fallback.successfulRelayUrls,
        failedRelayUrls: fallback.failedRelayUrls,
        rejectedRelayUrls: fallback.rejectedRelayUrls,
        relayFailureMessages: fallback.relayFailureMessages,
      }
    }

    if (event.kind === EVENT_KINDS.RELAY_LIST) {
      throw new Error(
        "Refusing to publish NIP-65 relays without an explicit OUT relay target."
      )
    }

    throw new Error("Refusing to publish without an approved relay target.")
  }

  const publishTimeoutMs = input.relayAuthentication
    ? CRITICAL_RETRY_PUBLISH_TIMEOUT_MS
    : input.deliveryMode === "critical"
      ? CRITICAL_PUBLISH_TIMEOUT_MS
      : STANDARD_PUBLISH_TIMEOUT_MS
  assertShouldContinue()
  const primary = await publishSignedEventPlan({
    event,
    relayUrls: plan.primaryCandidateRelayUrls ?? plan.primaryRelayUrls,
    maxRelayAttempts: plan.maxPrimaryRelayAttempts,
    requiredRelayCount:
      (plan.primaryCandidateRelayUrls ?? plan.primaryRelayUrls).length > 0
        ? 1
        : 0,
    timeoutMs: publishTimeoutMs,
    accountPubkey: input.accountPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: ownerSelectedPublishRelayUrls,
    appRelayUrls: plan.appRelayUrls,
    personalRelayUrls: plan.personalRelayUrls,
    independentRelayUrls: plan.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
    relayAuthentication: input.relayAuthentication,
  })
  attemptedRelayUrls = mergeUnique([
    attemptedRelayUrls,
    primary.attemptedRelayUrls,
  ])

  if (primary.thrown) {
    if (input.shouldContinue?.() === false || input.signal?.aborted) {
      throw createPublishDiagnosticsError({
        ...primary,
        plan,
        message: "Publish cancelled before required relay acknowledgement.",
      })
    }
    let retry: Awaited<ReturnType<typeof publishSignedEventPlan>> | null = null
    const attemptedPrimary = new Set(primary.attemptedRelayUrls)
    const retryRelayUrls = primary.failedRelayUrls.filter((url) =>
      attemptedPrimary.has(url)
    )

    if (
      input.deliveryMode === "critical" &&
      retryRelayUrls.length > 0 &&
      !input.relayAuthentication
    ) {
      assertShouldContinue()
      retry = await publishSignedEventPlan({
        event,
        relayUrls: retryRelayUrls,
        requiredRelayCount: 1,
        timeoutMs: CRITICAL_RETRY_PUBLISH_TIMEOUT_MS,
        accountPubkey: input.accountPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        ownerSelectedRelayUrls: ownerSelectedPublishRelayUrls,
        appRelayUrls: plan.appRelayUrls,
        personalRelayUrls: plan.personalRelayUrls,
        independentRelayUrls: plan.independentRelayUrls,
        accountNetworkLocalStateRepository:
          input.accountNetworkLocalStateRepository,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
      })
      attemptedRelayUrls = mergeUnique([
        attemptedRelayUrls,
        retry.attemptedRelayUrls,
      ])

      if (!retry.thrown) {
        const merged = mergePublishResults([primary, retry])
        return {
          plan,
          attemptedRelayUrls,
          admittedRelayUrls: merged.admittedRelayUrls,
          relayAttempts: merged.relayAttempts,
          successfulRelayUrls: merged.successfulRelayUrls,
          failedRelayUrls: merged.failedRelayUrls,
          rejectedRelayUrls: merged.rejectedRelayUrls,
          relayFailureMessages: merged.relayFailureMessages,
        }
      }
    }

    const fallbackRelayUrls = authorFallbackAllowed
      ? fixedFallbackRelayUrls
      : []
    const criticalRecipientFallbackRelayUrls =
      input.deliveryMode === "critical" ? fixedRecipientFallbackRelayUrls : []
    const retryResults = retry ? [primary, retry] : [primary]
    const retryRelayFailureMessages = mergeRelayFailureMessages(
      retryResults.map((result) => result.relayFailureMessages)
    )
    const retrySuccessfulRelayUrls = mergeUnique(
      retryResults.map((result) => result.successfulRelayUrls)
    )

    if (input.exclusiveRelayUrls) {
      const merged = mergePublishResults(retryResults)
      throw createPublishDiagnosticsError({
        message: "Could not publish to the required exclusive relay set.",
        plan,
        attemptedRelayUrls,
        admittedRelayUrls: merged.admittedRelayUrls,
        relayAttempts: merged.relayAttempts,
        successfulRelayUrls: merged.successfulRelayUrls,
        failedRelayUrls: merged.failedRelayUrls,
        rejectedRelayUrls: merged.rejectedRelayUrls,
        relayFailureMessages: merged.relayFailureMessages,
        thrown: retry?.thrown ?? primary.thrown,
      })
    }

    if (
      (fallbackRelayUrls.length > 0 ||
        criticalRecipientFallbackRelayUrls.length > 0) &&
      input.shouldContinue?.() !== false &&
      !input.signal?.aborted
    ) {
      assertShouldContinue()
      const fallbackAttemptRelayUrls = mergeUnique([
        fallbackRelayUrls,
        criticalRecipientFallbackRelayUrls,
      ])
      const fallback = await publishSignedEventPlan({
        event,
        relayUrls: fallbackAttemptRelayUrls,
        requiredRelayCount: 1,
        timeoutMs:
          input.deliveryMode === "critical"
            ? CRITICAL_RETRY_PUBLISH_TIMEOUT_MS
            : STANDARD_PUBLISH_TIMEOUT_MS,
        accountPubkey: input.accountPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        ownerSelectedRelayUrls: ownerSelectedPublishRelayUrls,
        appRelayUrls: fallbackAttemptRelayUrls,
        personalRelayUrls: [],
        accountNetworkLocalStateRepository:
          input.accountNetworkLocalStateRepository,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
      })
      attemptedRelayUrls = mergeUnique([
        attemptedRelayUrls,
        fallback.attemptedRelayUrls,
      ])
      const merged = mergePublishResults([...retryResults, fallback])

      if (!fallback.thrown) {
        return {
          plan,
          attemptedRelayUrls,
          admittedRelayUrls: merged.admittedRelayUrls,
          relayAttempts: merged.relayAttempts,
          successfulRelayUrls: merged.successfulRelayUrls,
          failedRelayUrls: merged.failedRelayUrls,
          rejectedRelayUrls: merged.rejectedRelayUrls,
          relayFailureMessages: merged.relayFailureMessages,
        }
      }

      throw createPublishDiagnosticsError({
        message: createAuthorFallbackPublishError(
          primary.thrown,
          fallback.thrown
        ).message,
        plan,
        attemptedRelayUrls,
        admittedRelayUrls: merged.admittedRelayUrls,
        relayAttempts: merged.relayAttempts,
        successfulRelayUrls: merged.successfulRelayUrls,
        failedRelayUrls: merged.failedRelayUrls,
        rejectedRelayUrls: merged.rejectedRelayUrls,
        relayFailureMessages: merged.relayFailureMessages,
        thrown: fallback.thrown,
      })
    }

    const merged = mergePublishResults(retryResults)
    throw createPublishDiagnosticsError({
      message: "Could not publish because no primary relay accepted the event.",
      plan,
      attemptedRelayUrls,
      admittedRelayUrls: merged.admittedRelayUrls,
      relayAttempts: merged.relayAttempts,
      successfulRelayUrls:
        merged.successfulRelayUrls.length > 0
          ? merged.successfulRelayUrls
          : retrySuccessfulRelayUrls,
      failedRelayUrls: merged.failedRelayUrls,
      rejectedRelayUrls: merged.rejectedRelayUrls,
      relayFailureMessages:
        Object.keys(merged.relayFailureMessages).length > 0
          ? merged.relayFailureMessages
          : retryRelayFailureMessages,
      thrown: retry?.thrown ?? primary.thrown,
    })
  }

  if (input.shouldContinue?.() === false) {
    return {
      plan,
      attemptedRelayUrls,
      admittedRelayUrls: primary.admittedRelayUrls,
      relayAttempts: primary.relayAttempts,
      successfulRelayUrls: primary.successfulRelayUrls,
      failedRelayUrls: primary.failedRelayUrls,
      rejectedRelayUrls: primary.rejectedRelayUrls,
      relayFailureMessages: primary.relayFailureMessages,
    }
  }
  const broadcastRelayUrls = mergeUnique([
    plan.broadcastCandidateRelayUrls ?? plan.broadcastRelayUrls,
  ])
  let broadcast: Awaited<ReturnType<typeof publishSignedEventPlan>>
  try {
    broadcast = await publishSignedEventPlan({
      event,
      relayUrls: broadcastRelayUrls,
      maxRelayAttempts: plan.maxBroadcastRelayAttempts,
      requiredRelayCount: broadcastRelayUrls.length > 0 ? 1 : 0,
      timeoutMs: publishTimeoutMs,
      accountPubkey: input.accountPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      ownerSelectedRelayUrls: ownerSelectedPublishRelayUrls,
      appRelayUrls: plan.appRelayUrls,
      personalRelayUrls: plan.personalRelayUrls,
      independentRelayUrls: plan.independentRelayUrls,
      accountNetworkLocalStateRepository:
        input.accountNetworkLocalStateRepository,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
  } catch {
    // Optional broadcast cannot revoke a primary ACK. A failed initial
    // policy read admits no targets and performs no broadcast socket I/O.
    const status =
      input.shouldContinue?.() === false || input.signal?.aborted
        ? "cancelled"
        : "error"
    broadcast = {
      attemptedRelayUrls: [],
      admittedRelayUrls: [],
      successfulRelayUrls: [],
      failedRelayUrls: broadcastRelayUrls,
      rejectedRelayUrls: [],
      relayAttempts: broadcastRelayUrls.map((relayUrl) => ({
        relayUrl,
        eventId: event.id,
        attempt: 1,
        status,
      })),
      relayFailureMessages: Object.fromEntries(
        broadcastRelayUrls.map((url) => [url, writeFailureMessage(status)])
      ),
      thrown: new Error("Best-effort broadcast did not complete."),
    }
  }
  attemptedRelayUrls = mergeUnique([
    attemptedRelayUrls,
    broadcast.attemptedRelayUrls,
  ])

  const merged = mergePublishResults([primary, broadcast])
  return {
    plan,
    attemptedRelayUrls,
    admittedRelayUrls: merged.admittedRelayUrls,
    relayAttempts: merged.relayAttempts,
    successfulRelayUrls: merged.successfulRelayUrls,
    failedRelayUrls: merged.failedRelayUrls,
    rejectedRelayUrls: merged.rejectedRelayUrls,
    relayFailureMessages: merged.relayFailureMessages,
  }
}

function snapshotSignedEvent(
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  const snapshot = structuredClone(event)
  for (const tag of snapshot.tags) Object.freeze(tag)
  Object.freeze(snapshot.tags)
  return Object.freeze(snapshot)
}

function snapshotPublishInput(
  input: PublishWithPlannerInput
): PublishWithPlannerInput {
  return {
    ...input,
    recipientPubkeys: input.recipientPubkeys && [...input.recipientPubkeys],
    extraRelayUrls: input.extraRelayUrls && [...input.extraRelayUrls],
    exclusiveRelayUrls: input.exclusiveRelayUrls && [
      ...input.exclusiveRelayUrls,
    ],
    appRelayUrls: input.appRelayUrls && [...input.appRelayUrls],
    personalRelayUrls: input.personalRelayUrls && [...input.personalRelayUrls],
    independentRelayUrls: input.independentRelayUrls && [
      ...input.independentRelayUrls,
    ],
    ownerSelectedRelayUrls: input.ownerSelectedRelayUrls && [
      ...input.ownerSelectedRelayUrls,
    ],
  }
}

function numberRelayAttempts(
  attempts: ProgressiveRelayPublishAttempt[]
): ProgressiveRelayPublishAttempt[] {
  const counts = new Map<string, number>()
  return attempts.map((outcome) => {
    const key = `${outcome.eventId}:${outcome.relayUrl}`
    const attempt = (counts.get(key) ?? 0) + 1
    counts.set(key, attempt)
    return { ...outcome, attempt }
  })
}
