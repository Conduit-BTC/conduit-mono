/**
 * Write-side glue between the relay planner and NDK's publish pipeline.
 *
 * Callers describe an intent (author-only event, or recipient-aware event)
 * and we resolve a relay set from cached NIP-65 hints + user write settings,
 * then publish to that explicit set instead of NDK's pool default.
 */

import { NDKRelaySet, type NDKEvent } from "@nostr-dev-kit/ndk"
import { getNdk } from "./ndk"
import { getRelayLists } from "./relay-list"
import { recordRelayFailure, recordRelaySuccess } from "./relay-health"
import {
  planRelayWrites,
  type RelayWriteIntent,
  type RelayWritePlan,
} from "./relay-planner"

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
  const plan = await planPublishRelays(input)
  const attemptedRelayUrls = Array.from(
    new Set([...plan.primaryRelayUrls, ...plan.broadcastRelayUrls])
  )

  if (attemptedRelayUrls.length === 0) {
    // Defensive: planner produced no targets — fall back to default publish.
    await event.publish()
    return { plan: emptyPlan(input.intent), attemptedRelayUrls: [] }
  }

  const ndk = getNdk()
  const relaySet = NDKRelaySet.fromRelayUrls(attemptedRelayUrls, ndk)

  try {
    await event.publish(relaySet)
    for (const url of attemptedRelayUrls) recordRelaySuccess(url)
  } catch (err) {
    // NDK throws when it cannot reach the required count of primary relays.
    // We still want to record per-relay outcomes if the error carries them;
    // otherwise mark the entire attempted set as failed to back off.
    for (const url of attemptedRelayUrls) recordRelayFailure(url)
    throw err
  }

  return { plan, attemptedRelayUrls }
}
