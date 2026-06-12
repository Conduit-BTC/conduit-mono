/**
 * NIP-02 contact-list helpers.
 *
 * Contact lists are append-only events with `p` tags for followed pubkeys.
 * These helpers stay deliberately bounded: they interpret known contact-list
 * events, but do not attempt expensive reverse follower discovery.
 */

export type FollowListEventLike = {
  pubkey?: string
  created_at?: number
  tags?: readonly (readonly string[])[]
}

export interface MerchantTrustSocialSummary {
  merchantFollowingCount: number
  viewerFollowsMerchant: boolean | null
  merchantFollowsViewer: boolean | null
  mutualFollowCount: number | null
}

function normalizeHexPubkey(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed || !/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

export function extractFollowPubkeys(
  tags: readonly (readonly string[])[] | undefined
): string[] {
  const seen = new Set<string>()

  for (const tag of tags ?? []) {
    if (tag[0] !== "p") continue
    const pubkey = normalizeHexPubkey(tag[1])
    if (pubkey) seen.add(pubkey)
  }

  return Array.from(seen)
}

export function selectLatestFollowListEvent<T extends FollowListEventLike>(
  events: Iterable<T>
): T | undefined {
  return Array.from(events).sort(
    (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
  )[0]
}

export function getFollowListPubkeySet(
  event: FollowListEventLike | null | undefined
): Set<string> {
  return new Set(extractFollowPubkeys(event?.tags))
}

export function buildMerchantTrustSocialSummary({
  viewerFollowPubkeys,
  merchantFollowPubkeys,
  merchantPubkey,
  viewerPubkey,
}: {
  viewerFollowPubkeys?: Iterable<string> | null
  merchantFollowPubkeys?: Iterable<string> | null
  merchantPubkey: string
  viewerPubkey?: string | null
}): MerchantTrustSocialSummary {
  const normalizedMerchantPubkey = normalizeHexPubkey(merchantPubkey)
  const normalizedViewerPubkey = normalizeHexPubkey(viewerPubkey ?? undefined)
  const viewerFollows = new Set(
    Array.from(viewerFollowPubkeys ?? [])
      .map((pubkey) => normalizeHexPubkey(pubkey))
      .filter(Boolean) as string[]
  )
  const merchantFollows = new Set(
    Array.from(merchantFollowPubkeys ?? [])
      .map((pubkey) => normalizeHexPubkey(pubkey))
      .filter(Boolean) as string[]
  )
  let mutualFollowCount: number | null = null

  if (viewerFollowPubkeys && merchantFollowPubkeys) {
    mutualFollowCount = 0
    for (const pubkey of viewerFollows) {
      if (merchantFollows.has(pubkey)) mutualFollowCount += 1
    }
  }

  return {
    merchantFollowingCount: merchantFollows.size,
    viewerFollowsMerchant:
      normalizedMerchantPubkey && viewerFollowPubkeys
        ? viewerFollows.has(normalizedMerchantPubkey)
        : null,
    merchantFollowsViewer:
      normalizedViewerPubkey && merchantFollowPubkeys
        ? merchantFollows.has(normalizedViewerPubkey)
        : null,
    mutualFollowCount,
  }
}
