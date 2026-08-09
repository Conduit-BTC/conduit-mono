import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanoutWithDiagnostics } from "./ndk"
import { isInsecureRelayUrl } from "./relay-list"
import { getGeneralReadRelayUrls, tryNormalizeRelayUrl } from "./relay-settings"

/**
 * Shared NIP-17 inbox routing boundary (CND-208).
 *
 * Canonical behavior stays NIP-17: a valid kind-10050 declaration is the
 * preferred and eventual exclusive delivery route. This module adds the typed
 * declaration/readiness model plus the named temporary validated-order
 * compatibility route for kind-16 order traffic during
 * migration. See docs/knowledge/nip17-inbox-bootstrap-migration.md.
 */

/** Typed result of a kind-10050 declaration lookup. */
export type InboxDeclarationState =
  | "declared"
  | "not_declared"
  | "lookup_partial"
  | "lookup_unavailable"
  | "malformed"

/** How much of a fanout read actually completed. */
export type InboxReadCoverage = "complete" | "partial" | "unavailable"

/** Where a private-message read relay came from. */
export type InboxReadSource =
  "declared" | "local_in" | "compatibility" | "mixed" | "cache"

/** Delivery lane for an outgoing private message. */
export type PrivateMessageDeliveryRoute =
  "declared_inbox" | "compatibility_order" | "blocked"

export type CompatibilityOrderRelaySource =
  "recipient_nip65" | "compatibility_registry"

export interface CompatibilityOrderRelayPlan {
  relayUrls: string[]
  relaySources: Record<string, CompatibilityOrderRelaySource>
  truncated: boolean
}

export const MAX_COMPATIBILITY_ORDER_RELAYS = 3
export const MAX_DECLARED_INBOX_WRITE_RELAYS = 3

export interface PrivateMessageRelays {
  pubkey: string
  relayUrls: string[]
}

/**
 * Parse a kind-10050 private-message relay list into recipient inbox relays.
 * An absent or unusable declaration means the recipient is not NIP-17 ready;
 * general relay lists and configured relays are not delivery fallbacks.
 */
export function parsePrivateMessageRelays(event: {
  kind?: number
  pubkey?: string
  tags?: string[][]
}): PrivateMessageRelays | null {
  if (event.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) return null
  const seen = new Set<string>()
  const relayUrls: string[] = []
  for (const tag of event.tags ?? []) {
    if (tag[0] !== "relay" || typeof tag[1] !== "string") continue
    const url = tag[1].trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    relayUrls.push(url)
  }
  return { pubkey: event.pubkey ?? "", relayUrls }
}

export interface InboxDeclarationResolution {
  pubkey: string
  state: InboxDeclarationState
  /** Secure declared inbox relays; empty unless state is "declared". */
  relayUrls: string[]
  /** True when served from cache past its freshness window. */
  stale: boolean
  fetchedAt: number
  /** Signed event identity when a declaration was resolved or primed. */
  eventId?: string
}

export interface ResolveInboxDeclarationOptions {
  fetchEventsWithDiagnostics?: typeof fetchEventsFanoutWithDiagnostics
  /** Discovery relays; defaults to local reads + compatibility reads. */
  relayUrls?: readonly string[]
  now?: () => number
  /** Freshness window override in ms (tests). */
  freshnessMs?: number
}

/** Positive declarations stay fresh for this long before a re-fetch. */
export const INBOX_DECLARATION_FRESHNESS_MS = 5 * 60_000

const declarationCache = new Map<string, InboxDeclarationResolution>()

/** Reset the kind-10050 declaration cache (tests). */
export function __resetInboxDeclarationCache(): void {
  declarationCache.clear()
}

/** Drop a cached declaration, e.g. after a Network repair publish. */
export function invalidateInboxDeclaration(pubkey: string): void {
  declarationCache.delete(cacheKey(pubkey))
}

/** Seed the cache after an intentional declaration publish. */
export function primeInboxDeclarationCache(
  pubkey: string,
  relayUrls: readonly string[],
  now: () => number = Date.now,
  eventId?: string
): void {
  declarationCache.set(cacheKey(pubkey), {
    pubkey: cacheKey(pubkey),
    state: "declared",
    relayUrls: [...relayUrls],
    stale: false,
    fetchedAt: now(),
    eventId,
  })
}

/** Read the cached declaration without any relay traffic. */
export function getCachedInboxDeclaration(
  pubkey: string
): InboxDeclarationResolution | null {
  return declarationCache.get(cacheKey(pubkey)) ?? null
}

function cacheKey(pubkey: string): string {
  return pubkey.trim().toLowerCase()
}

/** Normalize, deduplicate, and keep only secure wss:// relay urls. */
export function secureRelayUrls(relayUrls: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of relayUrls) {
    const normalized = tryNormalizeRelayUrl(url)
    if (!normalized.ok || isInsecureRelayUrl(normalized.url)) continue
    if (seen.has(normalized.url)) continue
    seen.add(normalized.url)
    out.push(normalized.url)
  }
  return out
}

/** Default discovery set: local secure reads plus bounded compatibility. */
export function inboxDiscoveryRelayUrls(): string[] {
  return secureRelayUrls([
    ...getGeneralReadRelayUrls({}),
    ...config.commerceDmFallbackRelayUrls,
  ])
}

function newestDeclarationEvent(
  events: readonly NDKEvent[],
  pubkey: string
): NDKEvent | null {
  let newest: NDKEvent | null = null
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS) continue
    if (event.pubkey?.trim().toLowerCase() !== pubkey) continue
    if (!newest) {
      newest = event
      continue
    }
    const newestAt = newest.created_at ?? 0
    const candidateAt = event.created_at ?? 0
    if (
      candidateAt > newestAt ||
      (candidateAt === newestAt && (event.id ?? "") < (newest.id ?? ""))
    ) {
      newest = event
    }
  }
  return newest
}

/**
 * Resolve a pubkey's kind-10050 declaration with typed, retryable outcomes.
 *
 * - All discovery relays failed never reports "not_declared"; it is
 *   "lookup_unavailable" (or the stale cached declaration when one exists).
 * - Partial coverage with no event stays "lookup_partial".
 * - A signed declaration without a usable secure relay tag is "malformed";
 *   it never overwrites a cached valid declaration.
 * - Only positive declarations are cached, with account-scoped freshness.
 */
export async function resolveInboxDeclaration(
  pubkey: string,
  options: ResolveInboxDeclarationOptions = {}
): Promise<InboxDeclarationResolution> {
  const key = cacheKey(pubkey)
  const now = options.now ?? Date.now
  const freshnessMs = options.freshnessMs ?? INBOX_DECLARATION_FRESHNESS_MS

  const cached = declarationCache.get(key)
  if (cached && now() - cached.fetchedAt < freshnessMs) {
    return { ...cached, stale: false }
  }

  const fetchWithDiagnostics =
    options.fetchEventsWithDiagnostics ?? fetchEventsFanoutWithDiagnostics
  const relayUrls =
    options.relayUrls && options.relayUrls.length > 0
      ? secureRelayUrls(options.relayUrls)
      : inboxDiscoveryRelayUrls()

  let result: Awaited<ReturnType<typeof fetchEventsFanoutWithDiagnostics>>
  try {
    result = await fetchWithDiagnostics(
      {
        kinds: [EVENT_KINDS.PRIVATE_MESSAGE_RELAYS],
        authors: [key],
        limit: 1,
      },
      { relayUrls, connectTimeoutMs: 3_000, fetchTimeoutMs: 6_000 }
    )
  } catch {
    result = {
      events: [],
      attemptedRelayUrls: [...relayUrls],
      successfulRelayUrls: [],
      failedRelayUrls: [...relayUrls],
    }
  }

  if (result.successfulRelayUrls.length === 0) {
    if (cached && cached.state === "declared") {
      return { ...cached, stale: true }
    }
    return {
      pubkey: key,
      state: "lookup_unavailable",
      relayUrls: [],
      stale: false,
      fetchedAt: now(),
    }
  }

  const newest = newestDeclarationEvent(result.events, key)
  if (!newest) {
    if (result.failedRelayUrls.length > 0) {
      if (cached && cached.state === "declared") {
        return { ...cached, stale: true }
      }
      return {
        pubkey: key,
        state: "lookup_partial",
        relayUrls: [],
        stale: false,
        fetchedAt: now(),
      }
    }
    // A complete read with no event is an authoritative absence: evict any
    // cached declaration so it cannot resurrect as a write target later.
    declarationCache.delete(key)
    return {
      pubkey: key,
      state: "not_declared",
      relayUrls: [],
      stale: false,
      fetchedAt: now(),
    }
  }

  const parsed = parsePrivateMessageRelays(newest)
  const secure = secureRelayUrls(parsed?.relayUrls ?? [])
  if (secure.length === 0) {
    // Signed but unusable. Preserve any cached valid declaration for reads;
    // never auto-override signed state (repair happens in Network).
    return {
      pubkey: key,
      state: "malformed",
      relayUrls: [],
      stale: false,
      fetchedAt: now(),
    }
  }

  const resolution: InboxDeclarationResolution = {
    pubkey: key,
    state: "declared",
    relayUrls: secure,
    stale: false,
    fetchedAt: now(),
    eventId: newest.id,
  }
  declarationCache.set(key, resolution)
  return resolution
}

export interface InboxReadPlan {
  relayUrls: string[]
  /** Per-relay provenance for diagnostics (content-free). */
  relaySources: Record<string, Exclude<InboxReadSource, "mixed">>
  /** Aggregate provenance of the plan. */
  source: InboxReadSource
}

export interface PlanInboxReadRelaysInput {
  declaration: InboxDeclarationResolution
  /** Locally enabled secure IN relays; defaults to relay-settings reads. */
  localReadRelayUrls?: readonly string[]
  /** Bounded compatibility reads; defaults to config.commerceDmFallbackRelayUrls. */
  compatibilityRelayUrls?: readonly string[]
  /**
   * Compatibility write targets Conduit must also poll. Defaults to the
   * operator-approved order registry and may only select from the read set.
   */
  requiredCompatibilityRelayUrls?: readonly string[]
  maxRelays?: number
}

/**
 * Permissive inbox read plan: union of declared inbox relays, locally enabled
 * secure IN relays, and the bounded compatibility read set. Nonempty local
 * settings never suppress compatibility reads. Reads may consult local state;
 * writes must not (see selectPrivateMessageDeliveryRoute).
 */
export function planInboxReadRelays(
  input: PlanInboxReadRelaysInput
): InboxReadPlan {
  const declared = secureRelayUrls(
    input.declaration.state === "declared" ? input.declaration.relayUrls : []
  )
  const cachedFallback =
    input.declaration.state === "malformed" ||
    input.declaration.state === "lookup_partial" ||
    input.declaration.state === "lookup_unavailable"
      ? secureRelayUrls(
          getCachedInboxDeclaration(input.declaration.pubkey)?.relayUrls ?? []
        )
      : []
  const localIn = secureRelayUrls(
    input.localReadRelayUrls ??
      getGeneralReadRelayUrls({ fallbackRelayUrls: [] })
  )
  const compatibility = secureRelayUrls(
    input.compatibilityRelayUrls ?? config.commerceDmFallbackRelayUrls
  )
  const compatibilitySet = new Set(compatibility)
  const requiredCompatibility = secureRelayUrls(
    input.requiredCompatibilityRelayUrls ?? config.dmCompatibilityOrderRelayUrls
  ).filter((url) => compatibilitySet.has(url))
  const requiredCompatibilitySet = new Set(requiredCompatibility)
  const remainingCompatibility = compatibility.filter(
    (url) => !requiredCompatibilitySet.has(url)
  )

  const relaySources: InboxReadPlan["relaySources"] = {}
  const orderedUrls: string[] = []
  const add = (
    urls: readonly string[],
    source: Exclude<InboxReadSource, "mixed">
  ) => {
    for (const url of urls) {
      if (relaySources[url]) continue
      relaySources[url] = source
      orderedUrls.push(url)
    }
  }
  add(declared, "declared")
  add(cachedFallback, "cache")
  // Reserve the write/read overlap before optional local and public
  // compatibility sources so a large local IN list cannot make an order
  // unreadable in Conduit after a compatibility delivery.
  add(requiredCompatibility, "compatibility")
  add(localIn, "local_in")
  add(remainingCompatibility, "compatibility")

  const limited =
    input.maxRelays && input.maxRelays > 0
      ? orderedUrls.slice(0, input.maxRelays)
      : orderedUrls
  const usedSources = new Set(limited.map((url) => relaySources[url]))
  const source: InboxReadSource =
    usedSources.size > 1
      ? "mixed"
      : (limited[0] && relaySources[limited[0]]) || "compatibility"

  return { relayUrls: limited, relaySources, source }
}

/** Derive read coverage from fanout diagnostics. */
export function deriveInboxReadCoverage(diagnostics: {
  successfulRelayUrls: readonly string[]
  failedRelayUrls: readonly string[]
}): InboxReadCoverage {
  if (diagnostics.successfulRelayUrls.length === 0) return "unavailable"
  if (diagnostics.failedRelayUrls.length > 0) return "partial"
  return "complete"
}

export interface DeliveryRouteSelection {
  route: PrivateMessageDeliveryRoute
  /** Exclusive write targets for the selected route; empty when blocked. */
  relayUrls: string[]
  /** Content-free per-target routing evidence. */
  relaySources: Record<string, "declared" | CompatibilityOrderRelaySource>
  truncated: boolean
  /** Content-free reason for a blocked route. */
  blockedReason?:
    "recipient_not_ready" | "recipient_lookup_failed" | "declaration_malformed"
}

export interface SelectDeliveryRouteInput {
  rumorKind: number
  declaration: InboxDeclarationResolution
  /**
   * True only for a validated kind-16 order lifecycle: locally created
   * checkout/order or a validated inbound order with matching order identity
   * and counterparty. General kind-14 DMs must pass false.
   */
  validatedOrder: boolean
  /** Deployment-profile-controlled compatibility flag; defaults to config. */
  compatibilityEnabled?: boolean
  /** Operator-approved compatibility registry; defaults to config. */
  compatibilityRelayUrls?: readonly string[]
  /** Signed recipient NIP-65 read relays may rank, but never widen, the pool. */
  recipientReadRelayUrls?: readonly string[]
  maxCompatibilityRelays?: number
}

/**
 * Build the non-standard compatibility lane used only for validated orders.
 * The operator-approved registry is the complete eligibility boundary. Signed
 * recipient NIP-65 read evidence can only move matching entries to the front;
 * arbitrary NIP-65 relays never become private-message write targets.
 */
export function planCompatibilityOrderRelays(input: {
  approvedRelayUrls: readonly string[]
  recipientReadRelayUrls?: readonly string[]
  maxRelays?: number
}): CompatibilityOrderRelayPlan {
  const approved = secureRelayUrls(input.approvedRelayUrls)
  const approvedSet = new Set(approved)
  const recipientMatches = secureRelayUrls(
    input.recipientReadRelayUrls ?? []
  ).filter((url) => approvedSet.has(url))
  const recipientMatchSet = new Set(recipientMatches)
  const ordered = [
    ...recipientMatches,
    ...approved.filter((url) => !recipientMatchSet.has(url)),
  ]
  const maxRelays = Math.max(
    0,
    Math.floor(input.maxRelays ?? MAX_COMPATIBILITY_ORDER_RELAYS)
  )
  const relayUrls = ordered.slice(0, maxRelays)
  const relaySources = Object.fromEntries(
    relayUrls.map((url) => [
      url,
      recipientMatchSet.has(url) ? "recipient_nip65" : "compatibility_registry",
    ])
  ) as Record<string, CompatibilityOrderRelaySource>

  return {
    relayUrls,
    relaySources,
    truncated: ordered.length > relayUrls.length,
  }
}

/**
 * Select the delivery lane for one outgoing private message.
 *
 * Invariants (docs/knowledge/nip17-inbox-bootstrap-migration.md):
 * - A valid current or cached declaration always outranks compatibility.
 * - Compatibility writes use only the explicit operator-approved registry and
 *   only for validated kind-16 order traffic while the flag is enabled.
 * - Kind-14 general DMs never use compatibility delivery.
 * - Signed malformed declarations block writes; repair happens in Network.
 */
export function selectPrivateMessageDeliveryRoute(
  input: SelectDeliveryRouteInput
): DeliveryRouteSelection {
  const declaration = input.declaration
  if (declaration.state === "declared") {
    const declaredRelayUrls = secureRelayUrls(declaration.relayUrls)
    const relayUrls = declaredRelayUrls.slice(
      0,
      MAX_DECLARED_INBOX_WRITE_RELAYS
    )
    return {
      route: "declared_inbox",
      relayUrls,
      relaySources: Object.fromEntries(
        relayUrls.map((url) => [url, "declared"])
      ),
      truncated: declaredRelayUrls.length > relayUrls.length,
    }
  }
  if (declaration.state === "malformed") {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: "declaration_malformed",
    }
  }

  const strictBlockedReason =
    declaration.state === "not_declared"
      ? ("recipient_not_ready" as const)
      : ("recipient_lookup_failed" as const)

  const isOrderMessage = input.rumorKind === EVENT_KINDS.ORDER
  if (!isOrderMessage || !input.validatedOrder) {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: strictBlockedReason,
    }
  }

  const compatibilityEnabled =
    input.compatibilityEnabled ?? config.dmCompatibilityOrderRoutingEnabled
  const compatibilityPlan = planCompatibilityOrderRelays({
    approvedRelayUrls:
      input.compatibilityRelayUrls ?? config.dmCompatibilityOrderRelayUrls,
    recipientReadRelayUrls: input.recipientReadRelayUrls,
    maxRelays: input.maxCompatibilityRelays,
  })
  if (!compatibilityEnabled || compatibilityPlan.relayUrls.length === 0) {
    return {
      route: "blocked",
      relayUrls: [],
      relaySources: {},
      truncated: false,
      blockedReason: strictBlockedReason,
    }
  }

  return {
    route: "compatibility_order",
    relayUrls: compatibilityPlan.relayUrls,
    relaySources: compatibilityPlan.relaySources,
    truncated: compatibilityPlan.truncated,
  }
}
