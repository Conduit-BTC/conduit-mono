import { SearchX, ShoppingCart, Store } from "lucide-react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { formatNpub, useProfile } from "@conduit/core"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage, Badge, Button } from "@conduit/ui"
import { CopyButton } from "../../components/CopyButton"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../../components/MerchantIdentity"
import {
  ProductGridCard,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import {
  useProgressiveProductDetail,
  useProgressiveProducts,
} from "../../hooks/useProgressiveProducts"
import { getProductPriceDisplay } from "../../lib/pricing"

export const Route = createFileRoute("/products/$productId")({
  component: ProductPage,
})

function ProductPage() {
  const cart = useCart()
  const { productId } = Route.useParams()
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [quantity, setQuantity] = useState(1)
  const [showAllTags, setShowAllTags] = useState(false)
  const [invalidRelatedImageIds, setInvalidRelatedImageIds] = useState<
    Set<string>
  >(new Set())
  const btcUsdRateQuery = useBtcUsdRate()

  const productQuery = useProgressiveProductDetail(productId)
  const product = productQuery.product

  const merchantProfile = useProfile(product?.pubkey, { priority: "visible" })

  const relatedProductsQuery = useProgressiveProducts({
    scope: "marketplace",
    merchantPubkey: product?.pubkey ?? "",
    enabled: !!product,
    sort: "newest",
  })
  const relatedProducts = useMemo(
    () =>
      product
        ? relatedProductsQuery.products
            .filter((candidate) => candidate.id !== product.id)
            .filter((candidate) => !invalidRelatedImageIds.has(candidate.id))
            .slice(0, 4)
        : [],
    [invalidRelatedImageIds, product, relatedProductsQuery.products]
  )
  const markInvalidRelatedImage = useCallback((productId: string) => {
    setInvalidRelatedImageIds((current) => {
      if (current.has(productId)) return current
      const next = new Set(current)
      next.add(productId)
      return next
    })
  }, [])

  const images = product?.images ?? []
  const hasMultipleImages = images.length > 1
  const selectedImage = images[selectedImageIndex] ?? images[0]
  const merchantName = product
    ? getMerchantDisplayName(merchantProfile.data, product.pubkey)
    : ""
  const cartItem = product
    ? cart.items.find((item) => item.productId === product.id)
    : null
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
          <Link
            to="/products"
            className="transition-colors hover:text-[var(--text-primary)]"
          >
            Shop
          </Link>
          <span>/</span>
          {product && (
            <>
              <Link
                to="/store/$pubkey"
                params={{ pubkey: product.pubkey }}
                className="transition-colors hover:text-[var(--text-primary)]"
              >
                {merchantName}
              </Link>
              <span>/</span>
            </>
          )}
          <span className="text-[var(--text-primary)]">
            {product?.title ?? "Product"}
          </span>
        </div>
      </div>

      {productQuery.isInitialLoading && (
        <div
          className={`grid gap-6 ${hasMultipleImages ? "lg:grid-cols-[88px_minmax(0,1fr)_minmax(320px,420px)]" : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]"}`}
        >
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

      {!!productQuery.error && (
        <div className="rounded-lg border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load product:{" "}
          {productQuery.error instanceof Error
            ? productQuery.error.message
            : "Unknown error"}
        </div>
      )}

      {product && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>
            {productQuery.isShowingCache
              ? "Showing cached listing"
              : productQuery.meta?.source === "commerce"
                ? "Verified by direct relay lookup"
                : "Loaded from relay view"}
          </span>
          {productQuery.isHydrating && (
            <>
              <span aria-hidden="true">/</span>
              <span className="text-secondary-300">
                checking latest relay state
              </span>
            </>
          )}
          {productQuery.meta?.stale && (
            <>
              <span aria-hidden="true">/</span>
              <span>stale-aware</span>
            </>
          )}
        </div>
      )}

      {!productQuery.isInitialLoading && !product && (
        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center sm:p-10">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-400">
            <SearchX className="h-6 w-6" />
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
            Product not found
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-[var(--text-secondary)]">
            This listing may have been removed, changed, or is no longer
            available from the current relay view.
          </p>
          <div className="mt-6 flex justify-center">
            <Button asChild className="h-11 px-5 text-sm">
              <Link to="/products">Browse products</Link>
            </Button>
          </div>
        </section>
      )}

      {product && (
        <>
          <div
            className={`grid gap-5 lg:gap-6 ${hasMultipleImages ? "lg:grid-cols-[88px_minmax(0,1fr)_minmax(320px,420px)]" : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]"}`}
          >
            {hasMultipleImages && (
              <div className="hidden gap-3 lg:grid">
                {images.slice(0, 4).map((image, index) => (
                  <button
                    key={`${image.url}-${index}`}
                    type="button"
                    onClick={() => setSelectedImageIndex(index)}
                    className={`overflow-hidden rounded-xl border bg-[var(--surface)] transition-colors ${
                      selectedImageIndex === index
                        ? "border-secondary-400 shadow-[var(--shadow-glass-inset)]"
                        : "border-[var(--border)] hover:border-[var(--text-secondary)]"
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
                  src={selectedImage?.url}
                  alt={selectedImage?.alt ?? product.title}
                  className="max-h-[60vh] w-auto max-w-full object-contain lg:max-h-[34rem]"
                />
              </div>
            </div>

            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
              <div className="flex flex-col gap-4">
                <div className="w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
                    Shop at
                  </div>
                  <div className="mt-3 flex items-start gap-3">
                    <Avatar className="h-11 w-11 shrink-0 border border-[var(--border)]">
                      <AvatarImage
                        src={merchantProfile.data?.picture}
                        alt={merchantName}
                      />
                      <AvatarFallback>
                        <MerchantAvatarFallback />
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/store/$pubkey"
                        params={{ pubkey: product.pubkey }}
                        className="block min-w-0 rounded-md transition-colors hover:text-secondary-300"
                      >
                        <div className="truncate text-base font-semibold leading-tight text-[var(--text-primary)]">
                          {merchantName}
                        </div>
                      </Link>
                      <div className="mt-1 flex min-w-0 items-center gap-2">
                        <Link
                          to="/store/$pubkey"
                          params={{ pubkey: product.pubkey }}
                          className="truncate font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          {formatNpub(product.pubkey, 10)}
                        </Link>
                        <CopyButton
                          value={product.pubkey}
                          label="Copy pubkey"
                        />
                      </div>
                    </div>
                  </div>
                </div>
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

                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
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
                  <div className="inline-flex h-10 items-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated)]">
                    <button
                      type="button"
                      className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-[var(--surface)]"
                      aria-label="Decrease quantity"
                      onClick={() =>
                        setQuantity((current) => Math.max(1, current - 1))
                      }
                    >
                      -
                    </button>
                    <div className="flex h-full min-w-10 items-center justify-center border-x border-[var(--border)] px-3 text-sm font-medium text-[var(--text-primary)]">
                      {quantity}
                    </div>
                    <button
                      type="button"
                      className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-[var(--surface)]"
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
                    {cartQuantity > 0
                      ? `Add more (${cartQuantity} in cart)`
                      : `Add ${quantity} to cart`}
                  </Button>
                </div>

                <Button asChild variant="outline" className="w-full">
                  <Link to="/cart">
                    <ShoppingCart className="h-4 w-4" />
                    View cart
                  </Link>
                </Button>

                <div className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm">
                  {typeof product.stock === "number" && (
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[var(--text-secondary)]">
                        Stock
                      </span>
                      <span className="text-[var(--text-primary)]">
                        {product.stock} available
                      </span>
                    </div>
                  )}
                  {product.location && (
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[var(--text-secondary)]">
                        Location
                      </span>
                      <span className="text-right text-[var(--text-primary)]">
                        {product.location}
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[var(--text-secondary)]">
                      Updated
                    </span>
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
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">
                  Details
                </h2>
                {product.tags.length > 0 && (
                  <button
                    type="button"
                    className="text-xs font-medium text-secondary-400 transition-colors hover:text-secondary-300"
                    onClick={() => setShowAllTags((current) => !current)}
                  >
                    {showAllTags
                      ? "Show fewer tags"
                      : `Show all tags (${product.tags.length})`}
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
                        <Badge
                          key={tag}
                          variant="outline"
                          className="capitalize"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
              <h2 className="text-xl font-semibold text-[var(--text-primary)]">
                Buying with Conduit
              </h2>
              <div className="mt-4 space-y-4 text-sm text-[var(--text-secondary)]">
                <p>
                  Add products to your cart, continue to checkout, and send your
                  order through Nostr.
                </p>
                <p>
                  Payment requests and order updates appear in your order
                  conversation after checkout.
                </p>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
                  More from this store
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  Keep browsing merchant listings without leaving the product
                  flow.
                </p>
              </div>
              <Button asChild variant="outline" className="h-11 px-4 text-sm">
                <Link to="/store/$pubkey" params={{ pubkey: product.pubkey }}>
                  <Store className="h-[18px] w-[18px]" />
                  Browse store
                </Link>
              </Button>
            </div>

            {relatedProductsQuery.isInitialLoading && (
              <ul className="grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <li key={index} className="h-full">
                    <ProductGridCardSkeleton />
                  </li>
                ))}
              </ul>
            )}

            {!relatedProductsQuery.isInitialLoading &&
              !relatedProductsQuery.isHydrating &&
              relatedProducts.length === 0 && (
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
                  This merchant has not published additional products yet.
                </div>
              )}

            {relatedProducts.length > 0 && (
              <ul className="grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
                {relatedProducts.map((relatedProduct) => {
                  const relatedCartItem = cart.items.find(
                    (item) => item.productId === relatedProduct.id
                  )
                  const relatedCartQuantity = relatedCartItem?.quantity ?? 0

                  return (
                    <li key={relatedProduct.id} className="h-full">
                      <ProductGridCard
                        product={relatedProduct}
                        merchantName={merchantName}
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
                          cart.setQuantity(
                            relatedProduct.id,
                            relatedCartItem.quantity - 1
                          )
                        }}
                        onInvalidImage={markInvalidRelatedImage}
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
