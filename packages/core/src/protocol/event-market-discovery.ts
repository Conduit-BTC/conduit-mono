export type EventMarketPerspectiveSource = "following" | "conduit" | "combined"

export type EventMarketPerspectiveAuthorSource =
  "refreshed" | "seed" | "cached" | "fallback" | "combined" | "none"

export interface EventMarketPerspectiveAuthorResolution {
  authorPubkeys: string[] | undefined
  source: EventMarketPerspectiveAuthorSource
}

function uniquePerspectiveAuthors(
  pubkeys: readonly string[] | undefined,
  perspectivePubkey?: string | null
): string[] {
  return Array.from(
    new Set(pubkeys?.map(normalizePubkey).filter(Boolean) as string[])
  )
    .filter((pubkey) => pubkey !== normalizePubkey(perspectivePubkey))
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

/**
 * Resolves the author boundary shared by product and event discovery. The
 * result is an input to candidate-first relay scans; callers must not turn it
 * into one independent event-market traversal per followed organizer.
 */
export function resolveEventMarketPerspectiveAuthorPubkeys(input: {
  usesPerspectiveGraph: boolean
  sourceMode?: EventMarketPerspectiveSource
  perspectivePubkey?: string | null
  refreshedAuthorPubkeys?: readonly string[]
  seedAuthorPubkeys?: readonly string[]
  cachedAuthorPubkeys?: readonly string[]
  fallbackAuthorPubkeys?: readonly string[]
  followLookupSettled?: boolean
}): EventMarketPerspectiveAuthorResolution {
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
  const hasRefreshedAuthors = input.refreshedAuthorPubkeys !== undefined
  const hasCachedAuthors = input.cachedAuthorPubkeys !== undefined

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
    if (hasRefreshedAuthors) {
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
    } else {
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
      if (hasCachedAuthors && cached.length > 0) {
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

  if (hasRefreshedAuthors) {
    return refreshed.length > 0
      ? { authorPubkeys: refreshed, source: "refreshed" }
      : { authorPubkeys: [], source: "none" }
  }
  const seeded = uniquePerspectiveAuthors(
    input.seedAuthorPubkeys,
    input.perspectivePubkey
  )
  if (seeded.length > 0) return { authorPubkeys: seeded, source: "seed" }
  if (hasCachedAuthors) {
    return cached.length > 0
      ? { authorPubkeys: cached, source: "cached" }
      : { authorPubkeys: [], source: "none" }
  }
  if (input.usesPerspectiveGraph && input.followLookupSettled) {
    return { authorPubkeys: [], source: "none" }
  }
  if (!input.usesPerspectiveGraph) {
    return { authorPubkeys: undefined, source: "none" }
  }
  return { authorPubkeys: undefined, source: "none" }
}

function normalizePubkey(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}
