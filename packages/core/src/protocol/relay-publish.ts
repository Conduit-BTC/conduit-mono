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
import { getRelayLists, isInsecureRelayUrl } from "./relay-list"
import { recordRelayFailure, recordRelaySuccess } from "./relay-health"
import {
  planRelayWrites,
  type RelayWriteIntent,
  type RelayWritePlan,
} from "./relay-planner"
import { EVENT_KINDS } from "./kinds"
import {
  assertSafeNip65RelayTags,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import { config } from "../config"
import {
  assertSafeReplaceablePublish,
  type ReplaceablePublishSafetyOptions,
} from "./replaceable-safety"

const STANDARD_PUBLISH_TIMEOUT_MS = 5_000
const CRITICAL_PUBLISH_TIMEOUT_MS = 10_000
const CRITICAL_RETRY_PUBLISH_TIMEOUT_MS = 15_000

export interface PublishWithPlannerInput {
  intent: RelayWriteIntent
  authorPubkey?: string
  /** Authenticated pubkey whose own NIP-65 local relays may be used. */
  authenticatedPubkey?: string | null
  recipientPubkeys?: readonly string[]
  /**
   * Extra recipient relay hints (e.g. NIP-17 kind-10050 private-message inbox
   * relays) added as delivery targets alongside the planned NIP-65 set. Secure
   * URLs only; insecure hints are dropped.
   */
  extraRelayUrls?: readonly string[]
  /**
   * Publish only to these relays. This bypasses NIP-65 planning and fallback
   * fanout for protocols such as NIP-17 that define an exclusive relay set.
   */
  exclusiveRelayUrls?: readonly string[]
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
}

export interface PublishWithPlannerResult {
  plan: RelayWritePlan
  /** URLs the event was actually attempted on (primary + broadcast). */
  attemptedRelayUrls: string[]
  /** URLs that acknowledged the publish. Empty on fallback path. */
  successfulRelayUrls: string[]
  /** URLs that failed (rejection or no ack). Empty on fallback path. */
  failedRelayUrls: string[]
  /** Per-relay failure detail when NDK exposes a rejection reason. */
  relayFailureMessages: Record<string, string>
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

interface RelayPublishTestOverrides {
  planPublishRelays?: (
    input: PublishWithPlannerInput
  ) => Promise<RelayWritePlan>
  getNdk?: typeof getNdk
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
    relayFailureMessages: Record<string, string>
  }[]
): {
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  relayFailureMessages: Record<string, string>
} {
  const successful = new Set<string>()
  const failed = new Set<string>()
  const relayFailureMessages: Record<string, string> = {}

  for (const result of results) {
    for (const url of result.successfulRelayUrls) {
      successful.add(url)
      failed.delete(url)
      delete relayFailureMessages[url]
    }
    for (const url of result.failedRelayUrls) {
      if (successful.has(url)) continue
      failed.add(url)
      relayFailureMessages[url] =
        result.relayFailureMessages[url] ?? "No acknowledgement before timeout"
    }
  }

  return {
    successfulRelayUrls: Array.from(successful),
    failedRelayUrls: Array.from(failed),
    relayFailureMessages,
  }
}

function getAuthorEventFallbackRelayUrls(input: {
  eventKind: number | undefined
  intent: RelayWriteIntent
  attemptedRelayUrls: readonly string[]
}): string[] {
  if (input.intent !== "author_event") return []

  const attempted = new Set(
    input.attemptedRelayUrls.map(normalizeOutcomeRelayUrl)
  )
  const publicRelayFallbackUrls =
    input.eventKind === EVENT_KINDS.RELAY_LIST
      ? []
      : config.corePublicFallbackRelayUrls.filter(
          (url) => !attempted.has(normalizeOutcomeRelayUrl(url))
        )

  return mergeUnique([config.appWriteRelayUrls, publicRelayFallbackUrls])
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

function createPublishDiagnosticsError(input: {
  message: string
  plan: RelayWritePlan
  attemptedRelayUrls: readonly string[]
  successfulRelayUrls: readonly string[]
  failedRelayUrls: readonly string[]
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
      relayFailureMessages: { ...input.relayFailureMessages },
    },
    input.thrown
  )
}

async function publishToRelayUrls(input: {
  event: NDKEvent
  ndk: ReturnType<typeof getNdk>
  relayUrls: readonly string[]
  requiredRelayCount: number
  timeoutMs: number
}): Promise<{
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  relayFailureMessages: Record<string, string>
  thrown: unknown
}> {
  // NDKEvent.publish() reads the instance from the event itself even when the
  // relay set was built with an NDK instance. Gift-wrap helpers can return an
  // unattached event, so bind it at the shared publish boundary.
  input.event.ndk ??= input.ndk

  if (input.relayUrls.length === 0) {
    return {
      successfulRelayUrls: [],
      failedRelayUrls: [],
      relayFailureMessages: {},
      thrown: null,
    }
  }

  const relaySet = NDKRelaySet.fromRelayUrls([...input.relayUrls], input.ndk)
  let publishedUrls = new Set<string>()
  let explicitFailedUrls = new Set<string>()
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
          explicitFailedUrls.add(url)
          explicitFailureMessages.set(url, getPublishErrorMessage(relayError))
        }
      }
    } else {
      explicitFailedUrls = new Set(input.relayUrls)
      for (const url of input.relayUrls) {
        explicitFailureMessages.set(
          normalizeOutcomeRelayUrl(url),
          getPublishErrorMessage(err)
        )
      }
    }
  }

  const outcome = deriveRelayOutcomes({
    attemptedRelayUrls: input.relayUrls,
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

  return { ...outcome, relayFailureMessages, thrown }
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
    const primaryRelayUrls = Array.from(
      new Set(
        input.exclusiveRelayUrls
          .map((url) => tryNormalizeRelayUrl(url))
          .flatMap((result) =>
            result.ok && !isInsecureRelayUrl(result.url) ? [result.url] : []
          )
      )
    )
    return {
      intent: input.intent,
      primaryRelayUrls,
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
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

  const relayLists =
    hintPubkeys.length > 0
      ? await getRelayLists(hintPubkeys, {
          cacheOnly: input.refreshRelayLists !== true,
          allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
        })
      : undefined

  return planRelayWrites({
    intent: input.intent,
    authorPubkey: input.authorPubkey,
    recipientPubkeys: input.recipientPubkeys,
    relayLists,
    authenticatedPubkey: input.authenticatedPubkey,
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
 * can surface diagnostics. If the planner yields no relays we fall back to
 * the NDKEvent's default `publish()` (NDK's pool of connected relays), except
 * for NIP-65 relay-list publishes where explicit user OUT relays are required.
 *
 * Primary relays are the delivery requirement. Broadcast relays are diagnostic
 * best-effort fanout and must not make a recipient delivery look successful.
 */
export async function publishWithPlanner(
  event: NDKEvent,
  input: PublishWithPlannerInput
): Promise<PublishWithPlannerResult> {
  if (event.kind === EVENT_KINDS.RELAY_LIST) {
    assertSafeNip65RelayTags(event.tags ?? [])
  }
  assertSafeReplaceablePublish(event, input.replaceableSafety)

  const assertShouldContinue = () => {
    if (input.shouldContinue?.() === false) {
      throw new Error("Publish cancelled because the signer session changed.")
    }
  }

  const basePlan = input.exclusiveRelayUrls
    ? await planPublishRelays(input)
    : testOverrides.planPublishRelays
      ? await testOverrides.planPublishRelays(input)
      : await planPublishRelays(input)
  assertShouldContinue()
  const extraPrimaryRelayUrls = input.exclusiveRelayUrls
    ? []
    : (input.extraRelayUrls ?? []).filter((url) => !isInsecureRelayUrl(url))
  const plan =
    extraPrimaryRelayUrls.length > 0
      ? {
          ...basePlan,
          primaryRelayUrls: mergeUnique([
            basePlan.primaryRelayUrls,
            extraPrimaryRelayUrls,
          ]),
        }
      : basePlan
  const plannedRelayUrls = Array.from(
    new Set([...plan.primaryRelayUrls, ...plan.broadcastRelayUrls])
  )
  let attemptedRelayUrls = [...plannedRelayUrls]

  if (plannedRelayUrls.length === 0) {
    if (input.exclusiveRelayUrls) {
      throw new Error(
        "Refusing to publish without a valid exclusive relay target."
      )
    }
    const fallbackRelayUrls = getAuthorEventFallbackRelayUrls({
      eventKind: event.kind,
      intent: input.intent,
      attemptedRelayUrls,
    })
    if (fallbackRelayUrls.length > 0) {
      assertShouldContinue()
      attemptedRelayUrls = fallbackRelayUrls
      const fallback = await publishToRelayUrls({
        event,
        ndk: testOverrides.getNdk ? testOverrides.getNdk() : getNdk(),
        relayUrls: fallbackRelayUrls,
        requiredRelayCount: 1,
        timeoutMs:
          input.deliveryMode === "critical"
            ? CRITICAL_RETRY_PUBLISH_TIMEOUT_MS
            : STANDARD_PUBLISH_TIMEOUT_MS,
      })
      if (fallback.thrown) {
        throw createPublishDiagnosticsError({
          message:
            "Could not publish because no fallback relay accepted the event.",
          plan: emptyPlan(input.intent),
          attemptedRelayUrls,
          successfulRelayUrls: fallback.successfulRelayUrls,
          failedRelayUrls: fallback.failedRelayUrls,
          relayFailureMessages: fallback.relayFailureMessages,
          thrown: fallback.thrown,
        })
      }
      return {
        plan: emptyPlan(input.intent),
        attemptedRelayUrls,
        successfulRelayUrls: fallback.successfulRelayUrls,
        failedRelayUrls: fallback.failedRelayUrls,
        relayFailureMessages: fallback.relayFailureMessages,
      }
    }

    if (event.kind === EVENT_KINDS.RELAY_LIST) {
      throw new Error(
        "Refusing to publish NIP-65 relays without an explicit OUT relay target."
      )
    }

    // Defensive: planner produced no targets and no configured fallback exists.
    assertShouldContinue()
    await event.publish()
    return {
      plan: emptyPlan(input.intent),
      attemptedRelayUrls: [],
      successfulRelayUrls: [],
      failedRelayUrls: [],
      relayFailureMessages: {},
    }
  }

  const ndk = testOverrides.getNdk ? testOverrides.getNdk() : getNdk()
  const publishTimeoutMs =
    input.deliveryMode === "critical"
      ? CRITICAL_PUBLISH_TIMEOUT_MS
      : STANDARD_PUBLISH_TIMEOUT_MS
  assertShouldContinue()
  const primary = await publishToRelayUrls({
    event,
    ndk,
    relayUrls: plan.primaryRelayUrls,
    requiredRelayCount: plan.primaryRelayUrls.length > 0 ? 1 : 0,
    timeoutMs: publishTimeoutMs,
  })

  if (primary.thrown) {
    let retry: Awaited<ReturnType<typeof publishToRelayUrls>> | null = null

    if (input.deliveryMode === "critical" && primary.failedRelayUrls.length) {
      assertShouldContinue()
      retry = await publishToRelayUrls({
        event,
        ndk,
        relayUrls: primary.failedRelayUrls,
        requiredRelayCount: 1,
        timeoutMs: CRITICAL_RETRY_PUBLISH_TIMEOUT_MS,
      })

      if (!retry.thrown) {
        const merged = mergePublishResults([primary, retry])
        return {
          plan,
          attemptedRelayUrls: mergeUnique([
            attemptedRelayUrls,
            primary.failedRelayUrls,
          ]),
          successfulRelayUrls: merged.successfulRelayUrls,
          failedRelayUrls: merged.failedRelayUrls,
          relayFailureMessages: merged.relayFailureMessages,
        }
      }
    }

    const fallbackRelayUrls = getAuthorEventFallbackRelayUrls({
      eventKind: event.kind,
      intent: input.intent,
      attemptedRelayUrls,
    })
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
    const retryFailedRelayUrls = mergeUnique(
      retryResults.map((result) => result.failedRelayUrls)
    )
    const retrySuccessfulRelayUrls = mergeUnique(
      retryResults.map((result) => result.successfulRelayUrls)
    )

    if (input.exclusiveRelayUrls) {
      const merged = mergePublishResults(retryResults)
      throw createPublishDiagnosticsError({
        message: "Could not publish to the required exclusive relay set.",
        plan,
        attemptedRelayUrls: mergeUnique([
          attemptedRelayUrls,
          retryFailedRelayUrls,
        ]),
        successfulRelayUrls: merged.successfulRelayUrls,
        failedRelayUrls: merged.failedRelayUrls,
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
      attemptedRelayUrls = mergeUnique([
        attemptedRelayUrls,
        primary.failedRelayUrls,
        fallbackAttemptRelayUrls,
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
      })
      const merged = mergePublishResults([...retryResults, fallback])

      if (!fallback.thrown) {
        return {
          plan,
          attemptedRelayUrls,
          successfulRelayUrls: merged.successfulRelayUrls,
          failedRelayUrls: merged.failedRelayUrls,
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
        relayFailureMessages: merged.relayFailureMessages,
        thrown: fallback.thrown,
      })
    }

    const merged = mergePublishResults(retryResults)
    throw createPublishDiagnosticsError({
      message: "Could not publish because no primary relay accepted the event.",
      plan,
      attemptedRelayUrls: mergeUnique([
        attemptedRelayUrls,
        retryFailedRelayUrls,
      ]),
      successfulRelayUrls:
        merged.successfulRelayUrls.length > 0
          ? merged.successfulRelayUrls
          : retrySuccessfulRelayUrls,
      failedRelayUrls: merged.failedRelayUrls,
      relayFailureMessages:
        Object.keys(merged.relayFailureMessages).length > 0
          ? merged.relayFailureMessages
          : retryRelayFailureMessages,
      thrown: retry?.thrown ?? primary.thrown,
    })
  }

  assertShouldContinue()
  const broadcast = await publishToRelayUrls({
    event,
    ndk,
    relayUrls: plan.broadcastRelayUrls,
    requiredRelayCount: plan.broadcastRelayUrls.length > 0 ? 1 : 0,
    timeoutMs: publishTimeoutMs,
  })

  return {
    plan,
    attemptedRelayUrls,
    successfulRelayUrls: mergeUnique([
      primary.successfulRelayUrls,
      broadcast.successfulRelayUrls,
    ]),
    failedRelayUrls: mergeUnique([
      primary.failedRelayUrls,
      broadcast.failedRelayUrls,
    ]),
    relayFailureMessages: mergeRelayFailureMessages([
      primary.relayFailureMessages,
      broadcast.relayFailureMessages,
    ]),
  }
}
