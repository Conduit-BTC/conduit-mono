import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Store } from "lucide-react"
import { useCallback } from "react"
import { formatNpub, pubkeyToNpub } from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage, Badge } from "@conduit/ui"
import {
  MARKET_SOURCE_OPTIONS,
  MarketBrowseNavigation,
} from "../components/MarketBrowseNavigation"
import { MerchantAvatarFallback } from "../components/MerchantIdentity"
import { useSellerDirectory } from "../hooks/useSellerDirectory"
import {
  describeAccountSearchEvidence,
  getAccountSuggestionLabel,
  getAccountSuggestionTarget,
} from "../lib/accountSearch"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"

export interface SellersSearch {
  source?: ProductCatalogSourceMode
  q?: string
}

export const Route = createFileRoute("/sellers")({
  validateSearch: (raw: Record<string, unknown>): SellersSearch => ({
    source: MARKET_SOURCE_OPTIONS.includes(
      raw.source as ProductCatalogSourceMode
    )
      ? (raw.source as ProductCatalogSourceMode)
      : undefined,
    q: typeof raw.q === "string" && raw.q.trim() ? raw.q : undefined,
  }),
  component: SellersPage,
})

function SellersPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const directory = useSellerDirectory({
    catalogSource: search.source ?? "combined",
    query: search.q ?? "",
  })
  const updateSearch = useCallback(
    (updates: Partial<SellersSearch>) => {
      navigate({
        search: (previous: SellersSearch) => {
          const next = { ...previous, ...updates }
          if (!next.source) delete next.source
          if (!next.q) delete next.q
          return next
        },
        replace: true,
      })
    },
    [navigate]
  )
  const evidence = describeAccountSearchEvidence(directory.accountSearch.data)
  const showNetworkSection = directory.query.length >= 2

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <MarketBrowseNavigation
        active="sellers"
        source={directory.effectiveSource}
        connected={directory.connected}
        onSelectSource={(source) =>
          updateSearch({ source: source === "combined" ? undefined : source })
        }
      />

      <header className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-secondary-400">
          <Store className="h-4 w-4" aria-hidden="true" />
          Sellers
        </div>
        <div>
          <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-4xl">
            Sellers
          </h1>
          <p className="mt-2 max-w-3xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Storefronts discovered from the same network perspective as the
            catalog. Use the search box to filter by name or to look up other
            accounts on search relays.
          </p>
        </div>
      </header>

      <section
        aria-labelledby="discovered-sellers-heading"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="discovered-sellers-heading"
            className="text-lg font-semibold text-[var(--text-primary)]"
          >
            {directory.query
              ? `Sellers matching "${directory.query}"`
              : "Discovered sellers"}
          </h2>
          <span className="text-sm text-[var(--text-muted)]">
            {directory.filteredSellers.length} of {directory.sellers.length}
            {directory.isFetching ? " · updating" : ""}
          </span>
        </div>
        {directory.filteredSellers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--text-muted)]">
            {directory.sellers.length === 0
              ? directory.isFetching
                ? "Loading listings from your perspective..."
                : "No sellers have been discovered from this perspective yet."
              : "No discovered seller name matches this search. Names still loading are not matched yet."}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {directory.filteredSellers.map((seller) => {
              const identity = directory.getIdentity(seller.pubkey)
              return (
                <li key={seller.pubkey}>
                  <Link
                    to="/store/$pubkey"
                    params={{ pubkey: pubkeyToNpub(seller.pubkey) }}
                    className="flex h-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <Avatar className="size-11 shrink-0">
                      {identity.picture ? (
                        <AvatarImage src={identity.picture} alt="" />
                      ) : null}
                      <AvatarFallback className="bg-transparent">
                        <MerchantAvatarFallback />
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={
                          identity.status === "resolved"
                            ? "truncate font-medium text-[var(--text-primary)]"
                            : "truncate font-medium text-[var(--text-muted)]"
                        }
                      >
                        {identity.displayName}
                      </span>
                      <span className="truncate text-xs text-[var(--text-muted)]">
                        {formatNpub(seller.pubkey, 6)}
                      </span>
                    </span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {seller.listingCount}{" "}
                      {seller.listingCount === 1 ? "listing" : "listings"}
                    </Badge>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {showNetworkSection ? (
        <section
          aria-labelledby="network-accounts-heading"
          className="space-y-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="network-accounts-heading"
              className="text-lg font-semibold text-[var(--text-primary)]"
            >
              Other accounts
            </h2>
            <span className="text-sm text-[var(--text-muted)]">
              {directory.accountSearch.isFetching
                ? "Searching relays..."
                : (evidence ?? "From search relays")}
            </span>
          </div>
          {directory.networkAccounts.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-6 text-sm text-[var(--text-muted)]">
              {directory.accountSearch.isFetching
                ? "Looking for accounts with this name..."
                : "No other accounts to show for this search."}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {directory.networkAccounts.map((match) => (
                <li key={match.pubkey}>
                  <Link
                    {...getAccountSuggestionTarget(match)}
                    className="flex h-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <Avatar className="size-11 shrink-0">
                      {match.profile.picture ? (
                        <AvatarImage src={match.profile.picture} alt="" />
                      ) : null}
                      <AvatarFallback className="bg-transparent">
                        <MerchantAvatarFallback />
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-[var(--text-primary)]">
                        {getAccountSuggestionLabel(match)}
                      </span>
                      <span className="truncate text-xs text-[var(--text-muted)]">
                        {match.profile.nip05?.replace(/^_@/, "") ??
                          formatNpub(match.pubkey, 6)}
                      </span>
                    </span>
                    {match.isSeller ? (
                      <Badge
                        variant="secondary"
                        className="shrink-0 text-[10px]"
                      >
                        Seller
                      </Badge>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}
