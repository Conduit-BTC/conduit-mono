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
 * plan with the bounded reader or an explicit relay-set publisher.
 *
 * Read intents map to the existing `CommerceReadPlanName` so commerce.ts
 * can adopt the planner without breaking the source-tagging model. Read
 * intents are deliberately broader than commerce so we can also plan for
 * profile, social graph, and DM reads.
 */

import { config } from "../config"
import {
  getConfiguredIsolatedE2eRelayUrl,
  getCommerceReadRelayUrls,
  getCommerceWriteRelayUrls,
  getGeneralReadRelayUrls,
  getGeneralWriteRelayUrls,
  loadRelaySettingsPlanningSnapshot,
  normalizeOwnerSelectedRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  tryNormalizeRelayUrl,
  type RelayPlanOptions,
  type RelaySettingsState,
} from "./relay-settings"
import { filterRelayListForContext, type RelayList } from "./relay-list"
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
  /** Deprecated NIP-04 history, read-only. */
  | "legacy_dm"
  /** Aggregate social signals (reactions, zaps, comments) for a product. */
  | "product_card_social_summary"
  /** Top-N comments preview for a product card. */
  | "product_comments_preview"
  /** Full review/comment thread for a product detail surface. */
  | "product_reviews"
  /** A profile's recent social feed (kind 1 / kind 6 / kind 30023, etc.). */
  | "profile_social_feed"
  /** NIP-02 contact lists, routed to each author's write relays. */
  | "contact_lists"
  /** Bounded public evidence for the selected incoming-order shopper. */
  | "shopper_trust"
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
  /** Authenticated pubkey whose own NIP-65 local relays may be used. */
  authenticatedPubkey?: string | null
  /**
   * Exact relay subset backed by that authenticated owner's durable Network
   * selection. Remote NIP-65 lists and relay hints must never populate this.
   */
  ownerSelectedRelayUrls?: readonly string[]
  /** Maximum number of relays to query (bounded fanout). */
  maxRelays?: number
  /** Skip per-relay health filtering (test seam / last-resort retries). */
  skipHealthFilter?: boolean
  /** Override read settings (test seam). */
  settings?: RelaySettingsState
  /** Preserve an exact signed kind-10002 empty Read set (bound snapshots). */
  signedRelayListAuthoritative?: boolean
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
  /** Exact executable subset authorized by the authenticated owner. */
  ownerSelectedRelayUrls?: string[]
}

export interface RelayWritePlanInput {
  intent: RelayWriteIntent
  /** Author of the event being published. */
  authorPubkey?: string
  /** Recipients for `recipient_event` intent. */
  recipientPubkeys?: readonly string[]
  /** Cached relay lists keyed by pubkey. */
  relayLists?: ReadonlyMap<string, RelayList>
  /** Authenticated pubkey whose own NIP-65 local relays may be used. */
  authenticatedPubkey?: string | null
  /** Exact relay subset backed by that authenticated owner's Network choice. */
  ownerSelectedRelayUrls?: readonly string[]
  /** Cap the primary relay count. */
  maxPrimaryRelays?: number
  /** Cap the broadcast relay count (best-effort, beyond primary). */
  maxBroadcastRelays?: number
  /** Skip health filtering. */
  skipHealthFilter?: boolean
  /** Override write settings (test seam). */
  settings?: RelaySettingsState
  /** A reconciled signed owner projection supersedes the arbitrary-author cache. */
  signedRelayListAuthoritative?: boolean
  /** Now in ms (test seam). */
  now?: number
}

export interface RelayWritePlan {
  intent: RelayWriteIntent
  /**
   * True when the authenticated author's usable signed NIP-65 projection
   * governs this plan. Code-owned author fallbacks must not broaden it.
   */
  signedRelayListAuthoritative?: boolean
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
  fallbackRelayUrls: readonly string[]
  signedRelayListAuthoritative?: boolean
}): RelayPlanOptions {
  return {
    settings: input.settings,
    fallbackRelayUrls: input.fallbackRelayUrls,
    signedRelayListAuthoritative: input.signedRelayListAuthoritative,
  }
}

function appAssistedReadFallbackRelayUrls(): string[] {
  return dedupeOrdered([
    ...config.appBackplaneRelayUrls,
    ...config.corePublicFallbackRelayUrls,
  ])
}

function commerceReadFallbackRelayUrls(): string[] {
  return dedupeOrdered([
    ...config.appBackplaneRelayUrls,
    ...config.commerceDiscoveryRelayUrls,
    ...config.corePublicFallbackRelayUrls,
  ])
}

function corePublicReadFallbackRelayUrls(): string[] {
  return dedupeOrdered(config.corePublicFallbackRelayUrls)
}

function defaultRecipientWriteFallbackRelayUrls(): string[] {
  return config.dmInboxDefaultRelayUrls.length > 0
    ? config.dmInboxDefaultRelayUrls
    : appAssistedReadFallbackRelayUrls()
}

function hintReadRelaysForAuthors(
  authors: readonly string[],
  relayLists: ReadonlyMap<string, RelayList> | undefined,
  authenticatedPubkey: string | null | undefined,
  ownerSelectedRelayUrls: readonly string[] = []
): string[] {
  if (!relayLists || authors.length === 0) return []
  const authenticatedOwner = authenticatedPubkey?.trim().toLowerCase()
  const ownerSelected = new Set(
    normalizeOwnerSelectedRelayUrls(ownerSelectedRelayUrls)
  )
  const out: string[] = []
  for (const pubkey of authors) {
    const rawList = relayLists.get(pubkey)
    if (!rawList) continue
    const isAuthenticatedOwner =
      pubkey.trim().toLowerCase() === authenticatedOwner
    // Reads target where the author *writes*. For DM inbox reads, the
    // caller passes recipients instead and uses `hintReadRelaysForRecipients`.
    out.push(
      ...(isAuthenticatedOwner
        ? normalizeSecureOrIsolatedE2eRelayUrls(rawList.writeRelayUrls)
        : filterRelayListForContext(rawList).writeRelayUrls)
    )
    if (isAuthenticatedOwner) {
      out.push(
        ...rawList.writeRelayUrls.filter((relayUrl) =>
          ownerSelected.has(relayUrl)
        )
      )
    }
  }
  return out
}

function hintReadRelaysForRecipients(
  recipients: readonly string[],
  relayLists: ReadonlyMap<string, RelayList> | undefined,
  authenticatedPubkey: string | null | undefined,
  ownerSelectedRelayUrls: readonly string[] = []
): string[] {
  if (!relayLists || recipients.length === 0) return []
  const authenticatedOwner = authenticatedPubkey?.trim().toLowerCase()
  const ownerSelected = new Set(
    normalizeOwnerSelectedRelayUrls(ownerSelectedRelayUrls)
  )
  const out: string[] = []
  for (const pubkey of recipients) {
    const rawList = relayLists.get(pubkey)
    if (!rawList) continue
    const isAuthenticatedOwner =
      pubkey.trim().toLowerCase() === authenticatedOwner
    out.push(
      ...(isAuthenticatedOwner
        ? normalizeSecureOrIsolatedE2eRelayUrls(rawList.readRelayUrls)
        : filterRelayListForContext(rawList).readRelayUrls)
    )
    if (isAuthenticatedOwner) {
      out.push(
        ...rawList.readRelayUrls.filter((relayUrl) =>
          ownerSelected.has(relayUrl)
        )
      )
    }
  }
  return out
}

function hasRecipientReadRelays(input: {
  pubkey: string
  relayLists: ReadonlyMap<string, RelayList> | undefined
  authenticatedPubkey: string | null | undefined
  ownerSelectedRelayUrls?: readonly string[]
}): boolean {
  const rawList = input.relayLists?.get(input.pubkey)
  if (!rawList) return false
  const authenticatedOwner = input.authenticatedPubkey?.trim().toLowerCase()
  const isAuthenticatedOwner =
    input.pubkey.trim().toLowerCase() === authenticatedOwner
  const eligibleWssRelayUrls = isAuthenticatedOwner
    ? normalizeSecureOrIsolatedE2eRelayUrls(rawList.readRelayUrls)
    : filterRelayListForContext(rawList).readRelayUrls
  if (eligibleWssRelayUrls.length > 0) {
    return true
  }
  if (!isAuthenticatedOwner) return false
  const ownerSelected = new Set(
    normalizeOwnerSelectedRelayUrls(input.ownerSelectedRelayUrls ?? [])
  )
  return rawList.readRelayUrls.some((relayUrl) => ownerSelected.has(relayUrl))
}

function applyReadTransportAuthority(
  relayUrls: readonly string[],
  ownerSelectedRelayUrls: readonly string[]
): string[] {
  const ownerSelected = new Set(
    normalizeOwnerSelectedRelayUrls(ownerSelectedRelayUrls)
  )
  const remotelyEligible = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
  )
  const accepted: string[] = []
  const seen = new Set<string>()
  for (const rawRelayUrl of relayUrls) {
    const normalized = tryNormalizeRelayUrl(rawRelayUrl)
    if (!normalized.ok || seen.has(normalized.url)) continue
    if (
      !remotelyEligible.has(normalized.url) &&
      !ownerSelected.has(normalized.url)
    ) {
      continue
    }
    seen.add(normalized.url)
    accepted.push(normalized.url)
  }
  return accepted
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
  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  if (config.e2eRelayIsolationEnabled) {
    if (!isolatedRelayUrl) {
      throw new Error(
        "E2E relay isolation requires one configured loopback relay"
      )
    }
    return {
      intent: input.intent,
      relayUrls: [isolatedRelayUrl],
      parkedRelayUrls: [],
      hintRelayUrls: [],
      ownerSelectedRelayUrls: [],
    }
  }

  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    input.ownerSelectedRelayUrls ?? []
  )

  const baseRelays = (() => {
    switch (input.intent) {
      case "commerce_products":
      case "author_products":
        // NIP-65 membership describes the account's preferred read relays. It
        // is not a global offline switch for code-owned public commerce
        // discovery, which remains a separate bounded capability.
        return getCommerceReadRelayUrls(
          settingsPlanOptions({
            settings: input.settings,
            fallbackRelayUrls: commerceReadFallbackRelayUrls(),
            signedRelayListAuthoritative: false,
          })
        )
      case "dm_inbox":
      case "legacy_dm":
        return getGeneralReadRelayUrls(
          settingsPlanOptions({
            settings: input.settings,
            fallbackRelayUrls: config.commerceDmFallbackRelayUrls,
            signedRelayListAuthoritative: input.signedRelayListAuthoritative,
          })
        )
      case "product_card_social_summary":
      case "product_comments_preview":
      case "product_reviews":
      case "profile_social_feed":
      case "contact_lists":
      case "shopper_trust":
      case "profiles":
      case "relay_lists":
      case "general":
        return getGeneralReadRelayUrls(
          settingsPlanOptions({
            settings: input.settings,
            fallbackRelayUrls: corePublicReadFallbackRelayUrls(),
            signedRelayListAuthoritative: input.signedRelayListAuthoritative,
          })
        )
    }
  })()

  const authenticatedOwner = input.authenticatedPubkey?.trim().toLowerCase()
  const includesAuthenticatedOwner = Boolean(
    authenticatedOwner &&
    (input.authors ?? []).some(
      (pubkey) => pubkey.trim().toLowerCase() === authenticatedOwner
    )
  )
  const authenticatedOwnerAuthorHints =
    input.signedRelayListAuthoritative && includesAuthenticatedOwner
      ? getGeneralWriteRelayUrls(
          settingsPlanOptions({
            settings: input.settings,
            fallbackRelayUrls: [],
          })
        )
      : []
  const authorHintPubkeys = input.signedRelayListAuthoritative
    ? (input.authors ?? []).filter(
        (pubkey) => pubkey.trim().toLowerCase() !== authenticatedOwner
      )
    : (input.authors ?? [])
  const authorHints = hintReadRelaysForAuthors(
    authorHintPubkeys,
    input.relayLists,
    input.authenticatedPubkey,
    ownerSelectedRelayUrls
  )
  const recipientHints = hintReadRelaysForRecipients(
    input.recipients ?? [],
    input.relayLists,
    input.authenticatedPubkey,
    ownerSelectedRelayUrls
  )
  const hintRelayUrls = applyReadTransportAuthority(
    dedupeOrdered([
      ...authenticatedOwnerAuthorHints,
      ...authorHints,
      ...recipientHints,
    ]),
    ownerSelectedRelayUrls
  )

  const ordered = applyReadTransportAuthority(
    dedupeOrdered([...hintRelayUrls, ...baseRelays]),
    ownerSelectedRelayUrls
  )
  const { kept, parked } = applyHealthFilter(
    ordered,
    input.skipHealthFilter,
    input.now
  )

  const relayUrls = clampFanout(kept, input.maxRelays ?? DEFAULT_READ_FANOUT)
  const executableRelayUrls = new Set(relayUrls)
  return {
    intent: input.intent,
    relayUrls,
    parkedRelayUrls: parked,
    hintRelayUrls,
    ownerSelectedRelayUrls: ownerSelectedRelayUrls.filter((relayUrl) =>
      executableRelayUrls.has(relayUrl)
    ),
  }
}

/**
 * Resolve a write plan.
 *
 * - `author_event`: primary = author's NIP-65 write relays plus the user's
 *   enabled write relays (commerce + public). Broadcast empty by default.
 * - `recipient_event`: primary = union of each recipient's read relays
 *   (from cached NIP-65). If a recipient has no cached list, we fall back
 *   to shared app/public recipient relays instead of sender-only outbox
 *   relays. Broadcast = user's write relays so the event is also seeded into
 *   our outbox.
 *
 * Recipient-aware writes always include at least one of the user's write
 * relays in `broadcastRelayUrls`, so an event sent to a recipient with no
 * known inbox still has a sender-side backup without treating that backup as
 * recipient delivery.
 */
export function planRelayWrites(input: RelayWritePlanInput): RelayWritePlan {
  const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
  if (config.e2eRelayIsolationEnabled) {
    if (!isolatedRelayUrl) {
      throw new Error(
        "E2E relay isolation requires one configured loopback relay"
      )
    }
    return {
      intent: input.intent,
      primaryRelayUrls: [isolatedRelayUrl],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    }
  }

  const userWriteRelays =
    input.intent === "author_event"
      ? getCommerceWriteRelayUrls(
          settingsPlanOptions({
            settings: input.settings,
            fallbackRelayUrls: [],
          })
        )
      : getGeneralWriteRelayUrls(
          settingsPlanOptions({
            settings: input.settings,
            fallbackRelayUrls: [],
          })
        )

  if (input.intent === "author_event") {
    const authorPubkey = input.authorPubkey?.trim().toLowerCase()
    const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
    const hasReconciledOwnerProjection = Boolean(
      input.signedRelayListAuthoritative &&
      authorPubkey &&
      authorPubkey === authenticatedPubkey
    )
    const authorWriteHints = hasReconciledOwnerProjection
      ? []
      : hintReadRelaysForAuthors(
          input.authorPubkey ? [input.authorPubkey] : [],
          input.relayLists,
          input.authenticatedPubkey,
          input.ownerSelectedRelayUrls
        )
    const ordered = dedupeOrdered(
      hasReconciledOwnerProjection
        ? userWriteRelays
        : [...authorWriteHints, ...userWriteRelays]
    )
    const { kept, parked } = applyHealthFilter(
      ordered,
      input.skipHealthFilter,
      input.now
    )
    return {
      intent: input.intent,
      signedRelayListAuthoritative: hasReconciledOwnerProjection,
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
    input.relayLists,
    input.authenticatedPubkey,
    input.ownerSelectedRelayUrls
  )

  // Recipients with no cached list contribute nothing. Use the shared
  // app/public relay fallback as recipient delivery, not the sender's private
  // outbox relays; otherwise a buyer-only write ACK can look deliverable while
  // the recipient inbox has no reason to read that relay.
  const missingRecipientFallback = recipients.some(
    (pubkey) =>
      !hasRecipientReadRelays({
        pubkey,
        relayLists: input.relayLists,
        authenticatedPubkey: input.authenticatedPubkey,
        ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
      })
  )
    ? defaultRecipientWriteFallbackRelayUrls()
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
  planReads: (
    input: Omit<RelayReadPlanInput, "settings" | "signedRelayListAuthoritative">
  ) => RelayReadPlan
  planWrites: (
    input: Omit<
      RelayWritePlanInput,
      "settings" | "signedRelayListAuthoritative"
    >
  ) => RelayWritePlan
} {
  const snapshot = loadRelaySettingsPlanningSnapshot(scope)
  return {
    settings: snapshot.settings,
    planReads: (input) =>
      planRelayReads({
        ...input,
        settings: snapshot.settings,
        signedRelayListAuthoritative: snapshot.signedRelayListAuthoritative,
      }),
    planWrites: (input) =>
      planRelayWrites({
        ...input,
        settings: snapshot.settings,
        signedRelayListAuthoritative: snapshot.signedRelayListAuthoritative,
      }),
  }
}
