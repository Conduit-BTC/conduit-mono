import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ChevronDown, LoaderCircle, X } from "lucide-react"
import { EVENT_KINDS, normalizePubkey, pubkeyToNpub } from "@conduit/core"
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
} from "@conduit/ui"
import { SignerSwitch } from "../../components/SignerSwitch"
import { MerchantAvatarFallback } from "../../components/MerchantIdentity"
import {
  ProductGridCard,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import { useShopperPricing } from "../../hooks/useShopperPricing"
import { useCart } from "../../hooks/useCart"
import { useMarketBrowseModel } from "../../hooks/useMarketBrowseModel"
import { normalizeFacetValues } from "../../lib/facets"
import { cartItemInputFromProduct, selectCartItem } from "../../lib/cart-model"
import {
  type MarketBrowseSearch,
  type MarketBrowseSortOption,
} from "../../lib/marketBrowseModel"
import type { ProductCatalogSourceMode } from "../../lib/productCatalogRead"

const PAGE_SIZE = 12
const COLLAPSED_TAG_CLOUD_HEIGHT = 76
const CATALOG_SOURCE_OPTIONS: ProductCatalogSourceMode[] = [
  "combined",
  "following",
  "conduit",
]
const CATALOG_SOURCE_LABELS: Record<ProductCatalogSourceMode, string> = {
  combined: "Following + Conduit",
  following: "Following",
  conduit: "Conduit",
}
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
      source: CATALOG_SOURCE_OPTIONS.includes(
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

function CatalogSourceControl({
  catalogSource,
  connected,
  onSelect,
}: {
  catalogSource: ProductCatalogSourceMode
  connected: boolean
  onSelect: (source: ProductCatalogSourceMode) => void
}) {
  return (
    <section className="flex min-h-10 flex-col gap-2 text-xs sm:flex-row sm:items-center">
      <div className="shrink-0 font-medium uppercase tracking-wider text-[var(--text-muted)]">
        Catalog
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface)] p-1">
          {CATALOG_SOURCE_OPTIONS.map((source) => {
            const selected = catalogSource === source
            return (
              <button
                key={source}
                type="button"
                disabled={!connected && source !== "conduit"}
                onClick={() => onSelect(source)}
                className={[
                  "h-7 rounded-full px-3 font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                  selected
                    ? "bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  !connected && source !== "conduit"
                    ? "pointer-events-none opacity-45"
                    : "",
                ].join(" ")}
              >
                {CATALOG_SOURCE_LABELS[source]}
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function ProductsPage() {
  const cart = useCart()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [connectOpen, setConnectOpen] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [tagCloudOverflows, setTagCloudOverflows] = useState(false)
  const [tagCloudMeasured, setTagCloudMeasured] = useState(false)
  const [tagCloudInteracted, setTagCloudInteracted] = useState(false)
  const [storeMenuOpen, setStoreMenuOpen] = useState(false)
  const hasAutoPromptedConnect = useRef(false)
  const tagCloudRef = useRef<HTMLDivElement | null>(null)
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
    catalogSource: search.source ?? "combined",
    search,
    storeMenuOpen,
    visibleCount,
  })
  const {
    auth,
    catalogSource,
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
  const connected = status === "connected"
  const shouldCollapseTagCloud =
    !showAllTags && (!tagCloudMeasured || tagCloudOverflows)

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

  useLayoutEffect(() => {
    const element = tagCloudRef.current
    if (!element) return

    const measure = () => {
      setTagCloudOverflows(
        element.scrollHeight > COLLAPSED_TAG_CLOUD_HEIGHT + 1
      )
      setTagCloudMeasured(true)
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

      <CatalogSourceControl
        catalogSource={catalogSource}
        connected={connected}
        onSelect={(source) =>
          updateSearch({
            source: source === "combined" ? undefined : source,
          })
        }
      />

      {shouldShowCategories && (
        <section className="space-y-3">
          <div className="flex min-h-8 items-center justify-between gap-3">
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Categories
            </div>
            <div className="flex h-8 shrink-0 items-center justify-end">
              {tagCloudOverflows && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-secondary-400 transition-colors duration-150 hover:bg-[var(--surface-elevated)] hover:text-secondary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  aria-expanded={showAllTags}
                  onClick={() => {
                    setTagCloudInteracted(true)
                    setShowAllTags((current) => !current)
                  }}
                >
                  {showAllTags ? "Collapse" : "Expand categories"}
                  <ChevronDown
                    className={[
                      "h-3.5 w-3.5 transition-transform duration-150",
                      showAllTags ? "rotate-180" : "",
                    ].join(" ")}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
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
                  shouldCollapseTagCloud ? "max-h-[4.75rem]" : "max-h-72",
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
                        className="gap-1.5 cursor-pointer transition-colors hover:border-secondary-400 hover:text-[var(--text-primary)]"
                      >
                        <span>{option.label}</span>
                        <span
                          className={[
                            "inline-block min-w-[3ch] self-center text-right text-[0.82em] font-medium leading-none tabular-nums transition-colors",
                            option.selected
                              ? "text-white/85"
                              : "text-[var(--text-muted)]",
                          ].join(" ")}
                        >
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
              {storeFacetOptions.map((option) => {
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
                label={`Remove ${getMerchantName(merchant)} store filter`}
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
        <ul className="grid auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
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
        !productsQuery.isHydrating &&
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
        <ul className="grid auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
          {productCards.map(({ product, merchant }, index) => {
            return (
              <li
                key={product.id}
                className={[
                  "h-full",
                  // Keep the first page fully rendered (LCP / above the fold).
                  // Let the browser skip layout + paint for the revealed tail
                  // while reserving row height so the scrollbar stays stable.
                  index >= PAGE_SIZE
                    ? "[content-visibility:auto] [contain-intrinsic-size:auto_360px]"
                    : "",
                ].join(" ")}
              >
                <ProductGridCard
                  product={product}
                  merchantName={merchant.displayName}
                  merchantNamePending={merchant.status === "pending"}
                  imageLoading={index < 4 ? "eager" : "lazy"}
                  btcUsdRate={btcUsdRate}
                  pricePreference={shopperPricing.preference}
                  cartQuantity={
                    selectCartItem(cart.items, {
                      merchantPubkey: product.pubkey,
                      productId: product.id,
                    })?.quantity ?? 0
                  }
                  onAddToCart={() =>
                    cart.addItem(cartItemInputFromProduct(product), 1)
                  }
                  onIncrement={() =>
                    cart.addItem(cartItemInputFromProduct(product), 1)
                  }
                  onDecrement={() => {
                    const identity = {
                      merchantPubkey: product.pubkey,
                      productId: product.id,
                    }
                    const existing = selectCartItem(cart.items, identity)
                    if (!existing) return
                    if (existing.quantity <= 1) {
                      cart.removeItem(identity)
                      return
                    }
                    cart.setQuantity(identity, existing.quantity - 1)
                  }}
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
