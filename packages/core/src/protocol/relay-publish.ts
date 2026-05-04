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
  planRelayWrites,
  type RelayWriteIntent,
  type RelayWritePlan,
} from "./relay-planner"
import { EVENT_KINDS } from "./kinds"
import { assertSafeNip65RelayTags } from "./relay-settings"

export interface PublishWithPlannerInput {
  intent: RelayWriteIntent
  authorPubkey?: string
  recipientPubkeys?: readonly string[]
  /** Disable per-relay health filtering (last-resort retries). */
  skipHealthFilter?: boolean
}

export interface PublishWithPlannerResult {
  plan: RelayWritePlan
  /** URLs the event was actually attempted on (primary + broadcast). */
  attemptedRelayUrls: string[]
  /** URLs that acknowledged the publish. Empty on fallback path. */
  successfulRelayUrls: string[]
  /** URLs that failed (rejection or no ack). Empty on fallback path. */
  failedRelayUrls: string[]
}

function relayUrl(relay: NDKRelay): string | undefined {
  // NDKRelay exposes `url` via its WebSocket-like getter; guard for safety.
  const url = (relay as unknown as { url?: string }).url
  return typeof url === "string" && url.length > 0 ? url : undefined
}

function collectRelayUrls(relays: Iterable<NDKRelay>): Set<string> {
  const urls = new Set<string>()
  for (const relay of relays) {
    const url = relayUrl(relay)
    if (url) urls.add(url)
  }
  return urls
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
  const attempted = new Set(input.attemptedRelayUrls)
  const successful = new Set<string>()
  const failed = new Set<string>()

  for (const url of input.publishedUrls ?? []) {
    if (attempted.has(url)) successful.add(url)
  }
  for (const url of input.failedUrls ?? []) {
    if (attempted.has(url) && !successful.has(url)) failed.add(url)
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

/**
 * Resolve a planner-driven relay set without publishing. Useful when callers
 * need to prepare an NDKRelaySet up-front (e.g. to attach to an NDK signer
 * pipeline before the event is finalized).
 */
export async function planPublishRelays(
  input: PublishWithPlannerInput
): Promise<RelayWritePlan> {
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
      ? await getRelayLists(hintPubkeys, { cacheOnly: true })
      : undefined

  return planRelayWrites({
    intent: input.intent,
    authorPubkey: input.authorPubkey,
    recipientPubkeys: input.recipientPubkeys,
    relayLists,
    skipHealthFilter: input.skipHealthFilter,
  })
}

/**
 * Publish an NDKEvent to a planner-resolved relay set.
 *
 * Returns the resolved plan and the URL list that was attempted so callers
 * can surface diagnostics. If the planner yields no relays we fall back to
 * the NDKEvent's default `publish()` (NDK's pool of connected relays).
 */
export async function publishWithPlanner(
  event: NDKEvent,
  input: PublishWithPlannerInput
): Promise<PublishWithPlannerResult> {
  if (event.kind === EVENT_KINDS.RELAY_LIST) {
    assertSafeNip65RelayTags(event.tags ?? [])
  }

  const plan = await planPublishRelays(input)
  const attemptedRelayUrls = Array.from(
    new Set([...plan.primaryRelayUrls, ...plan.broadcastRelayUrls])
  )

  if (attemptedRelayUrls.length === 0) {
    // Defensive: planner produced no targets — fall back to default publish.
    await event.publish()
    return {
      plan: emptyPlan(input.intent),
      attemptedRelayUrls: [],
      successfulRelayUrls: [],
      failedRelayUrls: [],
    }
  }

  const ndk = getNdk()
  const relaySet = NDKRelaySet.fromRelayUrls(attemptedRelayUrls, ndk)

  let publishedUrls = new Set<string>()
  let explicitFailedUrls = new Set<string>()
  let thrown: unknown = null

  try {
    const publishedRelays = await event.publish(relaySet)
    publishedUrls = collectRelayUrls(publishedRelays)
  } catch (err) {
    thrown = err
    if (err instanceof NDKPublishError) {
      publishedUrls = collectRelayUrls(err.publishedToRelays)
      for (const relay of err.errors.keys()) {
        const url = relayUrl(relay)
        if (url) explicitFailedUrls.add(url)
      }
    } else {
      // Unknown failure mode — back off the entire attempted set.
      explicitFailedUrls = new Set(attemptedRelayUrls)
    }
  }

  const { successfulRelayUrls, failedRelayUrls } = deriveRelayOutcomes({
    attemptedRelayUrls,
    publishedUrls,
    failedUrls: explicitFailedUrls,
  })

  for (const url of successfulRelayUrls) recordRelaySuccess(url)
  for (const url of failedRelayUrls) recordRelayFailure(url)

  if (thrown) throw thrown

  return {
    plan,
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls,
  }
}
