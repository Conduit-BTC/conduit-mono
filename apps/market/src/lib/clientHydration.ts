import {
  tryNormalizeRelayUrl,
  type CommerceProductRecord,
  type CommerceResult,
} from "@conduit/core"

export const MAX_PROFILE_RELAY_HINTS_PER_PUBKEY = 5
export const MERCHANT_PAGE_SIZE = 12
export const PRODUCT_PAGE_SIZE = 12
export const MERCHANT_SEARCH_PREVIEW_SIZE = 6

/** Request displayed identities and one additional page, never the catalog. */
export function getPagedMerchantPubkeys(
  pubkeys: readonly string[],
  visibleCount: number,
  pageSize = MERCHANT_PAGE_SIZE
): string[] {
  return Array.from(new Set(pubkeys)).slice(
    0,
    Math.max(0, visibleCount) + pageSize
  )
}

export function normalizeRelayHints(
  relayUrls: readonly (string | null | undefined)[],
  maxHints = MAX_PROFILE_RELAY_HINTS_PER_PUBKEY
): string[] {
  const seen = new Set<string>()
  const hints: string[] = []

  for (const relayUrl of relayUrls) {
    if (!relayUrl) continue
    const normalized = tryNormalizeRelayUrl(relayUrl)
    if (!normalized.ok || seen.has(normalized.url)) continue
    seen.add(normalized.url)
    hints.push(normalized.url)
    if (hints.length >= maxHints) break
  }

  return hints
}

export function mergeRelayHintsByPubkey(
  ...maps: Array<Record<string, readonly string[] | undefined> | undefined>
): Record<string, string[]> {
  const merged = new Map<string, string[]>()

  for (const map of maps) {
    for (const [pubkey, relayUrls] of Object.entries(map ?? {})) {
      const current = merged.get(pubkey) ?? []
      const hints = normalizeRelayHints([
        ...(current ?? []),
        ...(relayUrls ?? []),
      ])
      if (hints.length > 0) merged.set(pubkey, hints)
    }
  }

  return Object.fromEntries(merged)
}

export function getProductSourceRelayHintsByPubkey(
  ...results: Array<CommerceResult<CommerceProductRecord[]> | undefined>
): Record<string, string[]> {
  const byPubkey = new Map<string, string[]>()

  for (const result of results) {
    for (const record of result?.data ?? []) {
      const relayUrls = record.sourceRelayUrls ?? []
      if (relayUrls.length === 0) continue
      const current = byPubkey.get(record.product.pubkey) ?? []
      byPubkey.set(
        record.product.pubkey,
        normalizeRelayHints([...current, ...relayUrls])
      )
    }
  }

  return Object.fromEntries(byPubkey)
}

export function splitMerchantHydrationTargets({
  allMerchantPubkeys,
  visibleMerchantPubkeys,
}: {
  allMerchantPubkeys: readonly string[]
  visibleMerchantPubkeys: readonly string[]
}): {
  visibleMerchantPubkeys: string[]
  backgroundMerchantPubkeys: string[]
} {
  const visible = Array.from(new Set(visibleMerchantPubkeys))
  const visibleSet = new Set(visible)
  const background = Array.from(
    new Set(allMerchantPubkeys.filter((pubkey) => !visibleSet.has(pubkey)))
  )

  return {
    visibleMerchantPubkeys: visible,
    backgroundMerchantPubkeys: background,
  }
}

/** Keep browse profile reads tied to rows the shopper can currently use. */
export function getBrowseBackgroundHydrationPubkeys(input: {
  menuMerchantPubkeys: readonly string[]
  selectedMerchantPubkeys: readonly string[]
  searchMerchantPubkeys: readonly string[]
  isSearching: boolean
  storeMenuOpen: boolean
}): string[] {
  if (input.isSearching)
    return Array.from(
      new Set([
        ...input.searchMerchantPubkeys,
        ...(input.storeMenuOpen ? input.menuMerchantPubkeys : []),
        ...input.selectedMerchantPubkeys,
      ])
    )
  if (!input.storeMenuOpen) return [...input.selectedMerchantPubkeys]
  return Array.from(
    new Set([...input.menuMerchantPubkeys, ...input.selectedMerchantPubkeys])
  )
}
