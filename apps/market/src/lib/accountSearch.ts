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

export type AccountSuggestionTarget =
  | { to: "/store/$pubkey"; params: { pubkey: string } }
  | { to: "/u/$profileRef"; params: { profileRef: string } }

export function getAccountSuggestionLabel(match: ProfileSearchMatch): string {
  return getProfileName(match.profile) ?? formatNpub(match.pubkey, 6)
}

export function toAccountSuggestionItems(
  matches: readonly ProfileSearchMatch[]
): SearchSuggestionItem[] {
  return matches.map((match) => {
    const profile = sanitizeProfileMedia(match.profile) ?? match.profile
    const label = getAccountSuggestionLabel(match)
    const nip05 = profile.nip05?.trim()
    return {
      id: match.pubkey,
      label,
      description:
        nip05 && nip05 !== label
          ? nip05.replace(/^_@/, "")
          : formatNpub(match.pubkey, 6),
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
 * Truthful footer for the suggestion list. An empty list is described as the
 * bounded scope that was searched, never as proof that no account exists.
 */
export function describeAccountSearchEvidence(
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
