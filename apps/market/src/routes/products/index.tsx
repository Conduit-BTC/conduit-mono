import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronDown, X } from "lucide-react"
import { normalizePubkey, pubkeyToNpub } from "@conduit/core"
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  getResultPresentation,
  RefreshChip,
  MultiSelectCombobox,
  Input,
  Checkbox,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@conduit/ui"
import { SignerSwitch } from "../../components/SignerSwitch"
import { DeferredMerchantAvatar } from "../../components/DeferredMerchantAvatar"
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
  MERCHANT_PAGE_SIZE,
  MERCHANT_SEARCH_PREVIEW_SIZE,
} from "../../lib/clientHydration"
import {
  type MarketBrowseSearch,
  type MarketBrowseSortOption,
} from "../../lib/marketBrowseModel"
import {
  DEFAULT_MARKET_CATALOG_SOURCE,
  type ProductCatalogSourceMode,
} from "../../lib/productCatalogRead"

const SORT_OPTIONS: Array<{
  value: MarketBrowseSortOption
  label: string
}> = [
  // Keep the existing URL value while naming the discovery policy honestly.
  { value: "newest", label: "Recently updated" },
  { value: "relevance", label: "Relevance" },
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
    const query = typeof raw.q === "string" ? raw.q : undefined
    const scoped = !!query?.trim() || tags.length > 0 || merchants.length > 0

    const authRequired =
      raw.authRequired === true ||
      raw.authRequired === "true" ||
      raw.authRequired === 1 ||
      raw.authRequired === "1"

    return {
      view:
        !scoped && (raw.view === "recent" || raw.view === "all")
          ? raw.view
          : undefined,
      older:
        !scoped && (raw.older === true || raw.older === "true")
          ? true
          : undefined,
      merchant: merchants.length > 0 ? merchants : undefined,
      q: query,
      sort:
        scoped &&
        (raw.sort !== "relevance" || !!query?.trim()) &&
        (["newest", "relevance", "price_asc", "price_desc"] as const).includes(
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
  const [visibleCount, setVisibleCount] = useState(24)
  const [connectOpen, setConnectOpen] = useState(false)
  const [categoryQuery, setCategoryQuery] = useState("")
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [merchantMenuOpen, setMerchantMenuOpen] = useState(false)
  const [merchantQuery, setMerchantQuery] = useState("")
  const [visibleMerchantCount, setVisibleMerchantCount] =
    useState(MERCHANT_PAGE_SIZE)
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
          // Explicit catalog scopes must leave the home feed and its recency policy.
          if (next.q?.trim() || next.tag?.length || next.merchant?.length) {
            delete next.view
            delete next.older
          }
          if (!next.q?.trim() && !next.tag?.length && !next.merchant?.length)
            delete next.sort
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
    merchantQuery,
    visibleMerchantCount,
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
    hasMoreStoreFacets,
    merchantSearchStatus,
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
  const searchStatusMessage = browseModel.isShowingCachedSearch
    ? "Showing cached text matches while live search is unavailable or loading."
    : productsQuery.error
      ? productData.length
        ? "Search is unavailable. Showing previous matches for this search."
        : "Search is unavailable. Retry to check again."
      : browseModel.searchTagScopeVerified === false
        ? "Category search may miss matching products. Try removing category filters."
        : "Search results may be incomplete. Retry to check again."
  const visibleMatchingMerchants = useMemo(
    () => matchingSellers.slice(0, MERCHANT_SEARCH_PREVIEW_SIZE),
    [matchingSellers]
  )
  const categoryTriggerLabel =
    selectedTags.length === 0
      ? "All categories"
      : selectedTags.length === 1
        ? "1 category"
        : `${selectedTags.length} categories`

  const loadMoreMerchants = useCallback(() => {
    setVisibleMerchantCount(visibleMerchantCount + MERCHANT_PAGE_SIZE)
  }, [visibleMerchantCount])

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
    setVisibleCount(24)
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
          setVisibleCount((current) => current + 24)
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
    <div className="space-y-5 [overflow-anchor:none]">
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

      <section aria-labelledby="category-browse-heading" className="space-y-3">
        <h1
          id="category-browse-heading"
          className="text-xl font-semibold text-balance"
        >
          Shop by category
        </h1>
        <div className="flex flex-wrap gap-2">
          {categoryFacetOptions.slice(0, 8).map((option) => (
            <Button
              key={option.value}
              variant={option.selected ? "primary" : "outline"}
              size="sm"
              aria-pressed={option.selected}
              onClick={() => toggleTag(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <form
          className="flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const tag = categoryQuery.trim().toLowerCase()
            if (tag) {
              updateSearch({ tag: [tag] })
              setCategoryQuery("")
            }
          }}
        >
          <Input
            aria-label="Browse any category"
            placeholder="Enter a category"
            value={categoryQuery}
            onChange={(event) => setCategoryQuery(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!categoryQuery.trim()}
          >
            Browse
          </Button>
        </form>
        <p className="text-xs text-pretty text-[var(--text-muted)]">
          Choose a suggested category or enter another above. Merchant counts
          show products already seen.
        </p>
      </section>

      {!browseModel.scoped && (
        <div className="space-y-3">
          <Tabs
            value={search.view ?? "discover"}
            onValueChange={(value) =>
              updateSearch({
                view:
                  value === "discover"
                    ? undefined
                    : (value as "recent" | "all"),
                older: undefined,
                sort: undefined,
              })
            }
          >
            <TabsList className="flex h-auto flex-wrap justify-start">
              <TabsTrigger value="discover">Discover</TabsTrigger>
              <TabsTrigger value="recent">Recently updated</TabsTrigger>
              <TabsTrigger value="all">Explore all products</TabsTrigger>
            </TabsList>
          </Tabs>
          <p
            role="status"
            className="text-sm text-pretty text-[var(--text-secondary)]"
          >
            {browseModel.browseMode === "discover"
              ? "A selection across merchants. More products load as you browse."
              : browseModel.browseMode === "recent"
                ? search.older
                  ? "Listing publications and revisions, including older listings."
                  : "Listing publications and revisions from the last 30 days."
                : "Browse across the eligible catalog, including older listings."}
          </p>
          {browseModel.browseMode === "recent" && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={!!search.older}
                onCheckedChange={(checked) =>
                  updateSearch({ older: checked === true ? true : undefined })
                }
              />
              Include older listings
            </label>
          )}
        </div>
      )}

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
                    {categoryFacetTotal ? "Known" : ""}
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
                      {option.count ? `${option.count} cached` : ""}
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
          <MultiSelectCombobox
            open={merchantMenuOpen}
            onOpenChange={(open) => {
              setMerchantMenuOpen(open)
              if (!open) {
                setMerchantQuery("")
                setVisibleMerchantCount(MERCHANT_PAGE_SIZE)
              }
            }}
            label={merchantTriggerLabel}
            allLabel="All merchants"
            searchLabel="Search merchants"
            search={merchantQuery}
            onSearchChange={(query) => {
              setMerchantQuery(query)
              setVisibleMerchantCount(MERCHANT_PAGE_SIZE)
            }}
            selectedValues={selectedMerchants}
            onToggle={toggleMerchant}
            onClear={() => updateSearch({ merchant: undefined })}
            options={merchantFacetOptions.map((option) => ({
              value: option.value,
              label: option.label,
              detail: option.count
                ? `${option.count} cached ${option.count === 1 ? "product" : "products"}`
                : "Browse catalog",
              icon: (
                <DeferredMerchantAvatar
                  picture={getMerchantIdentity(option.value).picture}
                  className="size-5 shrink-0"
                  imageClassName="object-cover"
                  iconClassName="size-2.5"
                />
              ),
            }))}
            hasMore={hasMoreStoreFacets}
            onLoadMore={loadMoreMerchants}
            status={merchantSearchStatus}
          />
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

      {search.q?.trim() ? (
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
              Search the merchant directory
            </Link>
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            Merchant name results may be incomplete while profiles are loading.
          </p>
          {visibleMatchingMerchants.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleMatchingMerchants.map((seller) => (
                <li key={seller.pubkey}>
                  <SellerCard
                    pubkey={seller.pubkey}
                    identity={getMerchantIdentity(seller.pubkey)}
                    listingCount={seller.listingCount || undefined}
                    countIsCached
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
        <div className="flex items-center gap-1">
          <RefreshChip
            iconOnly
            refreshing={isUpdatingListings}
            onRefresh={productsQuery.refetch}
            stale={productsQuery.isRefreshStale}
            refreshingLabel="Updating listings..."
          />
        </div>
        {browseModel.isShowingCachedSearch && <span>Cached matches</span>}
        {browseModel.scoped ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1 px-1 text-sm">
                <span className="text-[var(--text-muted)]">Sort:</span>
                <span>
                  {
                    SORT_OPTIONS.find(
                      (option) =>
                        option.value ===
                        (search.sort ??
                          (browseModel.isSearching ? "relevance" : "newest"))
                    )?.label
                  }
                </span>
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-64 max-w-[calc(100vw-2rem)]"
            >
              {SORT_OPTIONS.filter(
                (option) =>
                  option.value !== "relevance" || browseModel.isSearching
              ).map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={
                    (search.sort ??
                      (browseModel.isSearching ? "relevance" : "newest")) ===
                    option.value
                  }
                  onSelect={() =>
                    updateSearch({
                      sort:
                        option.value ===
                        (browseModel.isSearching ? "relevance" : "newest")
                          ? undefined
                          : option.value,
                    })
                  }
                  className="min-h-10 border-b border-[var(--border)] last:border-b-0"
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {browseModel.isSearching && !browseModel.isRemoteSearchEligible && (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          Enter at least two characters for live search.
        </p>
      )}

      {browseModel.isSearching &&
        !productsQuery.isInitialLoading &&
        productsQuery.isRefreshStale &&
        (productData.length > 0 || productsQuery.isHydrating) && (
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            {searchStatusMessage}
          </p>
        )}

      {!browseModel.isSearching &&
        productsQuery.isRefreshStale &&
        !productsQuery.isInitialLoading && (
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            Browsing coverage is partial. More listings may be available across
            merchants and relays.
          </p>
        )}
      {browseModel.boundaryBlocked && (
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          Many listings share the same update time. Narrow the category or
          merchant to continue browsing.
        </p>
      )}

      {/* Loading */}
      {productsQuery.isInitialLoading && (
        <ul className={PRODUCT_GRID_CLASS_NAME}>
          {Array.from({ length: 24 }).map((_, idx) => (
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
            <span>
              {browseModel.isSearching
                ? searchStatusMessage
                : "Products couldn't be loaded. Retry to check again."}
            </span>
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
            {browseModel.isSearching
              ? browseModel.isRemoteSearchEligible
                ? "No matching products found in this Market view."
                : "No cached products match this search."
              : "No product listings found yet."}
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
              onClick={() => setVisibleCount((c) => c + 24)}
            >
              Show more
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
