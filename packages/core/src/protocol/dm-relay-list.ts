import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { db, type CachedDmRelayList } from "../db"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout, getEventSourceRelayUrls } from "./ndk"
import { tryNormalizeRelayUrl } from "./relay-settings"

/**
 * NIP-17 kind:10050 inbox relay list resolution.
 *
 * This cache is deliberately separate from NIP-65 relay metadata. A kind:10050
 * relay tells us where encrypted gift wraps can reach a recipient; it is not a
 * user-managed IN/OUT preference and must not be surfaced as one.
 */

export const DM_RELAY_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1_000
export const DM_RELAY_LIST_FETCH_TIMEOUT_MS = 6_000
export const DM_RELAY_LIST_CONNECT_TIMEOUT_MS = 4_000

export interface DmRelayList {
  pubkey: string
  relayUrls: string[]
  eventCreatedAt: number
  sourceRelayUrls?: string[]
  cachedAt: number
}

export interface DmRelayListLookupOptions {
  skipCache?: boolean
  cacheOnly?: boolean
  relayUrls?: readonly string[]
  now?: () => number
}

export function serializeDmRelayListTags(
  relayUrls: readonly string[]
): string[][] {
  return dedupeUrls(relayUrls).map((url) => ["relay", url])
}

interface DmRelayListTestOverrides {
  fetchEventsFanout?: typeof fetchEventsFanout
  loadCached?: (pubkey: string) => Promise<CachedDmRelayList | undefined>
  putCached?: (entry: CachedDmRelayList) => Promise<void>
  now?: () => number
}

let testOverrides: DmRelayListTestOverrides = {}

export function __setDmRelayListTestOverrides(
  overrides: Partial<DmRelayListTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetDmRelayListTestOverrides(): void {
  testOverrides = {}
}

function now(opts?: DmRelayListLookupOptions): number {
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

export function parseDmRelayListEvent(
  event: Pick<NDKEvent, "pubkey" | "tags" | "created_at">,
  options?: { sourceRelayUrls?: readonly string[]; cachedAt?: number }
): DmRelayList {
  const relayUrls = dedupeUrls(
    (event.tags ?? [])
      .filter((tag) => tag[0] === "relay" && typeof tag[1] === "string")
      .map((tag) => tag[1] ?? "")
  )

  return {
    pubkey: event.pubkey,
    relayUrls,
    eventCreatedAt: event.created_at ?? 0,
    sourceRelayUrls: options?.sourceRelayUrls
      ? dedupeUrls(options.sourceRelayUrls)
      : undefined,
    cachedAt: options?.cachedAt ?? Date.now(),
  }
}

function toCachedRow(list: DmRelayList): CachedDmRelayList {
  return {
    pubkey: list.pubkey,
    relayUrls: list.relayUrls,
    eventCreatedAt: list.eventCreatedAt,
    sourceRelayUrls: list.sourceRelayUrls,
    cachedAt: list.cachedAt,
  }
}

function fromCachedRow(row: CachedDmRelayList): DmRelayList {
  return {
    pubkey: row.pubkey,
    relayUrls: dedupeUrls(row.relayUrls ?? []),
    eventCreatedAt: row.eventCreatedAt ?? 0,
    sourceRelayUrls: row.sourceRelayUrls
      ? dedupeUrls(row.sourceRelayUrls)
      : undefined,
    cachedAt: row.cachedAt ?? 0,
  }
}

async function loadCached(pubkey: string): Promise<DmRelayList | undefined> {
  if (testOverrides.loadCached) {
    const row = await testOverrides.loadCached(pubkey)
    return row ? fromCachedRow(row) : undefined
  }
  try {
    const row = await db.dmRelayLists.get(pubkey)
    return row ? fromCachedRow(row) : undefined
  } catch {
    return undefined
  }
}

async function putCached(list: DmRelayList): Promise<void> {
  const row = toCachedRow(list)
  if (testOverrides.putCached) {
    await testOverrides.putCached(row)
    return
  }
  try {
    await db.dmRelayLists.put(row)
  } catch {
    // best-effort; ignore persistence failures in non-browser environments.
  }
}

export function pickLatestDmRelayListEvent<
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

function getDefaultDiscoveryRelayUrls(): string[] {
  return dedupeUrls([
    ...config.corePublicFallbackRelayUrls,
    ...config.appBackplaneRelayUrls,
  ])
}

async function runFetch(
  filter: NDKFilter,
  relayUrls: readonly string[]
): Promise<NDKEvent[]> {
  const impl = testOverrides.fetchEventsFanout ?? fetchEventsFanout
  return (await impl(filter, {
    relayUrls: relayUrls.length > 0 ? [...relayUrls] : undefined,
    connectTimeoutMs: DM_RELAY_LIST_CONNECT_TIMEOUT_MS,
    fetchTimeoutMs: DM_RELAY_LIST_FETCH_TIMEOUT_MS,
    budgetClass: "critical_order_read",
  })) as NDKEvent[]
}

export async function getDmRelayList(
  pubkey: string,
  opts: DmRelayListLookupOptions = {}
): Promise<DmRelayList | undefined> {
  if (!pubkey) return undefined

  const cached = opts.skipCache ? undefined : await loadCached(pubkey)
  if (cached && now(opts) - cached.cachedAt < DM_RELAY_LIST_CACHE_TTL_MS) {
    return cached
  }
  if (opts.cacheOnly) return cached

  const relayUrls = opts.relayUrls ?? getDefaultDiscoveryRelayUrls()

  try {
    const events = await runFetch(
      { kinds: [EVENT_KINDS.DM_RELAY_LIST], authors: [pubkey], limit: 5 },
      relayUrls
    )
    const latest = pickLatestDmRelayListEvent(events, pubkey)
    if (!latest) return cached
    const list = parseDmRelayListEvent(latest, {
      sourceRelayUrls: getEventSourceRelayUrls(latest),
      cachedAt: now(opts),
    })
    await putCached(list)
    return list
  } catch {
    return cached
  }
}

export async function getDmRelayLists(
  pubkeys: readonly string[],
  opts: DmRelayListLookupOptions = {}
): Promise<Map<string, DmRelayList>> {
  const out = new Map<string, DmRelayList>()
  const unique = Array.from(
    new Set(pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean))
  )
  if (unique.length === 0) return out

  const missing: string[] = []
  if (!opts.skipCache) {
    for (const pubkey of unique) {
      const cached = await loadCached(pubkey)
      if (cached && now(opts) - cached.cachedAt < DM_RELAY_LIST_CACHE_TTL_MS) {
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
  if (opts.cacheOnly) return out

  const relayUrls = opts.relayUrls ?? getDefaultDiscoveryRelayUrls()

  try {
    const events = await runFetch(
      {
        kinds: [EVENT_KINDS.DM_RELAY_LIST],
        authors: missing,
        limit: Math.max(missing.length * 2, 10),
      },
      relayUrls
    )

    for (const pubkey of missing) {
      const latest = pickLatestDmRelayListEvent(events, pubkey)
      if (!latest) continue
      const list = parseDmRelayListEvent(latest, {
        sourceRelayUrls: getEventSourceRelayUrls(latest),
        cachedAt: now(opts),
      })
      await putCached(list)
      out.set(pubkey, list)
    }
  } catch {
    // best-effort; cached entries already merged above
  }

  return out
}

export async function ingestDmRelayListEvent(
  event: Pick<NDKEvent, "pubkey" | "tags" | "created_at">,
  sourceRelayUrls?: readonly string[]
): Promise<DmRelayList> {
  const list = parseDmRelayListEvent(event, {
    sourceRelayUrls,
    cachedAt: Date.now(),
  })
  await putCached(list)
  return list
}
