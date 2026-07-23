import {
  AlertTriangle,
  ChevronDown,
  Check,
  Copy,
  ReceiptText,
  RefreshCw,
  ShoppingCart,
  Store,
  Trash2,
  Zap,
} from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  formatNpub,
  getCachedMarketplaceProducts,
  getCachedMerchantStorefront,
  getMarketplaceProducts,
  getMerchantStorefront,
  getProfileName,
  getTelemetryCountBucket,
  normalizePubkey,
  pubkeyToNpub,
  recordBrowserTelemetryEvent,
  useProfile,
  type BtcUsdRateQuote,
  type CommercePriceLike,
  type Product,
  type ShopperPriceDisplay,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  cn,
} from "@conduit/ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@conduit/ui"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  MerchantAvatarFallback,
  Nip05TrustIndicator,
  getMerchantDisplayName,
  getProfileNip05,
} from "../components/MerchantIdentity"
import { type CartItem, useCart } from "../hooks/useCart"
import { useCartProductAvailability } from "../hooks/useCartProductAvailability"
import { useShopperPricing } from "../hooks/useShopperPricing"
import { buildCheckoutPricingIntent } from "../lib/checkout-payment"
import {
  createCartItemFromProduct,
  getCartCostSummary,
  getCartItemStockForAvailability,
  groupCartItems,
  isCartProductAvailabilityBlocking,
  type CartProductAvailability,
  type MerchantCartGroup,
} from "../lib/cart-model"

type PriceFormatter = (price: CommercePriceLike) => ShopperPriceDisplay

type CartSearch = {
  merchant?: string
}

type CartSummaryPrice = {
  primary: string
  secondary?: string | null
  canZapOut: boolean
}

export const Route = createFileRoute("/cart")({
  validateSearch: (search: Record<string, unknown>): CartSearch => ({
    merchant:
      typeof search.merchant === "string"
        ? (normalizePubkey(search.merchant) ?? search.merchant)
        : undefined,
  }),
  component: CartPage,
})

function CartIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <ShoppingCart className={className} />
}

function OrderIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <ReceiptText className={className} />
}

function TrashIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Trash2 className={className} />
}

function LightningIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Zap className={className} />
}

function RefreshIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <RefreshCw className={className} />
}

function getCartSummaryPrice(
  items: CartItem[],
  btcUsdRate: BtcUsdRateQuote | null,
  formatPrice: PriceFormatter
): CartSummaryPrice {
  const summary = getCartCostSummary(items, btcUsdRate)
  const pricing = buildCheckoutPricingIntent(items, btcUsdRate)

  if (!summary.itemPricesAvailable || pricing.status !== "ok") {
    return {
      primary:
        pricing.status === "error" && pricing.code === "stale_quote"
          ? "Price conversion is stale"
          : "Price conversion unavailable",
      secondary: `${summary.count} item${summary.count === 1 ? "" : "s"}`,
      canZapOut: false,
    }
  }

  const display = formatPrice({
    price: pricing.totalSats,
    currency: "SATS",
    priceSats: pricing.totalSats,
  })

  return {
    ...display,
    canZapOut: summary.canZapOut,
  }
}

function getCartTelemetryProductType(items: CartItem[]): string {
  const hasDigital = items.some((item) => item.format === "digital")
  const hasPhysical = items.some((item) => item.format !== "digital")

  if (hasDigital && hasPhysical) return "mixed"
  if (hasDigital) return "digital"
  if (hasPhysical) return "physical"
  return "unknown"
}

function getCartTelemetryItemCountBucket(items: CartItem[]): string {
  return getTelemetryCountBucket(
    items.reduce((sum, item) => sum + item.quantity, 0)
  )
}

async function fetchSuggestedProducts(
  merchantPubkey: string | undefined,
  excludedIds: string[],
  preferredTags: string[],
  source: "cache" | "live" = "live"
): Promise<Product[]> {
  const result = merchantPubkey
    ? source === "cache"
      ? await getCachedMerchantStorefront({ merchantPubkey, limit: 48 })
      : await getMerchantStorefront({ merchantPubkey, limit: 48 })
    : source === "cache"
      ? await getCachedMarketplaceProducts({ limit: 120 })
      : await getMarketplaceProducts({ limit: 120 })

  const excludedSet = new Set(excludedIds)
  const preferredTagSet = new Set(
    preferredTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
  )
  const seen = new Set<string>()

  return result.data
    .map((record) => record.product)
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

      if (bTagOverlap !== aTagOverlap) return bTagOverlap - aTagOverlap

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
  className = "",
}: {
  merchantPubkey: string
  className?: string
}) {
  const { data: profile } = useProfile(merchantPubkey)
  const merchantName = getMerchantDisplayName(profile, merchantPubkey)
  const nip05 = getProfileNip05(profile)
  const [copied, setCopied] = useState(false)

  async function copyMerchantNpub(): Promise<void> {
    try {
      await navigator.clipboard.writeText(pubkeyToNpub(merchantPubkey))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      <Link
        to="/store/$pubkey"
        params={{ pubkey: pubkeyToNpub(merchantPubkey) }}
        className="block shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
        aria-label={`Visit ${merchantName} store`}
      >
        <Avatar className="h-12 w-12 border border-[var(--border)]">
          <AvatarImage src={profile?.picture} alt={merchantName} />
          <AvatarFallback>
            <MerchantAvatarFallback />
          </AvatarFallback>
        </Avatar>
      </Link>
      <div className="min-w-0">
        <Link
          to="/store/$pubkey"
          params={{ pubkey: pubkeyToNpub(merchantPubkey) }}
          className="block truncate text-lg font-semibold leading-tight text-[var(--text-primary)] transition-colors hover:text-secondary-300 sm:text-xl"
        >
          {merchantName}
        </Link>
        {nip05 ? (
          <div
            className="mt-1 truncate text-xs font-medium text-[var(--text-muted)]"
            title={nip05}
          >
            <Nip05TrustIndicator pubkey={merchantPubkey} nip05={nip05} />
          </div>
        ) : (
          <button
            type="button"
            className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md text-left font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
            aria-label={
              copied
                ? `Copied ${merchantName} npub`
                : `Copy ${merchantName} npub`
            }
            title={copied ? "Copied" : "Copy npub"}
            onClick={() => void copyMerchantNpub()}
          >
            <span className="truncate">{formatNpub(merchantPubkey, 10)}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

function RelatedProductRow({
  product,
  formatPrice,
  cartQuantity,
  onAdd,
}: {
  product: Product
  formatPrice: PriceFormatter
  cartQuantity: number
  onAdd: () => void
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const imageUrl = product.images[0]?.url
  const price = formatPrice(product)
  const { data: profile } = useProfile(product.pubkey)
  const merchantName = getProfileName(profile)
  const merchantLabel = merchantName ?? formatNpub(product.pubkey, 6)
  const soldOut = product.stock === 0

  if (!imageUrl || imageFailed) return null

  return (
    <div
      className={`grid min-h-[9.5rem] grid-cols-[80px_minmax(0,1fr)] items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 ${
        soldOut ? "opacity-75" : ""
      }`}
    >
      <Link
        to="/products/$productId"
        params={{ productId: product.id }}
        className="shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)]"
      >
        <img
          src={imageUrl}
          alt={product.images[0]?.alt ?? product.title}
          className={`h-20 w-20 object-cover ${
            soldOut ? "grayscale opacity-60" : ""
          }`}
          width={80}
          height={80}
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      </Link>

      <div className="min-w-0 flex-1">
        <Link
          to="/products/$productId"
          params={{ productId: product.id }}
          className="line-clamp-2 text-sm font-medium leading-6 text-[var(--text-primary)] transition-colors hover:text-secondary-300"
        >
          {product.title}
        </Link>
        {soldOut ? (
          <Badge variant="warning" className="mt-1.5">
            Sold out
          </Badge>
        ) : null}
        <Link
          to="/store/$pubkey"
          params={{ pubkey: pubkeyToNpub(product.pubkey) }}
          className={`mt-1 block truncate text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] ${
            merchantName ? "" : "font-mono"
          }`}
        >
          {merchantLabel}
        </Link>
        <div className="mt-2 text-sm font-semibold text-secondary-400">
          {price.primary}
        </div>
        {price.secondary && (
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            {price.secondary}
          </div>
        )}
        <Button
          size="sm"
          variant={cartQuantity > 0 ? "muted" : "outline"}
          className="mt-3 h-9 px-3 text-sm"
          disabled={soldOut}
          onClick={onAdd}
        >
          <CartIcon className="h-4 w-4" />
          {soldOut
            ? "Sold out"
            : cartQuantity > 0
              ? `In cart (${cartQuantity})`
              : "Add"}
        </Button>
      </div>
    </div>
  )
}

function CartLineItem({
  item,
  availability,
  formatPrice,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  item: CartItem
  availability?: CartProductAvailability
  formatPrice: PriceFormatter
  onIncrement: () => void
  onDecrement: () => void
  onRemove: () => void
}) {
  const soldOut = availability?.status === "sold_out"
  const insufficientStock = availability?.status === "insufficient_stock"
  const incrementDisabled =
    isCartProductAvailabilityBlocking(availability) ||
    (typeof availability?.stock === "number" &&
      item.quantity >= availability.stock)
  const linePrice = formatPrice({
    price: item.price * item.quantity,
    currency: item.currency,
    priceSats:
      typeof item.priceSats === "number"
        ? item.priceSats * item.quantity
        : undefined,
    sourcePrice: item.sourcePrice
      ? {
          ...item.sourcePrice,
          amount: item.sourcePrice.amount * item.quantity,
        }
      : undefined,
  })
  const unitPrice = formatPrice(item)

  return (
    <div
      className={`grid grid-cols-[88px_minmax(0,1fr)] gap-4 py-5 sm:grid-cols-[112px_minmax(0,1fr)] lg:grid-cols-[112px_minmax(0,1fr)_minmax(8rem,auto)] lg:items-start ${
        soldOut ? "opacity-80" : ""
      }`}
    >
      <div className="size-[88px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] sm:size-28">
        {item.image && (
          <img
            src={item.image}
            alt={item.title}
            className={`h-full w-full object-cover ${
              soldOut ? "grayscale opacity-60" : ""
            }`}
            loading="lazy"
            onError={(event) => {
              event.currentTarget.style.display = "none"
            }}
          />
        )}
      </div>

      <div className="min-w-0">
        <Link
          to="/products/$productId"
          params={{ productId: item.productId }}
          className="line-clamp-2 text-base font-medium leading-tight text-[var(--text-primary)] transition-colors hover:text-secondary-300 sm:text-lg"
        >
          {item.title}
        </Link>
        {soldOut || insufficientStock ? (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 text-sm text-warning"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span>
              {soldOut
                ? "Sold out. Remove this item before checkout."
                : `Only ${availability?.stock ?? 0} available. Reduce quantity before checkout.`}
            </span>
          </div>
        ) : null}
        <div className="mt-2 text-sm text-[var(--text-secondary)]">
          Qty {item.quantity}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            aria-label={`Remove ${item.title} from cart`}
            onClick={onRemove}
          >
            <TrashIcon className="h-4 w-4" />
          </button>

          <div className="inline-flex h-10 items-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated)]">
            <button
              type="button"
              className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-[var(--surface)]"
              aria-label={`Decrease quantity for ${item.title}`}
              onClick={onDecrement}
            >
              -
            </button>
            <div className="flex h-full min-w-10 items-center justify-center border-x border-[var(--border)] px-3 text-sm font-medium tabular-nums text-[var(--text-primary)]">
              {item.quantity}
            </div>
            <button
              type="button"
              disabled={incrementDisabled}
              className="flex h-full w-10 items-center justify-center text-lg text-[var(--text-primary)] transition-colors hover:bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`Increase quantity for ${item.title}`}
              onClick={onIncrement}
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div className="col-span-2 min-w-0 sm:col-start-2 lg:col-span-1 lg:col-start-auto lg:text-right">
        <div className="text-xl font-semibold text-[var(--text-primary)] sm:text-2xl">
          {linePrice.primary}
        </div>
        <div className="mt-1 text-sm text-[var(--text-muted)]">
          {item.quantity > 1
            ? `${unitPrice.primary} each`
            : (unitPrice.secondary ?? "\u00a0")}
        </div>
      </div>
    </div>
  )
}

function MerchantCartCard({
  group,
  availabilityByProductId,
  availabilityChecking,
  expanded,
  forceExpanded,
  btcUsdRate,
  formatPrice,
  onToggle,
  onCheckout,
  onClear,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  group: MerchantCartGroup
  availabilityByProductId: ReadonlyMap<string, CartProductAvailability>
  availabilityChecking: boolean
  expanded: boolean
  forceExpanded: boolean
  btcUsdRate: BtcUsdRateQuote | null
  formatPrice: PriceFormatter
  onToggle: () => void
  onCheckout: () => void
  onClear: () => void
  onIncrement: (item: CartItem) => void
  onDecrement: (item: CartItem) => void
  onRemove: (item: CartItem) => void
}) {
  const { data: profile } = useProfile(group.merchantPubkey)
  const summary = getCartSummaryPrice(group.items, btcUsdRate, formatPrice)
  const hasSoldOutItems = group.items.some(
    (item) => availabilityByProductId.get(item.productId)?.status === "sold_out"
  )
  const hasInsufficientStockItems = group.items.some(
    (item) =>
      availabilityByProductId.get(item.productId)?.status ===
      "insufficient_stock"
  )
  const hasUnavailableItems = hasSoldOutItems || hasInsufficientStockItems
  const canZapOut =
    !hasUnavailableItems && Boolean(profile?.lud16) && summary.canZapOut
  const primaryActionLabel = availabilityChecking
    ? "Checking stock"
    : hasSoldOutItems && hasInsufficientStockItems
      ? "Update cart items"
      : hasSoldOutItems
        ? "Remove sold-out items"
        : hasInsufficientStockItems
          ? "Reduce item quantity"
          : canZapOut
            ? "Zap out"
            : "Order"
  const reviewItemsLabel = `${expanded ? "Hide" : "Review"} ${group.totalItems} item${group.totalItems === 1 ? "" : "s"}`
  const detailsId = `cart-group-${group.merchantPubkey}`

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <MerchantIdentity
            merchantPubkey={group.merchantPubkey}
            className="flex-1"
          />
          <Button
            variant="outline"
            className="h-10 shrink-0 px-3 text-sm"
            aria-label="Clear store cart"
            onClick={onClear}
          >
            <TrashIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Clear store cart</span>
            <span className="sm:hidden">Clear</span>
          </Button>
        </div>

        <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="text-3xl font-semibold leading-tight text-secondary-400 sm:text-4xl">
              <span className="tabular-nums">{summary.primary}</span>
            </div>
            {summary.secondary && (
              <div className="mt-1 text-sm text-[var(--text-muted)]">
                {summary.secondary}
              </div>
            )}
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap lg:w-auto lg:justify-end">
            <Button
              className="h-11 px-5 text-sm"
              disabled={availabilityChecking || hasUnavailableItems}
              onClick={onCheckout}
            >
              {canZapOut ? (
                <LightningIcon className="h-4 w-4" />
              ) : (
                <OrderIcon className="h-4 w-4" />
              )}
              {primaryActionLabel}
            </Button>
            {!forceExpanded && (
              <Button
                variant="outline"
                className="h-11 px-4 text-sm"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={onToggle}
              >
                <CartIcon className="h-4 w-4" />
                {reviewItemsLabel}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    expanded && "rotate-180"
                  )}
                  aria-hidden="true"
                />
              </Button>
            )}
          </div>
        </div>

        {expanded && (
          <div id={detailsId} className="mt-5 border-t border-[var(--border)]">
            <div className="divide-y divide-[var(--border)]">
              {group.items.map((item) => (
                <CartLineItem
                  key={item.productId}
                  item={item}
                  availability={availabilityByProductId.get(item.productId)}
                  formatPrice={formatPrice}
                  onIncrement={() => onIncrement(item)}
                  onDecrement={() => onDecrement(item)}
                  onRemove={() => onRemove(item)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function CartPage() {
  const cart = useCart()
  const cartAvailability = useCartProductAvailability(cart.items)
  const search = Route.useSearch()
  const navigate = useNavigate()
  const shopperPricing = useShopperPricing()
  const [confirmClearTarget, setConfirmClearTarget] = useState<
    "all" | string | null
  >(null)

  const merchantGroups = useMemo(() => groupCartItems(cart.items), [cart.items])
  const expandedGroup = merchantGroups.find(
    (group) => group.merchantPubkey === search.merchant
  )
  const expandedMerchant = expandedGroup?.merchantPubkey
  const relatedSourceItems = expandedGroup?.items ?? cart.items
  const preferredTags = useMemo(
    () => relatedSourceItems.flatMap((item) => item.tags ?? []),
    [relatedSourceItems]
  )
  const continueToCheckout = useCallback(
    (merchant: string): void => {
      navigate({
        to: "/checkout",
        search: { merchant: pubkeyToNpub(merchant) },
      })
    },
    [navigate]
  )

  const setExpandedMerchant = useCallback(
    (merchantPubkey: string | undefined): void => {
      navigate({
        to: "/cart",
        search: {
          merchant: merchantPubkey ? pubkeyToNpub(merchantPubkey) : undefined,
        },
        replace: true,
      })
    },
    [navigate]
  )

  function handleCheckout(merchant: string): void {
    const group = merchantGroups.find(
      (entry) => entry.merchantPubkey === merchant
    )
    if (
      group?.items.some((item) =>
        isCartProductAvailabilityBlocking(
          cartAvailability.availabilityByProductId.get(item.productId)
        )
      )
    ) {
      return
    }
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "checkout_initiated",
      properties: {
        count_bucket: getCartTelemetryItemCountBucket(group?.items ?? []),
        product_type: getCartTelemetryProductType(group?.items ?? []),
        status: "success",
        surface: "cart",
      },
    })

    continueToCheckout(merchant)
  }

  useEffect(() => {
    if (!search.merchant) return
    if (merchantGroups.length === 0) return
    if (expandedGroup) return
    setExpandedMerchant(undefined)
  }, [
    expandedGroup,
    merchantGroups.length,
    search.merchant,
    setExpandedMerchant,
  ])

  function handleConfirmClear(): void {
    if (!confirmClearTarget) return

    if (confirmClearTarget === "all") {
      cart.clear()
    } else {
      cart.clearMerchant(confirmClearTarget)
      if (expandedMerchant === confirmClearTarget) {
        setExpandedMerchant(undefined)
      }
    }

    setConfirmClearTarget(null)
  }

  const relatedProductsQueryKey = [
    "cart-related-products",
    expandedMerchant ?? "all",
    relatedSourceItems
      .map((item) => item.productId)
      .sort()
      .join(":"),
    preferredTags.slice().sort().join(":"),
  ] as const

  const cachedRelatedProductsQuery = useQuery({
    queryKey: ["cache", ...relatedProductsQueryKey],
    enabled: cart.items.length > 0,
    queryFn: () =>
      fetchSuggestedProducts(
        expandedMerchant,
        relatedSourceItems.map((item) => item.productId),
        preferredTags,
        "cache"
      ),
    staleTime: 15_000,
  })

  const relatedProductsQuery = useQuery({
    queryKey: ["live", ...relatedProductsQueryKey],
    enabled: cart.items.length > 0,
    placeholderData: (previousData) => previousData,
    queryFn: () =>
      fetchSuggestedProducts(
        expandedMerchant,
        relatedSourceItems.map((item) => item.productId),
        preferredTags,
        "live"
      ),
  })
  const relatedProducts =
    relatedProductsQuery.data && relatedProductsQuery.data.length > 0
      ? relatedProductsQuery.data
      : (cachedRelatedProductsQuery.data ?? [])
  const isRelatedProductsInitialLoading =
    relatedProducts.length === 0 &&
    relatedProductsQuery.isLoading &&
    cachedRelatedProductsQuery.isLoading

  const allCartsSummary = getCartSummaryPrice(
    cart.items,
    shopperPricing.quote,
    shopperPricing.formatPrice
  )
  const clearCartDialog = (
    <Dialog
      open={confirmClearTarget !== null}
      onOpenChange={(open) => !open && setConfirmClearTarget(null)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {confirmClearTarget === "all"
              ? "Clear all carts?"
              : "Clear this store cart?"}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-secondary)]">
            {confirmClearTarget === "all"
              ? "This will remove every item from all store carts."
              : "This will remove every item from this store cart."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmClearTarget(null)}>
            Cancel
          </Button>
          <Button onClick={handleConfirmClear}>Clear cart</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  if (cart.items.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
          <Link
            to="/products"
            className="transition-colors hover:text-[var(--text-primary)]"
          >
            Shop
          </Link>
          <span>/</span>
          <span className="text-[var(--text-primary)]">Cart</span>
        </div>

        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 sm:p-10">
          <div className="max-w-xl space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-400">
              <CartIcon className="h-6 w-6" />
            </div>
            <h1 className="text-4xl font-semibold text-[var(--text-primary)]">
              Your cart is empty
            </h1>
            <p className="text-sm leading-7 text-[var(--text-secondary)]">
              Add products from the marketplace to start an order. Store carts
              stay grouped here so order and zap flows remain merchant-aware.
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Link
          to="/products"
          className="transition-colors hover:text-[var(--text-primary)]"
        >
          Shop
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">Cart</span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-4xl font-semibold text-[var(--text-primary)]">
                Cart
              </h1>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Review items by store, then order or zap out with one merchant
                at a time.
              </p>
            </div>
            <div className="text-sm tabular-nums text-[var(--text-secondary)]">
              {merchantGroups.length} store
              {merchantGroups.length === 1 ? "" : "s"}
              <span className="mx-2 text-[var(--text-muted)]">/</span>
              {cart.totals.count} item{cart.totals.count === 1 ? "" : "s"}
            </div>
          </div>

          {cartAvailability.hasUnavailableItems ? (
            <div
              role="alert"
              className="flex flex-col gap-4 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm text-[var(--text-secondary)] sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className="mt-0.5 h-5 w-5 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <div>
                  <div className="font-medium text-[var(--text-primary)]">
                    {cartAvailability.hasInsufficientStockItems
                      ? "Some cart quantities exceed available stock"
                      : "Your cart contains a sold-out item"}
                  </div>
                  <p className="mt-1 leading-6">
                    {cartAvailability.hasInsufficientStockItems
                      ? "Reduce affected quantities to the current available stock, and remove any sold-out items before sending this order."
                      : "Remove sold-out items before sending this order. Other store carts remain available."}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                disabled={cartAvailability.isChecking}
                onClick={() => void cartAvailability.refresh()}
              >
                <RefreshIcon
                  className={`h-4 w-4 ${
                    cartAvailability.isChecking ? "animate-spin" : ""
                  }`}
                />
                {cartAvailability.isChecking
                  ? "Checking availability"
                  : "Check again"}
              </Button>
            </div>
          ) : null}

          {search.merchant && !expandedGroup && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
              That store cart is not in your cart anymore.
            </div>
          )}

          {merchantGroups.map((group) => {
            const forceExpanded = merchantGroups.length === 1
            const expanded =
              forceExpanded || expandedMerchant === group.merchantPubkey

            return (
              <MerchantCartCard
                key={group.merchantPubkey}
                group={group}
                availabilityByProductId={
                  cartAvailability.availabilityByProductId
                }
                availabilityChecking={cartAvailability.isChecking}
                expanded={expanded}
                forceExpanded={forceExpanded}
                btcUsdRate={shopperPricing.quote}
                formatPrice={shopperPricing.formatPrice}
                onToggle={() =>
                  setExpandedMerchant(
                    expandedMerchant === group.merchantPubkey
                      ? undefined
                      : group.merchantPubkey
                  )
                }
                onCheckout={() => handleCheckout(group.merchantPubkey)}
                onClear={() => setConfirmClearTarget(group.merchantPubkey)}
                onIncrement={(item) =>
                  cart.addItem(
                    {
                      productId: item.productId,
                      merchantPubkey: item.merchantPubkey,
                      title: item.title,
                      price: item.price,
                      currency: item.currency,
                      priceSats: item.priceSats,
                      sourcePrice: item.sourcePrice,
                      sourceShippingCost: item.sourceShippingCost,
                      image: item.image,
                      tags: item.tags,
                      format: item.format,
                      shippingCostSats: item.shippingCostSats,
                      shippingOptionId: item.shippingOptionId,
                      shippingOptionDTag: item.shippingOptionDTag,
                      shippingCountries: item.shippingCountries,
                      shippingCountryRules: item.shippingCountryRules,
                      publicZapEnabled: item.publicZapEnabled,
                      zapMessagePolicy: item.zapMessagePolicy,
                      publicZapPolicyKnown: item.publicZapPolicyKnown,
                      stock: getCartItemStockForAvailability(
                        item,
                        cartAvailability.availabilityByProductId.get(
                          item.productId
                        )
                      ),
                    },
                    1
                  )
                }
                onDecrement={(item) => {
                  if (item.quantity <= 1) {
                    cart.removeItem(item.productId)
                    return
                  }
                  cart.setQuantity(item.productId, item.quantity - 1)
                }}
                onRemove={(item) => cart.removeItem(item.productId)}
              />
            )
          })}
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <div className="text-sm font-medium text-[var(--text-primary)]">
              All carts
            </div>
            <div className="mt-3 text-3xl font-semibold text-secondary-400">
              {allCartsSummary.primary}
            </div>
            {allCartsSummary.secondary && (
              <div className="mt-1 text-sm text-[var(--text-muted)]">
                {allCartsSummary.secondary}
              </div>
            )}
            <div className="mt-3 text-sm text-[var(--text-secondary)]">
              {cart.totals.count} item{cart.totals.count === 1 ? "" : "s"}{" "}
              across {merchantGroups.length} store
              {merchantGroups.length === 1 ? "" : "s"}.
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
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">
                  Related products
                </h2>
                <div className="mt-1 min-h-5 text-xs text-[var(--text-muted)]">
                  {relatedProductsQuery.isFetching ? (
                    <span className="inline-flex items-center gap-1.5">
                      <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
                      Refreshing suggestions
                    </span>
                  ) : expandedGroup ? (
                    "Suggestions based on the expanded store cart."
                  ) : (
                    "Suggestions based on items in your carts."
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {isRelatedProductsInitialLoading && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
                  Checking cached suggestions and nearby relay results.
                </div>
              )}

              {relatedProducts.map((product) => {
                const cartQuantity =
                  cart.items.find((item) => item.productId === product.id)
                    ?.quantity ?? 0

                return (
                  <RelatedProductRow
                    key={product.id}
                    product={product}
                    formatPrice={shopperPricing.formatPrice}
                    cartQuantity={cartQuantity}
                    onAdd={() =>
                      cart.addItem(createCartItemFromProduct(product))
                    }
                  />
                )
              })}

              {!isRelatedProductsInitialLoading &&
                relatedProducts.length === 0 && (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
                    No additional products to suggest yet.
                  </div>
                )}
            </div>
          </div>
        </aside>
      </div>

      {clearCartDialog}
    </div>
  )
}
