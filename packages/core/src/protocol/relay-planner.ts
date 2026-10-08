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
import type { AccountNetworkRoutingPolicy } from "./account-network-routing-policy"
import { EVENT_KINDS } from "./kinds"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayGrant,
  type RelayTarget,
} from "./relay-authority"

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
  /** General author-only event (e.g. profile or contact list). */
  | "author_event"
  /** Commerce author event routed through commerce-qualified App roles. */
  | "commerce_author_event"
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
  /** Device-local switches for app-owned and personal NIP-65 relay layers. */
  routingPolicy?: Pick<
    AccountNetworkRoutingPolicy,
    "appRelaysEnabled" | "personalRelaysEnabled"
  >
  /** Now in ms (test seam). */
  now?: number
}

export interface RelayReadPlan {
  intent: RelayReadIntent
  /** Ordered candidates with every independent authority retained. */
  relayTargets: RelayTarget[]
  /** Ordered relay URLs to query under the legacy planner-time fanout cap. */
  relayUrls: string[]
  /**
   * Full ordered, health-eligible candidate set. Final I/O applies
   * `maxRelayAttempts` after re-reading live account source policy so a
   * disabled source cannot consume the bounded fanout ahead of an enabled
   * source.
   */
  candidateRelayUrls: string[]
  /** Maximum admitted relay attempts. Omitted when fanout is unbounded. */
  maxRelayAttempts?: number
  /** Relays that were parked by health and excluded. */
  parkedRelayUrls: string[]
  /** Relays that came from per-author NIP-65 hints. */
  hintRelayUrls: string[]
  /** Exact executable subset authorized by the authenticated owner. */
  ownerSelectedRelayUrls?: string[]
  /** Planned targets contributed by Conduit's transparent app layer. */
  appRelayUrls?: string[]
  /** Planned targets contributed by the authenticated owner's NIP-65 layer. */
  personalRelayUrls?: string[]
  /** Remote signed NIP-65 hints that remain authoritative across local switches. */
  independentRelayUrls: string[]
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
  /** Device-local switches for app-owned and personal NIP-65 relay layers. */
  routingPolicy?: Pick<
    AccountNetworkRoutingPolicy,
    "appRelaysEnabled" | "personalRelaysEnabled"
  >
  /** Now in ms (test seam). */
  now?: number
}

export interface RelayWritePlan {
  /** Exact primary candidates and their independent write authorities. */
  primaryRelayTargets: RelayTarget[]
  /** Exact best-effort candidates and their independent write authorities. */
  broadcastRelayTargets: RelayTarget[]
  /** Fixed fallback candidates resolved before any publish I/O. */
  fallbackRelayUrls?: string[]
  intent: RelayWriteIntent
  /**
   * True when the authenticated author's usable signed NIP-65 projection
   * governs this plan. Code-owned author fallbacks must not broaden it.
   */
  signedRelayListAuthoritative?: boolean
  /**
   * Relays where the event MUST be accepted for the write to be considered
   * successful. For `recipient_event`, these are the union of recipients'
   * read relays. For author intents, these are the user's write relays plus
   * only the App write roles qualified for that intent.
   */
  primaryRelayUrls: string[]
  /** Full ordered candidates retained until final live-policy admission. */
  primaryCandidateRelayUrls?: string[]
  /** Maximum admitted primary relay attempts; omitted when unbounded. */
  maxPrimaryRelayAttempts?: number
  /**
   * Best-effort broadcast targets. Failures here do not fail the publish.
   * Used to seed an event into the user's write relays even when the
   * primary set is recipient-driven.
   */
  broadcastRelayUrls: string[]
  /** Full ordered broadcast candidates retained until final admission. */
  broadcastCandidateRelayUrls?: string[]
  /** Maximum admitted broadcast attempts; omitted when unbounded. */
  maxBroadcastRelayAttempts?: number
  /** Relays that were parked by health and excluded. */
  parkedRelayUrls: string[]
  /** Planned targets contributed by Conduit's transparent app layer. */
  appRelayUrls?: string[]
  /** Planned targets contributed by the authenticated owner's NIP-65 layer. */
  personalRelayUrls?: string[]
  /** Remote signed NIP-65 hints that remain authoritative across local switches. */
  independentRelayUrls: string[]
}

/**
 * Prepare read authority for verifying a public event after a write ACK.
 * Recipient and owner NIP-17 grants are deliberately omitted: private inbox
 * delivery authority does not authorize reading an author's public event.
 */
export function planPublicEventReadbackTargets(
  targets: readonly RelayTarget[]
): RelayTarget[] {
  const readback: RelayTarget[] = []
  for (const target of targets) {
    const grants: RelayGrant[] = []
    for (const grant of target.grants) {
      if (
        grant.kind === "owner_nip17" ||
        grant.kind === "recipient_nip17" ||
        grant.kind === "recovery" ||
        grant.kind === "retained_inbox" ||
        grant.kind === "compatibility"
      ) {
        continue
      }
      if (grant.operation === "read") {
        grants.push({ ...grant })
        continue
      }
      switch (grant.kind) {
        case "owner_nip65":
          if (grant.selection === "write") {
            grants.push({
              kind: "owner_nip65",
              operation: "read",
              ownerPubkey: grant.ownerPubkey,
              selection: "write",
            })
          }
          break
        case "remote_nip65":
          grants.push({
            kind: "remote_nip65",
            operation: "read",
            pubkey: grant.pubkey,
          })
          break
        case "app":
          if (
            grant.bucket === "general_write" ||
            grant.bucket === "commerce_write"
          ) {
            grants.push({
              kind: "app",
              operation: "read",
              bucket: "author_readback",
            })
          } else {
            // A successful public write ACK is direct evidence that this
            // secure relay can be queried for exact readback.
            grants.push({ kind: "public_hint", operation: "read" })
          }
          break
        case "discovery":
          grants.push({
            kind: "discovery",
            operation: "read",
            registry: grant.registry,
          })
          break
        case "source_delivery":
          grants.push({ kind: "public_hint", operation: "read" })
          break
        case "owner_selection":
          if (grant.eventKind === EVENT_KINDS.RELAY_LIST) {
            grants.push({
              kind: "owner_nip65",
              operation: "read",
              ownerPubkey: grant.ownerPubkey,
              selection: "write",
            })
          }
          break
      }
    }
    if (grants.length > 0) readback.push({ url: target.url, grants })
  }
  return mergeRelayTargets(readback)
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

function appReadRelayUrlsForIntent(intent: RelayReadIntent): string[] {
  switch (intent) {
    case "commerce_products":
    case "author_products":
      return dedupeOrdered([
        ...config.appCommerceRelayUrls,
        ...config.commerceDiscoveryRelayUrls,
      ])
    case "dm_inbox":
    case "legacy_dm":
      return dedupeOrdered(config.commerceDmFallbackRelayUrls)
    default:
      return dedupeOrdered([
        ...config.appReadRelayUrls,
        ...config.corePublicFallbackRelayUrls,
      ])
  }
}

function isAuthorWriteIntent(intent: RelayWriteIntent): boolean {
  return intent === "author_event" || intent === "commerce_author_event"
}

function appWriteRelayUrlsForIntent(intent: RelayWriteIntent): string[] {
  return intent === "commerce_author_event"
    ? dedupeOrdered(config.commerceRelayUrls)
    : dedupeOrdered(config.appWriteRelayUrls)
}

function defaultRecipientWriteFallbackRelayUrls(): string[] {
  return config.dmInboxDefaultRelayUrls.length > 0
    ? config.dmInboxDefaultRelayUrls
    : config.appReadRelayUrls
}

function appLayerEnabled(
  policy:
    | Pick<
        AccountNetworkRoutingPolicy,
        "appRelaysEnabled" | "personalRelaysEnabled"
      >
    | undefined
): boolean {
  return policy?.appRelaysEnabled ?? true
}

function personalLayerEnabled(
  policy:
    | Pick<
        AccountNetworkRoutingPolicy,
        "appRelaysEnabled" | "personalRelaysEnabled"
      >
    | undefined
): boolean {
  return policy?.personalRelaysEnabled ?? true
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

function targetsForCandidateUrls(
  urls: readonly string[],
  ...sources: readonly { urls: readonly string[]; grant: RelayGrant }[]
): RelayTarget[] {
  const candidates = new Set(urls)
  return mergeRelayTargets(
    ...sources.map((source) =>
      relayTargetsFromUrls(
        source.urls.filter((url) => candidates.has(url)),
        source.grant
      )
    )
  ).sort((left, right) => urls.indexOf(left.url) - urls.indexOf(right.url))
}

function appReadGrantSources(intent: RelayReadIntent, urls: readonly string[]) {
  const sources: { urls: readonly string[]; grant: RelayGrant }[] = [
    {
      urls: config.appReadRelayUrls,
      grant: { kind: "app", operation: "read", bucket: "general_read" },
    },
    {
      urls: config.appCommerceRelayUrls,
      grant: { kind: "app", operation: "read", bucket: "commerce_read" },
    },
    {
      urls: config.corePublicFallbackRelayUrls,
      grant: {
        kind: "public_fallback",
        operation: "read",
        bucket: "core_public",
      },
    },
    {
      urls: config.commerceDiscoveryRelayUrls,
      grant: {
        kind: "public_fallback",
        operation: "read",
        bucket: "commerce_discovery",
      },
    },
  ]
  if (intent === "dm_inbox" || intent === "legacy_dm") {
    sources.push({
      urls: config.commerceDmFallbackRelayUrls,
      grant: { kind: "compatibility", operation: "read", policy: "inbox_read" },
    })
  }
  return sources.map((source) => ({
    ...source,
    urls: source.urls.filter((url) => urls.includes(url)),
  }))
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
      relayTargets: targetsForCandidateUrls([isolatedRelayUrl], {
        urls: [isolatedRelayUrl],
        grant: { kind: "app", operation: "read", bucket: "general_read" },
      }),
      relayUrls: [isolatedRelayUrl],
      candidateRelayUrls: [isolatedRelayUrl],
      maxRelayAttempts: 1,
      parkedRelayUrls: [],
      hintRelayUrls: [],
      ownerSelectedRelayUrls: [],
      appRelayUrls: [isolatedRelayUrl],
      personalRelayUrls: [],
      independentRelayUrls: [],
    }
  }

  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    input.ownerSelectedRelayUrls ?? []
  )

  const personalBaseRelays = personalLayerEnabled(input.routingPolicy)
    ? (() => {
        switch (input.intent) {
          case "commerce_products":
          case "author_products":
            return getCommerceReadRelayUrls(
              settingsPlanOptions({
                settings: input.settings,
                fallbackRelayUrls: [],
                signedRelayListAuthoritative:
                  input.signedRelayListAuthoritative,
              })
            )
          case "dm_inbox":
          case "legacy_dm":
            return getGeneralReadRelayUrls(
              settingsPlanOptions({
                settings: input.settings,
                fallbackRelayUrls: [],
                signedRelayListAuthoritative:
                  input.signedRelayListAuthoritative,
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
                fallbackRelayUrls: [],
                signedRelayListAuthoritative:
                  input.signedRelayListAuthoritative,
              })
            )
        }
      })()
    : []
  const appBaseRelays = appLayerEnabled(input.routingPolicy)
    ? appReadRelayUrlsForIntent(input.intent)
    : []

  const authenticatedOwner = input.authenticatedPubkey?.trim().toLowerCase()
  const includesAuthenticatedOwner = Boolean(
    authenticatedOwner &&
    (input.authors ?? []).some(
      (pubkey) => pubkey.trim().toLowerCase() === authenticatedOwner
    )
  )
  const authenticatedOwnerAuthorHints =
    personalLayerEnabled(input.routingPolicy) && includesAuthenticatedOwner
      ? input.signedRelayListAuthoritative
        ? getGeneralWriteRelayUrls(
            settingsPlanOptions({
              settings: input.settings,
              fallbackRelayUrls: [],
            })
          )
        : hintReadRelaysForAuthors(
            [authenticatedOwner!],
            input.relayLists,
            input.authenticatedPubkey,
            ownerSelectedRelayUrls
          )
      : []
  const authorHintPubkeys = (input.authors ?? []).filter(
    (pubkey) => pubkey.trim().toLowerCase() !== authenticatedOwner
  )
  const authorHints = hintReadRelaysForAuthors(
    authorHintPubkeys,
    input.relayLists,
    input.authenticatedPubkey,
    ownerSelectedRelayUrls
  )
  const includesAuthenticatedRecipient = Boolean(
    authenticatedOwner &&
    (input.recipients ?? []).some(
      (pubkey) => pubkey.trim().toLowerCase() === authenticatedOwner
    )
  )
  const authenticatedOwnerRecipientHints =
    personalLayerEnabled(input.routingPolicy) && includesAuthenticatedRecipient
      ? input.signedRelayListAuthoritative
        ? getGeneralReadRelayUrls(
            settingsPlanOptions({
              settings: input.settings,
              fallbackRelayUrls: [],
              signedRelayListAuthoritative: input.signedRelayListAuthoritative,
            })
          )
        : hintReadRelaysForRecipients(
            [authenticatedOwner!],
            input.relayLists,
            input.authenticatedPubkey,
            ownerSelectedRelayUrls
          )
      : []
  const recipientHints = hintReadRelaysForRecipients(
    (input.recipients ?? []).filter(
      (pubkey) => pubkey.trim().toLowerCase() !== authenticatedOwner
    ),
    input.relayLists,
    input.authenticatedPubkey,
    ownerSelectedRelayUrls
  )
  const hintRelayUrls = applyReadTransportAuthority(
    dedupeOrdered([
      ...authenticatedOwnerAuthorHints,
      ...authenticatedOwnerRecipientHints,
      ...authorHints,
      ...recipientHints,
    ]),
    ownerSelectedRelayUrls
  )

  const ordered = applyReadTransportAuthority(
    dedupeOrdered([...hintRelayUrls, ...personalBaseRelays, ...appBaseRelays]),
    ownerSelectedRelayUrls
  )
  const { kept, parked } = applyHealthFilter(
    ordered,
    input.skipHealthFilter,
    input.now
  )

  const requestedMaxRelays = input.maxRelays ?? DEFAULT_READ_FANOUT
  const maxRelayAttempts =
    requestedMaxRelays > 0 ? requestedMaxRelays : undefined
  const relayUrls = clampFanout(kept, requestedMaxRelays)
  const candidateRelayUrlSet = new Set(kept)
  const appRelaySet = new Set(appBaseRelays)
  const personalRelaySet = new Set([
    ...ownerSelectedRelayUrls,
    ...personalBaseRelays,
    ...authenticatedOwnerAuthorHints,
    ...authenticatedOwnerRecipientHints,
  ])
  const independentRelaySet = new Set([...authorHints, ...recipientHints])
  const remoteHintSources = [
    ...(input.authors ?? []),
    ...(input.recipients ?? []),
  ]
    .filter((pubkey) => pubkey.trim().toLowerCase() !== authenticatedOwner)
    .map((pubkey) => ({
      urls: [
        ...(input.authors?.includes(pubkey)
          ? filterRelayListForContext(
              input.relayLists?.get(pubkey) ?? {
                pubkey,
                readRelayUrls: [],
                writeRelayUrls: [],
                eventCreatedAt: 0,
                cachedAt: 0,
              }
            ).writeRelayUrls
          : []),
        ...(input.recipients?.includes(pubkey)
          ? filterRelayListForContext(
              input.relayLists?.get(pubkey) ?? {
                pubkey,
                readRelayUrls: [],
                writeRelayUrls: [],
                eventCreatedAt: 0,
                cachedAt: 0,
              }
            ).readRelayUrls
          : []),
      ],
      grant: { kind: "remote_nip65", operation: "read", pubkey } as const,
    }))
  const relayTargets = targetsForCandidateUrls(
    kept,
    ...appReadGrantSources(input.intent, appBaseRelays),
    {
      urls: personalBaseRelays,
      grant: {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: authenticatedOwner ?? "",
        selection: "read",
      },
    },
    {
      urls: authenticatedOwnerAuthorHints,
      grant: {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: authenticatedOwner ?? "",
        selection: "write",
      },
    },
    {
      urls: authenticatedOwnerRecipientHints,
      grant: {
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: authenticatedOwner ?? "",
        selection: "read",
      },
    },
    ...remoteHintSources
  )
  return {
    intent: input.intent,
    relayTargets,
    relayUrls,
    candidateRelayUrls: kept,
    ...(maxRelayAttempts === undefined ? {} : { maxRelayAttempts }),
    parkedRelayUrls: parked,
    hintRelayUrls,
    ownerSelectedRelayUrls: ownerSelectedRelayUrls.filter((relayUrl) =>
      candidateRelayUrlSet.has(relayUrl)
    ),
    appRelayUrls: kept.filter((relayUrl) => appRelaySet.has(relayUrl)),
    personalRelayUrls: kept.filter((relayUrl) =>
      personalRelaySet.has(relayUrl)
    ),
    independentRelayUrls: kept.filter((relayUrl) =>
      independentRelaySet.has(relayUrl)
    ),
  }
}

/**
 * Resolve a write plan.
 *
 * - author intents: primary = author's NIP-65 write relays plus the user's
 *   enabled writes and intent-qualified App writes. Broadcast empty by default.
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
      primaryRelayTargets: targetsForCandidateUrls([isolatedRelayUrl], {
        urls: [isolatedRelayUrl],
        grant: { kind: "app", operation: "write", bucket: "general_write" },
      }),
      broadcastRelayTargets: [],
      primaryRelayUrls: [isolatedRelayUrl],
      primaryCandidateRelayUrls: [isolatedRelayUrl],
      maxPrimaryRelayAttempts: 1,
      broadcastRelayUrls: [],
      broadcastCandidateRelayUrls: [],
      parkedRelayUrls: [],
      appRelayUrls: [isolatedRelayUrl],
      personalRelayUrls: [],
      independentRelayUrls: [],
    }
  }

  const personalWriteRelays = personalLayerEnabled(input.routingPolicy)
    ? isAuthorWriteIntent(input.intent)
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
    : []
  const appWriteRelays = appLayerEnabled(input.routingPolicy)
    ? appWriteRelayUrlsForIntent(input.intent)
    : []
  const userWriteRelays = dedupeOrdered([
    ...personalWriteRelays,
    ...appWriteRelays,
  ])
  const appWriteRelaySet = new Set(appWriteRelays)
  const personalWriteRelaySet = new Set(personalWriteRelays)

  if (isAuthorWriteIntent(input.intent)) {
    const authorPubkey = input.authorPubkey?.trim().toLowerCase()
    const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
    const isAuthenticatedAuthor = Boolean(
      authorPubkey && authorPubkey === authenticatedPubkey
    )
    const hasReconciledOwnerProjection = Boolean(
      input.signedRelayListAuthoritative && isAuthenticatedAuthor
    )
    const authorWriteHints =
      hasReconciledOwnerProjection ||
      (isAuthenticatedAuthor && !personalLayerEnabled(input.routingPolicy))
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
    const requestedMaxPrimaryRelays =
      input.maxPrimaryRelays ?? DEFAULT_PRIMARY_FANOUT
    const primaryRelayUrls = clampFanout(kept, requestedMaxPrimaryRelays)
    const authorWriteHintSet = new Set(authorWriteHints)
    const primaryRelayTargets = targetsForCandidateUrls(
      kept,
      {
        urls: appWriteRelays,
        grant: {
          kind: "app",
          operation: "write",
          bucket:
            input.intent === "commerce_author_event"
              ? "commerce_write"
              : "general_write",
        },
      },
      {
        urls: personalWriteRelays,
        grant: {
          kind: "owner_nip65",
          operation: "write",
          ownerPubkey: authenticatedPubkey ?? "",
          selection: "write",
        },
      },
      isAuthenticatedAuthor
        ? {
            urls: authorWriteHints,
            grant: {
              kind: "owner_nip65",
              operation: "write",
              ownerPubkey: authenticatedPubkey ?? "",
              selection: "write",
            },
          }
        : {
            urls: authorWriteHints,
            grant: {
              kind: "remote_nip65",
              operation: "write",
              pubkey: authorPubkey ?? "",
            },
          }
    )
    return {
      intent: input.intent,
      primaryRelayTargets,
      broadcastRelayTargets: [],
      signedRelayListAuthoritative: hasReconciledOwnerProjection,
      primaryRelayUrls,
      primaryCandidateRelayUrls: kept,
      ...(requestedMaxPrimaryRelays > 0
        ? { maxPrimaryRelayAttempts: requestedMaxPrimaryRelays }
        : {}),
      broadcastRelayUrls: [],
      broadcastCandidateRelayUrls: [],
      parkedRelayUrls: parked,
      appRelayUrls: kept.filter((relayUrl) => appWriteRelaySet.has(relayUrl)),
      personalRelayUrls: kept.filter(
        (relayUrl) =>
          personalWriteRelaySet.has(relayUrl) ||
          (isAuthenticatedAuthor && authorWriteHintSet.has(relayUrl))
      ),
      independentRelayUrls: isAuthenticatedAuthor
        ? []
        : kept.filter((relayUrl) => authorWriteHintSet.has(relayUrl)),
    }
  }

  // recipient_event
  const recipients = input.recipientPubkeys ?? []
  const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
  const authenticatedRecipientPubkeys = authenticatedPubkey
    ? recipients.filter(
        (pubkey) => pubkey.trim().toLowerCase() === authenticatedPubkey
      )
    : []
  const remoteRecipientPubkeys = recipients.filter(
    (pubkey) => pubkey.trim().toLowerCase() !== authenticatedPubkey
  )
  const authenticatedRecipientHints = personalLayerEnabled(input.routingPolicy)
    ? hintReadRelaysForRecipients(
        authenticatedRecipientPubkeys,
        input.relayLists,
        input.authenticatedPubkey,
        input.ownerSelectedRelayUrls
      )
    : []
  const remoteRecipientHints = hintReadRelaysForRecipients(
    remoteRecipientPubkeys,
    input.relayLists,
    input.authenticatedPubkey,
    input.ownerSelectedRelayUrls
  )
  const recipientHints = dedupeOrdered([
    ...authenticatedRecipientHints,
    ...remoteRecipientHints,
  ])

  // Recipients with no cached list contribute nothing. Use the shared
  // app/public relay fallback as recipient delivery, not the sender's private
  // outbox relays; otherwise a buyer-only write ACK can look deliverable while
  // the recipient inbox has no reason to read that relay.
  const missingRecipientFallback =
    recipients.some((pubkey) => {
      const isAuthenticatedRecipient =
        pubkey.trim().toLowerCase() === authenticatedPubkey
      return (
        (isAuthenticatedRecipient &&
          !personalLayerEnabled(input.routingPolicy)) ||
        !hasRecipientReadRelays({
          pubkey,
          relayLists: input.relayLists,
          authenticatedPubkey: input.authenticatedPubkey,
          ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
        })
      )
    }) && appLayerEnabled(input.routingPolicy)
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

  const primaryKeptSet = new Set(primaryKept)
  const broadcastOrdered = dedupeOrdered(
    userWriteRelays.filter((url) => !primaryKeptSet.has(url))
  )
  const { kept: broadcastKept, parked: broadcastParked } = applyHealthFilter(
    broadcastOrdered,
    input.skipHealthFilter,
    input.now
  )

  const requestedMaxPrimaryRelays =
    input.maxPrimaryRelays ?? DEFAULT_PRIMARY_FANOUT
  const requestedMaxBroadcastRelays =
    input.maxBroadcastRelays ?? DEFAULT_BROADCAST_FANOUT
  const primaryRelayUrls = clampFanout(primaryKept, requestedMaxPrimaryRelays)
  const broadcastRelayUrls = clampFanout(
    broadcastKept,
    requestedMaxBroadcastRelays
  )
  const executableRelayUrls = dedupeOrdered([...primaryKept, ...broadcastKept])
  const missingRecipientFallbackSet = new Set(missingRecipientFallback)
  const authenticatedRecipientHintSet = new Set(authenticatedRecipientHints)
  const primaryRelayTargets = targetsForCandidateUrls(
    primaryKept,
    {
      urls: missingRecipientFallback,
      grant: { kind: "app", operation: "write", bucket: "recipient_delivery" },
    },
    {
      urls: authenticatedRecipientHints,
      grant: {
        kind: "owner_nip65",
        operation: "write",
        ownerPubkey: authenticatedPubkey ?? "",
        selection: "read",
      },
    },
    ...remoteRecipientPubkeys.map((pubkey) => ({
      urls: filterRelayListForContext(
        input.relayLists?.get(pubkey) ?? {
          pubkey,
          readRelayUrls: [],
          writeRelayUrls: [],
          eventCreatedAt: 0,
          cachedAt: 0,
        }
      ).readRelayUrls,
      grant: { kind: "remote_nip65", operation: "write", pubkey } as const,
    }))
  )
  const broadcastRelayTargets = targetsForCandidateUrls(
    broadcastKept,
    {
      urls: appWriteRelays,
      grant: { kind: "app", operation: "write", bucket: "general_write" },
    },
    {
      urls: personalWriteRelays,
      grant: {
        kind: "owner_nip65",
        operation: "write",
        ownerPubkey: authenticatedPubkey ?? "",
        selection: "write",
      },
    }
  )
  return {
    intent: input.intent,
    primaryRelayTargets,
    broadcastRelayTargets,
    primaryRelayUrls,
    primaryCandidateRelayUrls: primaryKept,
    ...(requestedMaxPrimaryRelays > 0
      ? { maxPrimaryRelayAttempts: requestedMaxPrimaryRelays }
      : {}),
    broadcastRelayUrls,
    broadcastCandidateRelayUrls: broadcastKept,
    ...(requestedMaxBroadcastRelays > 0
      ? { maxBroadcastRelayAttempts: requestedMaxBroadcastRelays }
      : {}),
    parkedRelayUrls: dedupeOrdered([...primaryParked, ...broadcastParked]),
    appRelayUrls: executableRelayUrls.filter(
      (relayUrl) =>
        missingRecipientFallbackSet.has(relayUrl) ||
        appWriteRelaySet.has(relayUrl)
    ),
    personalRelayUrls: executableRelayUrls.filter(
      (relayUrl) =>
        personalWriteRelaySet.has(relayUrl) ||
        authenticatedRecipientHintSet.has(relayUrl)
    ),
    independentRelayUrls: executableRelayUrls.filter((relayUrl) =>
      remoteRecipientHints.includes(relayUrl)
    ),
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
