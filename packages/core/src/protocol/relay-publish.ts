/**
 * Write-side glue between the relay planner and NDK's publish pipeline.
 *
 * Callers describe an intent (author-only event, or recipient-aware event)
 * and we resolve a relay set from cached NIP-65 hints + user write settings,
 * then publish to that explicit set instead of NDK's pool default.
 */

import {
  NDKPublishError,
  NDKRelaySet,
  type NDKEvent,
  type NDKRelay,
} from "@nostr-dev-kit/ndk"
import { getNdk } from "./ndk"
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
  type ExactRelayWriteAuthorization,
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
  /** URLs that acknowledged the publish. Empty on fallback path. */
  successfulRelayUrls: string[]
  /** URLs that failed (rejection or no ack). Empty on fallback path. */
  failedRelayUrls: string[]
  /** Failed URLs that explicitly rejected the event rather than timing out. */
  rejectedRelayUrls?: string[]
  /** Per-relay failure detail when NDK exposes a rejection reason. */
  relayFailureMessages: Record<string, string>
}

export type ProgressiveRelayPublishStatus = ExactRelayWriteStatus | "error"

export interface ProgressiveRelayPublishAttempt {
  relayUrl: string
  attempt: number
  status: ProgressiveRelayPublishStatus
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
    this.diagnostics = diagnostics
    this.cause = cause
  }
}

function assertValidSignedPublish(
  event: NDKEvent,
  input: PublishWithPlannerInput
): void {
  let rawEvent: SignedPublicNostrEvent
  try {
    rawEvent = event.rawEvent() as SignedPublicNostrEvent
  } catch {
    throw new Error("Refusing to publish an invalid signed Nostr event.")
  }
  assertValidSignedPublicPublish(rawEvent, input)
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
  event: NDKEvent,
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
  getNdk?: typeof getNdk
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

function relayUrl(relay: NDKRelay): string | undefined {
  // NDKRelay exposes `url` via its WebSocket-like getter; guard for safety.
  const url = (relay as unknown as { url?: string }).url
  if (typeof url !== "string" || url.length === 0) return undefined
  return normalizeOutcomeRelayUrl(url)
}

function collectRelayUrls(relays: Iterable<NDKRelay>): Set<string> {
  const urls = new Set<string>()
  for (const relay of relays) {
    const url = relayUrl(relay)
    if (url) urls.add(url)
  }
  return urls
}

function normalizeOutcomeRelayUrl(url: string): string {
  const normalized = tryNormalizeRelayUrl(url)
  return normalized.ok ? normalized.url : url
}

/**
 * Pure: derive successful/failed URL sets from an attempted set plus
 * NDK's per-relay outcome reporting.
 *
 *  - On success path (no throw), `publishedRelays` is the set NDK confirms.
 *    Anything in `attemptedRelayUrls` not present there is considered failed.
 *  - On the `NDKPublishError` path, NDK's `publishedToRelays` (acked despite
 *    overall partial failure) wins; relays in `errors` are failures; remaining
 *    attempted relays default to failure (timeout / dropped).
 *  - On any other thrown error, the entire attempted set is marked failed.
 */
export function deriveRelayOutcomes(input: {
  attemptedRelayUrls: readonly string[]
  publishedUrls?: Iterable<string>
  failedUrls?: Iterable<string>
}): { successfulRelayUrls: string[]; failedRelayUrls: string[] } {
  const attempted = new Set(
    input.attemptedRelayUrls.map(normalizeOutcomeRelayUrl)
  )
  const successful = new Set<string>()
  const failed = new Set<string>()

  for (const url of input.publishedUrls ?? []) {
    const normalized = normalizeOutcomeRelayUrl(url)
    if (attempted.has(normalized)) successful.add(normalized)
  }
  for (const url of input.failedUrls ?? []) {
    const normalized = normalizeOutcomeRelayUrl(url)
    if (attempted.has(normalized) && !successful.has(normalized)) {
      failed.add(normalized)
    }
  }
  for (const url of attempted) {
    if (!successful.has(url) && !failed.has(url)) failed.add(url)
  }

  return {
    successfulRelayUrls: Array.from(successful),
    failedRelayUrls: Array.from(failed),
  }
}

function emptyPlan(intent: RelayWriteIntent): RelayWritePlan {
  return {
    intent,
    primaryRelayUrls: [],
    broadcastRelayUrls: [],
    parkedRelayUrls: [],
    independentRelayUrls: [],
  }
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
  }[]
): {
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  rejectedRelayUrls: string[]
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
      relayFailureMessages[url] =
        result.relayFailureMessages[url] ?? "No acknowledgement before timeout"
    }
    for (const url of result.rejectedRelayUrls ?? []) {
      if (successful.has(url) || !failed.has(url)) continue
      rejected.add(url)
    }
  }

  return {
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

function getPublishErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === "string" && error.trim()) return error.trim()
  return "No acknowledgement before publish timeout"
}

const NIP_01_DUPLICATE_REASON = /^duplicate:/i
const NIP_01_REJECTION_REASON =
  /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i

function isExplicitRelayRejection(error: unknown): boolean {
  return NIP_01_REJECTION_REASON.test(getPublishErrorMessage(error).trim())
}

function isDuplicateRelayAcceptance(error: unknown): boolean {
  return NIP_01_DUPLICATE_REASON.test(getPublishErrorMessage(error).trim())
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
      attemptedRelayUrls: [...input.attemptedRelayUrls],
      successfulRelayUrls: [...input.successfulRelayUrls],
      failedRelayUrls: [...input.failedRelayUrls],
      rejectedRelayUrls: [...(input.rejectedRelayUrls ?? [])],
      relayFailureMessages: { ...input.relayFailureMessages },
    },
    input.thrown
  )
}

async function publishToRelayUrls(input: {
  event: NDKEvent
  ndk: ReturnType<typeof getNdk>
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
  relayAuthentication?: {
    expectedPubkey: string
    signer: NostrEventSigner
    sessionScope: object
    waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
  }
}): Promise<{
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  relayFailureMessages: Record<string, string>
  rejectedRelayUrls: string[]
  thrown: unknown
}> {
  const targets = await resolveRelayPublishTargets(input)
  const {
    candidateRelayUrls,
    orderedCandidateRelayUrls,
    accountNetworkLocalStateRepository,
    relayUrls,
  } = targets

  // NDKEvent.publish() reads the instance from the event itself even when the
  // relay set was built with an NDK instance. Gift-wrap helpers can return an
  // unattached event, so bind it at the shared publish boundary.
  input.event.ndk ??= input.ndk

  if (relayUrls.length === 0) {
    return {
      attemptedRelayUrls: [],
      successfulRelayUrls: [],
      failedRelayUrls: [],
      relayFailureMessages: {},
      rejectedRelayUrls: [],
      thrown:
        candidateRelayUrls.length > 0 && input.accountPubkey != null
          ? new Error(
              "Refusing to publish because no account-eligible relay target remains."
            )
          : null,
    }
  }

  if (input.relayAuthentication) {
    const rawEvent = input.event.rawEvent() as SignedPublicNostrEvent
    const writeExactFrame =
      testOverrides.publishSignedEventFrameToRelay ??
      publishSignedEventFrameToRelay
    const successfulRelayUrls: string[] = []
    const failedRelayUrls: string[] = []
    const rejectedRelayUrls: string[] = []
    const relayFailureMessages: Record<string, string> = {}
    const attemptedRelayUrls: string[] = []
    let signerFailureSuppressed = false
    let actualAttemptCount = 0

    // Serialize auth-capable relay writes so one foreground action cannot open
    // concurrent external-signer prompts. Each target still receives the same
    // already-signed gift wrap and remains inside the exact exclusive set.
    for (const candidateRelayUrl of orderedCandidateRelayUrls) {
      if (
        input.maxRelayAttempts !== undefined &&
        input.maxRelayAttempts > 0 &&
        actualAttemptCount >= input.maxRelayAttempts
      ) {
        break
      }
      let freshlyEligibleRelayUrls: string[]
      try {
        assertPublishSessionCurrent(input.shouldContinue)
        freshlyEligibleRelayUrls =
          input.accountPubkey === undefined || input.accountPubkey === null
            ? [candidateRelayUrl]
            : await filterEligibleAccountRelayUrls({
                accountPubkey: input.accountPubkey,
                authenticatedPubkey: input.authenticatedPubkey,
                candidateRelayUrls: [candidateRelayUrl],
                ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
                appRelayUrls: input.appRelayUrls,
                personalRelayUrls: input.personalRelayUrls,
                independentRelayUrls: input.independentRelayUrls,
                repository: accountNetworkLocalStateRepository,
              })
        assertPublishSessionCurrent(input.shouldContinue)
      } catch (error) {
        // Before the first acknowledgement, fail closed exactly as before. Once
        // any relay has ACKed this immutable frame, preserve that durable
        // success and stop opening new signer-authenticated connections.
        if (successfulRelayUrls.length === 0) throw error
        break
      }
      const relayUrl = freshlyEligibleRelayUrls[0]
      if (!relayUrl) continue
      actualAttemptCount += 1
      attemptedRelayUrls.push(relayUrl)
      const authorization: ExactRelayWriteAuthorization = {
        expectedPubkey: input.relayAuthentication.expectedPubkey,
        signer: input.relayAuthentication.signer,
        sessionScope: input.relayAuthentication.sessionScope,
        waitForSignerVisibility:
          input.relayAuthentication.waitForSignerVisibility,
        shouldContinue: input.shouldContinue,
        onSignerFailure: () => {
          signerFailureSuppressed = true
        },
      }
      const status = await writeExactFrame({
        relayUrl,
        signedEvent: rawEvent,
        timeoutMs: input.timeoutMs,
        authorization,
      })
      if (status === "acked") {
        successfulRelayUrls.push(relayUrl)
        recordRelaySuccess(relayUrl)
        continue
      }
      failedRelayUrls.push(relayUrl)
      recordRelayFailure(relayUrl)
      if (status === "rejected") {
        rejectedRelayUrls.push(relayUrl)
        relayFailureMessages[relayUrl] = "Relay rejected the event"
      } else {
        relayFailureMessages[relayUrl] = "No acknowledgement before timeout"
      }
      if (signerFailureSuppressed) break
    }

    return {
      attemptedRelayUrls,
      successfulRelayUrls,
      failedRelayUrls,
      relayFailureMessages,
      rejectedRelayUrls,
      thrown:
        successfulRelayUrls.length >= input.requiredRelayCount
          ? null
          : attemptedRelayUrls.length === 0 && input.accountPubkey != null
            ? new Error(
                "Refusing to publish because no account-eligible relay target remains."
              )
            : new Error("No required relay acknowledged the event."),
    }
  }

  assertPublishSessionCurrent(input.shouldContinue)
  const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, input.ndk)
  let publishedUrls = new Set<string>()
  let explicitFailedUrls = new Set<string>()
  const rejectedRelayUrls = new Set<string>()
  const explicitFailureMessages = new Map<string, string>()
  let thrown: unknown = null

  try {
    const publishedRelays = await input.event.publish(
      relaySet,
      input.timeoutMs,
      input.requiredRelayCount
    )
    publishedUrls = collectRelayUrls(publishedRelays)
  } catch (err) {
    thrown = err
    if (err instanceof NDKPublishError) {
      publishedUrls = collectRelayUrls(err.publishedToRelays)
      for (const [relay, relayError] of err.errors.entries()) {
        const url = relayUrl(relay)
        if (url) {
          // `duplicate:` means this exact event is already durable on the
          // relay. Treat it as an idempotent acknowledgement so a retry after
          // an ACK-loss or browser crash can converge.
          if (isDuplicateRelayAcceptance(relayError)) {
            publishedUrls.add(url)
            continue
          }
          explicitFailedUrls.add(url)
          // NDK currently stores OK-false, timeout, and transport failures as
          // plain Error values in the same map. Only NIP-01's machine-readable
          // rejection prefixes prove a relay explicitly rejected the event;
          // every ambiguous failure remains retryable as timed_out.
          if (isExplicitRelayRejection(relayError)) {
            rejectedRelayUrls.add(url)
          }
          explicitFailureMessages.set(url, getPublishErrorMessage(relayError))
        }
      }
    } else {
      explicitFailedUrls = new Set(relayUrls)
      for (const url of relayUrls) {
        explicitFailureMessages.set(
          normalizeOutcomeRelayUrl(url),
          getPublishErrorMessage(err)
        )
      }
    }
  }

  const outcome = deriveRelayOutcomes({
    attemptedRelayUrls: relayUrls,
    publishedUrls,
    failedUrls: explicitFailedUrls,
  })

  for (const url of outcome.successfulRelayUrls) recordRelaySuccess(url)
  for (const url of outcome.failedRelayUrls) recordRelayFailure(url)

  const relayFailureMessages = Object.fromEntries(
    outcome.failedRelayUrls.map((url) => [
      url,
      explicitFailureMessages.get(url) ?? "No acknowledgement before timeout",
    ])
  )

  return {
    attemptedRelayUrls: relayUrls,
    ...outcome,
    relayFailureMessages,
    rejectedRelayUrls: Array.from(rejectedRelayUrls),
    thrown,
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
      : [...input.relayUrls]
  const accountNetworkLocalStateRepository =
    input.accountNetworkLocalStateRepository ??
    testOverrides.accountNetworkLocalStateRepository
  const orderedCandidateRelayUrls =
    input.accountPubkey === undefined || input.accountPubkey === null
      ? candidateRelayUrls
      : (
          await orderEquivalentAccountRelayOperations({
            accountPubkey: input.accountPubkey,
            operations: candidateRelayUrls.map((relayUrl) => ({
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
          })
  const relayUrls =
    input.maxRelayAttempts && input.maxRelayAttempts > 0
      ? eligibleRelayUrls.slice(0, input.maxRelayAttempts)
      : eligibleRelayUrls
  return {
    candidateRelayUrls,
    orderedCandidateRelayUrls,
    accountNetworkLocalStateRepository,
    relayUrls,
  }
}

/**
 * Publish one already-signed gift wrap to one immutable exact-target plan.
 * The first relay ACK resolves the foreground milestone while the separate
 * settlement milestone retains every bounded relay outcome. No fallback or
 * target-plan widening is permitted.
 */
export async function publishWithPlannerProgressive(
  event: NDKEvent,
  input: PublishWithPlannerInput
): Promise<ProgressivePublishMilestones> {
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
  assertValidSignedPublish(event, input)
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

  const rawEvent = event.rawEvent() as SignedPublicNostrEvent
  const writeExactFrame =
    testOverrides.publishSignedEventFrameToRelay ??
    publishSignedEventFrameToRelay
  const statuses = new Map<string, "pending" | ProgressiveRelayPublishStatus>(
    targets.relayUrls.map((relayUrl) => [relayUrl, "pending"])
  )
  const attemptedRelayUrls = new Set<string>()
  const relayFailureMessages: Record<string, string> = {}
  const relayAttempts: ProgressiveRelayPublishAttempt[] = []
  const attemptCounts = new Map<string, number>()
  let hasAccepted = false
  let signerFailureSuppressed = false
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
      else pendingRelayUrls.push(relayUrl)
    }

    return {
      plan,
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
      statuses.set(relayUrl, "error")
      relayFailureMessages[relayUrl] = message
    }
  }

  const attemptRelay = async (
    relayUrl: string,
    timeoutMs: number
  ): Promise<void> => {
    try {
      assertPublishSessionCurrent(input.shouldContinue)
      attemptedRelayUrls.add(relayUrl)
      const attempt = (attemptCounts.get(relayUrl) ?? 0) + 1
      attemptCounts.set(relayUrl, attempt)
      const authorization: ExactRelayWriteAuthorization | undefined =
        input.relayAuthentication
          ? {
              expectedPubkey: input.relayAuthentication.expectedPubkey,
              signer: input.relayAuthentication.signer,
              sessionScope: input.relayAuthentication.sessionScope,
              waitForSignerVisibility:
                input.relayAuthentication.waitForSignerVisibility,
              shouldContinue: input.shouldContinue,
              onSignerFailure: () => {
                signerFailureSuppressed = true
              },
            }
          : undefined
      const status = await writeExactFrame({
        relayUrl,
        signedEvent: rawEvent,
        timeoutMs,
        authorization,
      })
      statuses.set(relayUrl, status)
      relayAttempts.push({ relayUrl, attempt, status })
      if (status === "acked") {
        delete relayFailureMessages[relayUrl]
        recordRelaySuccess(relayUrl)
        if (!hasAccepted) {
          hasAccepted = true
          resolveAccepted(snapshot())
        }
        return
      }

      recordRelayFailure(relayUrl)
      relayFailureMessages[relayUrl] =
        status === "rejected"
          ? "Relay rejected the event"
          : "No acknowledgement before timeout"
    } catch {
      const attempt = attemptCounts.get(relayUrl) ?? 1
      statuses.set(relayUrl, "error")
      relayAttempts.push({ relayUrl, attempt, status: "error" })
      relayFailureMessages[relayUrl] = "Relay write failed"
      recordRelayFailure(relayUrl)
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

    if (!input.relayAuthentication) {
      await Promise.all(
        relayUrls.map((relayUrl) => attemptRelay(relayUrl, timeoutMs))
      )
      return
    }

    // Auth-capable exact writes stay serial so one foreground action cannot
    // open concurrent external-signer prompts.
    for (let index = 0; index < relayUrls.length; index += 1) {
      const relayUrl = relayUrls[index]!
      if (signerFailureSuppressed || input.shouldContinue?.() === false) {
        markUnattemptedErrors(
          relayUrls.slice(index),
          signerFailureSuppressed
            ? "Relay authorization unavailable"
            : "Publish session changed"
        )
        break
      }
      await attemptRelay(relayUrl, timeoutMs)
    }
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
    if (!hasAccepted && !input.relayAuthentication) {
      assertPublishSessionCurrent(input.shouldContinue)
      const retryTargets = await resolveRelayPublishTargets(targetInput)
      const retryRelayUrls = retryTargets.relayUrls.filter(
        (relayUrl) => statuses.get(relayUrl) !== "acked"
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
  const status = await publishSignedEventFrameToRelay({
    signedEvent: input.signedEvent,
    relayUrl,
    timeoutMs: CRITICAL_PUBLISH_TIMEOUT_MS,
  })
  if (status === "acked") recordRelaySuccess(relayUrl)
  else recordRelayFailure(relayUrl)
  return status
}

/**
 * Resolve a planner-driven relay set without publishing. Useful when callers
 * need to prepare an NDKRelaySet up-front (e.g. to attach to an NDK signer
 * pipeline before the event is finalized).
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
 * Publish an NDKEvent to a planner-resolved relay set.
 *
 * Returns the resolved plan and the URL list that was attempted so callers
 * can surface diagnostics. Every network attempt uses either the resolved
 * plan or a Conduit-configured fallback; bare NDK pool publishing is forbidden.
 *
 * Primary relays are the delivery requirement. Broadcast relays are diagnostic
 * best-effort fanout and must not make a recipient delivery look successful.
 */
export async function publishWithPlanner(
  event: NDKEvent,
  input: PublishWithPlannerInput
): Promise<PublishWithPlannerResult> {
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
  assertValidSignedPublish(event, input)

  assertRelayAuthenticationConfiguration(event, input)

  const assertShouldContinue = () =>
    assertPublishSessionCurrent(input.shouldContinue)

  const basePlan = input.exclusiveRelayUrls
    ? await planPublishRelays(input)
    : testOverrides.planPublishRelays
      ? await testOverrides.planPublishRelays(input)
      : await planPublishRelays(input)
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
  const plan = config.e2eRelayIsolationEnabled
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
    const fallbackRelayUrls = getAuthorEventFallbackRelayUrls({
      eventKind: event.kind,
      intent: input.intent,
      attemptedRelayUrls,
    })
    if (fallbackRelayUrls.length > 0) {
      assertShouldContinue()
      const fallback = await publishToRelayUrls({
        event,
        ndk: testOverrides.getNdk ? testOverrides.getNdk() : getNdk(),
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
          plan: emptyPlan(input.intent),
          attemptedRelayUrls,
          successfulRelayUrls: fallback.successfulRelayUrls,
          failedRelayUrls: fallback.failedRelayUrls,
          rejectedRelayUrls: fallback.rejectedRelayUrls,
          relayFailureMessages: fallback.relayFailureMessages,
          thrown: fallback.thrown,
        })
      }
      return {
        plan: emptyPlan(input.intent),
        attemptedRelayUrls,
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

  const ndk = testOverrides.getNdk ? testOverrides.getNdk() : getNdk()
  const publishTimeoutMs = input.relayAuthentication
    ? CRITICAL_RETRY_PUBLISH_TIMEOUT_MS
    : input.deliveryMode === "critical"
      ? CRITICAL_PUBLISH_TIMEOUT_MS
      : STANDARD_PUBLISH_TIMEOUT_MS
  assertShouldContinue()
  const primary = await publishToRelayUrls({
    event,
    ndk,
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
    relayAuthentication: input.relayAuthentication,
  })
  attemptedRelayUrls = mergeUnique([
    attemptedRelayUrls,
    primary.attemptedRelayUrls,
  ])

  if (primary.thrown) {
    let retry: Awaited<ReturnType<typeof publishToRelayUrls>> | null = null

    if (
      input.deliveryMode === "critical" &&
      primary.failedRelayUrls.length &&
      !input.relayAuthentication
    ) {
      assertShouldContinue()
      retry = await publishToRelayUrls({
        event,
        ndk,
        relayUrls: primary.failedRelayUrls,
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
          successfulRelayUrls: merged.successfulRelayUrls,
          failedRelayUrls: merged.failedRelayUrls,
          rejectedRelayUrls: merged.rejectedRelayUrls,
          relayFailureMessages: merged.relayFailureMessages,
        }
      }
    }

    const fallbackRelayUrls = authorFallbackAllowed
      ? getAuthorEventFallbackRelayUrls({
          eventKind: event.kind,
          intent: input.intent,
          attemptedRelayUrls,
        })
      : []
    const criticalRecipientFallbackRelayUrls =
      input.deliveryMode === "critical"
        ? getCriticalRecipientFallbackRelayUrls({
            intent: input.intent,
            attemptedRelayUrls,
          })
        : []
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
        successfulRelayUrls: merged.successfulRelayUrls,
        failedRelayUrls: merged.failedRelayUrls,
        rejectedRelayUrls: merged.rejectedRelayUrls,
        relayFailureMessages: merged.relayFailureMessages,
        thrown: retry?.thrown ?? primary.thrown,
      })
    }

    if (
      fallbackRelayUrls.length > 0 ||
      criticalRecipientFallbackRelayUrls.length > 0
    ) {
      assertShouldContinue()
      const fallbackAttemptRelayUrls = mergeUnique([
        fallbackRelayUrls,
        criticalRecipientFallbackRelayUrls,
      ])
      const fallback = await publishToRelayUrls({
        event,
        ndk,
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
      successfulRelayUrls: primary.successfulRelayUrls,
      failedRelayUrls: primary.failedRelayUrls,
      rejectedRelayUrls: primary.rejectedRelayUrls,
      relayFailureMessages: primary.relayFailureMessages,
    }
  }
  const broadcast = await publishToRelayUrls({
    event,
    ndk,
    relayUrls: plan.broadcastCandidateRelayUrls ?? plan.broadcastRelayUrls,
    maxRelayAttempts: plan.maxBroadcastRelayAttempts,
    requiredRelayCount:
      (plan.broadcastCandidateRelayUrls ?? plan.broadcastRelayUrls).length > 0
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
  })
  attemptedRelayUrls = mergeUnique([
    attemptedRelayUrls,
    broadcast.attemptedRelayUrls,
  ])

  const merged = mergePublishResults([primary, broadcast])
  return {
    plan,
    attemptedRelayUrls,
    successfulRelayUrls: merged.successfulRelayUrls,
    failedRelayUrls: merged.failedRelayUrls,
    rejectedRelayUrls: merged.rejectedRelayUrls,
    relayFailureMessages: merged.relayFailureMessages,
  }
}
