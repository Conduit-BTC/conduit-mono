import { createFileRoute, Link } from "@tanstack/react-router"
import {
  EVENT_KINDS,
  fetchEventsFanout,
  formatPubkey,
  getNdk,
  parseProductEvent,
  useProfile,
  type Product,
} from "@conduit/core"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage, Badge, Button } from "@conduit/ui"
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"
import { ProductGridCard, ProductGridCardSkeleton } from "../../components/ProductGridCard"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import { getProductPriceDisplay } from "../../lib/pricing"

export const Route = createFileRoute("/products/$productId")({
  component: ProductPage,
})

function CartIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 3h2l.4 2m0 0L7 13h10l2-8H5.4M5.4 5H19M7 13l-1 5h12M9 18a1 1 0 100 2 1 1 0 000-2zm8 0a1 1 0 100 2 1 1 0 000-2z"
      />
    </svg>
  )
}

function StoreIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 9.5l1.6-4.8A1 1 0 015.55 4h12.9a1 1 0 01.95.7L21 9.5M4 10h16v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8zm4 4h3m2 0h3"
      />
    </svg>
  )
}

function CopyPubkeyButton({ pubkey }: { pubkey: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(pubkey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? "Pubkey copied" : "Copy pubkey"}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border transition-colors ${
        copied
          ? "border-green-500/40 bg-green-500/12 text-green-400"
          : "border-white/14 bg-white/[0.03] text-[var(--text-muted)] hover:border-white/24 hover:text-[var(--text-primary)]"
      }`}
      onClick={handleCopy}
    >
      {copied ? (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  )
}

function parseAddress(productId: string): { kind: number; pubkey: string; d: string } | null {
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

  const filter: NDKFilter = { ids: [decodedId] }
  const ev = (await ndk.fetchEvent(filter)) as NDKEvent | null
  if (!ev) return null
  return parseProductEvent(ev)
}

async function fetchRelatedProducts(product: Product): Promise<Product[]> {
  const merchantProducts = await fetchEventsFanout({
    kinds: [EVENT_KINDS.PRODUCT],
    authors: [product.pubkey],
    limit: 12,
  }, {
    connectTimeoutMs: 4_000,
    fetchTimeoutMs: 8_000,
  }) as NDKEvent[]

  const parsed = merchantProducts
    .map((event) => {
      try {
        return parseProductEvent(event)
      } catch {
        return null
      }
    })
    .filter(Boolean) as Product[]

  return parsed
    .filter((candidate) => candidate.id !== product.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
}

function ProductPage() {
  const cart = useCart()
  const { productId } = Route.useParams()
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [quantity, setQuantity] = useState(1)
  const [showAllTags, setShowAllTags] = useState(false)
  const btcUsdRateQuery = useBtcUsdRate()

  const productQuery = useQuery({
    queryKey: ["product", productId],
    queryFn: () => fetchProduct(productId),
  })

  const merchantProfile = useProfile(productQuery.data?.pubkey)

  const relatedProductsQuery = useQuery({
    queryKey: ["related-products", productQuery.data?.id],
    enabled: !!productQuery.data,
    queryFn: () => fetchRelatedProducts(productQuery.data!),
  })

  const product = productQuery.data
  const images = product?.images.length
    ? product.images
    : [{ url: "/images/placeholders/landscape.jpg", alt: product?.title }]
  const hasMultipleImages = images.length > 1
  const selectedImage = images[selectedImageIndex] ?? images[0]
  const merchantName =
    merchantProfile.data?.displayName ||
    merchantProfile.data?.name ||
    (product ? formatPubkey(product.pubkey, 6) : "")
  const merchantAvatarFallback = (merchantName[0] ?? "C").toUpperCase()
  const cartItem = product ? cart.items.find((item) => item.productId === product.id) : null
  const cartQuantity = cartItem?.quantity ?? 0
  const priceDisplay = product
    ? getProductPriceDisplay(product, btcUsdRateQuery.data?.rate ?? null)
    : null

  const visibleTags = useMemo(() => {
    if (!product) return []
    return showAllTags ? product.tags : product.tags.slice(0, 6)
  }, [product, showAllTags])

  useEffect(() => {
    setSelectedImageIndex(0)
    setQuantity(1)
    setShowAllTags(false)
  }, [product?.id])

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/products" className="transition-colors hover:text-[var(--text-primary)]">
            Shop
          </Link>
          <span>/</span>
          {product && (
            <>
              <Link
                to="/products"
                search={{ merchant: product.pubkey }}
                className="transition-colors hover:text-[var(--text-primary)]"
              >
                {merchantName}
              </Link>
              <span>/</span>
            </>
          )}
          <span className="text-[var(--text-primary)]">{product?.title ?? "Product"}</span>
        </div>
      </div>

      {productQuery.isLoading && (
        <div className={`grid gap-6 ${hasMultipleImages ? "lg:grid-cols-[88px_minmax(0,1fr)_minmax(320px,420px)]" : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]"}`}>
          {hasMultipleImages && (
            <div className="hidden gap-3 lg:grid">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="aspect-square animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                />
              ))}
            </div>
          )}
          <div className="min-h-[22rem] animate-pulse rounded-2xl border border-[var(--border)] bg-[var(--surface)] lg:min-h-[32rem]" />
          <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
            <div className="h-5 w-24 animate-pulse rounded bg-[var(--surface-elevated)]" />
            <div className="h-8 w-4/5 animate-pulse rounded bg-[var(--surface-elevated)]" />
            <div className="h-20 animate-pulse rounded bg-[var(--surface-elevated)]" />
            <div className="h-24 animate-pulse rounded bg-[var(--surface-elevated)]" />
          </div>
        </div>
      )}

      {productQuery.error && (
        <div className="rounded-lg border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load product:{" "}
          {productQuery.error instanceof Error ? productQuery.error.message : "Unknown error"}
        </div>
      )}

      {productQuery.data === null && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Product not found.
        </div>
      )}

      {product && (
        <>
          <div className={`grid gap-5 lg:gap-6 ${hasMultipleImages ? "lg:grid-cols-[88px_minmax(0,1fr)_minmax(320px,420px)]" : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]"}`}>
            {hasMultipleImages && (
              <div className="hidden gap-3 lg:grid">
                {images.slice(0, 4).map((image, index) => (
                  <button
                    key={`${image.url}-${index}`}
                    type="button"
                    onClick={() => setSelectedImageIndex(index)}
                    className={`overflow-hidden rounded-xl border bg-[var(--surface)] transition-colors ${
                      selectedImageIndex === index
                        ? "border-secondary-400 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
                        : "border-[var(--border)] hover:border-white/30"
                    }`}
                  >
                    <div className="aspect-square">
                      <img
                        src={image.url}
                        alt={image.alt ?? product.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="flex min-h-[22rem] items-center justify-center bg-[var(--background)] p-4 sm:p-6 lg:min-h-[32rem]">
                <img
                  src={selectedImage?.url ?? "/images/placeholders/landscape.jpg"}
                  alt={selectedImage?.alt ?? product.title}
                  className="max-h-[60vh] w-auto max-w-full object-contain lg:max-h-[34rem]"
                  onError={(e) => {
                    ;(e.currentTarget as HTMLImageElement).src = "/images/placeholders/landscape.jpg"
                  }}
                />
              </div>
            </div>

            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
              <div className="flex flex-col gap-4">
                <Link
                  to="/products"
                  search={{ merchant: product.pubkey }}
                  className="block w-full min-w-0 rounded-xl border border-white/10 bg-[var(--surface-elevated)] px-4 py-3 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
                >
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
                    Shop at
                  </div>
                  <div className="mt-3 flex items-start gap-3">
                    <Avatar className="h-11 w-11 shrink-0 border border-white/10">
                      <AvatarImage src={merchantProfile.data?.picture} alt={merchantName} />
                      <AvatarFallback>{merchantAvatarFallback}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base font-semibold leading-tight text-[var(--text-primary)]">
                        {merchantName}
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-xs text-[var(--text-muted)]">
                          {formatPubkey(product.pubkey, 10)}
                        </span>
                        <CopyPubkeyButton pubkey={product.pubkey} />
                      </div>
                    </div>
                  </div>
                </Link>
              </div>

              <div className="mt-5 space-y-5 border-t border-[var(--border)] pt-5">
                <div>
                  <h1 className="text-2xl font-semibold leading-tight text-[var(--text-primary)] sm:text-3xl">
                    {product.title}
                  </h1>
                  {product.summary && (
                    <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                      {product.summary}
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-white/10 bg-[var(--surface-elevated)] p-4">
                  <div className="text-2xl font-bold text-secondary-400">
                    {priceDisplay?.primary}
                  </div>
                  {priceDisplay?.secondary && (
                    <div className="mt-1 text-sm text-[var(--text-muted)]">
                      {priceDisplay.secondary}
                    </div>
                  )}
                  <div className="mt-3 text-xs text-[var(--text-secondary)]">
                    Payment and shipping are finalized during checkout.
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex h-10 items-center overflow-hidden rounded-md border border-white/20 bg-[var(--surface-elevated)]">
                    <button
                      type="button"
                      className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-white/5"
                      aria-label="Decrease quantity"
                      onClick={() => setQuantity((current) => Math.max(1, current - 1))}
                    >
                      -
                    </button>
                    <div className="flex h-full min-w-10 items-center justify-center border-x border-white/10 px-3 text-sm font-medium text-[var(--text-primary)]">
                      {quantity}
                    </div>
                    <button
                      type="button"
                      className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-white/5"
                      aria-label="Increase quantity"
                      onClick={() => setQuantity((current) => current + 1)}
                    >
                      +
                    </button>
                  </div>

                  <Button
                    className="min-w-[12rem] flex-1"
                    onClick={() =>
                      cart.addItem(
                        {
                          productId: product.id,
                          merchantPubkey: product.pubkey,
                          title: product.title,
                          price: product.price,
                          currency: product.currency,
                          image: product.images[0]?.url,
                          tags: product.tags,
                        },
                        quantity
                      )
                    }
                  >
                    {cartQuantity > 0 ? `Add more (${cartQuantity} in cart)` : `Add ${quantity} to cart`}
                  </Button>
                </div>

                <Button asChild variant="outline" className="w-full">
                  <Link to="/cart">
                    <CartIcon className="h-4 w-4" />
                    View cart
                  </Link>
                </Button>

                <div className="grid gap-3 rounded-xl border border-white/10 bg-[var(--surface-elevated)] p-4 text-sm">
                  {typeof product.stock === "number" && (
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[var(--text-secondary)]">Stock</span>
                      <span className="text-[var(--text-primary)]">{product.stock} available</span>
                    </div>
                  )}
                  {product.location && (
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[var(--text-secondary)]">Location</span>
                      <span className="text-right text-[var(--text-primary)]">{product.location}</span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[var(--text-secondary)]">Updated</span>
                    <span className="text-right text-[var(--text-primary)]">
                      {new Intl.DateTimeFormat("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      }).format(product.updatedAt)}
                    </span>
                  </div>
                </div>
              </div>
            </aside>
          </div>

          <section className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">Details</h2>
                {product.tags.length > 0 && (
                  <button
                    type="button"
                    className="text-xs font-medium text-secondary-400 transition-colors hover:text-secondary-300"
                    onClick={() => setShowAllTags((current) => !current)}
                  >
                    {showAllTags ? "Show fewer tags" : `Show all tags (${product.tags.length})`}
                  </button>
                )}
              </div>

              <div className="mt-4 space-y-5">
                <p className="text-sm leading-7 text-[var(--text-secondary)]">
                  {product.summary ??
                    "This listing does not include a merchant-written summary yet. Product pricing, identity, and order flow are still available for checkout."}
                </p>

                {visibleTags.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      Tags
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {visibleTags.map((tag) => (
                        <Badge key={tag} variant="outline" className="capitalize">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
              <h2 className="text-xl font-semibold text-[var(--text-primary)]">Buying with Conduit</h2>
              <div className="mt-4 space-y-4 text-sm text-[var(--text-secondary)]">
                <p>Add products to your cart, continue to checkout, and send your order through Nostr.</p>
                <p>Payment requests and order updates appear in your order conversation after checkout.</p>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold text-[var(--text-primary)]">More from this store</h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  Keep browsing merchant listings without leaving the product flow.
                </p>
              </div>
              <Button asChild variant="outline" className="h-11 px-4 text-sm">
                <Link to="/products" search={{ merchant: product.pubkey }}>
                  <StoreIcon className="h-[18px] w-[18px]" />
                  Browse store
                </Link>
              </Button>
            </div>

            {relatedProductsQuery.isLoading && (
              <ul className="grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <li key={index} className="h-full">
                    <ProductGridCardSkeleton />
                  </li>
                ))}
              </ul>
            )}

            {relatedProductsQuery.data && relatedProductsQuery.data.length === 0 && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
                This merchant has not published additional products yet.
              </div>
            )}

            {relatedProductsQuery.data && relatedProductsQuery.data.length > 0 && (
              <ul className="grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
                {relatedProductsQuery.data.map((relatedProduct) => {
                  const relatedCartItem = cart.items.find((item) => item.productId === relatedProduct.id)
                  const relatedCartQuantity = relatedCartItem?.quantity ?? 0

                  return (
                    <li key={relatedProduct.id} className="h-full">
                      <ProductGridCard
                        product={relatedProduct}
                        btcUsdRate={btcUsdRateQuery.data?.rate ?? null}
                        cartQuantity={relatedCartQuantity}
                        onAddToCart={() =>
                          cart.addItem(
                            {
                              productId: relatedProduct.id,
                              merchantPubkey: relatedProduct.pubkey,
                              title: relatedProduct.title,
                              price: relatedProduct.price,
                              currency: relatedProduct.currency,
                              image: relatedProduct.images[0]?.url,
                              tags: relatedProduct.tags,
                            },
                            1
                          )
                        }
                        onIncrement={() =>
                          cart.addItem(
                            {
                              productId: relatedProduct.id,
                              merchantPubkey: relatedProduct.pubkey,
                              title: relatedProduct.title,
                              price: relatedProduct.price,
                              currency: relatedProduct.currency,
                              image: relatedProduct.images[0]?.url,
                              tags: relatedProduct.tags,
                            },
                            1
                          )
                        }
                        onDecrement={() => {
                          if (!relatedCartItem) return
                          if (relatedCartItem.quantity <= 1) {
                            cart.removeItem(relatedProduct.id)
                            return
                          }
                          cart.setQuantity(relatedProduct.id, relatedCartItem.quantity - 1)
                        }}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
