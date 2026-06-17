import { tryNormalizeRelayUrl } from "./relay-settings"

export const MAX_RELAY_HINTS_PER_GROUP = 5

export function normalizeRelayHints(
  relayUrls: readonly (string | null | undefined)[],
  maxHints = MAX_RELAY_HINTS_PER_GROUP
): string[] {
  if (maxHints <= 0) return []

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

export function mergeRelayHints(
  ...groups: Array<readonly (string | null | undefined)[] | undefined>
): string[] {
  const seen = new Set<string>()
  const hints: string[] = []

  for (const group of groups) {
    for (const relayUrl of normalizeRelayHints(group ?? [])) {
      if (seen.has(relayUrl)) continue
      seen.add(relayUrl)
      hints.push(relayUrl)
    }
  }

  return hints
}

export function mergeRelayHintsByPubkey(
  ...maps: Array<Record<string, readonly string[] | undefined> | undefined>
): Record<string, string[]> {
  const merged = new Map<string, string[]>()

  for (const map of maps) {
    for (const [pubkey, relayUrls] of Object.entries(map ?? {})) {
      const hints = normalizeRelayHints([
        ...(merged.get(pubkey) ?? []),
        ...(relayUrls ?? []),
      ])
      if (hints.length > 0) merged.set(pubkey, hints)
    }
  }

  return Object.fromEntries(merged)
}
