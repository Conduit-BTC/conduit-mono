import {
  formatNpub,
  getProfileName,
  pubkeyToNpub,
  sanitizeProfileMedia,
  type ProfileSearchMatch,
  type ProfileSearchResult,
} from "@conduit/core"
import type { SearchSuggestionItem } from "@conduit/ui"

export const ACCOUNT_SUGGESTION_LIMIT = 5
/**
 * Both account surfaces read one shared query, then narrow it themselves: the
 * header shows the first `ACCOUNT_SUGGESTION_LIMIT` rows, and the Sellers page
 * first removes accounts already listed as discovered sellers. Fetching the
 * display cap would let those removals empty the "Other accounts" row.
 */
export const ACCOUNT_SEARCH_CANDIDATE_LIMIT = 20

export function describeAccountSearchSource(
  result: ProfileSearchResult | undefined,
  loading: { device: boolean; network: boolean }
): string {
  if (loading.network) return "Searching relays..."
  if (loading.device) return "Searching this device..."
  const evidence = describeAccountSearchEvidence(result)
  if (evidence) return evidence
  return result?.evidence === "not_queried"
    ? "From this device"
    : "From search relays"
}

/**
 * Resolves the highlighted option by account, not by position. Relay results
 * merge into a list that is already on screen, so an index would silently
 * point at a different account after a reorder.
 */
export function resolveActiveSuggestionIndex(
  items: readonly SearchSuggestionItem[],
  activeId: string | null
): number {
  if (!activeId) return -1
  return items.findIndex((item) => item.id === activeId)
}

/** Caps a suggestion list after any surface-specific filtering. */
export function limitAccountMatches(
  matches: readonly ProfileSearchMatch[],
  limit: number = ACCOUNT_SUGGESTION_LIMIT
): ProfileSearchMatch[] {
  return matches.slice(0, limit)
}

export type AccountSuggestionTarget =
  | { to: "/store/$pubkey"; params: { pubkey: string } }
  | { to: "/u/$profileRef"; params: { profileRef: string } }

export function getAccountSuggestionLabel(match: ProfileSearchMatch): string {
  return getProfileName(match.profile) ?? formatNpub(match.pubkey, 6)
}

/**
 * Search results describe themselves with the npub, never with a claimed
 * NIP-05 identifier. A kind-0 event can claim any identifier, and these rows
 * are unverified suggestions; showing the claim here would read as a verified
 * handle. Verified NIP-05 is shown on the profile and storefront surfaces,
 * where the shared verifier has confirmed the identifier for that pubkey.
 */
export function getAccountSuggestionDescription(
  match: ProfileSearchMatch
): string {
  return formatNpub(match.pubkey, 6)
}

export function toAccountSuggestionItems(
  matches: readonly ProfileSearchMatch[]
): SearchSuggestionItem[] {
  return matches.map((match) => {
    const profile = sanitizeProfileMedia(match.profile) ?? match.profile
    return {
      id: match.pubkey,
      label: getAccountSuggestionLabel(match),
      description: getAccountSuggestionDescription(match),
      badge: match.isSeller ? "Seller" : undefined,
      imageUrl: profile.picture,
    }
  })
}

/**
 * Sellers open their storefront directly; other accounts open the public
 * profile view, which links to a storefront once listings are discovered.
 */
export function getAccountSuggestionTarget(
  match: ProfileSearchMatch
): AccountSuggestionTarget {
  const npub = pubkeyToNpub(match.pubkey)
  return match.isSeller
    ? { to: "/store/$pubkey", params: { pubkey: npub } }
    : { to: "/u/$profileRef", params: { profileRef: npub } }
}

/**
 * Device reads can fail while relays answer normally. A failed local read is
 * named so an empty or badge-less list is never read as a confirmed answer.
 */
export function describeAccountSearchDeviceEvidence(
  result: ProfileSearchResult | undefined
): string | null {
  const device = result?.device
  if (!device) return null
  if (device.profileCache === "unavailable") {
    return "Accounts saved on this device could not be read."
  }
  if (device.cachedFrontiers === "unavailable") {
    return "Relay results could not be checked against saved accounts."
  }
  if (device.sellerFlags === "unavailable") {
    return "Seller badges could not be checked on this device."
  }
  return null
}

/**
 * Truthful footer for the suggestion list. An empty list is described as the
 * bounded scope that was searched, never as proof that no account exists.
 */
export function describeAccountSearchEvidence(
  result: ProfileSearchResult | undefined
): string | null {
  const sentences = [
    describeAccountSearchDeviceEvidence(result),
    describeAccountSearchRelayEvidence(result),
  ].filter((sentence): sentence is string => !!sentence)
  return sentences.length > 0 ? sentences.join(" ") : null
}

function describeAccountSearchRelayEvidence(
  result: ProfileSearchResult | undefined
): string | null {
  if (!result) return null
  const hasMatches = result.matches.length > 0
  switch (result.evidence) {
    case "not_queried":
      return null
    case "present_current":
      return null
    case "absent_within_scope":
      return `No accounts matched on ${result.relaysCompleted} search ${
        result.relaysCompleted === 1 ? "relay" : "relays"
      }.`
    case "lookup_partial":
      return hasMatches
        ? "Search relay results are incomplete. More accounts may exist."
        : "Search relay results are incomplete. No matches yet."
    case "lookup_unavailable":
      return hasMatches
        ? "Search relays are unavailable. Showing accounts seen on this device."
        : "Search relays are unavailable right now."
  }
}
