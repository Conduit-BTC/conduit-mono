import { useEffect, useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { EVENT_KINDS, fetchEventsFanout, formatPubkey, parseProductEvent, useProfile, type Product } from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { ProductGridCard, ProductGridCardSkeleton } from "../../components/ProductGridCard"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import { getComparablePriceValue } from "../../lib/pricing"

const PAGE_SIZE = 12

type SortOption = "newest" | "price_asc" | "price_desc"

export interface ProductSearch {
  merchant?: string
  q?: string
  sort?: SortOption
  tag?: string
}

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
  validateSearch: (raw: Record<string, unknown>): ProductSearch => ({
    merchant: typeof raw.merchant === "string" ? raw.merchant : undefined,
    q: typeof raw.q === "string" ? raw.q : undefined,
    sort: (["newest", "price_asc", "price_desc"] as const).includes(
      raw.sort as SortOption
    )
      ? (raw.sort as SortOption)
      : undefined,
    tag: typeof raw.tag === "string" ? raw.tag : undefined,
  }),
})

async function fetchProducts(merchant?: string): Promise<Product[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.PRODUCT],
    limit: 50,
  }
  if (merchant) filter.authors = [merchant]

  const list = await fetchEventsFanout(filter, {
    connectTimeoutMs: 4_000,
    fetchTimeoutMs: 8_000,
  }) as NDKEvent[]
  return list
    .map((e) => {
      try {
        return parseProductEvent(e)
      } catch {
        return null
      }
    })
    .filter(Boolean) as Product[]
}

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

  if (search.tag) {
    const tag = search.tag.toLowerCase()
    result = result.filter((p) =>
      p.tags.some((t) => t.toLowerCase() === tag)
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
          (getComparablePriceValue(a, btcUsdRate) ?? (hasSingleCurrency ? a.price : 0)) -
          (getComparablePriceValue(b, btcUsdRate) ?? (hasSingleCurrency ? b.price : 0))
      )
    case "price_desc":
      if (!canSortByPrice) return [...products]
      return [...products].sort(
        (a, b) =>
          (getComparablePriceValue(b, btcUsdRate) ?? (hasSingleCurrency ? b.price : 0)) -
          (getComparablePriceValue(a, btcUsdRate) ?? (hasSingleCurrency ? a.price : 0))
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
  const navigate = useNavigate({ from: Route.fullPath })
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data?.rate ?? null

  const productsQuery = useQuery({
    queryKey: ["products", search.merchant ?? "all"],
    queryFn: () => fetchProducts(search.merchant),
  })

  // Derive all unique tags from the full (unfiltered) product set
  const allTags = useMemo(() => {
    if (!productsQuery.data) return []
    const tagSet = new Set<string>()
    for (const p of productsQuery.data) {
      for (const t of p.tags) tagSet.add(t.toLowerCase())
    }
    return Array.from(tagSet).sort()
  }, [productsQuery.data])

  const allMerchants = useMemo(() => {
    if (!productsQuery.data) return []
    const set = new Set<string>()
    for (const p of productsQuery.data) set.add(p.pubkey)
    return Array.from(set).sort()
  }, [productsQuery.data])

  const updateSearch = (updates: Partial<ProductSearch>) => {
    navigate({
      search: (prev: ProductSearch) => {
        const next = { ...prev, ...updates }
        for (const key of Object.keys(next) as (keyof ProductSearch)[]) {
          if (!next[key]) delete next[key]
        }
        return next
      },
      replace: true,
    })
  }

  const filteredProducts = useMemo(() => {
    if (!productsQuery.data) return []
    return filterProducts(productsQuery.data, search)
  }, [productsQuery.data, search])

  const hasSingleCurrency = useMemo(() => {
    const currencies = new Set(
      filteredProducts.map((product) => product.currency.trim().toUpperCase())
    )
    return currencies.size <= 1
  }, [filteredProducts])

  const canSortByPrice = useMemo(() => {
    if (filteredProducts.length <= 1) return true
    if (hasSingleCurrency) return true

    const comparableValues = filteredProducts.map((product) => getComparablePriceValue(product, btcUsdRate))
    return comparableValues.every((value) => value !== null)
  }, [btcUsdRate, filteredProducts, hasSingleCurrency])

  const effectiveSort = canSortByPrice ? search.sort : undefined

  const filtered = useMemo(
    () => sortProducts(filteredProducts, effectiveSort, canSortByPrice, hasSingleCurrency, btcUsdRate),
    [btcUsdRate, canSortByPrice, effectiveSort, filteredProducts, hasSingleCurrency]
  )

  const searchKey = `${search.q}-${search.tag}-${search.sort}-${search.merchant}`
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [searchKey])

  useEffect(() => {
    if (!canSortByPrice && (search.sort === "price_asc" || search.sort === "price_desc")) {
      updateSearch({ sort: undefined })
    }
  }, [canSortByPrice, search.sort])

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  const hasActiveFilters = !!(search.q || search.tag || search.sort || search.merchant)

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Category tags */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Categories
            </span>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => updateSearch({ tag: search.tag === tag ? undefined : tag })}
                className="rounded-full transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <Badge
                  variant={search.tag === tag ? "default" : "outline"}
                  className="cursor-pointer capitalize transition-colors hover:border-secondary-400 hover:text-[var(--text-primary)]"
                >
                  {tag}
                </Badge>
              </button>
            ))}
          </div>
        )}

        {/* Merchant filter */}
        {allMerchants.length > 1 && (
          <Select
            value={search.merchant ?? "__all"}
            onValueChange={(v) => updateSearch({ merchant: v === "__all" ? undefined : v })}
          >
            <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs">
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

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sort */}
        <Select
          value={effectiveSort ?? "newest"}
          onValueChange={(v) =>
            updateSearch({ sort: v === "newest" ? undefined : (v as SortOption) })
          }
        >
          <SelectTrigger className="h-8 w-auto min-w-[160px] text-xs">
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
            className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onClick={() => updateSearch({ q: undefined, tag: undefined, sort: undefined, merchant: undefined })}
          >
            Clear
          </Button>
        )}
      </div>

      {!canSortByPrice && filteredProducts.length > 1 && (
        <p className="text-xs text-[var(--text-muted)]">
          Price sorting is available when listings share a currency or when a BTC/USD display rate is configured.
        </p>
      )}

      {/* Active filter pills */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">
            {filtered.length} {filtered.length === 1 ? "result" : "results"}
          </span>
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
          {search.merchant && (
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

      {/* Loading */}
      {productsQuery.isLoading && (
        <ul className="grid list-none grid-cols-2 gap-3 p-0 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: PAGE_SIZE }).map((_, idx) => (
            <li key={idx} className="h-full">
              <ProductGridCardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {/* Error */}
      {productsQuery.error && (
        <div className="text-sm text-error">
          Failed to load products:{" "}
          {productsQuery.error instanceof Error ? productsQuery.error.message : "Unknown error"}
        </div>
      )}

      {/* Empty state - no products from relays */}
      {productsQuery.data && productsQuery.data.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No product listings found yet. Once merchants publish kind {EVENT_KINDS.PRODUCT} listings to
          your relays, they will show up here.
        </div>
      )}

      {/* Empty state - filters returned nothing */}
      {productsQuery.data && productsQuery.data.length > 0 && filtered.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No products match your filters. Try adjusting your search or{" "}
          <button
            className="underline hover:text-[var(--text-primary)]"
            onClick={() => updateSearch({ q: undefined, tag: undefined, sort: undefined, merchant: undefined })}
          >
            clear all filters
          </button>
          .
        </div>
      )}

      {/* Product grid */}
      {visible.length > 0 && (
        <ul className="grid list-none grid-cols-2 gap-3 p-0 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((p) => (
            <li key={p.id} className="h-full">
              <ProductGridCard
                product={p}
                btcUsdRate={btcUsdRate}
                cartQuantity={cart.items.find((item) => item.productId === p.id)?.quantity ?? 0}
                onAddToCart={() =>
                  cart.addItem(
                    {
                      productId: p.id,
                      merchantPubkey: p.pubkey,
                      title: p.title,
                      price: p.price,
                      currency: p.currency,
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
                    },
                    1
                  )
                }
                onDecrement={() => {
                  const existing = cart.items.find((item) => item.productId === p.id)
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
    </div>
  )
}
