import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ChevronDown, LoaderCircle } from "lucide-react"
import { EVENT_KINDS } from "@conduit/core"
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { SignerSwitch } from "../../components/SignerSwitch"
import {
  ProductGridCard,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import { useMarketBrowseModel } from "../../hooks/useMarketBrowseModel"
import { normalizeFacetValues } from "../../lib/facets"
import {
  type MarketBrowseSearch,
  type MarketBrowseSortOption,
} from "../../lib/marketBrowseModel"

const PAGE_SIZE = 12

export type ProductSearch = MarketBrowseSearch

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
  validateSearch: (raw: Record<string, unknown>): ProductSearch => {
    const merchants = normalizeFacetValues(raw.merchant)
    const tags = normalizeFacetValues(raw.tag).map((tag) => tag.toLowerCase())

    return {
      merchant: merchants.length > 0 ? merchants : undefined,
      q: typeof raw.q === "string" ? raw.q : undefined,
      sort: (["newest", "price_asc", "price_desc"] as const).includes(
        raw.sort as MarketBrowseSortOption
      )
        ? (raw.sort as MarketBrowseSortOption)
        : undefined,
      tag: tags.length > 0 ? Array.from(new Set(tags)) : undefined,
      authRequired:
        raw.authRequired === true ||
        raw.authRequired === "true" ||
        raw.authRequired === 1 ||
        raw.authRequired === "1",
    }
  },
})

function ProductsPage() {
  const cart = useCart()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [connectOpen, setConnectOpen] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [tagCloudOverflows, setTagCloudOverflows] = useState(false)
  const [tagCloudInteracted, setTagCloudInteracted] = useState(false)
  const [storeMenuOpen, setStoreMenuOpen] = useState(false)
  const hasAutoPromptedConnect = useRef(false)
  const tagCloudRef = useRef<HTMLDivElement | null>(null)
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data ?? null
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
              (Array.isArray(value) && value.length === 0)
            ) {
              delete next[key]
            }
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
    search,
    storeMenuOpen,
    visibleCount,
  })
  const {
    auth,
    categoryFacetOptions,
    filtered,
    hasActiveFilters,
    hasMore,
    hasUnavailablePriceForSort,
    isUpdatingListings,
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
    storeFacetOptions,
    storeFacetTotal,
    storeTriggerLabel,
    getMerchantIdentity,
  } = browseModel
  const { status } = auth

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

  useLayoutEffect(() => {
    const element = tagCloudRef.current
    if (!element) return

    const measure = () => {
      setTagCloudOverflows(element.scrollHeight > element.clientHeight + 1)
    }

    measure()

    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    resizeObserver?.observe(element)
    window.addEventListener("resize", measure)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [categoryFacetOptions, showAllTags])

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
                Checkout, orders, and merchant follow-up require a connected
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

      {shouldShowCategories && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Categories
            </div>
            {tagCloudOverflows && (
              <button
                type="button"
                className="text-xs font-medium text-secondary-400 transition-colors duration-150 hover:text-secondary-300"
                onClick={() => {
                  setTagCloudInteracted(true)
                  setShowAllTags((current) => !current)
                }}
              >
                {showAllTags ? "Collapse" : "Expand categories"}
              </button>
            )}
          </div>

          {showCategorySkeleton ? (
            <div className="flex max-h-[4.75rem] flex-wrap items-center gap-1.5 overflow-hidden pt-0.5">
              {Array.from({ length: 18 }).map((_, index) => (
                <div
                  key={index}
                  className="h-7 animate-pulse rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]"
                  style={{
                    width: `${56 + (index % 5) * 18}px`,
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="relative">
              <div
                ref={tagCloudRef}
                className={[
                  "overflow-y-scroll pr-1 [scrollbar-gutter:stable]",
                  tagCloudInteracted
                    ? "transition-[max-height] duration-150 ease-out"
                    : "",
                  showAllTags || !tagCloudOverflows
                    ? "max-h-72"
                    : "max-h-[4.75rem]",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {categoryFacetOptions.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => toggleTag(option.value)}
                      aria-pressed={option.selected}
                      className="rounded-full transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      <Badge
                        variant={option.selected ? "default" : "outline"}
                        className="gap-1.5 cursor-pointer capitalize transition-colors hover:border-secondary-400 hover:text-[var(--text-primary)]"
                      >
                        <span>{option.label}</span>
                        <span className="self-center text-[0.82em] font-medium leading-none tabular-nums text-[var(--text-muted)]">
                          [{option.count}]
                        </span>
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <span className="min-w-12 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
            Store
          </span>
          <DropdownMenu open={storeMenuOpen} onOpenChange={setStoreMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="min-w-0 flex-1 justify-between text-xs sm:w-auto sm:min-w-[150px] sm:flex-none"
              >
                {storeTriggerLabel}
                <ChevronDown className="size-4 opacity-60" />
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
                  All stores
                </span>
                <span className="ml-auto text-xs font-medium tabular-nums text-[var(--text-muted)]">
                  [{storeFacetTotal}]
                </span>
              </DropdownMenuCheckboxItem>
              {storeFacetOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={option.selected}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleMerchant(option.value)}
                  className="gap-3"
                >
                  <span
                    className={[
                      "min-w-0 flex-1 truncate",
                      getMerchantIdentity(option.value).status === "pending"
                        ? "animate-pulse"
                        : "",
                    ].join(" ")}
                  >
                    {option.label}
                  </span>
                  <span className="ml-auto text-xs font-medium tabular-nums text-[var(--text-muted)]">
                    [{option.count}]
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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

        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <span className="min-w-12 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
            Sort
          </span>
          <Select
            value={search.sort ?? "newest"}
            onValueChange={(v) =>
              updateSearch({
                sort:
                  v === "newest" ? undefined : (v as MarketBrowseSortOption),
              })
            }
          >
            <SelectTrigger className="h-8 min-w-0 flex-1 text-xs sm:w-auto sm:min-w-[160px] sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="price_asc">Price: Low to High</SelectItem>
              <SelectItem value="price_desc">Price: High to Low</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {hasUnavailablePriceForSort && (
        <p className="text-xs text-[var(--text-muted)]">
          Listings without a rate-backed sats price are shown last.
        </p>
      )}

      {search.q && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="gap-1">
            &ldquo;{search.q}&rdquo;
            <button
              onClick={() => updateSearch({ q: undefined })}
              className="ml-0.5 transition-colors hover:text-[var(--text-primary)]"
              aria-label="Remove search filter"
            >
              &times;
            </button>
          </Badge>
        </div>
      )}

      {selectedMerchants.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {selectedMerchants.map((merchant) => (
            <Badge key={merchant} variant="secondary" className="gap-1">
              {getMerchantName(merchant)}
              <button
                onClick={() => toggleMerchant(merchant)}
                className="ml-0.5 transition-colors hover:text-[var(--text-primary)]"
                aria-label={`Remove ${getMerchantName(merchant)} store filter`}
              >
                &times;
              </button>
            </Badge>
          ))}
        </div>
      )}

      {selectedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {selectedTags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 capitalize">
              {tag}
              <button
                onClick={() => toggleTag(tag)}
                className="ml-0.5 transition-colors hover:text-[var(--text-primary)]"
                aria-label={`Remove ${tag} filter`}
              >
                &times;
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="relative flex min-h-[1.625rem] items-center pr-36 text-xs text-[var(--text-muted)]">
        <span>
          {filtered.length} {filtered.length === 1 ? "result" : "results"}
        </span>
        <span
          aria-hidden={!isUpdatingListings}
          className={[
            "absolute right-0 top-0 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-2.5 py-1 text-[var(--text-secondary)] transition-opacity duration-150",
            isUpdatingListings
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          ].join(" ")}
        >
          <LoaderCircle className="size-3 animate-spin text-secondary-300" />
          Updating listings
        </span>
      </div>

      {/* Loading */}
      {productsQuery.isInitialLoading && (
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {Array.from({ length: PAGE_SIZE }).map((_, idx) => (
            <li key={idx} className="h-full">
              <ProductGridCardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {/* Error */}
      {!!productsQuery.error && (
        <div className="text-sm text-error">
          Failed to load products:{" "}
          {productsQuery.error instanceof Error
            ? productsQuery.error.message
            : "Unknown error"}
        </div>
      )}

      {/* Empty state - no products from relays */}
      {!productsQuery.isInitialLoading &&
        !productsQuery.isHydrating &&
        productData.length === 0 && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
            No product listings found yet. Once merchants publish kind{" "}
            {EVENT_KINDS.PRODUCT} listings to your relays, they will show up
            here.
          </div>
        )}

      {/* Empty state - filters returned nothing */}
      {!productsQuery.isInitialLoading &&
        productData.length > 0 &&
        filtered.length === 0 && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
            No products match your filters. Try adjusting your search or{" "}
            <button
              className="underline hover:text-[var(--text-primary)]"
              onClick={() =>
                updateSearch({
                  q: undefined,
                  tag: undefined,
                  sort: undefined,
                  merchant: undefined,
                })
              }
            >
              clear all filters
            </button>
            .
          </div>
        )}

      {/* Product grid */}
      {productCards.length > 0 && (
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {productCards.map(({ product, merchant }, index) => {
            return (
              <li key={product.id} className="h-full">
                <ProductGridCard
                  product={product}
                  merchantName={merchant.displayName}
                  merchantNamePending={merchant.status === "pending"}
                  imageLoading={index < 4 ? "eager" : "lazy"}
                  btcUsdRate={btcUsdRate}
                  cartQuantity={
                    cart.items.find((item) => item.productId === product.id)
                      ?.quantity ?? 0
                  }
                  onAddToCart={() =>
                    cart.addItem(
                      {
                        productId: product.id,
                        merchantPubkey: product.pubkey,
                        title: product.title,
                        price: product.price,
                        currency: product.currency,
                        priceSats: product.priceSats,
                        sourcePrice: product.sourcePrice,
                        image: product.images[0]?.url,
                        tags: product.tags,
                      },
                      1
                    )
                  }
                  onIncrement={() =>
                    cart.addItem(
                      {
                        productId: product.id,
                        merchantPubkey: product.pubkey,
                        title: product.title,
                        price: product.price,
                        currency: product.currency,
                        priceSats: product.priceSats,
                        sourcePrice: product.sourcePrice,
                        image: product.images[0]?.url,
                        tags: product.tags,
                      },
                      1
                    )
                  }
                  onDecrement={() => {
                    const existing = cart.items.find(
                      (item) => item.productId === product.id
                    )
                    if (!existing) return
                    if (existing.quantity <= 1) {
                      cart.removeItem(product.id)
                      return
                    }
                    cart.setQuantity(product.id, existing.quantity - 1)
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}

      {/* Show more */}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          >
            Show more
          </Button>
        </div>
      )}
    </div>
  )
}
