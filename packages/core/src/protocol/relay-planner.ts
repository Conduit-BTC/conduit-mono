/**
 * Relay planner: produces concrete relay URL lists for reads and writes.
 *
 * Inputs:
 * - the user's relay settings (commerce + public sections, read/write flags)
 * - cached NIP-65 relay lists for arbitrary pubkeys (for author-aware reads
 *   and recipient-aware writes)
 * - per-relay health (skip parked relays)
 *
 * Outputs:
 * - `RelayReadPlan` describes which relays to query for a given intent
 * - `RelayWritePlan` describes where to publish a given event, with a
 *   primary set (must succeed) and optional broadcast set (best-effort)
 *
 * The planner is pure / synchronous and never opens a websocket. Callers
 * (e.g. `commerce.ts`, publish helpers) are responsible for executing the
 * plan with `fetchEventsFanout` / `event.publish()`.
 *
 * Read intents map to the existing `CommerceReadPlanName` so commerce.ts
 * can adopt the planner without breaking the source-tagging model. Read
 * intents are deliberately broader than commerce so we can also plan for
 * profile, social graph, and DM reads.
 */

import { config } from "../config"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  loadRelaySettings,
  type RelayPlanOptions,
  type RelaySettingsState,
} from "./relay-settings"
import type { RelayList } from "./relay-list"
import { partitionByHealth } from "./relay-health"

export type RelayReadIntent =
  /** Marketplace listings — commerce + public fallback. */
  | "commerce_products"
  /** Author-scoped products: prefer author's write relays + commerce. */
  | "author_products"
  /** Profile metadata for one or more pubkeys (kind 0). */
  | "profiles"
  /** NIP-65 relay lists themselves. */
  | "relay_lists"
  /** Encrypted DMs for a recipient (NIP-17 inbox). */
  | "dm_inbox"
  /** Aggregate social signals (reactions, zaps, comments) for a product. */
  | "product_card_social_summary"
  /** Top-N comments preview for a product card. */
  | "product_comments_preview"
  /** Full review/comment thread for a product detail surface. */
  | "product_reviews"
  /** A profile's recent social feed (kind 1 / kind 6 / kind 30023, etc.). */
  | "profile_social_feed"
  /** Generic kind-fanout that has no author hint. */
  | "general"

export type RelayWriteIntent =
  /** Author-only event (e.g. product listing, profile, deletion). */
  | "author_event"
  /** Recipient-aware event (e.g. NIP-17 gift wrap to one or more pubkeys). */
  | "recipient_event"

export interface RelayReadPlanInput {
  intent: RelayReadIntent
  /** Authors whose write relays should be added to the read set. */
  authors?: readonly string[]
  /** Recipients (e.g. inbox owners) whose read relays should be added. */
  recipients?: readonly string[]
  /** Cached relay lists keyed by pubkey. Missing keys fall back to defaults. */
  relayLists?: ReadonlyMap<string, RelayList>
  /** Maximum number of relays to query (bounded fanout). */
  maxRelays?: number
  /** Skip per-relay health filtering (test seam / last-resort retries). */
  skipHealthFilter?: boolean
  /** Override read settings (test seam). */
  settings?: RelaySettingsState
  /** Now in ms (test seam). */
  now?: number
}

export interface RelayReadPlan {
  intent: RelayReadIntent
  /** Ordered relay URLs to query. */
  relayUrls: string[]
  /** Relays that were parked by health and excluded. */
  parkedRelayUrls: string[]
  /** Relays that came from per-author NIP-65 hints. */
  hintRelayUrls: string[]
}

export interface RelayWritePlanInput {
  intent: RelayWriteIntent
  /** Author of the event being published. */
  authorPubkey?: string
  /** Recipients for `recipient_event` intent. */
  recipientPubkeys?: readonly string[]
  /** Cached relay lists keyed by pubkey. */
  relayLists?: ReadonlyMap<string, RelayList>
  /** Cap the primary relay count. */
  maxPrimaryRelays?: number
  /** Cap the broadcast relay count (best-effort, beyond primary). */
  maxBroadcastRelays?: number
  /** Skip health filtering. */
  skipHealthFilter?: boolean
  /** Override write settings (test seam). */
  settings?: RelaySettingsState
  /** Now in ms (test seam). */
  now?: number
}

export interface RelayWritePlan {
  intent: RelayWriteIntent
  /**
   * Relays where the event MUST be accepted for the write to be considered
   * successful. For `recipient_event`, these are the union of recipients'
   * read relays. For `author_event`, these are the user's write relays
   * (commerce + public).
   */
  primaryRelayUrls: string[]
  /**
   * Best-effort broadcast targets. Failures here do not fail the publish.
   * Used to seed an event into the user's write relays even when the
   * primary set is recipient-driven.
   */
  broadcastRelayUrls: string[]
  /** Relays that were parked by health and excluded. */
  parkedRelayUrls: string[]
}

export const DEFAULT_READ_FANOUT = 6
export const DEFAULT_PRIMARY_FANOUT = 4
export const DEFAULT_BROADCAST_FANOUT = 4

function dedupeOrdered(urls: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    if (!url) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function settingsPlanOptions(input: {
  settings?: RelaySettingsState
}): RelayPlanOptions {
  return {
    settings: input.settings,
    fallbackRelayUrls: config.defaultRelays,
  }
}

function hintReadRelaysForAuthors(
  authors: readonly string[],
  relayLists: ReadonlyMap<string, RelayList> | undefined
): string[] {
  if (!relayLists || authors.length === 0) return []
  const out: string[] = []
  for (const pubkey of authors) {
    const list = relayLists.get(pubkey)
    if (!list) continue
    // Reads target where the author *writes*. For DM inbox reads, the
    // caller passes recipients instead and uses `hintReadRelaysForRecipients`.
    out.push(...list.writeRelayUrls)
  }
  return out
}

function hintReadRelaysForRecipients(
  recipients: readonly string[],
  relayLists: ReadonlyMap<string, RelayList> | undefined
): string[] {
  if (!relayLists || recipients.length === 0) return []
  const out: string[] = []
  for (const pubkey of recipients) {
    const list = relayLists.get(pubkey)
    if (!list) continue
    out.push(...list.readRelayUrls)
  }
  return out
}

function applyHealthFilter(
  urls: readonly string[],
  skipHealthFilter: boolean | undefined,
  now: number | undefined
): { kept: string[]; parked: string[] } {
  if (skipHealthFilter) return { kept: dedupeOrdered(urls), parked: [] }
  const { healthy, parked } = partitionByHealth(urls, now ?? Date.now())
  return { kept: dedupeOrdered(healthy), parked: dedupeOrdered(parked) }
}

function clampFanout(urls: string[], limit: number | undefined): string[] {
  if (limit === undefined || limit <= 0) return urls
  return urls.slice(0, limit)
}

/**
 * Resolve a read plan. Order of precedence (highest first):
 *
 * 1. NIP-65 hints for `authors` (their write relays) and `recipients`
 *    (their read relays).
 * 2. User's commerce relays (for commerce intents) or general read relays.
 * 3. Public fallback relays.
 *
 * The result is deduplicated and capped at `maxRelays`.
 */
export function planRelayReads(input: RelayReadPlanInput): RelayReadPlan {
  const settingsOpts = settingsPlanOptions(input)

  const baseRelays = (() => {
    switch (input.intent) {
      case "commerce_products":
      case "author_products":
        return getCommerceReadRelayUrls(settingsOpts)
      case "product_card_social_summary":
      case "product_comments_preview":
      case "product_reviews":
      case "profile_social_feed":
      case "profiles":
      case "relay_lists":
      case "dm_inbox":
      case "general":
        return getGeneralReadRelayUrls(settingsOpts)
    }
  })()

  const authorHints = hintReadRelaysForAuthors(
    input.authors ?? [],
    input.relayLists
  )
  const recipientHints = hintReadRelaysForRecipients(
    input.recipients ?? [],
    input.relayLists
  )
  const hintRelayUrls = dedupeOrdered([...authorHints, ...recipientHints])

  const ordered = dedupeOrdered([...hintRelayUrls, ...baseRelays])
  const { kept, parked } = applyHealthFilter(
    ordered,
    input.skipHealthFilter,
    input.now
  )

  return {
    intent: input.intent,
    relayUrls: clampFanout(kept, input.maxRelays ?? DEFAULT_READ_FANOUT),
    parkedRelayUrls: parked,
    hintRelayUrls,
  }
}

/**
 * Resolve a write plan.
 *
 * - `author_event`: primary = user's write relays (commerce + public).
 *   Broadcast empty by default.
 * - `recipient_event`: primary = union of each recipient's read relays
 *   (from cached NIP-65). If a recipient has no cached list, we fall back
 *   to the user's general write relays for that recipient — best-effort
 *   delivery rather than dropping the message. Broadcast = user's write
 *   relays so the event is also seeded into our outbox.
 *
 * Recipient-aware writes always include at least one of the user's write
 * relays in `broadcastRelayUrls`, so an event sent to a recipient with no
 * known inbox is still eventually discoverable via the sender's outbox.
 */
export function planRelayWrites(input: RelayWritePlanInput): RelayWritePlan {
  const settingsOpts = settingsPlanOptions(input)
  const userWriteRelays = getGeneralWriteRelayUrls(settingsOpts)

  if (input.intent === "author_event") {
    const ordered = dedupeOrdered(userWriteRelays)
    const { kept, parked } = applyHealthFilter(
      ordered,
      input.skipHealthFilter,
      input.now
    )
    return {
      intent: input.intent,
      primaryRelayUrls: clampFanout(
        kept,
        input.maxPrimaryRelays ?? DEFAULT_PRIMARY_FANOUT
      ),
      broadcastRelayUrls: [],
      parkedRelayUrls: parked,
    }
  }

  // recipient_event
  const recipients = input.recipientPubkeys ?? []
  const recipientHints = hintReadRelaysForRecipients(
    recipients,
    input.relayLists
  )

  // Recipients with no cached list contribute nothing; fall back to user
  // write relays for those recipients so the event is at least seeded
  // somewhere both parties can discover it.
  const missingRecipientFallback = recipients.some(
    (pubkey) => !input.relayLists?.get(pubkey)?.readRelayUrls.length
  )
    ? userWriteRelays
    : []

  const primaryOrdered = dedupeOrdered([
    ...recipientHints,
    ...missingRecipientFallback,
  ])
  const { kept: primaryKept, parked: primaryParked } = applyHealthFilter(
    primaryOrdered,
    input.skipHealthFilter,
    input.now
  )

  const broadcastOrdered = dedupeOrdered(
    userWriteRelays.filter((url) => !primaryKept.includes(url))
  )
  const { kept: broadcastKept, parked: broadcastParked } = applyHealthFilter(
    broadcastOrdered,
    input.skipHealthFilter,
    input.now
  )

  return {
    intent: input.intent,
    primaryRelayUrls: clampFanout(
      primaryKept,
      input.maxPrimaryRelays ?? DEFAULT_PRIMARY_FANOUT
    ),
    broadcastRelayUrls: clampFanout(
      broadcastKept,
      input.maxBroadcastRelays ?? DEFAULT_BROADCAST_FANOUT
    ),
    parkedRelayUrls: dedupeOrdered([...primaryParked, ...broadcastParked]),
  }
}

/**
 * Convenience: load relay settings once and return both plan helpers
 * bound to that snapshot. Useful for callers that need consistent reads
 * and writes within a single user action.
 */
export function planRelaysWithSnapshot(scope?: string | null): {
  settings: RelaySettingsState
  planReads: (input: Omit<RelayReadPlanInput, "settings">) => RelayReadPlan
  planWrites: (input: Omit<RelayWritePlanInput, "settings">) => RelayWritePlan
} {
  const settings = loadRelaySettings(scope)
  return {
    settings,
    planReads: (input) => planRelayReads({ ...input, settings }),
    planWrites: (input) => planRelayWrites({ ...input, settings }),
  }
}
