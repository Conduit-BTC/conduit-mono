import { tryNormalizeRelayUrl } from "./relay-settings"

export type RelayOperation = "read" | "write"
export type AppRelayGrantBucket =
  | "general_read"
  | "commerce_read"
  | "general_write"
  | "commerce_write"
  | "recipient_delivery"
  | "recipient_fallback"
  | "core_public_write"
  | "commerce_discovery_write"
  | "search_index"
  | "inbox_read"
  | "author_readback"
  | "diagnostic_read"
export type PublicFallbackBucket =
  | "core_public"
  | "commerce_discovery"
  | "search_index"
  | "zap_public"
  | "default"

/** One reason a target may be contacted for one operation. Grants are additive. */
export type RelayGrant =
  | {
      kind: "app"
      operation: RelayOperation
      bucket: AppRelayGrantBucket
    }
  | {
      kind: "discovery"
      operation: RelayOperation
      registry: "owner_10002" | "inbox_10050"
    }
  | {
      kind: "owner_nip65"
      operation: RelayOperation
      ownerPubkey: string
      selection: "read" | "write"
    }
  | { kind: "owner_nip17"; operation: RelayOperation; ownerPubkey: string }
  | {
      kind: "owner_selection"
      operation: RelayOperation
      ownerPubkey: string
      eventKind: 10002 | 10050
      eventId: string
    }
  | {
      kind: "recipient_nip17"
      operation: "write"
      recipientPubkey: string
      eventId?: string
    }
  | {
      kind: "recovery"
      operation: "read"
      ownerPubkey: string
      replacementEventId?: string
    }
  | { kind: "retained_inbox"; operation: "read"; ownerPubkey: string }
  | {
      kind: "compatibility"
      operation: RelayOperation
      policy: "inbox_read" | "order_delivery"
    }
  | {
      kind: "remote_nip65"
      operation: RelayOperation
      pubkey: string
    }
  | {
      kind: "public_fallback"
      operation: "read"
      bucket: PublicFallbackBucket
    }
  | { kind: "public_hint"; operation: "read" }
  | { kind: "source_delivery"; operation: "write" }

export interface RelayTarget {
  url: string
  grants: RelayGrant[]
}

/** Preserve all reasons for an overlapping URL while keeping first-seen order. */
export function mergeRelayTargets(
  ...groups: readonly (readonly RelayTarget[])[]
): RelayTarget[] {
  const byUrl = new Map<string, RelayTarget>()
  for (const target of groups.flat()) {
    const normalized = tryNormalizeRelayUrl(target.url)
    if (!normalized.ok) continue
    const existing = byUrl.get(normalized.url) ?? {
      url: normalized.url,
      grants: [],
    }
    const seen = new Set(existing.grants.map((grant) => JSON.stringify(grant)))
    for (const grant of target.grants) {
      const key = JSON.stringify(grant)
      if (!seen.has(key)) {
        existing.grants.push({ ...grant })
        seen.add(key)
      }
    }
    byUrl.set(normalized.url, existing)
  }
  return [...byUrl.values()]
}

/**
 * Intersect an operation's ordered URL plan with its independent grants.
 * Target construction order is not operation priority. Omitted URLs use target
 * order; an explicit empty list selects nothing. Normalized overlap keeps all
 * grants and consumes at most one network attempt.
 */
export function selectRelayTargets(
  targets: readonly RelayTarget[],
  relayUrls?: readonly string[]
): RelayTarget[] {
  const merged = mergeRelayTargets(targets)
  if (relayUrls === undefined) return merged
  const byUrl = new Map(merged.map((target) => [target.url, target]))
  const selected: RelayTarget[] = []
  for (const raw of relayUrls) {
    const normalized = tryNormalizeRelayUrl(raw)
    if (!normalized.ok) continue
    const target = byUrl.get(normalized.url)
    if (!target) continue
    selected.push(target)
    byUrl.delete(normalized.url)
  }
  return selected
}

export function relayTargetUrls(targets: readonly RelayTarget[]): string[] {
  return targets.map((target) => target.url)
}

/** A source must be named at construction; an unclassified URL grants nothing. */
export function relayTargetsFromUrls(
  urls: readonly string[],
  grant: RelayGrant
): RelayTarget[] {
  return mergeRelayTargets(urls.map((url) => ({ url, grants: [{ ...grant }] })))
}
