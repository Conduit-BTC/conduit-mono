import { createFileRoute, Link } from "@tanstack/react-router"
import { EVENT_KINDS, getNdk, parseProductEvent, type Product } from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@conduit/ui"
import { useCart } from "../../hooks/useCart"
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"

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
  const decodedId = decodeURIComponent(productId)

  if (addr && addr.kind === EVENT_KINDS.PRODUCT) {
    const filter: NDKFilter = {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [addr.pubkey],
      "#d": [addr.d],
      limit: 1,
    }
    const ev = (await ndk.fetchEvent(filter)) as NDKEvent | null
    if (ev) return parseProductEvent(ev)

    // Some relays don't index #d lookups consistently.
    // Fallback to author's recent products and match locally by d-tag/address id.
    const byAuthor = Array.from(
      (await ndk.fetchEvents({
        kinds: [EVENT_KINDS.PRODUCT],
        authors: [addr.pubkey],
        limit: 100,
      })) as Set<NDKEvent>
    ) as NDKEvent[]

    const matched = byAuthor.find((event) => {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1]
      if (!dTag) return false
      const addressId = `30402:${event.pubkey}:${dTag}`
      return addressId === decodedId
    })
    if (matched) return parseProductEvent(matched)
  }

  // Fallback: treat as event id if caller passed a raw id.
  const filter: NDKFilter = { ids: [decodedId] }
  const ev = (await ndk.fetchEvent(filter)) as NDKEvent | null
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
  const image = p?.images[0]?.url ?? "/images/placeholders/landscape.jpg"

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
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
          <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="aspect-square bg-[var(--background)] lg:aspect-video">
              <img
                src={image}
                alt={p.title}
                className="h-full w-full object-cover"
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).src = "/images/placeholders/landscape.jpg"
                }}
              />
            </div>
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
            <h1 className="text-3xl font-semibold text-[var(--text-primary)]">{p.title}</h1>
            {p.summary && (
              <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{p.summary}</p>
            )}
            <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-xs">
              <div className="text-[var(--text-secondary)]">Merchant</div>
              <div className="mt-1 font-mono text-[var(--text-primary)]">{p.pubkey}</div>
            </div>

            <div className="mt-5 border-t border-[var(--border)] pt-5">
              <div className="text-2xl font-bold text-[var(--text-primary)]">
                {p.price} {p.currency}
              </div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">
                Shipping and payment finalized in checkout
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  className="flex-1"
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
                <Button asChild variant="outline">
                  <Link to="/cart">View cart</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
