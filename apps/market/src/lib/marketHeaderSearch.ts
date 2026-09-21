import type { ProfileSearchMatch, ProfileSearchResult } from "@conduit/core"
import type { SearchSuggestionGroup, SearchSuggestionItem } from "@conduit/ui"

import {
  describeAccountSearchEvidence,
  getAccountSuggestionTarget,
  toAccountSuggestionItems,
  type AccountSuggestionTarget,
} from "./accountSearch"
import type { FacetOption } from "./facets"
import type { SellerEligibilityState } from "./sellerDirectory"

export type MarketHeaderSuggestionTarget =
  | { kind: "category"; tag: string }
  | { kind: "account"; target: AccountSuggestionTarget }

export interface MarketHeaderSuggestionModel {
  groups: SearchSuggestionGroup[]
  items: SearchSuggestionItem[]
  targetById: ReadonlyMap<string, MarketHeaderSuggestionTarget>
}

export function buildMarketHeaderSuggestionModel(input: {
  listboxId: string
  categories: readonly FacetOption[]
  accounts: readonly ProfileSearchMatch[]
}): MarketHeaderSuggestionModel {
  const targetById = new Map<string, MarketHeaderSuggestionTarget>()
  const categoryItems = input.categories.map((category) => {
    const id = `category:${category.value}`
    targetById.set(id, { kind: "category", tag: category.value })
    return {
      id,
      label: category.label,
      description: "Browse category",
      fallback: "#",
    }
  })
  const merchantMatches = input.accounts.filter((match) => match.isSeller)
  const accountMatches = input.accounts.filter((match) => !match.isSeller)
  const merchantItems = toAccountSuggestionItems(merchantMatches).map(
    (item) => ({
      ...item,
      badge: undefined,
    })
  )
  const accountItems = toAccountSuggestionItems(accountMatches)

  for (const match of input.accounts) {
    targetById.set(match.pubkey, {
      kind: "account",
      target: getAccountSuggestionTarget(match),
    })
  }

  const groups = [
    {
      id: `${input.listboxId}-categories`,
      heading: "Categories",
      items: categoryItems,
    },
    {
      id: `${input.listboxId}-merchants`,
      heading: "Merchants",
      items: merchantItems,
    },
    {
      id: `${input.listboxId}-accounts`,
      heading: "Accounts",
      items: accountItems,
    },
  ].filter((group) => group.items.length > 0)

  return {
    groups,
    items: groups.flatMap((group) => group.items),
    targetById,
  }
}

export function getCategoryBrowseSearch(
  previous: Record<string, unknown>,
  tag: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous, tag: [tag] }
  delete next.q
  delete next.authRequired
  return next
}

function describeCatalogEvidence(
  eligibilityState: SellerEligibilityState,
  catalogIncomplete: boolean
): string | null {
  switch (eligibilityState) {
    case "loading":
      return "Checking the active Market catalog. Some categories, merchants, or accounts may be missing until it finishes."
    case "partial":
      return "Market discovery is incomplete. Some categories, merchants, or accounts may be missing."
    case "unavailable":
      return "Market discovery is unavailable right now. Saved categories, merchants, or accounts may still appear."
    case "ready":
      return catalogIncomplete
        ? "The active Market catalog is incomplete. Some categories or merchants may be missing."
        : null
  }
}

export function describeMarketHeaderSearchEvidence(
  result: ProfileSearchResult | undefined,
  eligibilityState: SellerEligibilityState,
  catalogIncomplete: boolean
): string | null {
  const sentences = [
    describeCatalogEvidence(eligibilityState, catalogIncomplete),
    describeAccountSearchEvidence(result),
  ].filter((sentence): sentence is string => !!sentence)
  return sentences.length > 0 ? sentences.join(" ") : null
}

export function describeMarketHeaderSearchEmptyState(input: {
  eligibilityState: SellerEligibilityState
  catalogUnavailable: boolean
  loading: boolean
}): string | null {
  if (input.loading) {
    return "Searching categories, merchants, and accounts..."
  }
  if (input.eligibilityState === "partial") {
    return "Results may be incomplete. No matches yet."
  }
  if (input.eligibilityState === "unavailable" || input.catalogUnavailable) {
    return "Categories, merchants, and accounts could not be fully loaded."
  }
  return null
}
