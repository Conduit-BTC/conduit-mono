import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronDown, X } from "lucide-react"
import { normalizePubkey, pubkeyToNpub } from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  getResultPresentation,
  RefreshChip,
} from "@conduit/ui"
import { SignerSwitch } from "../../components/SignerSwitch"
import { MerchantAvatarFallback } from "../../components/MerchantIdentity"
import {
  PRODUCT_GRID_CLASS_NAME,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import {
  MARKET_SOURCE_OPTIONS,
  MarketBrowseNavigation,
} from "../../components/MarketBrowseNavigation"
import { ResolvedProductGridCard } from "../../components/ResolvedProductGridCard"
import { SellerCard } from "../../components/SellerCard"
import { useShopperPricing } from "../../hooks/useShopperPricing"
import { useMarketBrowseModel } from "../../hooks/useMarketBrowseModel"
import { normalizeFacetValues } from "../../lib/facets"
import {
  type MarketBrowseSearch,
  type MarketBrowseSortOption,
} from "../../lib/marketBrowseModel"
import {
  DEFAULT_MARKET_CATALOG_SOURCE,
  type ProductCatalogSourceMode,
} from "../../lib/productCatalogRead"

const PAGE_SIZE = 12
/** Merchant matches shown inline; the rest stay one link away on /merchants. */
const MATCHING_MERCHANT_LIMIT = 6
const SORT_OPTIONS: Array<{
  value: MarketBrowseSortOption
  label: string
}> = [
  // Keep the existing URL value while naming the discovery policy honestly.
  { value: "newest", label: "Fresh & diverse" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
]

export type ProductSearch = MarketBrowseSearch

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
  validateSearch: (raw: Record<string, unknown>): ProductSearch => {
    const merchants = normalizeFacetValues(raw.merchant).map(
      (merchant) => normalizePubkey(merchant) ?? merchant
    )
    const tags = normalizeFacetValues(raw.tag).map((tag) => tag.toLowerCase())

    const authRequired =
      raw.authRequired === true ||
      raw.authRequired === "true" ||
      raw.authRequired === 1 ||
      raw.authRequired === "1"

    return {
      merchant: merchants.length > 0 ? merchants : undefined,
      q: typeof raw.q === "string" ? raw.q : undefined,
      sort: (["newest", "price_asc", "price_desc"] as const).includes(
        raw.sort as MarketBrowseSortOption
      )
        ? (raw.sort as MarketBrowseSortOption)
        : undefined,
      source: MARKET_SOURCE_OPTIONS.includes(
        raw.source as ProductCatalogSourceMode
      )
        ? (raw.source as ProductCatalogSourceMode)
        : undefined,
      tag: tags.length > 0 ? Array.from(new Set(tags)) : undefined,
      ...(authRequired ? { authRequired } : {}),
    }
  },
})

function FilterRemoveButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      aria-label={label}
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}

function ProductsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [connectOpen, setConnectOpen] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [merchantMenuOpen, setMerchantMenuOpen] = useState(false)
  const hasAutoPromptedConnect = useRef(false)
  const hasMoreRef = useRef(false)
  const loadMoreObserverRef = useRef<IntersectionObserver | null>(null)
  const shopperPricing = useShopperPricing()
  const btcUsdRate = shopperPricing.quote
  const updateSearch = useCallback(
    (updates: Partial<ProductSearch>) => {
      navigate({
        search: (prev: ProductSearch) => {
          const next = { ...prev, ...updates }
          for (const key of Object.keys(next) as (keyof ProductSearch)[]) {
            const value = next[key]
            if (
              value === undefined ||
              value === null ||
              value === "" ||
              (key === "authRequired" && value === false) ||
              (Array.isArray(value) && value.length === 0)
            ) {
              delete next[key]
            }
          }
          if (next.merchant) {
            next.merchant = next.merchant.map((merchant) =>
              pubkeyToNpub(merchant)
            )
          }
          return next
        },
        replace: true,
      })
    },
    [navigate]
  )

  const browseModel = useMarketBrowseModel({
    btcUsdRate,
    catalogSource: search.source ?? DEFAULT_MARKET_CATALOG_SOURCE,
    search,
    storeMenuOpen: merchantMenuOpen,
    visibleCount,
  })
  const {
    auth,
    catalogSource,
    categoryFacetOptions,
    categoryFacetTotal,
    filtered,
    hasActiveFilters,
    hasMore,
    hasUnavailablePriceForSort,
    isUpdatingListings,
    matchingSellers,
    productCards,
    productData,
    productsQuery,
    searchKey,
    selectedMerchants,
    selectedMerchantSet,
    selectedTags,
    selectedTagSet,
    shouldShowCategories,
    showCategorySkeleton,
    storeFacetOptions: merchantFacetOptions,
    storeFacetTotal: merchantFacetTotal,
    storeTriggerLabel: merchantTriggerLabel,
    getMerchantIdentity,
  } = browseModel
  const { status } = auth
  const connected = status === "connected"
  const resultPresentation = getResultPresentation({
    resultCount: productData.length,
    visibleResultCount: filtered.length,
    reliability:
      productsQuery.isRefreshStale || productsQuery.error
        ? "degraded"
        : "complete",
  })
  const visibleMatchingMerchants = useMemo(
    () => matchingSellers.slice(0, MATCHING_MERCHANT_LIMIT),
    [matchingSellers]
  )
  const categoryTriggerLabel =
    selectedTags.length === 0
      ? "All categories"
      : selectedTags.length === 1
        ? "1 category"
        : `${selectedTags.length} categories`

  const toggleTag = (tag: string) => {
    if (selectedTagSet.has(tag)) {
      updateSearch({
        tag: selectedTags.filter((selectedTag) => selectedTag !== tag),
      })
      return
    }

    updateSearch({ tag: [...selectedTags, tag] })
  }

  const toggleMerchant = (merchant: string) => {
    if (selectedMerchantSet.has(merchant)) {
      updateSearch({
        merchant: selectedMerchants.filter(
          (selectedMerchant) => selectedMerchant !== merchant
        ),
      })
      return
    }

    updateSearch({ merchant: [...selectedMerchants, merchant] })
  }

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [searchKey])

  useEffect(() => {
    hasMoreRef.current = hasMore
  }, [hasMore])

  const attachLoadMoreSentinel = useCallback((node: HTMLDivElement | null) => {
    loadMoreObserverRef.current?.disconnect()
    loadMoreObserverRef.current = null
    if (!node || typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver(
      (entries) => {
        // Reveal the next page ~one screen early so the N+1 batch is already
        // laid out by the time the user scrolls to it. Each reveal pushes the
        // sentinel back out of view, so it re-fires only on further scroll.
        if (entries[0]?.isIntersecting && hasMoreRef.current) {
          setVisibleCount((current) => current + PAGE_SIZE)
        }
      },
      { rootMargin: "600px 0px" }
    )
    observer.observe(node)
    loadMoreObserverRef.current = observer
  }, [])

  useEffect(() => {
    if (
      search.authRequired &&
      status !== "connected" &&
      !hasAutoPromptedConnect.current
    ) {
      setConnectOpen(true)
      hasAutoPromptedConnect.current = true
    }

    if (!search.authRequired) {
      hasAutoPromptedConnect.current = false
    }
  }, [search.authRequired, status])

  useEffect(() => {
    if (search.authRequired && status === "connected") {
      updateSearch({ authRequired: undefined })
      hasAutoPromptedConnect.current = false
    }
  }, [search.authRequired, status, updateSearch])

  const getMerchantName = useCallback(
    (merchantPubkey: string) => getMerchantIdentity(merchantPubkey).displayName,
    [getMerchantIdentity]
  )

  return (
    <div className="space-y-5">
      {search.authRequired && (
        <section className="rounded-2xl border border-secondary-500/30 bg-secondary-500/10 p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-secondary-300">
                Signer required
              </div>
              <h2 className="mt-2 text-lg font-semibold text-[var(--text-primary)] sm:text-xl">
                Connect a signer to continue.
              </h2>
              <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                Orders, zap out, and merchant follow-up require a connected
                Nostr signer.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {status === "connected" ? (
                <Button
                  className="h-11 px-4 text-sm"
                  onClick={() =>
                    updateSearch({
                      authRequired: undefined,
                    })
                  }
                >
                  Connected
                </Button>
              ) : (
                <Button
                  className="h-11 px-4 text-sm"
                  onClick={() => setConnectOpen(true)}
                >
                  Connect
                </Button>
              )}
              <Button
                variant="outline"
                className="h-11 px-4 text-sm"
                onClick={() => updateSearch({ authRequired: undefined })}
              >
                Dismiss
              </Button>
            </div>
          </div>
          <div className="mt-4 text-xs text-[var(--text-secondary)]">
            You were redirected here because the next step requires a signer.
          </div>
          <SignerSwitch
            open={connectOpen}
            onOpenChange={setConnectOpen}
            hideTrigger
          />
        </section>
      )}

      <MarketBrowseNavigation
        active="products"
        source={catalogSource}
        connected={connected}
        onSelectSource={(source) =>
          updateSearch({
            source:
              source === DEFAULT_MARKET_CATALOG_SOURCE ? undefined : source,
          })
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex w-full min-w-0 flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          {shouldShowCategories ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-20 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
                Categories
              </span>
              <DropdownMenu
                open={categoryMenuOpen}
                onOpenChange={setCategoryMenuOpen}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={showCategorySkeleton}
                    className="min-w-0 flex-1 justify-between text-xs sm:w-auto sm:min-w-[150px] sm:flex-none"
                  >
                    {showCategorySkeleton
                      ? "Loading categories..."
                      : categoryTriggerLabel}
                    <ChevronDown
                      className="size-4 opacity-60"
                      aria-hidden="true"
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-80 w-72 overflow-y-scroll [scrollbar-gutter:stable]">
                  <DropdownMenuCheckboxItem
                    checked={selectedTags.length === 0}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={() => updateSearch({ tag: undefined })}
                    className="justify-between gap-3"
                  >
                    <span className="font-semibold text-primary-500">
                      All categories
                    </span>
                    <span className="ml-auto text-xs font-medium tabular-nums text-[var(--text-muted)]">
                      [{categoryFacetTotal}]
                    </span>
                  </DropdownMenuCheckboxItem>
                  {categoryFacetOptions.map((option) => (
                    <DropdownMenuCheckboxItem
                      key={option.value}
                      checked={option.selected}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={() => toggleTag(option.value)}
                      className="justify-between gap-3"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                      </span>
                      <span className="ml-auto text-xs font-medium tabular-nums text-[var(--text-muted)]">
                        [{option.count}]
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-20 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
              Merchant
            </span>
            <DropdownMenu
              open={merchantMenuOpen}
              onOpenChange={setMerchantMenuOpen}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-w-0 flex-1 justify-between text-xs sm:w-auto sm:min-w-[150px] sm:flex-none"
                >
                  {merchantTriggerLabel}
                  <ChevronDown
                    className="size-4 opacity-60"
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 w-72 overflow-y-scroll [scrollbar-gutter:stable]">
                <DropdownMenuCheckboxItem
                  checked={selectedMerchants.length === 0}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => updateSearch({ merchant: undefined })}
                  className="justify-between gap-3"
                >
                  <span className="font-semibold text-primary-500">
                    All merchants
                  </span>
                  <span className="ml-auto text-xs font-medium tabular-nums text-[var(--text-muted)]">
                    [{merchantFacetTotal}]
                  </span>
                </DropdownMenuCheckboxItem>
                {merchantFacetOptions.map((option) => {
                  const identity = getMerchantIdentity(option.value)
                  return (
                    <DropdownMenuCheckboxItem
                      key={option.value}
                      checked={option.selected}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={() => toggleMerchant(option.value)}
                      className="gap-2.5"
                    >
                      <Avatar className="h-5 w-5 shrink-0">
                        <AvatarImage
                          src={identity.picture}
                          alt=""
                          className="object-cover"
                        />
                        <AvatarFallback>
                          <MerchantAvatarFallback iconClassName="h-2.5 w-2.5" />
                        </AvatarFallback>
                      </Avatar>
                      <span
                        className={[
                          "min-w-0 flex-1 truncate",
                          identity.status === "pending" ? "animate-pulse" : "",
                        ].join(" ")}
                      >
                        {option.label}
                      </span>
                      <span className="ml-auto text-xs font-medium tabular-nums text-[var(--text-muted)]">
                        [{option.count}]
                      </span>
                    </DropdownMenuCheckboxItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              onClick={() =>
                updateSearch({
                  q: undefined,
                  tag: undefined,
                  sort: undefined,
                  merchant: undefined,
                })
              }
            >
              Clear filters
            </Button>
          )}
        </div>

        <div className="flex w-full flex-col gap-2 sm:ml-auto sm:w-auto sm:flex-row sm:items-center">
          <span className="min-w-12 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
            Sort
          </span>
          <div
            className="inline-flex max-w-full overflow-x-auto rounded-full border border-[var(--border)] bg-[var(--surface)] p-1"
            role="group"
            aria-label="Sort products"
          >
            {SORT_OPTIONS.map((option) => {
              const selected = (search.sort ?? "newest") === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    updateSearch({
                      sort:
                        option.value === "newest" ? undefined : option.value,
                    })
                  }
                  className={[
                    "h-7 shrink-0 rounded-full px-3 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                    selected
                      ? "bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  ].join(" ")}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {hasUnavailablePriceForSort && (
        <p className="text-xs text-[var(--text-muted)]">
          Listings without a rate-backed sats price are shown last.
        </p>
      )}

      {search.q && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1.5">
            &ldquo;{search.q}&rdquo;
            <FilterRemoveButton
              label="Remove search filter"
              onClick={() => updateSearch({ q: undefined })}
            />
          </Badge>
        </div>
      )}

      {selectedMerchants.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {selectedMerchants.map((merchant) => (
            <Badge key={merchant} variant="secondary" className="gap-1.5">
              {getMerchantName(merchant)}
              <FilterRemoveButton
                label={`Remove ${getMerchantName(merchant)} merchant filter`}
                onClick={() => toggleMerchant(merchant)}
              />
            </Badge>
          ))}
        </div>
      )}

      {selectedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {selectedTags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1.5">
              {tag}
              <FilterRemoveButton
                label={`Remove ${tag} filter`}
                onClick={() => toggleTag(tag)}
              />
            </Badge>
          ))}
        </div>
      )}

      {visibleMatchingMerchants.length > 0 ? (
        <section
          aria-labelledby="matching-merchants-heading"
          className="space-y-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="matching-merchants-heading"
              className="text-base font-semibold text-[var(--text-primary)]"
            >
              Merchants matching &quot;{search.q}&quot;
            </h2>
            <Link
              to="/merchants"
              // Keep the browse perspective; the merchant directory reads the
              // same source and would otherwise change the merchant set.
              search={{ q: search.q, source: search.source }}
              className="text-sm text-secondary-400 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {matchingSellers.length > visibleMatchingMerchants.length
                ? `See all ${matchingSellers.length} merchants`
                : "See all merchants"}
            </Link>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleMatchingMerchants.map((seller) => (
              <li key={seller.pubkey}>
                <SellerCard
                  pubkey={seller.pubkey}
                  identity={getMerchantIdentity(seller.pubkey)}
                  listingCount={seller.listingCount}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="relative flex min-h-8 items-center pr-44 text-xs text-[var(--text-muted)]">
        <span>
          {filtered.length} {filtered.length === 1 ? "result" : "results"}
        </span>
        <RefreshChip
          refreshing={isUpdatingListings}
          onRefresh={productsQuery.refetch}
          stale={productsQuery.isRefreshStale}
          refreshingLabel="Updating listings..."
          className="absolute right-0 top-1/2 -translate-y-1/2"
        />
      </div>

      {/* Loading */}
      {productsQuery.isInitialLoading && (
        <ul className={PRODUCT_GRID_CLASS_NAME}>
          {Array.from({ length: PAGE_SIZE }).map((_, idx) => (
            <li key={idx}>
              <ProductGridCardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {!productsQuery.isInitialLoading &&
        !productsQuery.isHydrating &&
        resultPresentation.kind === "degraded_empty" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm text-[var(--text-primary)]">
            <span>Products couldn&apos;t be loaded. Retry to check again.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={productsQuery.isHydrating}
              onClick={() => void productsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        )}

      {!productsQuery.isInitialLoading &&
        !productsQuery.isHydrating &&
        resultPresentation.kind === "complete_empty" && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
            No product listings found yet.
          </div>
        )}

      {!productsQuery.isInitialLoading &&
        !productsQuery.isHydrating &&
        resultPresentation.kind === "filter_empty" && (
          <div
            className={
              resultPresentation.visibility === "compact"
                ? "rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm text-[var(--text-primary)]"
                : "rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]"
            }
            role={
              resultPresentation.visibility === "compact" ? "alert" : undefined
            }
          >
            <p>
              No loaded products match your filters.
              {resultPresentation.visibility === "compact"
                ? " Discovery is incomplete, so other matching products may still be available."
                : " Try adjusting your search."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  updateSearch({
                    q: undefined,
                    tag: undefined,
                    sort: undefined,
                    merchant: undefined,
                  })
                }
              >
                Clear all filters
              </Button>
              {resultPresentation.visibility === "compact" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isUpdatingListings}
                  onClick={() => void productsQuery.refetch()}
                >
                  Retry
                </Button>
              )}
            </div>
          </div>
        )}

      {/* Product grid */}
      {productCards.length > 0 && (
        <ul className={PRODUCT_GRID_CLASS_NAME}>
          {productCards.map(({ product, family, merchant }, index) => {
            return (
              <li key={product.id} className="h-full">
                <ResolvedProductGridCard
                  product={product}
                  family={family}
                  familyHydrating={productsQuery.isHydrating}
                  merchantName={merchant.displayName}
                  merchantNamePending={merchant.status === "pending"}
                  imageLoading={index < 4 ? "eager" : "lazy"}
                  btcUsdRate={btcUsdRate}
                  pricePreference={shopperPricing.preference}
                />
              </li>
            )
          })}
        </ul>
      )}

      {/* Auto-reveal the next page as the sentinel nears the viewport; the
          button stays as an accessible / no-IntersectionObserver fallback. */}
      {hasMore && (
        <>
          <div
            ref={attachLoadMoreSentinel}
            aria-hidden="true"
            className="h-px w-full"
          />
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              Show more
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
