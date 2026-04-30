/**
 * Social commerce event-graph hydrator (scaffold).
 *
 * This module implements the API surface called for in
 * `docs/specs/relay/social_commerce_performance_checkpoint.md` Layers 5
 * and "Engagement Summary APIs". It does not ship any UI — surfaces
 * (product cards, profile headers, etc.) will adopt it incrementally.
 *
 * Design rules:
 *  - Cache-first: surfaces read from Dexie immediately and let the
 *    hydrator refresh in the background.
 *  - Tiered: each call accepts a `tier` so callers can express why they
 *    want the data (immediate counter, viewport-visible preview, full
 *    detail thread).
 *  - Planner-driven: relay reads go through `planRelayReads` with
 *    cached NIP-65 hints; the hydrator never invents its own fanout.
 *  - Bounded: a tiny in-memory queue rate-limits concurrent network
 *    work so a grid of cards does not stampede the relay set.
 */

import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { db, type CachedProductSocialSummary } from "../db"
import { fetchEventsFanout } from "./ndk"
import { getRelayLists } from "./relay-list"
import { planRelayReads, type RelayReadIntent } from "./relay-planner"

/**
 * Hydration tier indicates how aggressively the caller wants the data.
 * Surfaces map their visibility/intent into a tier; the hydrator turns
 * that into concurrency, fanout caps, and freshness windows.
 */
export type HydrationTier =
  /** Render needs the data immediately (e.g. product detail header). */
  | "immediate"
  /** Card is in the viewport; staged refresh acceptable. */
  | "viewport"
  /** Card is near the viewport (prefetch). */
  | "prefetch"
  /** User explicitly expanded the card / opened the panel. */
  | "expanded"
  /** Full thread / detail-only surfaces. */
  | "detail"

interface TierConfig {
  /** Max concurrent relay queries for this tier. */
  concurrency: number
  /** Max relays per query. */
  maxRelays: number
  /** Cache freshness window: cached entries newer than this skip the fetch. */
  freshnessMs: number
  /** Total relay timeout budget. */
  fetchTimeoutMs: number
}

const TIER_CONFIG: Record<HydrationTier, TierConfig> = {
  immediate: {
    concurrency: 4,
    maxRelays: 6,
    freshnessMs: 30_000,
    fetchTimeoutMs: 6_000,
  },
  viewport: {
    concurrency: 3,
    maxRelays: 4,
    freshnessMs: 60_000,
    fetchTimeoutMs: 5_000,
  },
  prefetch: {
    concurrency: 2,
    maxRelays: 3,
    freshnessMs: 120_000,
    fetchTimeoutMs: 4_000,
  },
  expanded: {
    concurrency: 4,
    maxRelays: 5,
    freshnessMs: 30_000,
    fetchTimeoutMs: 6_000,
  },
  detail: {
    concurrency: 6,
    maxRelays: 8,
    freshnessMs: 15_000,
    fetchTimeoutMs: 8_000,
  },
}

/**
 * Coordinate (NIP-33 `kind:pubkey:d-tag`) or event id identifying the
 * commerce object whose social signals should be hydrated.
 */
export interface ProductSocialKey {
  /** NIP-33 coordinate `kind:pubkey:d-tag` for parameterized events. */
  coordinate?: string
  /** Event id (32-byte hex). */
  eventId?: string
  /** Author pubkey (used to route reads at their write relays). */
  authorPubkey?: string
}

/** Public summary returned to surfaces. */
export interface ProductSocialSummary {
  key: string
  reactionCount: number
  zapCount: number
  zapAmountMsats: number
  commentCount: number
  reviewCount: number
  /** "cache" if served from Dexie, "network" if freshly fetched, "stale" if cache + degraded. */
  source: "cache" | "network" | "stale" | "empty"
  cachedAt?: number
  verifiedAt?: number
}

/** Comment preview row returned to surfaces. */
export interface ProductCommentPreview {
  id: string
  pubkey: string
  content: string
  createdAt: number
}

function summaryKey(input: ProductSocialKey): string {
  if (input.coordinate) return input.coordinate
  if (input.eventId) return `event:${input.eventId}`
  throw new Error("ProductSocialKey requires coordinate or eventId")
}

function summaryToPublic(
  row: CachedProductSocialSummary | undefined,
  source: ProductSocialSummary["source"],
  fallbackKey: string
): ProductSocialSummary {
  if (!row) {
    return {
      key: fallbackKey,
      reactionCount: 0,
      zapCount: 0,
      zapAmountMsats: 0,
      commentCount: 0,
      reviewCount: 0,
      source,
    }
  }
  return {
    key: row.key,
    reactionCount: row.reactionCount ?? 0,
    zapCount: row.zapCount ?? 0,
    zapAmountMsats: row.zapAmountMsats ?? 0,
    commentCount: row.commentCount ?? 0,
    reviewCount: row.reviewCount ?? 0,
    source,
    cachedAt: row.cachedAt,
    verifiedAt: row.verifiedAt,
  }
}

async function loadCachedSummary(
  key: string
): Promise<CachedProductSocialSummary | undefined> {
  try {
    return await db.productSocialSummaries.get(key)
  } catch {
    return undefined
  }
}

async function persistSummary(row: CachedProductSocialSummary): Promise<void> {
  try {
    await db.productSocialSummaries.put(row)
  } catch {
    // SSR / locked-down browser — soft-fail; cache is best-effort.
  }
}

// -----------------------------------------------------------------------
// Tier-aware queue
// -----------------------------------------------------------------------

interface QueueTask<T> {
  tier: HydrationTier
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

const TIER_PRIORITY: Record<HydrationTier, number> = {
  immediate: 0,
  detail: 1,
  expanded: 2,
  viewport: 3,
  prefetch: 4,
}

class HydrationQueue {
  private readonly pending: QueueTask<unknown>[] = []
  private active = 0
  private maxConcurrency = 6

  enqueue<T>(tier: HydrationTier, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = { tier, run, resolve, reject }
      // Insert sorted by tier priority (lower = sooner).
      const idx = this.pending.findIndex(
        (existing) => TIER_PRIORITY[existing.tier] > TIER_PRIORITY[tier]
      )
      if (idx === -1) this.pending.push(task as QueueTask<unknown>)
      else this.pending.splice(idx, 0, task as QueueTask<unknown>)
      this.maxConcurrency = Math.max(
        this.maxConcurrency,
        TIER_CONFIG[tier].concurrency
      )
      this.tick()
    })
  }

  private tick(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const task = this.pending.shift()
      if (!task) break
      this.active += 1
      task
        .run()
        .then((value) => task.resolve(value))
        .catch((error) => task.reject(error))
        .finally(() => {
          this.active -= 1
          this.tick()
        })
    }
  }

  /** Test-only helper: drain pending tasks. */
  __pendingCount(): number {
    return this.pending.length
  }
}

const queue = new HydrationQueue()

/** Test-only access to the queue (used by unit tests). */
export const __socialHydratorTestHooks = {
  pendingCount: () => queue.__pendingCount(),
}

// -----------------------------------------------------------------------
// Public APIs
// -----------------------------------------------------------------------

async function planRead(
  intent: RelayReadIntent,
  authors: string[],
  tier: HydrationTier
): Promise<string[]> {
  const lists = authors.length > 0 ? await getRelayLists(authors) : new Map()
  const plan = planRelayReads({
    intent,
    authors,
    relayLists: lists,
    maxRelays: TIER_CONFIG[tier].maxRelays,
  })
  return plan.relayUrls
}

/**
 * Resolve a product's aggregated social summary. Cache-first: returns
 * immediately from Dexie when available; on a miss or when the cache is
 * older than the tier's freshness window, schedules a background
 * refresh via the queue and returns the cached row (or an empty row).
 *
 * Callers that need a fresh value can `await` the returned
 * `refreshPromise`.
 */
export async function getProductSocialSummary(
  input: ProductSocialKey,
  options: { tier?: HydrationTier } = {}
): Promise<{
  summary: ProductSocialSummary
  refreshPromise: Promise<ProductSocialSummary>
}> {
  const tier = options.tier ?? "viewport"
  const key = summaryKey(input)
  const cached = await loadCachedSummary(key)
  const now = Date.now()
  const fresh =
    cached &&
    now - (cached.verifiedAt ?? cached.cachedAt) <=
      TIER_CONFIG[tier].freshnessMs

  const summary = cached
    ? summaryToPublic(cached, fresh ? "cache" : "stale", key)
    : summaryToPublic(undefined, "empty", key)

  const refreshPromise = fresh
    ? Promise.resolve(summary)
    : queue.enqueue(tier, async () => {
        const authors = input.authorPubkey ? [input.authorPubkey] : []
        const relayUrls = await planRead(
          "product_card_social_summary",
          authors,
          tier
        )
        if (relayUrls.length === 0) {
          return summary
        }

        const filter: NDKFilter = input.coordinate
          ? { "#a": [input.coordinate], kinds: [7, 1111, 9735] }
          : { "#e": [input.eventId ?? ""], kinds: [7, 1111, 9735] }

        const events = await fetchEventsFanout(filter, {
          relayUrls,
          fetchTimeoutMs: TIER_CONFIG[tier].fetchTimeoutMs,
        })

        const counts = aggregateSocialCounts(events)
        const row: CachedProductSocialSummary = {
          key,
          ...counts,
          cachedAt: Date.now(),
          verifiedAt: Date.now(),
        }
        await persistSummary(row)
        return summaryToPublic(row, "network", key)
      })

  return { summary, refreshPromise }
}

/**
 * Top-N comments preview for a product card. Returns network-fetched
 * events ordered newest-first; cache layer is intentionally omitted at
 * this stage — comment threads change quickly and are queued at lower
 * priority than counters.
 */
export async function getProductCommentsPreview(
  input: ProductSocialKey,
  options: { limit?: number; tier?: HydrationTier } = {}
): Promise<ProductCommentPreview[]> {
  const tier = options.tier ?? "expanded"
  const limit = options.limit ?? 3
  return queue.enqueue(tier, async () => {
    const authors = input.authorPubkey ? [input.authorPubkey] : []
    const relayUrls = await planRead("product_comments_preview", authors, tier)
    if (relayUrls.length === 0) return []
    const filter: NDKFilter = input.coordinate
      ? { "#a": [input.coordinate], kinds: [1111], limit }
      : { "#e": [input.eventId ?? ""], kinds: [1111], limit }
    const events = await fetchEventsFanout(filter, {
      relayUrls,
      fetchTimeoutMs: TIER_CONFIG[tier].fetchTimeoutMs,
    })
    return events
      .map((event) => ({
        id: event.id,
        pubkey: event.pubkey,
        content: event.content ?? "",
        createdAt: event.created_at ?? 0,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  })
}

/**
 * Recent profile feed for a pubkey. Detail-tier; intentionally narrow
 * at this stage so callers can build profile headers and stop here.
 */
export async function getProfileSocialFeed(
  pubkey: string,
  options: { limit?: number; tier?: HydrationTier } = {}
): Promise<NDKEvent[]> {
  const tier = options.tier ?? "detail"
  const limit = options.limit ?? 20
  return queue.enqueue(tier, async () => {
    const relayUrls = await planRead("profile_social_feed", [pubkey], tier)
    if (relayUrls.length === 0) return []
    const filter: NDKFilter = {
      authors: [pubkey],
      kinds: [1, 6, 30023],
      limit,
    }
    return fetchEventsFanout(filter, {
      relayUrls,
      fetchTimeoutMs: TIER_CONFIG[tier].fetchTimeoutMs,
    })
  })
}

/** Internal: derive counters from a bag of social events. */
function aggregateSocialCounts(
  events: readonly NDKEvent[]
): Pick<
  CachedProductSocialSummary,
  | "reactionCount"
  | "zapCount"
  | "zapAmountMsats"
  | "commentCount"
  | "reviewCount"
> {
  let reactionCount = 0
  let zapCount = 0
  let zapAmountMsats = 0
  let commentCount = 0
  let reviewCount = 0

  for (const event of events) {
    switch (event.kind) {
      case 7:
        reactionCount += 1
        break
      case 1111:
        commentCount += 1
        // Comments tagged as merchant-feedback / review variants count
        // both ways: surface still gets the comment, plus a review tally.
        if (event.tags.some(([k, v]) => k === "t" && v === "review")) {
          reviewCount += 1
        }
        break
      case 9735: {
        zapCount += 1
        const bolt11Tag = event.tags.find(([key]) => key === "bolt11")
        const amountTag = event.tags.find(([key]) => key === "amount")
        if (amountTag && amountTag[1]) {
          const parsed = Number(amountTag[1])
          if (Number.isFinite(parsed)) zapAmountMsats += parsed
        } else if (bolt11Tag) {
          // Decoding bolt11 is out of scope for the scaffold; counters
          // remain accurate even when amount tag is absent.
        }
        break
      }
      default:
        break
    }
  }

  return {
    reactionCount,
    zapCount,
    zapAmountMsats,
    commentCount,
    reviewCount,
  }
}

/** Test seam: aggregate counters without going through the queue. */
export const __aggregateSocialCounts = aggregateSocialCounts
