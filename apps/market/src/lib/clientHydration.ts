import {
  tryNormalizeRelayUrl,
  type CommerceProductRecord,
  type CommerceResult,
} from "@conduit/core"

export const MAX_PROFILE_RELAY_HINTS_PER_PUBKEY = 5

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
