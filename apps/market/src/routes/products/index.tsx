import { createFileRoute, Link } from "@tanstack/react-router"
import { EVENT_KINDS, getNdk, parseProductEvent, type Product } from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@conduit/ui"

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
})

async function fetchProducts(merchant?: string): Promise<Product[]> {
  const ndk = getNdk()
  const filter: any = {
    kinds: [EVENT_KINDS.PRODUCT],
    limit: 50,
  }
  if (merchant) filter.authors = [merchant]

  const events = await (ndk as any).fetchEvents(filter)
  const list = Array.from(events ?? []) as any[]
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
  const search = Route.useSearch() as any
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
        <div className="text-sm text-[var(--text-secondary)]">Loading...</div>
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
        <div className="grid gap-3 md:grid-cols-2">
          {productsQuery.data.map((p) => (
            <Link
              key={p.id}
              to="/products/$productId"
              params={{ productId: encodeURIComponent(p.id) }}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:bg-[var(--surface-elevated)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-medium text-[var(--text-primary)]">{p.title}</div>
                  {p.summary && (
                    <div className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">
                      {p.summary}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-sm text-[var(--text-secondary)]">
                  {p.price} {p.currency}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
