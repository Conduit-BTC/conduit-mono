import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { db, type CachedProfile } from "../db"
import type { Profile } from "../types"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanoutDetailed, type FetchEventsFanoutResult } from "./ndk"
import { projectCachedProfile } from "./profile-cache"
import { parseProfileEvent } from "./profiles"
import { loadRelaySettingsPlanningSnapshot } from "./relay-settings"

export const PROFILE_SEARCH_MIN_QUERY_LENGTH = 2
export const PROFILE_SEARCH_DEFAULT_LIMIT = 5
const NETWORK_FETCH_LIMIT = 24
const LOCAL_CACHE_SCAN_LIMIT = 5_000

/**
 * Bounded read outcome for one settled query. A completed plan that observed
 * nothing is `absent_within_scope`; it is never proof that no account exists.
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
}

export interface ProfileSearchResult {
  query: string
  matches: ProfileSearchMatch[]
  evidence: ProfileSearchEvidence
  relaysPlanned: number
  relaysCompleted: number
  /** False when returned network events skipped signature verification. */
  verified: boolean
}

export interface ProfileSearchQuery {
  query: string
  limit?: number
  signal?: AbortSignal
}

export interface ProfileSearchDependencies {
  loadCachedProfiles: () => Promise<CachedProfile[]>
  loadSellerPubkeys: (pubkeys: readonly string[]) => Promise<Set<string>>
  planSearchRelayUrls: () => string[]
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

function pickLatestEventPerPubkey(events: readonly NDKEvent[]): NDKEvent[] {
  const latest = new Map<string, NDKEvent>()
  for (const event of events) {
    if (event.kind !== EVENT_KINDS.PROFILE || !event.pubkey) continue
    const current = latest.get(event.pubkey)
    if (!current || (event.created_at ?? 0) > (current.created_at ?? 0)) {
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

export function resolveProfileSearchEvidence(input: {
  relaysPlanned: number
  relaysCompleted: number
  matchCount: number
}): ProfileSearchEvidence {
  if (input.relaysPlanned === 0 || input.relaysCompleted === 0) {
    return "lookup_unavailable"
  }
  if (input.relaysCompleted < input.relaysPlanned) return "lookup_partial"
  return input.matchCount > 0 ? "present_current" : "absent_within_scope"
}

function defaultPlanSearchRelayUrls(): string[] {
  const snapshot = loadRelaySettingsPlanningSnapshot()
  const advertised = snapshot.settings.entries
    .filter((entry) => entry.readEnabled && entry.capabilities.search)
    .map((entry) => entry.url)
  return Array.from(
    new Set([...config.searchIndexRelayUrls, ...advertised])
  ).filter((url) => url.startsWith("wss://"))
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

const defaultDependencies: ProfileSearchDependencies = {
  loadCachedProfiles: () => db.profiles.limit(LOCAL_CACHE_SCAN_LIMIT).toArray(),
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

/**
 * Searches accounts by name: the local profile cache first, then a bounded
 * NIP-50 kind-0 read against search-capable relays. Results are display-only
 * suggestions and are not written to the profile cache; opening a result runs
 * the normal profile read with its frontier and payment-authority rules.
 */
export async function searchProfiles(
  input: ProfileSearchQuery,
  dependencies: Partial<ProfileSearchDependencies> = {}
): Promise<ProfileSearchResult> {
  const deps = { ...defaultDependencies, ...dependencies }
  const query = input.query.trim()
  const normalizedQuery = normalizeProfileSearchText(query)
  const limit = input.limit ?? PROFILE_SEARCH_DEFAULT_LIMIT

  if (normalizedQuery.length < PROFILE_SEARCH_MIN_QUERY_LENGTH) {
    return {
      query,
      matches: [],
      evidence: "not_queried",
      relaysPlanned: 0,
      relaysCompleted: 0,
      verified: true,
    }
  }

  const candidates = new Map<string, ProfileSearchMatch>()
  const addCandidate = (profile: Profile, source: ProfileSearchSource) => {
    const score = scoreProfileSearchMatch(profile, normalizedQuery)
    if (!Number.isFinite(score)) return
    const existing = candidates.get(profile.pubkey)
    if (!existing) {
      candidates.set(profile.pubkey, {
        pubkey: profile.pubkey,
        profile,
        isSeller: false,
        source,
        score,
      })
      return
    }
    candidates.set(profile.pubkey, {
      ...existing,
      profile: source === "network" ? profile : existing.profile,
      source: existing.source === source ? source : "both",
      score: Math.min(existing.score, score),
    })
  }

  let cachedRows: CachedProfile[] = []
  try {
    cachedRows = await deps.loadCachedProfiles()
  } catch {
    cachedRows = []
  }
  for (const row of cachedRows) {
    addCandidate(projectCachedProfile(row), "local_cache")
  }

  const relayUrls = deps.planSearchRelayUrls()
  let relaysCompleted = 0
  let verified = true
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
      relaysCompleted = result.relays.filter(
        (relay) => relay.status !== "failed"
      ).length
      verified = result.eventsVerified !== false
      for (const event of pickLatestEventPerPubkey(result.events)) {
        addCandidate(parseProfileEvent(event), "network")
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      relaysCompleted = 0
    }
  }

  const sellerPubkeys = await deps
    .loadSellerPubkeys(Array.from(candidates.keys()))
    .catch(() => new Set<string>())
  const matches = rankProfileSearchMatches(
    Array.from(candidates.values(), (candidate) => ({
      ...candidate,
      isSeller: sellerPubkeys.has(candidate.pubkey),
    })),
    limit
  )

  return {
    query,
    matches,
    evidence: resolveProfileSearchEvidence({
      relaysPlanned: relayUrls.length,
      relaysCompleted,
      matchCount: candidates.size,
    }),
    relaysPlanned: relayUrls.length,
    relaysCompleted,
    verified,
  }
}
