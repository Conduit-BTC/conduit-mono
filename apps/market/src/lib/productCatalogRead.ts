import {
  normalizePubkey,
  type CommerceQueryMeta,
  type SignedPublicNostrEvent,
} from "@conduit/core"

export type ProductCatalogScope = "marketplace" | "storefront"
export type ProductCatalogSourceMode = "following" | "conduit" | "combined"

export interface ProductCatalogReadInput {
  scope: ProductCatalogScope
  catalogSource?: ProductCatalogSourceMode
  merchantPubkey?: string
  perspectivePubkey?: string | null
  seedAuthorPubkeys?: string[]
  textQuery?: string
  tags?: string[]
  tag?: string
  sort?: string
  limit?: number
}

export type PerspectiveAuthorSource =
  "refreshed" | "seed" | "cached" | "fallback" | "combined" | "none"

export interface PerspectiveAuthorResolution {
  authorPubkeys: string[] | undefined
  source: PerspectiveAuthorSource
}

export async function refreshProductCatalogSources(input: {
  queryEnabled: boolean
  catalogReady: boolean
  streamsNetwork: boolean
  usesPerspectiveGraph: boolean
  catalogSource: ProductCatalogSourceMode
  refreshPerspectiveAuthors: () => boolean | Promise<boolean>
  restartNetworkStream: () => void
  refreshNetwork: () => unknown
  refreshCache: () => unknown
}): Promise<void> {
  if (!input.queryEnabled) return

  if (input.usesPerspectiveGraph && input.catalogSource !== "conduit") {
    const authorSetChanged = await input.refreshPerspectiveAuthors()
    if (authorSetChanged) return
  }

  if (!input.catalogReady) return
  if (input.streamsNetwork) input.restartNetworkStream()
  else void input.refreshNetwork()
  void input.refreshCache()
}

export function isProductDiscoveryReadIncomplete(
  meta: Pick<CommerceQueryMeta, "stale" | "degraded" | "capped"> | undefined
): boolean {
  return !!(meta?.stale || meta?.degraded || meta?.capped)
}

export interface FollowListSnapshot {
  pubkeys: string[]
  eventCreatedAt: number
  eventId?: string
  /** Trusted source provenance; absent for an unverified browser projection. */
  evidence?: "bundled" | "verified"
  /** Full signed evidence retained only for authenticated browser persistence. */
  signedEvent?: SignedPublicNostrEvent
}

const FOLLOW_LIST_EVENT_ID = /^[0-9a-f]{64}$/i

export function parseFollowListSnapshot(
  value: unknown,
  options: {
    excludePubkey?: string | null
    requireEventId?: boolean
    sortPubkeys?: boolean
    evidence?: FollowListSnapshot["evidence"]
    signedEvent?: SignedPublicNostrEvent
  } = {}
): FollowListSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<FollowListSnapshot>
  if (
    !Array.isArray(candidate.pubkeys) ||
    !candidate.pubkeys.every((pubkey) => typeof pubkey === "string") ||
    !Number.isSafeInteger(candidate.eventCreatedAt) ||
    (candidate.eventCreatedAt ?? -1) < 0 ||
    (candidate.eventId !== undefined &&
      !FOLLOW_LIST_EVENT_ID.test(candidate.eventId)) ||
    (options.requireEventId && candidate.eventId === undefined)
  ) {
    return undefined
  }

  const pubkeys = Array.from(
    new Set(candidate.pubkeys.map(normalizePubkey).filter(Boolean) as string[])
  ).filter((pubkey) => pubkey !== options.excludePubkey)
  if (options.sortPubkeys) pubkeys.sort()

  return {
    pubkeys,
    eventCreatedAt: candidate.eventCreatedAt!,
    eventId: candidate.eventId?.toLowerCase(),
    ...(options.evidence ? { evidence: options.evidence } : {}),
    ...(options.signedEvent ? { signedEvent: options.signedEvent } : {}),
  }
}

export function isSameFollowListSnapshot(
  a: FollowListSnapshot | undefined,
  b: FollowListSnapshot | undefined
): boolean {
  if (!a || !b) return a === b
  return (
    a.eventCreatedAt === b.eventCreatedAt &&
    a.eventId === b.eventId &&
    a.evidence === b.evidence &&
    a.pubkeys.length === b.pubkeys.length &&
    a.pubkeys.every((pubkey, index) => pubkey === b.pubkeys[index])
  )
}

export function selectStrongestFollowListSnapshot(
  current: FollowListSnapshot | undefined,
  candidate: FollowListSnapshot | undefined
): FollowListSnapshot | undefined {
  if (!candidate) return current
  if (!current) return candidate

  // The event id commits to `created_at` and every projected tag. Prefer the
  // newly observed copy of the same event so it can repair corrupt cached
  // timing as well as a corrupt cached pubkey projection.
  if (
    current.eventId !== undefined &&
    candidate.eventId !== undefined &&
    candidate.eventId === current.eventId
  ) {
    return candidate
  }
  if (candidate.eventCreatedAt > current.eventCreatedAt) return candidate
  if (candidate.eventCreatedAt < current.eventCreatedAt) return current

  // A verified signed event is stronger than an id-less bundled projection.
  // Once both ids are known, NIP-01 chooses the lower id on timestamp ties.
  if (!current.eventId && candidate.eventId) return candidate
  if (current.eventId && !candidate.eventId) return current
  if (!current.eventId || !candidate.eventId) return current
  return candidate.eventId < current.eventId ? candidate : current
}

export function isPerspectiveMarketplaceRead(
  input: Pick<ProductCatalogReadInput, "scope" | "merchantPubkey">
): boolean {
  return input.scope === "marketplace" && !input.merchantPubkey
}

function uniquePerspectiveAuthors(
  pubkeys: readonly string[] | undefined,
  perspectivePubkey?: string | null
): string[] {
  return Array.from(
    new Set(pubkeys?.map(normalizePubkey).filter(Boolean) as string[])
  )
    .filter((pubkey) => pubkey !== perspectivePubkey)
    .sort()
}

function includePerspectiveAuthor(
  pubkeys: readonly string[],
  perspectivePubkey?: string | null
): string[] {
  const normalizedPerspective = normalizePubkey(perspectivePubkey)
  return Array.from(
    new Set([
      ...pubkeys,
      ...(normalizedPerspective ? [normalizedPerspective] : []),
    ])
  ).sort()
}

export function resolvePerspectiveAuthorPubkeys(input: {
  usesPerspectiveGraph: boolean
  sourceMode?: ProductCatalogSourceMode
  perspectivePubkey?: string | null
  refreshedAuthorPubkeys?: readonly string[]
  seedAuthorPubkeys?: readonly string[]
  cachedAuthorPubkeys?: readonly string[]
  fallbackAuthorPubkeys?: readonly string[]
  followLookupSettled?: boolean
}): PerspectiveAuthorResolution {
  const refreshed = uniquePerspectiveAuthors(
    input.refreshedAuthorPubkeys,
    input.perspectivePubkey
  )
  const cached = uniquePerspectiveAuthors(
    input.cachedAuthorPubkeys,
    input.perspectivePubkey
  )
  const fallback = uniquePerspectiveAuthors(
    input.fallbackAuthorPubkeys,
    input.perspectivePubkey
  )
  const sourceMode = input.sourceMode ?? "following"

  if (input.usesPerspectiveGraph && sourceMode === "conduit") {
    const seeded = uniquePerspectiveAuthors(
      input.seedAuthorPubkeys,
      input.perspectivePubkey
    )
    if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }

    if (fallback.length > 0) {
      return { authorPubkeys: fallback, source: "fallback" }
    }
    return { authorPubkeys: undefined, source: "none" }
  }

  if (input.usesPerspectiveGraph && sourceMode === "combined") {
    if (refreshed.length > 0) {
      return {
        authorPubkeys: includePerspectiveAuthor(
          uniquePerspectiveAuthors(
            [...refreshed, ...fallback],
            input.perspectivePubkey
          ),
          input.perspectivePubkey
        ),
        source: fallback.length > 0 ? "combined" : "refreshed",
      }
    }

    const seeded = uniquePerspectiveAuthors(
      input.seedAuthorPubkeys,
      input.perspectivePubkey
    )
    if (seeded.length > 0) {
      return {
        authorPubkeys: includePerspectiveAuthor(
          uniquePerspectiveAuthors(
            [...seeded, ...fallback],
            input.perspectivePubkey
          ),
          input.perspectivePubkey
        ),
        source: fallback.length > 0 ? "combined" : "seed",
      }
    }

    if (cached.length > 0) {
      return {
        authorPubkeys: includePerspectiveAuthor(
          uniquePerspectiveAuthors(
            [...cached, ...fallback],
            input.perspectivePubkey
          ),
          input.perspectivePubkey
        ),
        source: fallback.length > 0 ? "combined" : "cached",
      }
    }

    if (fallback.length > 0) {
      return {
        authorPubkeys: includePerspectiveAuthor(
          fallback,
          input.perspectivePubkey
        ),
        source: "fallback",
      }
    }

    const normalizedPerspective = normalizePubkey(input.perspectivePubkey)
    if (normalizedPerspective) {
      return { authorPubkeys: [normalizedPerspective], source: "combined" }
    }
  }

  if (refreshed.length > 0) {
    return { authorPubkeys: refreshed, source: "refreshed" }
  }

  const seeded = uniquePerspectiveAuthors(
    input.seedAuthorPubkeys,
    input.perspectivePubkey
  )
  if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }

  if (cached.length > 0) return { authorPubkeys: cached, source: "cached" }

  if (input.usesPerspectiveGraph && input.followLookupSettled) {
    return { authorPubkeys: [], source: "none" }
  }

  if (!input.usesPerspectiveGraph) {
    return { authorPubkeys: undefined, source: "none" }
  }

  return { authorPubkeys: undefined, source: "none" }
}

export function getCatalogAuthorPubkeys(
  perspectiveAuthorPubkeys: string[] | undefined
): string[] | undefined {
  if (!perspectiveAuthorPubkeys) return undefined
  return Array.from(new Set(perspectiveAuthorPubkeys)).sort()
}

export function getCatalogAuthorKey(
  authorPubkeys: readonly string[] | undefined
): string {
  return authorPubkeys === undefined
    ? "unscoped"
    : `authors:${Array.from(new Set(authorPubkeys)).sort().join(",")}`
}

export function getProductCatalogQueryKey(
  input: ProductCatalogReadInput,
  source: "cache" | "network"
) {
  const perspectiveMarketplace = isPerspectiveMarketplaceRead(input)
  const catalogSource = input.catalogSource ?? "following"

  return [
    "progressive-products",
    source,
    input.scope,
    input.scope === "marketplace"
      ? (input.merchantPubkey ?? "all")
      : input.merchantPubkey,
    perspectiveMarketplace
      ? (input.perspectivePubkey ?? "market-perspective")
      : input.scope === "marketplace"
        ? (input.perspectivePubkey ?? "market-perspective")
        : "storefront",
    // The caller appends the resolved catalog-author key. Raw seed identity is
    // intentionally excluded: tag order, duplicates, and self-only changes do
    // not alter the actual catalog and must not restart its progressive read.
    perspectiveMarketplace || input.scope === "marketplace"
      ? "resolved-authors-appended"
      : "storefront",
    perspectiveMarketplace ? catalogSource : "scoped",
    perspectiveMarketplace ? "" : (input.textQuery ?? ""),
    perspectiveMarketplace
      ? ""
      : input.scope === "marketplace"
        ? (input.tags ?? []).join(",")
        : (input.tag ?? ""),
    perspectiveMarketplace ? "newest" : (input.sort ?? "newest"),
    input.limit ?? "default",
  ] as const
}
