import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  EVENT_KINDS,
  formatPubkey,
  getFollowPubkeys,
  getProfiles,
  useAuth,
  useProfile,
  type Product,
} from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  MARKETPLACE_NETWORK_LIMIT,
  useProgressiveProducts,
} from "../../hooks/useProgressiveProducts"
import {
  DEFAULT_MARKET_PERSPECTIVE_NPUB,
  DEFAULT_MARKET_PERSPECTIVE_PUBKEY,
  getDefaultMarketPerspectiveFollowPubkeys,
  storeDefaultMarketPerspectiveFollowPubkeys,
} from "../../lib/defaultMarketPerspective"
import { getComparablePriceValue } from "../../lib/pricing"

const PAGE_SIZE = 12

type SortOption = "newest" | "price_asc" | "price_desc"

export interface ProductSearch {
  merchant?: string
  q?: string
  sort?: SortOption
  tag?: string[]
  authRequired?: boolean
}

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
  validateSearch: (raw: Record<string, unknown>): ProductSearch => {
    const rawTag = raw.tag
    const tags = Array.isArray(rawTag)
      ? rawTag.filter(
          (value): value is string =>
            typeof value === "string" && value.trim() !== ""
        )
      : typeof rawTag === "string" && rawTag.trim() !== ""
        ? rawTag
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined

    return {
      merchant: typeof raw.merchant === "string" ? raw.merchant : undefined,
      q: typeof raw.q === "string" ? raw.q : undefined,
      sort: (["newest", "price_asc", "price_desc"] as const).includes(
        raw.sort as SortOption
      )
        ? (raw.sort as SortOption)
        : undefined,
      tag: tags && tags.length > 0 ? Array.from(new Set(tags)) : undefined,
      authRequired:
        raw.authRequired === true ||
        raw.authRequired === "true" ||
        raw.authRequired === 1 ||
        raw.authRequired === "1",
    }
  },
})

function filterProducts(products: Product[], search: ProductSearch): Product[] {
  let result = products

  if (search.q) {
    const q = search.q.toLowerCase()
    result = result.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.summary && p.summary.toLowerCase().includes(q))
    )
  }

  if (search.tag && search.tag.length > 0) {
    const tagSet = new Set(search.tag.map((tag) => tag.toLowerCase()))
    result = result.filter((p) =>
      p.tags.some((t) => tagSet.has(t.toLowerCase()))
    )
  }

  return result
}

function sortProducts(
  products: Product[],
  sort: SortOption | undefined,
  canSortByPrice: boolean,
  hasSingleCurrency: boolean,
  btcUsdRate: number | null
): Product[] {
  switch (sort) {
    case "price_asc":
      if (!canSortByPrice) return [...products]
      return [...products].sort(
        (a, b) =>
          (getComparablePriceValue(a, btcUsdRate) ??
            (hasSingleCurrency ? a.price : 0)) -
          (getComparablePriceValue(b, btcUsdRate) ??
            (hasSingleCurrency ? b.price : 0))
      )
    case "price_desc":
      if (!canSortByPrice) return [...products]
      return [...products].sort(
        (a, b) =>
          (getComparablePriceValue(b, btcUsdRate) ??
            (hasSingleCurrency ? b.price : 0)) -
          (getComparablePriceValue(a, btcUsdRate) ??
            (hasSingleCurrency ? a.price : 0))
      )
    case "newest":
    default:
      return [...products].sort((a, b) => b.createdAt - a.createdAt)
  }
}

/** Resolves a merchant pubkey to a display name */
function MerchantName({ pubkey }: { pubkey: string }) {
  const { data: profile } = useProfile(pubkey)
  return <>{profile?.displayName || profile?.name || formatPubkey(pubkey, 6)}</>
}

function ProductsPage() {
  const cart = useCart()
  const search = Route.useSearch()
  const { pubkey, status } = useAuth()
  const navigate = useNavigate({ from: Route.fullPath })
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [connectOpen, setConnectOpen] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [tagCloudOverflows, setTagCloudOverflows] = useState(false)
  const [pendingMerchant, setPendingMerchant] = useState<string | null>(null)
  const [merchantTagConflicts, setMerchantTagConflicts] = useState<string[]>([])
  const [anonymousFollowPubkeys, setAnonymousFollowPubkeys] = useState(
    getDefaultMarketPerspectiveFollowPubkeys
  )
  const hasAutoPromptedConnect = useRef(false)
  const tagCloudRef = useRef<HTMLDivElement | null>(null)
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data?.rate ?? null
  const usesAnonymousPerspective = !search.merchant && status !== "connected"

  // Anonymous Market should paint from the bundled Conduit follow seed
  // immediately, then refresh that kind-3 list in the background for future visits.
  const defaultPerspectiveRefreshQuery = useQuery({
    queryKey: ["default-market-perspective-follow-refresh"],
    queryFn: () =>
      getFollowPubkeys({ pubkey: DEFAULT_MARKET_PERSPECTIVE_PUBKEY }),
    enabled: usesAnonymousPerspective,
    staleTime: 6 * 60 * 60_000,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    const pubkeys = defaultPerspectiveRefreshQuery.data?.data
    if (!pubkeys || pubkeys.length === 0) return
    storeDefaultMarketPerspectiveFollowPubkeys(pubkeys)
    setAnonymousFollowPubkeys(pubkeys)
  }, [defaultPerspectiveRefreshQuery.data?.data])

  const productsQuery = useProgressiveProducts({
    scope: "marketplace",
    merchantPubkey: search.merchant,
    perspectivePubkey: search.merchant
      ? null
      : status === "connected" && pubkey
        ? pubkey
        : DEFAULT_MARKET_PERSPECTIVE_NPUB,
    seedAuthorPubkeys: usesAnonymousPerspective
      ? anonymousFollowPubkeys
      : undefined,
    textQuery: search.q,
    tags: search.tag,
    sort: search.sort,
    limit: search.merchant ? MARKETPLACE_NETWORK_LIMIT : undefined,
  })
  const productData = productsQuery.products

  // Derive all unique tags from the full (unfiltered) product set
  const allTags = useMemo(() => {
    if (productData.length === 0) return []
    const tagSet = new Set<string>()
    for (const p of productData) {
      for (const t of p.tags) tagSet.add(t.toLowerCase())
    }
    return Array.from(tagSet).sort()
  }, [productData])

  const allMerchants = useMemo(() => {
    if (productData.length === 0) return []
    const set = new Set<string>()
    for (const p of productData) set.add(p.pubkey)
    return Array.from(set).sort()
  }, [productData])

  const merchantTagMap = useMemo(() => {
    const byMerchant = new Map<string, Set<string>>()
    for (const product of productData) {
      const current = byMerchant.get(product.pubkey) ?? new Set<string>()
      for (const tag of product.tags) current.add(tag.toLowerCase())
      byMerchant.set(product.pubkey, current)
    }
    return byMerchant
  }, [productData])

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

  const selectedTags = search.tag ?? []
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags])

  const toggleTag = (tag: string) => {
    if (selectedTagSet.has(tag)) {
      updateSearch({
        tag: selectedTags.filter((selectedTag) => selectedTag !== tag),
      })
      return
    }

    updateSearch({ tag: [...selectedTags, tag] })
  }

  const applyMerchantSelection = (merchant: string | undefined) => {
    updateSearch({ merchant, tag: selectedTags })
  }

  const handleMerchantSelection = (merchant: string | undefined) => {
    if (!merchant) {
      applyMerchantSelection(undefined)
      return
    }

    if (selectedTags.length === 0) {
      applyMerchantSelection(merchant)
      return
    }

    const supportedTags = merchantTagMap.get(merchant) ?? new Set<string>()
    const incompatibleTags = selectedTags.filter(
      (tag) => !supportedTags.has(tag)
    )

    if (incompatibleTags.length === 0) {
      applyMerchantSelection(merchant)
      return
    }

    setPendingMerchant(merchant)
    setMerchantTagConflicts(incompatibleTags)
  }

  const confirmMerchantSelection = () => {
    if (!pendingMerchant) return
    const conflictSet = new Set(merchantTagConflicts)
    updateSearch({
      merchant: pendingMerchant,
      tag: selectedTags.filter((tag) => !conflictSet.has(tag)),
    })
    setPendingMerchant(null)
    setMerchantTagConflicts([])
  }

  const filteredProducts = useMemo(() => {
    return filterProducts(productData, search)
  }, [productData, search])

  const hasSingleCurrency = useMemo(() => {
    const currencies = new Set(
      filteredProducts.map((product) => product.currency.trim().toUpperCase())
    )
    return currencies.size <= 1
  }, [filteredProducts])

  const canSortByPrice = useMemo(() => {
    if (filteredProducts.length <= 1) return true
    if (hasSingleCurrency) return true

    const comparableValues = filteredProducts.map((product) =>
      getComparablePriceValue(product, btcUsdRate)
    )
    return comparableValues.every((value) => value !== null)
  }, [btcUsdRate, filteredProducts, hasSingleCurrency])

  const effectiveSort = canSortByPrice ? search.sort : undefined

  const filtered = useMemo(
    () =>
      sortProducts(
        filteredProducts,
        effectiveSort,
        canSortByPrice,
        hasSingleCurrency,
        btcUsdRate
      ),
    [
      btcUsdRate,
      canSortByPrice,
      effectiveSort,
      filteredProducts,
      hasSingleCurrency,
    ]
  )

  const searchKey = `${search.q}-${selectedTags.slice().sort().join(",")}-${search.sort}-${search.merchant}`
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [searchKey])

  useEffect(() => {
    if (
      !canSortByPrice &&
      (search.sort === "price_asc" || search.sort === "price_desc")
    ) {
      updateSearch({ sort: undefined })
    }
  }, [canSortByPrice, search.sort, updateSearch])

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

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length
  const visibleMerchantPubkeys = useMemo(
    () => Array.from(new Set(visible.map((product) => product.pubkey))),
    [visible]
  )
  const visibleMerchantProfilesQuery = useQuery({
    queryKey: ["visible-product-card-profiles", visibleMerchantPubkeys],
    enabled: visibleMerchantPubkeys.length > 0,
    queryFn: async () => {
      const result = await getProfiles({ pubkeys: visibleMerchantPubkeys })
      return result.data
    },
    staleTime: 5 * 60_000,
  })

  const hasActiveFilters = !!(
    search.q ||
    selectedTags.length > 0 ||
    search.sort ||
    search.merchant
  )
  const orderedTags = useMemo(() => {
    if (selectedTags.length === 0) {
      return allTags
    }

    const selectedFirst = selectedTags.filter((tag) => allTags.includes(tag))
    return [
      ...selectedFirst,
      ...allTags.filter((tag) => !selectedTagSet.has(tag)),
    ]
  }, [allTags, selectedTagSet, selectedTags])

  useEffect(() => {
    const element = tagCloudRef.current
    if (!element) return

    const measure = () => {
      setTagCloudOverflows(element.scrollHeight > 76)
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
  }, [orderedTags, selectedTagSet, showAllTags])

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

      {allTags.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Categories
            </div>
            {tagCloudOverflows && (
              <button
                type="button"
                className={[
                  "text-xs font-medium text-secondary-400 transition-[opacity,color] duration-200 hover:text-secondary-300",
                  showAllTags ? "opacity-100" : "pointer-events-none opacity-0",
                ].join(" ")}
                onClick={() => setShowAllTags((current) => !current)}
              >
                Collapse
              </button>
            )}
          </div>

          <div className="relative">
            <div
              ref={tagCloudRef}
              className={[
                "overflow-hidden transition-[max-height] duration-300 ease-out",
                showAllTags || !tagCloudOverflows
                  ? "max-h-64"
                  : "max-h-[4.75rem]",
              ].join(" ")}
            >
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {orderedTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className="rounded-full transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <Badge
                      variant={selectedTagSet.has(tag) ? "default" : "outline"}
                      className="cursor-pointer capitalize transition-colors hover:border-secondary-400 hover:text-[var(--text-primary)]"
                    >
                      {tag}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>

            {!showAllTags && tagCloudOverflows && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-center justify-center bg-gradient-to-b from-transparent via-[var(--background)]/90 to-[var(--background)] transition-opacity duration-200">
                <button
                  type="button"
                  className="pointer-events-auto rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-1 text-xs font-medium text-[var(--text-primary)] shadow-[var(--shadow-sm)] transition-[opacity,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]"
                  onClick={() => setShowAllTags(true)}
                >
                  Expand categories
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <span className="min-w-12 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
            Store
          </span>
          {search.merchant ? (
            <Badge variant="secondary" className="h-8 max-w-full gap-1.5 px-3">
              <MerchantName pubkey={search.merchant} />
              <button
                onClick={() => updateSearch({ merchant: undefined })}
                className="ml-0.5 transition-colors hover:text-[var(--text-primary)]"
                aria-label="Remove store filter"
              >
                &times;
              </button>
            </Badge>
          ) : (
            <Select
              value="__all"
              onValueChange={(v) =>
                handleMerchantSelection(v === "__all" ? undefined : v)
              }
            >
              <SelectTrigger className="h-8 min-w-0 flex-1 text-xs sm:w-auto sm:min-w-[140px] sm:flex-none">
                <SelectValue placeholder="All stores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All stores</SelectItem>
                {allMerchants.map((pk) => (
                  <SelectItem key={pk} value={pk}>
                    <MerchantName pubkey={pk} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <span className="min-w-12 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)] sm:min-w-0">
            Sort
          </span>
          <Select
            value={effectiveSort ?? "newest"}
            onValueChange={(v) =>
              updateSearch({
                sort: v === "newest" ? undefined : (v as SortOption),
              })
            }
          >
            <SelectTrigger className="h-8 min-w-0 flex-1 text-xs sm:w-auto sm:min-w-[160px] sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="price_asc" disabled={!canSortByPrice}>
                Price: Low to High
              </SelectItem>
              <SelectItem value="price_desc" disabled={!canSortByPrice}>
                Price: High to Low
              </SelectItem>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              onClick={() =>
                updateSearch({
                  q: undefined,
                  tag: undefined,
                  sort: undefined,
                  merchant: undefined,
                })
              }
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {!canSortByPrice && filteredProducts.length > 1 && (
        <p className="text-xs text-[var(--text-muted)]">
          Price sorting is available when listings share a currency or when a
          BTC/USD display rate is configured.
        </p>
      )}

      {(search.q ||
        (search.merchant && !allMerchants.includes(search.merchant))) && (
        <div className="flex flex-wrap items-center gap-2">
          {search.q && (
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
          )}
          {search.tag && (
            <Badge variant="secondary" className="gap-1 capitalize">
              {search.tag}
              <button
                onClick={() => updateSearch({ tag: undefined })}
                className="ml-0.5 transition-colors hover:text-[var(--text-primary)]"
                aria-label="Remove tag filter"
              >
                &times;
              </button>
            </Badge>
          )}
          {search.merchant && !allMerchants.includes(search.merchant) && (
            <Badge variant="secondary" className="gap-1">
              <MerchantName pubkey={search.merchant} />
              <button
                onClick={() => updateSearch({ merchant: undefined })}
                className="ml-0.5 transition-colors hover:text-[var(--text-primary)]"
                aria-label="Remove store filter"
              >
                &times;
              </button>
            </Badge>
          )}
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

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
        <span>
          {filtered.length} {filtered.length === 1 ? "result" : "results"}
        </span>
        <span aria-hidden="true">/</span>
        <span>
          {productsQuery.isShowingCache
            ? "showing cached listings"
            : productsQuery.hydrationStage === "resolving_follows"
              ? status === "connected"
                ? "reading your follow graph"
                : "reading Conduit follow graph"
              : productsQuery.hydrationStage === "first_degree"
                ? "hydrated from follow feed"
                : productsQuery.meta?.source === "public"
                  ? "verified from relays"
                  : productsQuery.meta?.source === "commerce"
                    ? "verified from commerce relays"
                    : "preparing relay view"}
        </span>
        {productsQuery.firstDegreeAuthorCount > 0 && (
          <>
            <span aria-hidden="true">/</span>
            <span>{productsQuery.firstDegreeAuthorCount} followed authors</span>
          </>
        )}
        {productsQuery.isHydrating && (
          <>
            <span aria-hidden="true">/</span>
            <span className="text-secondary-300">hydrating cards</span>
          </>
        )}
        {productsQuery.meta?.stale && (
          <>
            <span aria-hidden="true">/</span>
            <span>stale-aware</span>
          </>
        )}
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
      {visible.length > 0 && (
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {visible.map((p) => (
            <li key={p.id} className="h-full">
              <ProductGridCard
                product={p}
                merchantName={
                  visibleMerchantProfilesQuery.data?.[p.pubkey]?.displayName ||
                  visibleMerchantProfilesQuery.data?.[p.pubkey]?.name ||
                  formatPubkey(p.pubkey, 6)
                }
                btcUsdRate={btcUsdRate}
                cartQuantity={
                  cart.items.find((item) => item.productId === p.id)
                    ?.quantity ?? 0
                }
                onAddToCart={() =>
                  cart.addItem(
                    {
                      productId: p.id,
                      merchantPubkey: p.pubkey,
                      title: p.title,
                      price: p.price,
                      currency: p.currency,
                      image: p.images[0]?.url,
                      tags: p.tags,
                    },
                    1
                  )
                }
                onIncrement={() =>
                  cart.addItem(
                    {
                      productId: p.id,
                      merchantPubkey: p.pubkey,
                      title: p.title,
                      price: p.price,
                      currency: p.currency,
                      image: p.images[0]?.url,
                      tags: p.tags,
                    },
                    1
                  )
                }
                onDecrement={() => {
                  const existing = cart.items.find(
                    (item) => item.productId === p.id
                  )
                  if (!existing) return
                  if (existing.quantity <= 1) {
                    cart.removeItem(p.id)
                    return
                  }
                  cart.setQuantity(p.id, existing.quantity - 1)
                }}
              />
            </li>
          ))}
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

      <Dialog
        open={pendingMerchant !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingMerchant(null)
            setMerchantTagConflicts([])
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update store filter?</DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              The selected store does not include some of your current category
              filters. Those filters will be removed if you continue.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            {merchantTagConflicts.map((tag) => (
              <Badge key={tag} variant="secondary" className="capitalize">
                {tag}
              </Badge>
            ))}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingMerchant(null)
                setMerchantTagConflicts([])
              }}
            >
              Cancel
            </Button>
            <Button onClick={confirmMerchantSelection}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
