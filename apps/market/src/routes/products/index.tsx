import { createFileRoute, Link } from "@tanstack/react-router"
import { EVENT_KINDS, getNdk, parseProductEvent, type Product } from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@conduit/ui"
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { ProductGridCard, ProductGridCardSkeleton } from "../../components/ProductGridCard"
import { useCart } from "../../hooks/useCart"

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
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

function ProductsPage() {
  const cart = useCart()
  const search = Route.useSearch() as { merchant?: unknown }
  const merchant = typeof search?.merchant === "string" ? search.merchant : undefined
  const productsQuery = useQuery({
    queryKey: ["products", merchant ?? "all"],
    queryFn: () => fetchProducts(merchant),
  })

  return (
    <div className="space-y-4">
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

      {productsQuery.isLoading && (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, idx) => (
            <li key={idx}>
              <ProductGridCardSkeleton />
            </li>
          ))}
        </ul>
      )}
      {productsQuery.error && (
        <div className="text-sm text-error">
          Failed to load products:{" "}
          {productsQuery.error instanceof Error ? productsQuery.error.message : "Unknown error"}
        </div>
      )}

      {productsQuery.data && productsQuery.data.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No product listings found yet. Once merchants publish kind {EVENT_KINDS.PRODUCT} listings to
          your relays, they will show up here.
        </div>
      )}

      {productsQuery.data && productsQuery.data.length > 0 && (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {productsQuery.data.map((p) => (
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
