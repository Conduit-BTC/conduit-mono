import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Search, Store } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { PROFILE_SEARCH_MIN_QUERY_LENGTH } from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage, Badge, Input } from "@conduit/ui"
import {
  MARKET_SOURCE_OPTIONS,
  MarketBrowseNavigation,
} from "../components/MarketBrowseNavigation"
import { MerchantAvatarFallback } from "../components/MerchantIdentity"
import { SellerCard } from "../components/SellerCard"
import { useSellerDirectory } from "../hooks/useSellerDirectory"
import {
  describeAccountSearchSource,
  getAccountSuggestionDescription,
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
  const [queryValue, setQueryValue] = useState(search.q ?? "")
  const queryInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // Mirror the URL into the field only while the user is not typing, so a
    // debounced navigate cannot echo a stale value back over keystrokes.
    if (queryInputRef.current === document.activeElement) return
    setQueryValue(search.q ?? "")
  }, [search.q])

  useEffect(() => {
    const trimmed = queryValue.trim()
    if (trimmed === (search.q ?? "")) return
    const timeoutId = window.setTimeout(() => {
      updateSearch({ q: trimmed || undefined })
    }, 260)
    return () => window.clearTimeout(timeoutId)
  }, [queryValue, search.q, updateSearch])

  const showNetworkSection =
    directory.query.trim().length >= PROFILE_SEARCH_MIN_QUERY_LENGTH

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
            catalog. Filter them by name here, or look up other accounts on
            search relays.
          </p>
        </div>
        <div className="relative max-w-md">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            ref={queryInputRef}
            value={queryValue}
            onChange={(event) => setQueryValue(event.target.value)}
            placeholder="Filter sellers by name"
            aria-label="Filter sellers"
            autoComplete="off"
            className="h-11 bg-[var(--surface-elevated)] pl-9"
          />
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
            {directory.filteredSellers.map((seller) => (
              <li key={seller.pubkey}>
                <SellerCard
                  pubkey={seller.pubkey}
                  identity={directory.getIdentity(seller.pubkey)}
                  listingCount={seller.listingCount}
                />
              </li>
            ))}
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
              {describeAccountSearchSource(
                directory.accountSearch.data,
                directory.accountSearch.isFetching
              )}
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
                        {getAccountSuggestionDescription(match)}
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
