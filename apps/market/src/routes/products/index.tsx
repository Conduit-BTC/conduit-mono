import { useMemo } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { EVENT_KINDS, getNdk, parseProductEvent, type Product } from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Input } from "@conduit/ui"
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { ProductGridCard, ProductGridCardSkeleton } from "../../components/ProductGridCard"
import { useCart } from "../../hooks/useCart"

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
  const ndk = getNdk()
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.PRODUCT],
    limit: 50,
  }
  if (merchant) filter.authors = [merchant]

  const events = await ndk.fetchEvents(filter)
  const list = Array.from(events) as NDKEvent[]
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

function filterAndSort(
  products: Product[],
  search: ProductSearch
): Product[] {
  let result = products

  // Text search on title + summary
  if (search.q) {
    const q = search.q.toLowerCase()
    result = result.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.summary && p.summary.toLowerCase().includes(q))
    )
  }

  // Tag filter
  if (search.tag) {
    const tag = search.tag.toLowerCase()
    result = result.filter((p) =>
      p.tags.some((t) => t.toLowerCase() === tag)
    )
  }

  // Sort
  switch (search.sort) {
    case "price_asc":
      result = [...result].sort((a, b) => a.price - b.price)
      break
    case "price_desc":
      result = [...result].sort((a, b) => b.price - a.price)
      break
    case "newest":
    default:
      result = [...result].sort((a, b) => b.createdAt - a.createdAt)
      break
  }

  return result
}

function ProductsPage() {
  const cart = useCart()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

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

  // Apply client-side filtering + sorting
  const filtered = useMemo(() => {
    if (!productsQuery.data) return []
    return filterAndSort(productsQuery.data, search)
  }, [productsQuery.data, search])

  const updateSearch = (updates: Partial<ProductSearch>) => {
    navigate({
      search: (prev: ProductSearch) => {
        const next = { ...prev, ...updates }
        // Remove undefined/empty keys so URL stays clean
        for (const key of Object.keys(next) as (keyof ProductSearch)[]) {
          if (!next[key]) delete next[key]
        }
        return next
      },
      replace: true,
    })
  }

  const hasActiveFilters = !!(search.q || search.tag || search.sort)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Products</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Pulling kind {EVENT_KINDS.PRODUCT} listings from connected relays.
          </p>
        </div>
        <Button asChild variant="muted">
          <Link to="/cart">View cart</Link>
        </Button>
      </div>

      {/* Search + Sort bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <Input
            placeholder="Search products..."
            value={search.q ?? ""}
            onChange={(e) => updateSearch({ q: e.target.value || undefined })}
            className="pl-9"
          />
        </div>

        <select
          value={search.sort ?? "newest"}
          onChange={(e) =>
            updateSearch({
              sort: e.target.value === "newest" ? undefined : (e.target.value as SortOption),
            })
          }
          className="h-10 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
        >
          <option value="newest">Newest</option>
          <option value="price_asc">Price: Low to High</option>
          <option value="price_desc">Price: High to Low</option>
        </select>

        {hasActiveFilters && (
          <Button
            variant="muted"
            size="sm"
            onClick={() => updateSearch({ q: undefined, tag: undefined, sort: undefined })}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Tag chips */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => updateSearch({ tag: search.tag === tag ? undefined : tag })}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded-full"
            >
              <Badge variant={search.tag === tag ? "default" : "outline"}>
                {tag}
              </Badge>
            </button>
          ))}
        </div>
      )}

      {/* Results count when filtered */}
      {productsQuery.data && hasActiveFilters && (
        <p className="text-sm text-[var(--text-secondary)]">
          {filtered.length} {filtered.length === 1 ? "result" : "results"}
          {search.q && <> for &ldquo;{search.q}&rdquo;</>}
          {search.tag && <> in <Badge variant="secondary" className="mx-1">{search.tag}</Badge></>}
        </p>
      )}

      {/* Loading */}
      {productsQuery.isLoading && (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, idx) => (
            <li key={idx}>
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
            onClick={() => updateSearch({ q: undefined, tag: undefined, sort: undefined })}
          >
            clear all filters
          </button>
          .
        </div>
      )}

      {/* Product grid */}
      {filtered.length > 0 && (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((p) => (
            <li key={p.id}>
              <ProductGridCard
                product={p}
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
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
