import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { db, type CachedRelayList } from "../db"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout } from "./ndk"
import {
  getGeneralReadRelayUrls,
  parseNip65RelayTags,
  tryNormalizeRelayUrl,
  type RelayPreference,
} from "./relay-settings"

/**
 * NIP-65 relay list resolution for arbitrary pubkeys.
 *
 * The relay-settings module owns the local user's preferences. This module
 * caches `kind:10002` relay lists for any pubkey so the planner can:
 *
 * - route reads at an author's write relays
 * - route recipient-aware writes (replies, reactions, NIP-17) at a
 *   recipient's read/inbox relays
 *
 * Local cache is the first-paint source. Network refresh is best-effort and
 * uses a configurable fanout so we never block the UI on slow relays.
 */

export const RELAY_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
export const RELAY_LIST_FETCH_TIMEOUT_MS = 6_000
export const RELAY_LIST_CONNECT_TIMEOUT_MS = 4_000

export interface RelayList {
  pubkey: string
  readRelayUrls: string[]
  writeRelayUrls: string[]
  eventCreatedAt: number
  sourceRelayUrls?: string[]
  cachedAt: number
}

export interface RelayListLookupOptions {
  /** Skip cache check and fetch from network. */
  skipCache?: boolean
  /** Custom relay set to scan; defaults to user's general read relays. */
  relayUrls?: readonly string[]
  /** Override `Date.now()` (test seam). */
  now?: () => number
}

interface RelayListTestOverrides {
  fetchEventsFanout?: typeof fetchEventsFanout
  loadCached?: (pubkey: string) => Promise<CachedRelayList | undefined>
  putCached?: (entry: CachedRelayList) => Promise<void>
  now?: () => number
}

let testOverrides: RelayListTestOverrides = {}

export function __setRelayListTestOverrides(
  overrides: Partial<RelayListTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetRelayListTestOverrides(): void {
  testOverrides = {}
}

function now(opts?: RelayListLookupOptions): number {
  return opts?.now?.() ?? testOverrides.now?.() ?? Date.now()
}

function dedupeUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of urls) {
    const normalized = tryNormalizeRelayUrl(raw)
    if (!normalized.ok) continue
    if (seen.has(normalized.url)) continue
    seen.add(normalized.url)
    out.push(normalized.url)
  }
  return out
}

function preferencesToReadWrite(preferences: RelayPreference[]): {
  readRelayUrls: string[]
  writeRelayUrls: string[]
} {
  const reads: string[] = []
  const writes: string[] = []
  for (const pref of preferences) {
    if (pref.readEnabled) reads.push(pref.url)
    if (pref.writeEnabled) writes.push(pref.url)
  }
  return {
    readRelayUrls: dedupeUrls(reads),
    writeRelayUrls: dedupeUrls(writes),
  }
}

/**
 * Parse a NIP-65 kind:10002 event into a `RelayList`.
 *
 * Tolerates malformed `r` tags. Empty or missing `r` tags produce an
 * empty list, which the planner can treat as "no NIP-65 hint".
 */
export function parseRelayListEvent(
  event: Pick<NDKEvent, "pubkey" | "tags" | "created_at">,
  options?: { sourceRelayUrls?: readonly string[]; cachedAt?: number }
): RelayList {
  const preferences = parseNip65RelayTags(event.tags ?? [])
  const { readRelayUrls, writeRelayUrls } = preferencesToReadWrite(preferences)
  return {
    pubkey: event.pubkey,
    readRelayUrls,
    writeRelayUrls,
    eventCreatedAt: event.created_at ?? 0,
    sourceRelayUrls: options?.sourceRelayUrls
      ? dedupeUrls(options.sourceRelayUrls)
      : undefined,
    cachedAt: options?.cachedAt ?? Date.now(),
  }
}

function toCachedRow(list: RelayList): CachedRelayList {
  return {
    pubkey: list.pubkey,
    readRelayUrls: list.readRelayUrls,
    writeRelayUrls: list.writeRelayUrls,
    eventCreatedAt: list.eventCreatedAt,
    sourceRelayUrls: list.sourceRelayUrls,
    cachedAt: list.cachedAt,
  }
}

function fromCachedRow(row: CachedRelayList): RelayList {
  return {
    pubkey: row.pubkey,
    readRelayUrls: dedupeUrls(row.readRelayUrls ?? []),
    writeRelayUrls: dedupeUrls(row.writeRelayUrls ?? []),
    eventCreatedAt: row.eventCreatedAt ?? 0,
    sourceRelayUrls: row.sourceRelayUrls
      ? dedupeUrls(row.sourceRelayUrls)
      : undefined,
    cachedAt: row.cachedAt ?? 0,
  }
}

async function loadCached(pubkey: string): Promise<RelayList | undefined> {
  if (testOverrides.loadCached) {
    const row = await testOverrides.loadCached(pubkey)
    return row ? fromCachedRow(row) : undefined
  }
  const row = await db.relayLists.get(pubkey)
  return row ? fromCachedRow(row) : undefined
}

async function putCached(list: RelayList): Promise<void> {
  const row = toCachedRow(list)
  if (testOverrides.putCached) {
    await testOverrides.putCached(row)
    return
  }
  await db.relayLists.put(row)
}

/**
 * Pick the most recent NIP-65 event for the requested pubkey.
 *
 * Multiple relays may serve different revisions of the kind-10002
 * replaceable event; we keep the one with the highest `created_at`.
 */
export function pickLatestRelayListEvent<
  T extends Pick<NDKEvent, "pubkey" | "created_at">,
>(events: readonly T[], pubkey: string): T | undefined {
  let latest: T | undefined
  for (const event of events) {
    if (event.pubkey !== pubkey) continue
    const candidateTs = event.created_at ?? 0
    const currentTs = latest?.created_at ?? -1
    if (candidateTs > currentTs) latest = event
  }
  return latest
}

async function runFetch(
  filter: NDKFilter,
  relayUrls: readonly string[]
): Promise<NDKEvent[]> {
  const impl = testOverrides.fetchEventsFanout ?? fetchEventsFanout
  return (await impl(filter, {
    relayUrls: relayUrls.length > 0 ? [...relayUrls] : undefined,
    connectTimeoutMs: RELAY_LIST_CONNECT_TIMEOUT_MS,
    fetchTimeoutMs: RELAY_LIST_FETCH_TIMEOUT_MS,
  })) as NDKEvent[]
}

/**
 * Resolve a single relay list. Cache-first; refreshes when expired or when
 * `skipCache` is set. Returns `undefined` only if no kind-10002 event is
 * found and there is no cache row.
 */
export async function getRelayList(
  pubkey: string,
  opts: RelayListLookupOptions = {}
): Promise<RelayList | undefined> {
  if (!pubkey) return undefined

  const cached = opts.skipCache ? undefined : await loadCached(pubkey)
  if (cached && now(opts) - cached.cachedAt < RELAY_LIST_CACHE_TTL_MS) {
    return cached
  }

  const relayUrls =
    opts.relayUrls ??
    getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })

  try {
    const events = await runFetch(
      { kinds: [EVENT_KINDS.RELAY_LIST], authors: [pubkey], limit: 5 },
      relayUrls
    )
    const latest = pickLatestRelayListEvent(events, pubkey)
    if (!latest) {
      return cached
    }
    const list = parseRelayListEvent(latest, { cachedAt: now(opts) })
    await putCached(list)
    return list
  } catch {
    return cached
  }
}

/**
 * Resolve relay lists for many pubkeys. Cache-first; missing/stale entries
 * are fetched in a single batched filter to minimize relay round trips.
 */
export async function getRelayLists(
  pubkeys: readonly string[],
  opts: RelayListLookupOptions = {}
): Promise<Map<string, RelayList>> {
  const out = new Map<string, RelayList>()
  const unique = Array.from(
    new Set(pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean))
  )
  if (unique.length === 0) return out

  const missing: string[] = []

  if (!opts.skipCache) {
    for (const pubkey of unique) {
      const cached = await loadCached(pubkey)
      if (cached && now(opts) - cached.cachedAt < RELAY_LIST_CACHE_TTL_MS) {
        out.set(pubkey, cached)
      } else {
        if (cached) out.set(pubkey, cached)
        missing.push(pubkey)
      }
    }
  } else {
    missing.push(...unique)
  }

  if (missing.length === 0) return out

  const relayUrls =
    opts.relayUrls ??
    getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })

  try {
    const events = await runFetch(
      {
        kinds: [EVENT_KINDS.RELAY_LIST],
        authors: missing,
        limit: Math.max(missing.length * 2, 10),
      },
      relayUrls
    )

    for (const pubkey of missing) {
      const latest = pickLatestRelayListEvent(events, pubkey)
      if (!latest) continue
      const list = parseRelayListEvent(latest, { cachedAt: now(opts) })
      await putCached(list)
      out.set(pubkey, list)
    }
  } catch {
    // best-effort; cached entries already merged above
  }

  return out
}

/**
 * Persist a relay list directly. Used when a kind-10002 event is observed
 * incidentally during another fetch so we can warm the cache without an
 * explicit refresh.
 */
export async function ingestRelayListEvent(
  event: Pick<NDKEvent, "pubkey" | "tags" | "created_at">,
  sourceRelayUrls?: readonly string[]
): Promise<RelayList> {
  const list = parseRelayListEvent(event, {
    sourceRelayUrls,
    cachedAt: Date.now(),
  })
  await putCached(list)
  return list
}
