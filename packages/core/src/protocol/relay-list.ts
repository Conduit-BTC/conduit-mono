import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { db, type CachedRelayList } from "../db"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanout,
  fetchEventsFanoutDetailed,
  type FetchEventsFanoutResult,
} from "./ndk"
import {
  getGeneralReadRelayUrls,
  normalizePublicRelayHints,
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
  eventId?: string
  /** How this lookup obtained the list; stale hints must degrade coverage. */
  lookupState?: "network" | "fresh-cache" | "stale-cache"
  sourceRelayUrls?: string[]
  cachedAt: number
}

export interface RelayListLookupOptions {
  /** Skip cache check and fetch from network. */
  skipCache?: boolean
  /** Only consult the cache; do NOT issue a network fetch for missing entries. */
  cacheOnly?: boolean
  /** Custom relay set to scan; defaults to user's general read relays. */
  relayUrls?: readonly string[]
  /**
   * Preserve local/private and ws:// relay URLs only when the requested
   * kind-10002 owner matches this authenticated pubkey. Third-party relay hints
   * are limited to public-network wss:// destinations.
   */
  allowInsecureRelayUrlsForPubkey?: string | null
  /** Override `Date.now()` (test seam). */
  now?: () => number
  /** Cancel obsolete network work, such as after changing the selected order. */
  signal?: AbortSignal
}

export type RelayListResolutionState =
  | "network"
  | "fresh-cache"
  | "stale-cache"
  | "missing"
  | "partial-network"
  | "lookup-unavailable"

export interface RelayListsDetailedResult {
  relayLists: Map<string, RelayList>
  resolutionStates: Map<string, RelayListResolutionState>
}

interface RelayListTestOverrides {
  fetchEventsFanout?: typeof fetchEventsFanout
  fetchEventsFanoutDetailed?: typeof fetchEventsFanoutDetailed
  loadCached?: (pubkey: string) => Promise<CachedRelayList | undefined>
  putCached?: (entry: CachedRelayList) => Promise<void>
  now?: () => number
}

let testOverrides: RelayListTestOverrides = {}
const testCacheWriteLocks = new Map<string, Promise<void>>()

export function __setRelayListTestOverrides(
  overrides: Partial<RelayListTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetRelayListTestOverrides(): void {
  testOverrides = {}
  testCacheWriteLocks.clear()
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

function comparisonPubkey(pubkey: string | null | undefined): string | null {
  const normalized = pubkey?.trim().toLowerCase()
  return normalized ? normalized : null
}

export function isInsecureRelayUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === "ws:" || protocol === "http:"
  } catch {
    return false
  }
}

function allowsInsecureRelayUrls(
  listPubkey: string,
  allowedPubkey: string | null | undefined
): boolean {
  const owner = comparisonPubkey(listPubkey)
  const allowed = comparisonPubkey(allowedPubkey)
  return !!owner && owner === allowed
}

function publicRelayHintUrls(urls: readonly string[]): string[] {
  return normalizePublicRelayHints(urls)
}

export function filterRelayListForContext(
  list: RelayList,
  options: Pick<RelayListLookupOptions, "allowInsecureRelayUrlsForPubkey"> = {}
): RelayList {
  if (
    allowsInsecureRelayUrls(
      list.pubkey,
      options.allowInsecureRelayUrlsForPubkey
    )
  ) {
    return list
  }

  return {
    ...list,
    readRelayUrls: publicRelayHintUrls(list.readRelayUrls),
    writeRelayUrls: publicRelayHintUrls(list.writeRelayUrls),
    sourceRelayUrls: list.sourceRelayUrls
      ? publicRelayHintUrls(list.sourceRelayUrls)
      : undefined,
  }
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
  event: Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">,
  options?: { sourceRelayUrls?: readonly string[]; cachedAt?: number }
): RelayList {
  const preferences = parseNip65RelayTags(event.tags ?? [])
  const { readRelayUrls, writeRelayUrls } = preferencesToReadWrite(preferences)
  return {
    pubkey: event.pubkey,
    readRelayUrls,
    writeRelayUrls,
    eventCreatedAt: event.created_at ?? 0,
    eventId: event.id,
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
    eventId: list.eventId,
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
    eventId: row.eventId,
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
  try {
    const row = await db.relayLists.get(pubkey)
    return row ? fromCachedRow(row) : undefined
  } catch {
    // IndexedDB unavailable (e.g. SSR / non-browser test env) — treat as miss.
    return undefined
  }
}

function filterLookupRelayList(
  list: RelayList | undefined,
  opts: RelayListLookupOptions
): RelayList | undefined {
  return list ? filterRelayListForContext(list, opts) : undefined
}

function withLookupState(
  list: RelayList | undefined,
  lookupState: NonNullable<RelayList["lookupState"]>
): RelayList | undefined {
  return list ? { ...list, lookupState } : undefined
}

/**
 * Pick the most recent NIP-65 event for the requested pubkey.
 *
 * Multiple relays may serve different revisions of the kind-10002
 * replaceable event. Per NIP-01, the highest `created_at` wins; equal
 * timestamps resolve to the event with the lowest id.
 */
export function pickLatestRelayListEvent<
  T extends Pick<NDKEvent, "id" | "pubkey" | "created_at">,
>(events: readonly T[], pubkey: string): T | undefined {
  let latest: T | undefined
  for (const event of events) {
    if (event.pubkey !== pubkey) continue
    const candidateTs = event.created_at ?? 0
    if (
      !latest ||
      candidateTs > (latest.created_at ?? 0) ||
      (candidateTs === (latest.created_at ?? 0) && event.id < latest.id)
    ) {
      latest = event
    }
  }
  return latest
}

/**
 * Compare a fetched replaceable event with the retained cache projection.
 * A matching event refreshes cache freshness; an older or higher-id event
 * never displaces the NIP-01 winner already observed on another relay.
 */
function preferFetchedRelayList(
  fetched: RelayList,
  cached: RelayList | undefined
): RelayList {
  if (!cached) return fetched
  if (fetched.eventCreatedAt > cached.eventCreatedAt) return fetched
  if (fetched.eventCreatedAt < cached.eventCreatedAt) return cached

  if (!cached.eventId) return fetched
  if (!fetched.eventId) return cached
  return fetched.eventId <= cached.eventId ? fetched : cached
}

async function withTestCacheWriteLock<T>(
  pubkey: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = testCacheWriteLocks.get(pubkey) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  testCacheWriteLocks.set(pubkey, tail)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (testCacheWriteLocks.get(pubkey) === tail) {
      testCacheWriteLocks.delete(pubkey)
    }
  }
}

/**
 * Atomically retain the NIP-01 winner against the row current at commit time.
 * The network fetch happens outside this transaction, so every caller must use
 * the returned winner rather than assuming its fetched candidate was stored.
 */
async function retainStrongestRelayList(
  fetched: RelayList
): Promise<RelayList> {
  if (testOverrides.loadCached || testOverrides.putCached) {
    return await withTestCacheWriteLock(fetched.pubkey, async () => {
      const currentRow = testOverrides.loadCached
        ? await testOverrides.loadCached(fetched.pubkey)
        : undefined
      const current = currentRow ? fromCachedRow(currentRow) : undefined
      const winner = preferFetchedRelayList(fetched, current)
      if (winner === fetched && testOverrides.putCached) {
        await testOverrides.putCached(toCachedRow(fetched))
      }
      return winner
    })
  }

  try {
    return await db.transaction("rw", db.relayLists, async () => {
      const currentRow = await db.relayLists.get(fetched.pubkey)
      const current = currentRow ? fromCachedRow(currentRow) : undefined
      const winner = preferFetchedRelayList(fetched, current)
      if (winner === fetched) {
        await db.relayLists.put(toCachedRow(fetched))
      }
      return winner
    })
  } catch {
    // Cache persistence is best-effort when IndexedDB is unavailable. The
    // verified network candidate remains usable in this execution.
    return fetched
  }
}

async function runFetch(
  filter: NDKFilter,
  relayUrls: readonly string[],
  signal?: AbortSignal
): Promise<NDKEvent[]> {
  const impl = testOverrides.fetchEventsFanout ?? fetchEventsFanout
  return (await impl(filter, {
    relayUrls: relayUrls.length > 0 ? [...relayUrls] : undefined,
    connectTimeoutMs: RELAY_LIST_CONNECT_TIMEOUT_MS,
    fetchTimeoutMs: RELAY_LIST_FETCH_TIMEOUT_MS,
    signal,
  })) as NDKEvent[]
}

async function runFetchDetailed(
  filter: NDKFilter,
  relayUrls: readonly string[],
  signal?: AbortSignal
): Promise<FetchEventsFanoutResult> {
  if (relayUrls.length === 0) {
    return { events: [], relays: [], eventsVerified: true }
  }
  if (testOverrides.fetchEventsFanoutDetailed) {
    return await testOverrides.fetchEventsFanoutDetailed(filter, {
      relayUrls: [...relayUrls],
      connectTimeoutMs: RELAY_LIST_CONNECT_TIMEOUT_MS,
      fetchTimeoutMs: RELAY_LIST_FETCH_TIMEOUT_MS,
      skipHealthFilter: true,
      signal,
    })
  }
  if (testOverrides.fetchEventsFanout) {
    const events = await testOverrides.fetchEventsFanout(filter, {
      relayUrls: [...relayUrls],
      connectTimeoutMs: RELAY_LIST_CONNECT_TIMEOUT_MS,
      fetchTimeoutMs: RELAY_LIST_FETCH_TIMEOUT_MS,
      skipHealthFilter: true,
      signal,
    })
    return {
      events,
      relays: relayUrls.map((relayUrl) => ({
        relayUrl,
        status: "success",
        eventCount: events.length,
      })),
      eventsVerified: true,
    }
  }
  return await fetchEventsFanoutDetailed(filter, {
    relayUrls: [...relayUrls],
    connectTimeoutMs: RELAY_LIST_CONNECT_TIMEOUT_MS,
    fetchTimeoutMs: RELAY_LIST_FETCH_TIMEOUT_MS,
    skipHealthFilter: true,
    signal,
  })
}

function throwIfLookupAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  throw error
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
  throwIfLookupAborted(opts.signal)

  const retained = await loadCached(pubkey)
  const cached = opts.skipCache ? undefined : retained
  throwIfLookupAborted(opts.signal)
  if (cached && now(opts) - cached.cachedAt < RELAY_LIST_CACHE_TTL_MS) {
    return filterLookupRelayList(withLookupState(cached, "fresh-cache"), opts)
  }
  if (opts.cacheOnly) {
    return filterLookupRelayList(withLookupState(cached, "stale-cache"), opts)
  }

  const relayUrls =
    opts.relayUrls ??
    getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })

  try {
    const events = await runFetch(
      { kinds: [EVENT_KINDS.RELAY_LIST], authors: [pubkey], limit: 5 },
      relayUrls,
      opts.signal
    )
    throwIfLookupAborted(opts.signal)
    const latest = pickLatestRelayListEvent(events, pubkey)
    if (!latest) {
      return filterLookupRelayList(
        withLookupState(retained, "stale-cache"),
        opts
      )
    }
    const fetched = parseRelayListEvent(latest, { cachedAt: now(opts) })
    const list = await retainStrongestRelayList(fetched)
    throwIfLookupAborted(opts.signal)
    return filterLookupRelayList(
      withLookupState(list, list === fetched ? "network" : "stale-cache"),
      opts
    )
  } catch (error) {
    if (opts.signal?.aborted) throw error
    return filterLookupRelayList(withLookupState(retained, "stale-cache"), opts)
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
  return (await getRelayListsDetailed(pubkeys, opts)).relayLists
}

/**
 * Resolve relay lists without collapsing a completed no-event lookup into a
 * transport failure. Replaceable-event writers need this distinction before
 * treating fallback reads as complete enough to authorize a replacement.
 */
export async function getRelayListsDetailed(
  pubkeys: readonly string[],
  opts: RelayListLookupOptions = {}
): Promise<RelayListsDetailedResult> {
  throwIfLookupAborted(opts.signal)
  const out = new Map<string, RelayList>()
  const resolutionStates = new Map<string, RelayListResolutionState>()
  const unique = Array.from(
    new Set(pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean))
  )
  if (unique.length === 0) {
    return { relayLists: out, resolutionStates }
  }

  const missing: string[] = []

  for (const pubkey of unique) {
    const cached = await loadCached(pubkey)
    throwIfLookupAborted(opts.signal)
    if (!opts.skipCache) {
      if (cached && now(opts) - cached.cachedAt < RELAY_LIST_CACHE_TTL_MS) {
        out.set(
          pubkey,
          filterRelayListForContext(
            withLookupState(cached, "fresh-cache")!,
            opts
          )
        )
        resolutionStates.set(pubkey, "fresh-cache")
      } else {
        if (cached) {
          out.set(
            pubkey,
            filterRelayListForContext(
              withLookupState(cached, "stale-cache")!,
              opts
            )
          )
          resolutionStates.set(pubkey, "stale-cache")
        }
        missing.push(pubkey)
      }
    } else {
      if (cached) {
        out.set(
          pubkey,
          filterRelayListForContext(
            withLookupState(cached, "stale-cache")!,
            opts
          )
        )
        resolutionStates.set(pubkey, "stale-cache")
      }
      missing.push(pubkey)
    }
  }

  if (missing.length === 0) return { relayLists: out, resolutionStates }
  if (opts.cacheOnly) {
    for (const pubkey of missing) {
      if (!resolutionStates.has(pubkey)) {
        // A cache miss says nothing about whether the author has published a
        // relay list. Only a completed network lookup can establish absence.
        resolutionStates.set(pubkey, "lookup-unavailable")
      }
    }
    return { relayLists: out, resolutionStates }
  }

  const relayUrls =
    opts.relayUrls ??
    getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })

  try {
    const result = await runFetchDetailed(
      {
        kinds: [EVENT_KINDS.RELAY_LIST],
        authors: missing,
        limit: Math.max(missing.length * 2, 10),
      },
      relayUrls,
      opts.signal
    )
    throwIfLookupAborted(opts.signal)
    const statusByRelay = new Map(
      result.relays.map((relay) => [relay.relayUrl, relay.status] as const)
    )
    const verified = result.eventsVerified === true
    const transportComplete =
      verified &&
      relayUrls.length > 0 &&
      relayUrls.every((relayUrl) => statusByRelay.get(relayUrl) === "success")
    const transportUsable =
      verified &&
      relayUrls.some((relayUrl) => {
        const status = statusByRelay.get(relayUrl)
        return status === "success" || status === "partial"
      })

    for (const pubkey of missing) {
      const latest = verified
        ? pickLatestRelayListEvent(result.events, pubkey)
        : undefined
      if (!latest) {
        if (out.has(pubkey)) {
          resolutionStates.set(pubkey, "stale-cache")
        } else {
          resolutionStates.set(
            pubkey,
            transportComplete
              ? "missing"
              : transportUsable
                ? "partial-network"
                : "lookup-unavailable"
          )
        }
        continue
      }
      const fetched = parseRelayListEvent(latest, { cachedAt: now(opts) })
      const list = await retainStrongestRelayList(fetched)
      throwIfLookupAborted(opts.signal)
      out.set(
        pubkey,
        filterRelayListForContext(
          withLookupState(list, list === fetched ? "network" : "stale-cache")!,
          opts
        )
      )
      resolutionStates.set(
        pubkey,
        list !== fetched
          ? "stale-cache"
          : transportComplete
            ? "network"
            : "partial-network"
      )
    }
  } catch (error) {
    if (opts.signal?.aborted) throw error
    // best-effort; cached entries already merged above
    for (const pubkey of missing) {
      resolutionStates.set(
        pubkey,
        out.has(pubkey) ? "stale-cache" : "lookup-unavailable"
      )
    }
  }

  return { relayLists: out, resolutionStates }
}

/**
 * Persist a relay list directly. Used when a kind-10002 event is observed
 * incidentally during another fetch so we can warm the cache without an
 * explicit refresh.
 */
export async function ingestRelayListEvent(
  event: Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">,
  sourceRelayUrls?: readonly string[]
): Promise<RelayList> {
  const fetched = parseRelayListEvent(event, {
    sourceRelayUrls,
    cachedAt: Date.now(),
  })
  const list = await retainStrongestRelayList(fetched)
  return filterRelayListForContext(
    withLookupState(list, list === fetched ? "network" : "stale-cache")!
  )
}
