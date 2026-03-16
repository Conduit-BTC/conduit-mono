import { RefreshCw, ShoppingCart, Store, Trash2, Zap } from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  EVENT_KINDS,
  fetchEventsFanout,
  formatPubkey,
  parseProductEvent,
  useAuth,
  useProfile,
  type Product,
} from "@conduit/core"
import { type NDKEvent } from "@nostr-dev-kit/ndk"
import { Avatar, AvatarFallback, AvatarImage, Button } from "@conduit/ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@conduit/ui"
import { useEffect, useMemo, useState } from "react"
import { MerchantAvatarFallback, getMerchantDisplayName } from "../components/MerchantIdentity"
import { SignerSwitch } from "../components/SignerSwitch"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { type CartItem, useCart } from "../hooks/useCart"
import { getProductPriceDisplay } from "../lib/pricing"

type CartSearch = {
  merchant?: string
}

type MerchantCartGroup = {
  merchantPubkey: string
  items: CartItem[]
  totalItems: number
}

export const Route = createFileRoute("/cart")({
  validateSearch: (search: Record<string, unknown>): CartSearch => ({
    merchant: typeof search.merchant === "string" ? search.merchant : undefined,
  }),
  component: CartPage,
})

function CartIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <ShoppingCart className={className} />
}

function LightningIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Zap className={className} />
}

function TrashIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Trash2 className={className} />
}

function RefreshIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <RefreshCw className={className} />
}

function groupCartItems(items: CartItem[]): MerchantCartGroup[] {
  const byMerchant = new Map<string, CartItem[]>()
  for (const item of items) {
    const current = byMerchant.get(item.merchantPubkey) ?? []
    current.push(item)
    byMerchant.set(item.merchantPubkey, current)
  }

  return Array.from(byMerchant.entries())
    .map(([merchantPubkey, merchantItems]) => ({
      merchantPubkey,
      items: merchantItems,
      totalItems: merchantItems.reduce((sum, item) => sum + item.quantity, 0),
    }))
    .sort((a, b) => b.totalItems - a.totalItems)
}

function sumCartItems(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

function toProductRouteParam(productId: string): string {
  return encodeURIComponent(productId)
}

function getCartSummaryPrice(items: CartItem[], btcUsdRate: number | null) {
  const currencies = Array.from(new Set(items.map((item) => item.currency).filter(Boolean)))
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0)
  if (currencies.length !== 1) {
    return {
      primary: `${totalItems} item${totalItems === 1 ? "" : "s"}`,
      secondary: "Mixed currencies",
    }
  }

  return getProductPriceDisplay(
    { price: sumCartItems(items), currency: currencies[0] },
    btcUsdRate
  )
}

async function fetchSuggestedProducts(
  merchantPubkey: string | undefined,
  excludedIds: string[],
  preferredTags: string[]
): Promise<Product[]> {
  const events = await fetchEventsFanout(
    {
      kinds: [EVENT_KINDS.PRODUCT],
      ...(merchantPubkey ? { authors: [merchantPubkey] } : {}),
      limit: merchantPubkey ? 18 : 30,
    },
    {
      connectTimeoutMs: 4_000,
      fetchTimeoutMs: 8_000,
    }
  ) as NDKEvent[]

  const excludedSet = new Set(excludedIds)
  const preferredTagSet = new Set(
    preferredTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  )
  const seen = new Set<string>()

  return events
    .map((event) => {
      try {
        return parseProductEvent(event)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .filter((product): product is Product => {
      if (!product) return false
      if (excludedSet.has(product.id)) return false
      if (seen.has(product.id)) return false
      seen.add(product.id)
      return true
    })
    .sort((a, b) => {
      const aTagOverlap = a.tags.reduce((count, tag) => {
        return count + (preferredTagSet.has(tag.trim().toLowerCase()) ? 1 : 0)
      }, 0)
      const bTagOverlap = b.tags.reduce((count, tag) => {
        return count + (preferredTagSet.has(tag.trim().toLowerCase()) ? 1 : 0)
      }, 0)

      if (bTagOverlap !== aTagOverlap) {
        return bTagOverlap - aTagOverlap
      }

      if (merchantPubkey) {
        const aMerchantMatch = a.pubkey === merchantPubkey ? 1 : 0
        const bMerchantMatch = b.pubkey === merchantPubkey ? 1 : 0
        if (bMerchantMatch !== aMerchantMatch) {
          return bMerchantMatch - aMerchantMatch
        }
      }

      return b.updatedAt - a.updatedAt
    })
    .slice(0, 4)
}

function MerchantIdentity({
  merchantPubkey,
  eyebrow,
  fallbackLabel = "Store",
  className = "",
}: {
  merchantPubkey: string
  eyebrow?: string
  fallbackLabel?: string
  className?: string
}) {
  const { data: profile } = useProfile(merchantPubkey)
  const merchantName = getMerchantDisplayName(profile, merchantPubkey) || fallbackLabel

  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
        <Avatar className="h-12 w-12 shrink-0 border border-white/10">
          <AvatarImage src={profile?.picture} alt={merchantName} />
          <AvatarFallback>
            <MerchantAvatarFallback />
          </AvatarFallback>
        </Avatar>
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {eyebrow}
          </div>
        )}
        <Link
          to="/store/$pubkey"
          params={{ pubkey: merchantPubkey }}
          className="block truncate text-xl font-semibold leading-tight text-[var(--text-primary)] transition-colors hover:text-secondary-300"
        >
          {merchantName}
        </Link>
        <Link
          to="/store/$pubkey"
          params={{ pubkey: merchantPubkey }}
          className="mt-1 block truncate font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {formatPubkey(merchantPubkey, 10)}
        </Link>
      </div>
    </div>
  )
}

function MerchantOverviewCard({
  group,
  btcUsdRate,
  onCheckout,
}: {
  group: MerchantCartGroup
  btcUsdRate: number | null
  onCheckout: (merchantPubkey: string) => void
}) {
  const summary = getCartSummaryPrice(group.items, btcUsdRate)

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <MerchantIdentity merchantPubkey={group.merchantPubkey} />

        <div className="flex flex-col gap-3 lg:min-w-[24rem] lg:items-end">
          <div className="text-sm text-[var(--text-secondary)]">
            {group.totalItems} item{group.totalItems === 1 ? "" : "s"}
            <span className="mx-2 text-[var(--text-muted)]">/</span>
            <span className="font-semibold text-[var(--text-primary)]">{summary.primary}</span>
            {summary.secondary && (
              <span className="ml-2 text-[var(--text-muted)]">{summary.secondary}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="min-w-[10rem]" onClick={() => onCheckout(group.merchantPubkey)}>
              <span className="inline-flex items-center gap-2">
                <LightningIcon className="h-4 w-4" />
                Zap out
              </span>
            </Button>
            <Button asChild variant="outline" className="min-w-[10rem]">
              <Link to="/cart" search={{ merchant: group.merchantPubkey }}>
                <CartIcon className="h-4 w-4" />
                View cart
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RelatedProductRow({
  product,
  btcUsdRate,
  cartQuantity,
  onAdd,
}: {
  product: Product
  btcUsdRate: number | null
  cartQuantity: number
  onAdd: () => void
}) {
  const imageUrl = product.images[0]?.url ?? "/images/placeholders/product.png"
  const price = getProductPriceDisplay(product, btcUsdRate)
  const { data: profile } = useProfile(product.pubkey)
  const merchantLabel = getMerchantDisplayName(profile, product.pubkey)

  return (
    <div className="grid min-h-[9.5rem] grid-cols-[80px_minmax(0,1fr)] items-start gap-3 rounded-xl border border-white/10 bg-[var(--surface)] p-3">
      <Link
        to="/products/$productId"
        params={{ productId: toProductRouteParam(product.id) }}
        className="shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[var(--background)]"
      >
        <img
          src={imageUrl}
          alt={product.images[0]?.alt ?? product.title}
          className="h-20 w-20 object-cover"
          width={80}
          height={80}
          loading="lazy"
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).src = "/images/placeholders/product.png"
          }}
        />
      </Link>

      <div className="min-w-0 flex-1">
        <Link
          to="/products/$productId"
          params={{ productId: toProductRouteParam(product.id) }}
          className="line-clamp-2 text-sm font-medium leading-6 text-[var(--text-primary)] transition-colors hover:text-secondary-300"
        >
          {product.title}
        </Link>
        <div className="mt-1 truncate text-xs text-[var(--text-muted)]">
          {merchantLabel} / {formatPubkey(product.pubkey, 6)}
        </div>
        <div className="mt-2 text-sm font-semibold text-secondary-400">{price.primary}</div>
        {price.secondary && (
          <div className="mt-1 text-xs text-[var(--text-muted)]">{price.secondary}</div>
        )}
        <Button
          size="sm"
          variant={cartQuantity > 0 ? "muted" : "outline"}
          className="mt-3 h-9 px-3 text-sm"
          onClick={onAdd}
        >
          <CartIcon className="h-4 w-4" />
          {cartQuantity > 0 ? `In cart (${cartQuantity})` : "Add"}
        </Button>
      </div>
    </div>
  )
}

function CartLineItem({
  item,
  btcUsdRate,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  item: CartItem
  btcUsdRate: number | null
  onIncrement: () => void
  onDecrement: () => void
  onRemove: () => void
}) {
  const linePrice = getProductPriceDisplay(
    { price: item.price * item.quantity, currency: item.currency },
    btcUsdRate
  )
  const unitPrice = getProductPriceDisplay(
    { price: item.price, currency: item.currency },
    btcUsdRate
  )

  return (
    <div className="grid gap-4 py-5 md:grid-cols-[132px_minmax(0,1fr)_auto] md:items-start">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[var(--background)]">
        <img
          src={item.image ?? "/images/placeholders/product.png"}
          alt={item.title}
          className="aspect-square h-full w-full object-cover"
          loading="lazy"
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).src = "/images/placeholders/product.png"
          }}
        />
      </div>

      <div className="min-w-0">
        <Link
          to="/products/$productId"
          params={{ productId: toProductRouteParam(item.productId) }}
          className="line-clamp-2 text-xl font-medium leading-tight text-[var(--text-primary)] transition-colors hover:text-secondary-300"
        >
          {item.title}
        </Link>
        <div className="mt-3 text-sm text-[var(--text-secondary)]">
          Review this item before continuing to checkout for this store.
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/12 bg-[var(--surface-elevated)] text-[var(--text-secondary)] transition-colors hover:border-white/24 hover:text-[var(--text-primary)]"
            aria-label={`Remove ${item.title} from cart`}
            onClick={onRemove}
          >
            <TrashIcon className="h-4 w-4" />
          </button>

          <div className="inline-flex h-10 items-center overflow-hidden rounded-md border border-white/12 bg-[var(--surface-elevated)]">
            <button
              type="button"
              className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-white/5"
              aria-label={`Decrease quantity for ${item.title}`}
              onClick={onDecrement}
            >
              -
            </button>
            <div className="flex h-full min-w-10 items-center justify-center border-x border-white/10 px-3 text-sm font-medium text-[var(--text-primary)]">
              {item.quantity}
            </div>
            <button
              type="button"
              className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-white/5"
              aria-label={`Increase quantity for ${item.title}`}
              onClick={onIncrement}
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div className="md:min-w-[10rem] md:text-right">
        <div className="text-2xl font-semibold text-[var(--text-primary)]">{linePrice.primary}</div>
        <div className="mt-1 text-sm text-[var(--text-muted)]">
          {item.quantity > 1 ? `${unitPrice.primary} each` : unitPrice.secondary ?? "\u00a0"}
        </div>
      </div>
    </div>
  )
}

function CartPage() {
  const cart = useCart()
  const { pubkey, status } = useAuth()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const btcUsdRateQuery = useBtcUsdRate()
  const [confirmClearTarget, setConfirmClearTarget] = useState<"all" | string | null>(null)
  const [forceOverview, setForceOverview] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [pendingCheckoutMerchant, setPendingCheckoutMerchant] = useState<string | null>(null)

  const merchantGroups = useMemo(() => groupCartItems(cart.items), [cart.items])

  useEffect(() => {
    if (search.merchant) {
      setForceOverview(false)
      return
    }

    if (merchantGroups.length === 0) {
      setForceOverview(false)
    }
  }, [merchantGroups.length, search.merchant])

  const selectedMerchant = useMemo(() => {
    if (search.merchant && merchantGroups.some((group) => group.merchantPubkey === search.merchant)) {
      return search.merchant
    }

    if (forceOverview) {
      return undefined
    }

    if (merchantGroups.length === 1) {
      return merchantGroups[0].merchantPubkey
    }

    return undefined
  }, [merchantGroups, search.merchant])

  const selectedGroup = merchantGroups.find((group) => group.merchantPubkey === selectedMerchant)
  const selectedSummary = selectedGroup
    ? getCartSummaryPrice(selectedGroup.items, btcUsdRateQuery.data?.rate ?? null)
    : null
  const preferredTags = useMemo(() => {
    const sourceItems = selectedGroup ? selectedGroup.items : cart.items
    return sourceItems.flatMap((item) => item.tags ?? [])
  }, [cart.items, selectedGroup])

  const signerConnected = status === "connected" && !!pubkey

  function continueToCheckout(merchant: string): void {
    navigate({
      to: "/checkout",
      search: { merchant },
    })
  }

  function handleCheckout(merchant: string): void {
    if (signerConnected) {
      continueToCheckout(merchant)
      return
    }

    setPendingCheckoutMerchant(merchant)
    setConnectOpen(true)
  }

  useEffect(() => {
    if (signerConnected && pendingCheckoutMerchant) {
      const merchant = pendingCheckoutMerchant
      setPendingCheckoutMerchant(null)
      setConnectOpen(false)
      continueToCheckout(merchant)
    }
  }, [pendingCheckoutMerchant, signerConnected])

  function handleConfirmClear(): void {
    if (!confirmClearTarget) return
    const shouldForceOverview =
      confirmClearTarget !== "all" &&
      selectedGroup?.merchantPubkey === confirmClearTarget &&
      merchantGroups.length > 1

    if (confirmClearTarget === "all") {
      cart.clear()
    } else {
      cart.clearMerchant(confirmClearTarget)
    }

    if (shouldForceOverview) {
      setForceOverview(true)
      navigate({
        to: "/cart",
        search: {
          merchant: undefined,
        },
      })
    }

    setConfirmClearTarget(null)
  }

  const relatedProductsQuery = useQuery({
    queryKey: [
      "cart-related-products",
      selectedMerchant ?? "all",
      cart.items.map((item) => item.productId).sort().join(":"),
      preferredTags.slice().sort().join(":"),
    ],
    enabled: cart.items.length > 0,
    placeholderData: (previousData) => previousData,
    queryFn: () =>
      fetchSuggestedProducts(
        selectedMerchant,
        selectedGroup
          ? selectedGroup.items.map((item) => item.productId)
          : cart.items.map((item) => item.productId),
        preferredTags
      ),
  })

  if (cart.items.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Link to="/products" className="transition-colors hover:text-[var(--text-primary)]">
            Shop
          </Link>
          <span>/</span>
          <span className="text-[var(--text-primary)]">Cart</span>
        </div>

        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 sm:p-10">
          <div className="max-w-xl space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-[var(--surface-elevated)] text-secondary-400">
              <CartIcon className="h-6 w-6" />
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">Your cart is empty</h1>
            <p className="text-sm leading-7 text-[var(--text-secondary)]">
              Add products from the marketplace to start an order. Merchant carts stay separate so you can review each checkout independently.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button asChild className="h-11 px-4 text-sm">
                <Link to="/products">
                  <Store className="h-4 w-4" />
                  Continue shopping
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </div>
    )
  }

  if (!selectedGroup && merchantGroups.length > 1) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Link to="/products" className="transition-colors hover:text-[var(--text-primary)]">
            Shop
          </Link>
          <span>/</span>
          <span className="text-[var(--text-primary)]">Multicart</span>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">Carts per store</h1>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Choose a store cart to review before continuing to checkout.
                </p>
              </div>
              <div className="text-sm text-[var(--text-secondary)]">
                {merchantGroups.length} store{merchantGroups.length === 1 ? "" : "s"}
                <span className="mx-2 text-[var(--text-muted)]">/</span>
                {cart.totals.count} item{cart.totals.count === 1 ? "" : "s"}
              </div>
            </div>

            {merchantGroups.map((group) => (
              <MerchantOverviewCard
                key={group.merchantPubkey}
                group={group}
                btcUsdRate={btcUsdRateQuery.data?.rate ?? null}
                onCheckout={handleCheckout}
              />
            ))}
          </section>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="text-sm font-medium text-[var(--text-primary)]">All carts</div>
              <div className="mt-3 text-3xl font-semibold text-secondary-400">{cart.totals.count}</div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">
                Items waiting across {merchantGroups.length} merchant cart{merchantGroups.length === 1 ? "" : "s"}.
              </div>
              <Button
                variant="outline"
                className="mt-5 w-full"
                onClick={() => setConfirmClearTarget("all")}
              >
                Clear all carts
              </Button>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--text-primary)]">Related products</h2>
                  <div className="mt-1 min-h-5 text-xs text-[var(--text-muted)]">
                    {relatedProductsQuery.isFetching ? (
                      <span className="inline-flex items-center gap-1.5">
                        <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
                        Refreshing suggestions
                      </span>
                    ) : (
                      "Suggestions based on items in your carts."
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {!relatedProductsQuery.data &&
                  relatedProductsQuery.isLoading &&
                  Array.from({ length: 4 }).map((_, index) => (
                    <div
                      key={index}
                      className="h-[9.5rem] animate-pulse rounded-xl border border-white/10 bg-[var(--surface-elevated)]"
                    />
                  ))}

                {relatedProductsQuery.data?.map((product) => {
                  const cartQuantity =
                    cart.items.find((item) => item.productId === product.id)?.quantity ?? 0

                  return (
                    <RelatedProductRow
                      key={product.id}
                      product={product}
                      btcUsdRate={btcUsdRateQuery.data?.rate ?? null}
                      cartQuantity={cartQuantity}
                      onAdd={() =>
                        cart.addItem({
                          productId: product.id,
                          merchantPubkey: product.pubkey,
                          title: product.title,
                          price: product.price,
                          currency: product.currency,
                          image: product.images[0]?.url,
                          tags: product.tags,
                        })
                      }
                    />
                  )
                })}

                {relatedProductsQuery.data && relatedProductsQuery.data.length === 0 && (
                  <div className="rounded-xl border border-white/10 bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
                    No additional products to suggest yet.
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

        <SignerSwitch
          open={connectOpen}
          onOpenChange={(open) => {
            setConnectOpen(open)
            if (!open) {
              setPendingCheckoutMerchant(null)
            }
          }}
          hideTrigger
        />
      </div>
    )
  }

  if (!selectedGroup) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Link to="/products" className="transition-colors hover:text-[var(--text-primary)]">
          Shop
        </Link>
        <span>/</span>
        {merchantGroups.length > 1 && (
          <>
            <Link to="/cart" className="transition-colors hover:text-[var(--text-primary)]">
              Multicart
            </Link>
            <span>/</span>
          </>
        )}
        <span className="text-[var(--text-primary)]">Cart</span>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
          <div className="flex flex-col gap-5 border-b border-[var(--border)] pb-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">Cart</h1>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Review this merchant cart before heading into checkout.
                </p>
              </div>
              {merchantGroups.length > 1 && (
                <Button asChild variant="ghost" className="h-10 px-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  <Link to="/cart">Back to all carts</Link>
                </Button>
              )}
            </div>

            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <MerchantIdentity merchantPubkey={selectedGroup.merchantPubkey} eyebrow="Shop at" />
              <Button asChild variant="outline" className="h-11 self-start px-4 text-sm lg:self-center">
                <Link to="/store/$pubkey" params={{ pubkey: selectedGroup.merchantPubkey }}>
                  <Store className="h-4 w-4" />
                  Visit store
                </Link>
              </Button>
            </div>
          </div>

          <div className="divide-y divide-[var(--border)]">
            {selectedGroup.items.map((item) => (
              <CartLineItem
                key={item.productId}
                item={item}
                btcUsdRate={btcUsdRateQuery.data?.rate ?? null}
                onIncrement={() =>
                  cart.addItem(
                    {
                      productId: item.productId,
                      merchantPubkey: item.merchantPubkey,
                      title: item.title,
                      price: item.price,
                      currency: item.currency,
                      image: item.image,
                    },
                    1
                  )
                }
                onDecrement={() => {
                  if (item.quantity <= 1) {
                    cart.removeItem(item.productId)
                    return
                  }
                  cart.setQuantity(item.productId, item.quantity - 1)
                }}
                onRemove={() => cart.removeItem(item.productId)}
              />
            ))}
          </div>

          <div className="mt-6 flex flex-col gap-4 border-t border-[var(--border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm text-[var(--text-secondary)]">
                Subtotal ({selectedGroup.totalItems} item{selectedGroup.totalItems === 1 ? "" : "s"})
              </div>
              <div className="mt-1 text-2xl font-semibold text-secondary-400">
                {selectedSummary?.primary}
              </div>
              {selectedSummary?.secondary && (
                <div className="mt-1 text-sm text-[var(--text-muted)]">{selectedSummary.secondary}</div>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                className="h-11 px-4 text-sm"
                onClick={() => setConfirmClearTarget(selectedGroup.merchantPubkey)}
              >
                Clear cart
              </Button>
              <Button className="h-11 px-5 text-sm" onClick={() => handleCheckout(selectedGroup.merchantPubkey)}>
                <span className="inline-flex items-center gap-2">
                  <LightningIcon className="h-4 w-4" />
                  Zap out
                </span>
              </Button>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="text-sm font-medium text-[var(--text-primary)]">
              Subtotal ({selectedGroup.totalItems} item{selectedGroup.totalItems === 1 ? "" : "s"})
            </div>
            <div className="mt-3 text-3xl font-semibold text-secondary-400">{selectedSummary?.primary}</div>
            {selectedSummary?.secondary && (
              <div className="mt-1 text-sm text-[var(--text-muted)]">{selectedSummary.secondary}</div>
            )}
            <Button className="mt-5 w-full" onClick={() => handleCheckout(selectedGroup.merchantPubkey)}>
              <span className="inline-flex items-center gap-2">
                <LightningIcon className="h-4 w-4" />
                Zap out
              </span>
            </Button>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">Related products</h2>
                <div className="mt-1 min-h-5 text-xs text-[var(--text-muted)]">
                  {relatedProductsQuery.isFetching ? (
                    <span className="inline-flex items-center gap-1.5">
                      <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
                      Refreshing suggestions
                    </span>
                  ) : (
                    "Suggestions based on items in this cart."
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {!relatedProductsQuery.data &&
                relatedProductsQuery.isLoading &&
                Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-[9.5rem] animate-pulse rounded-xl border border-white/10 bg-[var(--surface-elevated)]"
                  />
                ))}

              {relatedProductsQuery.data?.map((product) => {
                const cartQuantity =
                  cart.items.find((item) => item.productId === product.id)?.quantity ?? 0

                return (
                  <RelatedProductRow
                    key={product.id}
                    product={product}
                    btcUsdRate={btcUsdRateQuery.data?.rate ?? null}
                    cartQuantity={cartQuantity}
                    onAdd={() =>
                      cart.addItem({
                        productId: product.id,
                        merchantPubkey: product.pubkey,
                        title: product.title,
                        price: product.price,
                        currency: product.currency,
                        image: product.images[0]?.url,
                        tags: product.tags,
                      })
                    }
                  />
                )
              })}

              {relatedProductsQuery.data && relatedProductsQuery.data.length === 0 && (
                <div className="rounded-xl border border-white/10 bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
                  No additional products to suggest yet.
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      <Dialog open={confirmClearTarget !== null} onOpenChange={(open) => !open && setConfirmClearTarget(null)}>
        <DialogContent className="border-white/20 bg-[#0d0424] text-[var(--text-primary)] shadow-[0_30px_80px_rgba(0,0,0,0.6)] ring-1 ring-white/10">
          <DialogHeader>
            <DialogTitle>
              {confirmClearTarget === "all" ? "Clear all carts?" : "Clear this cart?"}
            </DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              {confirmClearTarget === "all"
                ? "This will remove every item from all store carts."
                : "This will remove every item from the current store cart."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClearTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmClear}>
              Clear cart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SignerSwitch
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open)
          if (!open) {
            setPendingCheckoutMerchant(null)
          }
        }}
        hideTrigger
      />
    </div>
  )
}
