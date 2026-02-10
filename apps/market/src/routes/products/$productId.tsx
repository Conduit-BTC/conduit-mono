import { createFileRoute, Link } from "@tanstack/react-router"
import { EVENT_KINDS, getNdk, parseProductEvent, type Product } from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@conduit/ui"
import { useCart } from "../../hooks/useCart"

export const Route = createFileRoute("/products/$productId")({
  component: ProductPage,
})

function parseAddress(productId: string): { kind: number; pubkey: string; d: string } | null {
  // expected: 30402:<pubkey>:<d>
  const decoded = decodeURIComponent(productId)
  const [kindStr, pubkey, d] = decoded.split(":")
  const kind = Number(kindStr)
  if (!Number.isFinite(kind) || !pubkey || !d) return null
  return { kind, pubkey, d }
}

async function fetchProduct(productId: string): Promise<Product | null> {
  const addr = parseAddress(productId)
  const ndk = getNdk()

  if (addr && addr.kind === EVENT_KINDS.PRODUCT) {
    const filter: any = {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [addr.pubkey],
      "#d": [addr.d],
      limit: 1,
    }
    const ev = await (ndk as any).fetchEvent(filter)
    if (!ev) return null
    return parseProductEvent(ev)
  }

  // Fallback: treat as event id if caller passed a raw id.
  const filter: any = { ids: [decodeURIComponent(productId)] }
  const ev = await (ndk as any).fetchEvent(filter)
  if (!ev) return null
  return parseProductEvent(ev)
}

function ProductPage() {
  const cart = useCart()
  const { productId } = Route.useParams()

  const productQuery = useQuery({
    queryKey: ["product", productId],
    queryFn: () => fetchProduct(productId),
  })

  const p = productQuery.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Button asChild variant="muted">
          <Link to="/products">Back to products</Link>
        </Button>
        <Button asChild variant="muted">
          <Link to="/cart">Cart ({cart.totals.count})</Link>
        </Button>
      </div>

      {productQuery.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">Loading...</div>
      )}
      {productQuery.error && (
        <div className="text-sm text-error">
          Failed to load product:{" "}
          {productQuery.error instanceof Error ? productQuery.error.message : "Unknown error"}
        </div>
      )}
      {productQuery.data === null && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Product not found.
        </div>
      )}

      {p && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-medium text-[var(--text-primary)]">{p.title}</h1>
              {p.summary && (
                <p className="mt-2 text-sm text-[var(--text-secondary)]">{p.summary}</p>
              )}
              <div className="mt-3 text-sm text-[var(--text-secondary)]">
                Merchant: <span className="font-mono">{p.pubkey}</span>
              </div>
            </div>

            <div className="shrink-0 text-right">
              <div className="text-xl font-medium text-[var(--text-primary)]">
                {p.price} {p.currency}
              </div>
              <Button
                className="mt-3"
                onClick={() =>
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
              >
                Add to cart
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

