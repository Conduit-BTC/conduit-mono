/**
 * NDK-neutral read boundary over Conduit's bounded relay executor.
 *
 * The current raw WebSocket implementation still lives in `ndk.ts` while
 * callers migrate. This module deliberately exposes only plain Nostr data so
 * discovery, trust, cache, and replacement-write code do not depend on NDK
 * objects or NDK's relay/subscription behavior.
 */

import type { Filter } from "nostr-tools"
import {
  fetchEventsFanoutDetailed,
  getEventSourceRelayUrls,
  verifySignedPublicNostrEvents,
} from "./ndk"
import type { SignedPublicNostrEvent } from "./signed-event"

export interface RelayReadOptions {
  relayUrls: string[]
  connectTimeoutMs?: number
  fetchTimeoutMs?: number
  skipHealthFilter?: boolean
  reuseRelayConnections?: boolean
  signal?: AbortSignal
}

export interface RelayReadSourceStatus {
  relayUrl: string
  status: "success" | "partial" | "failed"
  eventCount: number
  /** Structurally matching events rejected by id or signature verification. */
  rejectedEventCount?: number
}

export interface SignedEventRelayReadResult {
  events: SignedPublicNostrEvent[]
  eventSourceRelayUrls: Record<string, string[]>
  relays: RelayReadSourceStatus[]
  eventsVerified: boolean
}

export interface VerifySignedEventsOptions {
  signal?: AbortSignal
  maxEvents?: number
}

export async function verifySignedEvents(
  events: readonly SignedPublicNostrEvent[],
  options: VerifySignedEventsOptions = {}
): Promise<{ events: SignedPublicNostrEvent[]; truncated: boolean }> {
  return await verifySignedPublicNostrEvents(events, options)
}

function copySignedEvent(
  event: Awaited<ReturnType<typeof fetchEventsFanoutDetailed>>["events"][number]
): SignedPublicNostrEvent {
  const raw = event.rawEvent()
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: raw.kind,
    tags: raw.tags.map((tag) => [...tag]),
    content: raw.content,
    sig: raw.sig,
  }
}

export async function fetchSignedEventsFanoutDetailed(
  filter: Filter,
  options: RelayReadOptions
): Promise<SignedEventRelayReadResult> {
  if (options.relayUrls.length === 0) {
    return {
      events: [],
      eventSourceRelayUrls: {},
      relays: [],
      eventsVerified: true,
    }
  }
  const result = await fetchEventsFanoutDetailed(
    filter as Parameters<typeof fetchEventsFanoutDetailed>[0],
    options
  )
  const eventSourceRelayUrls: Record<string, string[]> = {}

  for (const event of result.events) {
    eventSourceRelayUrls[event.id] = getEventSourceRelayUrls(event)
  }

  return {
    events: result.events.map(copySignedEvent),
    eventSourceRelayUrls,
    relays: result.relays.map((relay) => ({
      ...relay,
      // Make authoritative absence explicit for replacement-sensitive reads.
      rejectedEventCount: relay.rejectedEventCount ?? 0,
    })),
    eventsVerified: result.eventsVerified === true,
  }
}
