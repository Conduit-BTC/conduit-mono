import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { db, type CachedProfile } from "../db"
import type { Profile } from "../types"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanoutDetailed, type FetchEventsFanoutResult } from "./ndk"
import {
  compareProfileFrontiers,
  projectCachedProfile,
  type ProfileFrontier,
} from "./profile-cache"
import { parseProfileEvent } from "./profiles"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import { loadRelaySettingsPlanningSnapshot } from "./relay-settings"

export const PROFILE_SEARCH_MIN_QUERY_LENGTH = 1
/**
 * Relays index kind-0 text. A single character matches most of the network,
 * so the relay read starts one character later than the device scan; a short
 * query still answers from the cache instead of being ignored.
 */
export const PROFILE_SEARCH_MIN_NETWORK_QUERY_LENGTH = 2
export const PROFILE_SEARCH_DEFAULT_LIMIT = 5
const NETWORK_FETCH_LIMIT = 24
const LOCAL_CACHE_SCAN_LIMIT = 5_000
/**
 * One settled query must finish within a single bounded read window. Relay
 * lists grow with the account's own NIP-65 settings, so the plan keeps the
 * configured search indexes first and takes at most this many relays.
 */
export const PROFILE_SEARCH_MAX_RELAYS = 4
/**
 * The cached phase must answer while listings are still being written, and an
 * open write transaction on the products store can hold a seller lookup for
 * hundreds of milliseconds. Past this budget the phase answers with the
 * seller flags it already knows and lets the lookup finish in the background.
 */
export const CACHED_SELLER_LOOKUP_BUDGET_MS = 200

/**
 * Bounded read outcome for one settled query. A completed plan that observed
 * nothing is `absent_within_scope`; it is never proof that no account exists.
 * Any relay that answered partially, hit the filter limit, or returned events
 * that failed verification keeps the read `lookup_partial`.
 */
export type ProfileSearchEvidence =
  | "not_queried"
  | "present_current"
  | "absent_within_scope"
  | "lookup_partial"
  | "lookup_unavailable"

export type ProfileSearchSource = "local_cache" | "network" | "both"

export interface ProfileSearchMatch {
  pubkey: string
  profile: Profile
  /** The pubkey authored at least one locally discovered listing. */
  isSeller: boolean
  source: ProfileSearchSource
  /** Lower is a stronger textual match. */
  score: number
  /** Kind-0 frontier behind `profile`; absent for legacy projection-only rows. */
  frontier: ProfileFrontier
}

export interface ProfileSearchResult {
  query: string
  matches: ProfileSearchMatch[]
  evidence: ProfileSearchEvidence
  relaysPlanned: number
  /** Relays that answered with a complete, fully verified, uncapped read. */
  relaysCompleted: number
  /** Relays that answered but only partially, capped, or with rejected events. */
  relaysDegraded: number
  /** False when returned network events skipped signature verification. */
  verified: boolean
}

export interface ProfileSearchQuery {
  query: string
  limit?: number
  signal?: AbortSignal
  /** Cached phase only; `Infinity` waits for the seller lookup. */
  sellerLookupBudgetMs?: number
  /**
   * Active account. Its validated signed relay list supplies the NIP-50 read
   * relays for this search; a guest plan never reuses an account plan.
   */
  authenticatedPubkey?: string | null
}

export interface ProfileSearchDependencies {
  loadCachedProfiles: () => Promise<CachedProfile[]>
  /** Targeted read for the pubkeys a relay returned. */
  loadCachedProfileRows: (
    pubkeys: readonly string[]
  ) => Promise<Map<string, CachedProfile>>
  loadSellerPubkeys: (pubkeys: readonly string[]) => Promise<Set<string>>
  planSearchRelayUrls: (
    authenticatedPubkey: string | null
  ) => string[] | Promise<string[]>
  fetchEvents: (
    filter: NDKFilter,
    options: { relayUrls: string[]; signal?: AbortSignal }
  ) => Promise<FetchEventsFanoutResult>
}

export function normalizeProfileSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function matchScore(candidate: string | undefined, query: string): number {
  if (!candidate) return Number.POSITIVE_INFINITY
  const normalized = normalizeProfileSearchText(candidate)
  if (!normalized) return Number.POSITIVE_INFINITY
  if (normalized === query) return 0
  if (normalized.startsWith(query)) return 1
  if (normalized.split(" ").some((word) => word.startsWith(query))) return 2
  if (normalized.includes(query)) return 3
  return Number.POSITIVE_INFINITY
}

function nip05LocalPart(nip05: string | undefined): string | undefined {
  if (!nip05) return undefined
  const local = nip05.split("@")[0]
  return local === "_" ? undefined : local
}

/**
 * Scores a profile against a normalized query. Only name fields count; a
 * relay may match `about` text, but the suggestion list is about names.
 */
export function scoreProfileSearchMatch(
  profile: Profile,
  normalizedQuery: string
): number {
  return Math.min(
    matchScore(profile.displayName, normalizedQuery),
    matchScore(profile.name, normalizedQuery),
    matchScore(nip05LocalPart(profile.nip05), normalizedQuery) + 1
  )
}

function eventFrontier(event: NDKEvent): ProfileFrontier {
  return { createdAt: event.created_at, eventId: event.id }
}

function pickLatestEventPerPubkey(events: readonly NDKEvent[]): NDKEvent[] {
  const latest = new Map<string, NDKEvent>()
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.PROFILE || !event.pubkey) continue
    const current = latest.get(event.pubkey)
    if (
      !current ||
      compareProfileFrontiers(eventFrontier(event), eventFrontier(current)) > 0
    ) {
      latest.set(event.pubkey, event)
    }
  }
  return Array.from(latest.values())
}

export function rankProfileSearchMatches(
  matches: readonly ProfileSearchMatch[],
  limit: number
): ProfileSearchMatch[] {
  return [...matches]
    .sort(
      (left, right) =>
        Number(right.isSeller) - Number(left.isSeller) ||
        left.score - right.score ||
        (left.profile.displayName ?? left.profile.name ?? "").localeCompare(
          right.profile.displayName ?? right.profile.name ?? ""
        )
    )
    .slice(0, limit)
}

export interface ProfileSearchRelaySummary {
  relaysPlanned: number
  relaysCompleted: number
  relaysDegraded: number
  verified: boolean
}

/**
 * Classifies each relay observation. Only a `success` relay with no rejected
 * events and fewer events than the filter limit counts as complete; a capped
 * read may have dropped matches, and rejected events mean the relay returned
 * data this client could not trust.
 */
export function summarizeProfileSearchRelays(
  result: Pick<FetchEventsFanoutResult, "relays" | "eventsVerified">,
  fetchLimit: number = NETWORK_FETCH_LIMIT
): Omit<ProfileSearchRelaySummary, "relaysPlanned"> {
  let relaysCompleted = 0
  let relaysDegraded = 0
  for (const relay of result.relays) {
    if (relay.status === "failed") continue
    const complete =
      relay.status === "success" &&
      (relay.rejectedEventCount ?? 0) === 0 &&
      relay.eventCount < fetchLimit
    if (complete) relaysCompleted += 1
    else relaysDegraded += 1
  }
  return {
    relaysCompleted,
    relaysDegraded,
    verified: result.eventsVerified !== false,
  }
}

export function resolveProfileSearchEvidence(
  input: ProfileSearchRelaySummary & { matchCount: number }
): ProfileSearchEvidence {
  const answered = input.relaysCompleted + input.relaysDegraded
  if (input.relaysPlanned === 0 || answered === 0) return "lookup_unavailable"
  if (
    input.relaysDegraded > 0 ||
    input.relaysCompleted < input.relaysPlanned ||
    !input.verified
  ) {
    return "lookup_partial"
  }
  return input.matchCount > 0 ? "present_current" : "absent_within_scope"
}

function normalizeSearchRelayUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed.toLowerCase().startsWith("wss://") ? trimmed : null
}

/**
 * Deduplicates and caps the search plan. Configured search indexes keep
 * priority over relays that merely advertise NIP-50, so a long advertised
 * list cannot push the indexes out of the plan.
 */
export function planProfileSearchRelayUrls(
  configuredUrls: readonly string[],
  advertisedUrls: readonly string[],
  maxRelays: number = PROFILE_SEARCH_MAX_RELAYS
): string[] {
  const planned: string[] = []
  const seen = new Set<string>()
  for (const url of [...configuredUrls, ...advertisedUrls]) {
    if (planned.length >= maxRelays) break
    const normalized = normalizeSearchRelayUrl(url)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    planned.push(normalized)
  }
  return planned
}

async function defaultPlanSearchRelayUrls(
  authenticatedPubkey: string | null
): Promise<string[]> {
  const snapshot = authenticatedPubkey
    ? await readDurableAccountRelaySettingsPlanningSnapshot(authenticatedPubkey)
    : loadRelaySettingsPlanningSnapshot()
  return planProfileSearchRelayUrls(
    config.searchIndexRelayUrls,
    snapshot.settings.entries
      .filter((entry) => entry.readEnabled && entry.capabilities.search)
      .map((entry) => entry.url)
  )
}

async function defaultLoadSellerPubkeys(
  pubkeys: readonly string[]
): Promise<Set<string>> {
  if (pubkeys.length === 0) return new Set()
  const rows = await db.products
    .where("pubkey")
    .anyOf([...pubkeys])
    .toArray()
  return new Set(rows.map((row) => row.pubkey))
}

async function defaultLoadCachedProfileRows(
  pubkeys: readonly string[]
): Promise<Map<string, CachedProfile>> {
  if (pubkeys.length === 0) return new Map()
  const rows = await db.profiles.bulkGet([...pubkeys])
  return new Map(
    rows
      .filter((row): row is CachedProfile => !!row)
      .map((row) => [row.pubkey, row])
  )
}

const defaultDependencies: ProfileSearchDependencies = {
  loadCachedProfiles: () => db.profiles.limit(LOCAL_CACHE_SCAN_LIMIT).toArray(),
  loadCachedProfileRows: defaultLoadCachedProfileRows,
  loadSellerPubkeys: defaultLoadSellerPubkeys,
  planSearchRelayUrls: defaultPlanSearchRelayUrls,
  fetchEvents: (filter, options) =>
    fetchEventsFanoutDetailed(filter, {
      relayUrls: options.relayUrls,
      signal: options.signal,
      connectTimeoutMs: 1_500,
      fetchTimeoutMs: 3_000,
    }),
}

function emptyResult(query: string): ProfileSearchResult {
  return {
    query,
    matches: [],
    evidence: "not_queried",
    relaysPlanned: 0,
    relaysCompleted: 0,
    relaysDegraded: 0,
    verified: true,
  }
}

function toMatch(
  profile: Profile,
  source: ProfileSearchSource,
  normalizedQuery: string,
  frontier: ProfileFrontier
): ProfileSearchMatch | null {
  const score = scoreProfileSearchMatch(profile, normalizedQuery)
  if (!Number.isFinite(score)) return null
  return {
    pubkey: profile.pubkey,
    profile,
    isSeller: false,
    source,
    score,
    frontier,
  }
}

const knownSellerPubkeys = new Set<string>()

async function flagSellers(
  matches: ProfileSearchMatch[],
  deps: ProfileSearchDependencies,
  budgetMs = Infinity
): Promise<ProfileSearchMatch[]> {
  const lookup = deps
    .loadSellerPubkeys(matches.map((match) => match.pubkey))
    .then((pubkeys) => {
      for (const pubkey of pubkeys) knownSellerPubkeys.add(pubkey)
      return pubkeys
    })
    .catch(() => new Set<string>())
  const sellerPubkeys = Number.isFinite(budgetMs)
    ? await Promise.race([
        lookup,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), budgetMs)
        ),
      ])
    : await lookup
  const resolved = sellerPubkeys ?? knownSellerPubkeys
  return matches.map((match) => ({
    ...match,
    isSeller: resolved.has(match.pubkey),
  }))
}

/**
 * Fast phase: scans the local profile cache only. It never touches a relay,
 * so its evidence stays `not_queried`; callers show these rows immediately
 * while the network phase is still running.
 */
export async function searchCachedProfiles(
  input: ProfileSearchQuery,
  dependencies: Partial<ProfileSearchDependencies> = {}
): Promise<ProfileSearchResult> {
  const deps = { ...defaultDependencies, ...dependencies }
  const query = input.query.trim()
  const normalizedQuery = normalizeProfileSearchText(query)
  const limit = input.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT
  if (normalizedQuery.length < PROFILE_SEARCH_MIN_QUERY_LENGTH) {
    return emptyResult(query)
  }

  const cachedRows: CachedProfile[] = await deps
    .loadCachedProfiles()
    .catch(() => [])
  const candidates: ProfileSearchMatch[] = []
  for (const row of cachedRows) {
    const match = toMatch(
      projectCachedProfile(row),
      "local_cache",
      normalizedQuery,
      { createdAt: row.eventCreatedAt, eventId: row.eventId }
    )
    if (match) candidates.push(match)
  }

  return {
    ...emptyResult(query),
    matches: rankProfileSearchMatches(
      await flagSellers(
        candidates,
        deps,
        input.sellerLookupBudgetMs ?? CACHED_SELLER_LOOKUP_BUDGET_MS
      ),
      limit
    ),
  }
}

/**
 * Slow phase: a bounded NIP-50 kind-0 read against search-capable relays.
 * Results are display-only suggestions and are not written to the profile
 * cache; opening a result runs the normal profile read with its frontier and
 * payment-authority rules.
 */
export async function searchNetworkProfiles(
  input: ProfileSearchQuery,
  dependencies: Partial<ProfileSearchDependencies> = {}
): Promise<ProfileSearchResult> {
  const deps = { ...defaultDependencies, ...dependencies }
  const query = input.query.trim()
  const normalizedQuery = normalizeProfileSearchText(query)
  const limit = input.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT
  if (normalizedQuery.length < PROFILE_SEARCH_MIN_QUERY_LENGTH) {
    return emptyResult(query)
  }

  if (normalizedQuery.length < PROFILE_SEARCH_MIN_NETWORK_QUERY_LENGTH) {
    return emptyResult(query)
  }

  const relayUrls = await deps.planSearchRelayUrls(
    input.authenticatedPubkey ?? null
  )
  let summary: ProfileSearchRelaySummary = {
    relaysPlanned: relayUrls.length,
    relaysCompleted: 0,
    relaysDegraded: 0,
    verified: true,
  }
  const candidates: ProfileSearchMatch[] = []
  if (relayUrls.length > 0) {
    try {
      const result = await deps.fetchEvents(
        {
          kinds: [EVENT_KINDS.PROFILE],
          search: query,
          limit: NETWORK_FETCH_LIMIT,
        },
        { relayUrls, signal: input.signal }
      )
      summary = { ...summary, ...summarizeProfileSearchRelays(result) }
      const events = pickLatestEventPerPubkey(result.events)
      // A relay can answer with a kind-0 event this device already replaced.
      // Reconcile before scoring so a stale name is never offered as a match.
      const cachedRows = await deps
        .loadCachedProfileRows(events.map((event) => event.pubkey))
        .catch(() => new Map<string, CachedProfile>())
      for (const event of events) {
        const row = cachedRows.get(event.pubkey)
        const cachedFrontier: ProfileFrontier | null = row
          ? { createdAt: row.eventCreatedAt, eventId: row.eventId }
          : null
        const cachedWins =
          !!row &&
          !!cachedFrontier &&
          compareProfileFrontiers(cachedFrontier, eventFrontier(event)) > 0
        const match = toMatch(
          cachedWins ? projectCachedProfile(row) : parseProfileEvent(event),
          cachedWins ? "both" : "network",
          normalizedQuery,
          cachedWins ? cachedFrontier : eventFrontier(event)
        )
        if (match) candidates.push(match)
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
    }
  }

  return {
    query,
    matches: rankProfileSearchMatches(
      await flagSellers(candidates, deps),
      limit
    ),
    evidence: resolveProfileSearchEvidence({
      ...summary,
      matchCount: candidates.length,
    }),
    ...summary,
  }
}

function mergeMatches(
  existing: ProfileSearchMatch,
  incoming: ProfileSearchMatch,
  normalizedQuery: string
): ProfileSearchMatch | null {
  const comparison = compareProfileFrontiers(
    incoming.frontier,
    existing.frontier
  )
  const incomingWins =
    comparison > 0 || (comparison === 0 && incoming.source === "network")
  const winner = incomingWins ? incoming : existing
  // Rank and filter on the profile that will be displayed. A replaced name
  // must not keep a row in the list or lend it a stronger score.
  const score = scoreProfileSearchMatch(winner.profile, normalizedQuery)
  if (!Number.isFinite(score)) return null
  return {
    pubkey: existing.pubkey,
    profile: winner.profile,
    frontier: winner.frontier,
    isSeller: existing.isSeller || incoming.isSeller,
    source: existing.source === incoming.source ? incoming.source : "both",
    score,
  }
}

/**
 * Combines the cached and network phases for one query. For a pubkey seen in
 * both, the NIP-01 winner (newest `created_at`, lowest id on ties) supplies
 * the profile, so a stale relay copy never displaces a newer cached frontier.
 * Relay evidence comes from the network phase alone; cached rows are not
 * relay observations and cannot upgrade it.
 */
export function mergeProfileSearchResults(
  cached: ProfileSearchResult | undefined,
  network: ProfileSearchResult | undefined,
  limit: number = PROFILE_SEARCH_DEFAULT_LIMIT
): ProfileSearchResult {
  const query = network?.query ?? cached?.query ?? ""
  const normalizedQuery = normalizeProfileSearchText(query)
  const combined = new Map<string, ProfileSearchMatch>()
  for (const match of [
    ...(cached?.matches ?? []),
    ...(network?.matches ?? []),
  ]) {
    const existing = combined.get(match.pubkey)
    if (!existing) {
      combined.set(match.pubkey, match)
      continue
    }
    const merged = mergeMatches(existing, match, normalizedQuery)
    if (merged) combined.set(match.pubkey, merged)
    else combined.delete(match.pubkey)
  }
  const matches = rankProfileSearchMatches(Array.from(combined.values()), limit)
  if (!network) return { ...emptyResult(query), matches }
  return { ...network, query, matches }
}

/** Runs both phases and returns the merged result once the network answers. */
export async function searchProfiles(
  input: ProfileSearchQuery,
  dependencies: Partial<ProfileSearchDependencies> = {}
): Promise<ProfileSearchResult> {
  const limit = input.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT
  const [cached, network] = await Promise.all([
    searchCachedProfiles(input, dependencies),
    searchNetworkProfiles(input, dependencies),
  ])
  return mergeProfileSearchResults(cached, network, limit)
}
