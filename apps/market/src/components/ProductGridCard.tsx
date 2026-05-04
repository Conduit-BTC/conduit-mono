import { Check, ShoppingCart } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { formatPubkey, useProfile, type Product } from "@conduit/core"
import { Button, cn } from "@conduit/ui"
import { getProductPriceDisplay } from "../lib/pricing"

type ProductGridCardProps = {
  product: Product
  merchantName?: string
  imageLoading?: "eager" | "lazy"
  onAddToCart?: () => void
  btcUsdRate?: number | null
  cartQuantity?: number
  onIncrement?: () => void
  onDecrement?: () => void
  onInvalidImage?: (productId: string) => void
}

export function ProductGridCard({
  product,
  merchantName: merchantNameOverride,
  imageLoading = "lazy",
  onAddToCart,
  btcUsdRate,
  cartQuantity = 0,
  onIncrement,
  onDecrement,
  onInvalidImage,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const { data: profile } = useProfile(
    merchantNameOverride ? undefined : product.pubkey
  )
  const [didJustAdd, setDidJustAdd] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [imageIndex, setImageIndex] = useState(0)
  const previousQuantityRef = useRef(cartQuantity)

  const imageCandidates = product.images.filter((image) =>
    /^https?:\/\//i.test(image.url)
  )
  const activeImage = imageCandidates[imageIndex]
  const imageUrl = activeImage?.url

  const merchantName =
    merchantNameOverride ||
    profile?.displayName ||
    profile?.name ||
    formatPubkey(product.pubkey, 6)
  const { primary, secondary } = getProductPriceDisplay(
    product,
    btcUsdRate ?? null
  )

  useEffect(() => {
    setImageFailed(false)
    setImageIndex(0)
  }, [product.id])

  useEffect(() => {
    if (cartQuantity > previousQuantityRef.current) {
      setDidJustAdd(true)
      const timeoutId = window.setTimeout(() => setDidJustAdd(false), 220)
      previousQuantityRef.current = cartQuantity
      return () => window.clearTimeout(timeoutId)
    }

    previousQuantityRef.current = cartQuantity
    return undefined
  }, [cartQuantity])

  if (!imageUrl || imageFailed) return null

  return (
    <div
      role="link"
      tabIndex={0}
      className={cn(
        "group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-md)] transition-[border-color,box-shadow,transform,background-color] duration-200 hover:border-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:shadow-[var(--shadow-lg)]"
      )}
      onClick={() =>
        navigate({
          to: "/products/$productId",
          params: { productId: product.id },
        })
      }
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        navigate({
          to: "/products/$productId",
          params: { productId: product.id },
        })
      }}
    >
      <div className="aspect-[4/3] overflow-hidden border-b border-[var(--border)] bg-[var(--background)]">
        <img
          src={imageUrl}
          alt={activeImage?.alt ?? product.title}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          decoding="async"
          loading={imageLoading}
          onError={() => {
            if (imageIndex < imageCandidates.length - 1) {
              setImageIndex((current) => current + 1)
              return
            }
            setImageFailed(true)
            onInvalidImage?.(product.id)
          }}
        />
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="min-h-[3.25rem] space-y-1">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-[var(--text-primary)]">
            {product.title}
          </h3>
          <button
            type="button"
            className="truncate text-left text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              navigate({
                to: "/store/$pubkey",
                params: { pubkey: product.pubkey },
              })
            }}
          >
            {merchantName}
          </button>
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <div className="min-w-0">
            <div className="text-sm font-bold text-secondary-400">
              {primary}
            </div>
            <div className="min-h-[1rem] truncate text-xs text-[var(--text-muted)]">
              {secondary ?? "\u00a0"}
            </div>
          </div>
          {onAddToCart && (
            <div className="relative shrink-0">
              <Button
                variant={cartQuantity > 0 ? "muted" : "primary"}
                size="sm"
                className={cn(
                  "h-7 shrink-0 gap-1 rounded-md px-2.5 text-xs font-medium transition-all duration-200",
                  cartQuantity > 0
                    ? "border border-secondary-400/40 bg-secondary-500/10 text-secondary-300 hover:bg-secondary-500/16 md:group-hover:opacity-0"
                    : "",
                  cartQuantity > 0 ? "md:group-hover:pointer-events-none" : "",
                  didJustAdd ? "scale-[1.06]" : "scale-100"
                )}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onAddToCart()
                }}
              >
                {cartQuantity > 0 ? (
                  <Check className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ShoppingCart className="h-3.5 w-3.5 shrink-0" />
                )}
                {cartQuantity > 0 ? `In cart (${cartQuantity})` : "Add"}
              </Button>

              {cartQuantity > 0 && onIncrement && onDecrement && (
                <div className="pointer-events-none absolute inset-0 hidden items-center justify-center opacity-0 transition-all duration-200 md:flex md:group-hover:pointer-events-auto md:group-hover:opacity-100">
                  <div className="flex h-7 items-center overflow-hidden rounded-md border border-secondary-400/40 bg-[var(--surface)] shadow-md">
                    <button
                      type="button"
                      className="flex h-full w-7 items-center justify-center text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-elevated)]"
                      aria-label={`Remove one ${product.title} from cart`}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onDecrement()
                      }}
                    >
                      -
                    </button>
                    <div className="flex h-full min-w-8 items-center justify-center border-x border-[var(--border)] px-1 text-xs font-medium text-[var(--text-primary)]">
                      {cartQuantity}
                    </div>
                    <button
                      type="button"
                      className="flex h-full w-7 items-center justify-center text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-elevated)]"
                      aria-label={`Add one more ${product.title} to cart`}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onIncrement()
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ProductGridCardSkeleton() {
  return (
    <div className="flex h-full animate-pulse flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="aspect-[4/3] bg-[var(--surface-elevated)]" />
      <div className="flex flex-1 flex-col p-3">
        <div className="space-y-1.5">
          <div className="h-4 w-4/5 rounded bg-[var(--surface-elevated)]" />
          <div className="h-4 w-3/5 rounded bg-[var(--surface-elevated)]" />
          <div className="h-3 w-1/2 rounded bg-[var(--surface-elevated)]" />
        </div>
        <div className="mt-auto flex items-end justify-between pt-3">
          <div className="space-y-1">
            <div className="h-4 w-20 rounded bg-[var(--surface-elevated)]" />
            <div className="h-3 w-16 rounded bg-[var(--surface-elevated)]" />
          </div>
          <div className="h-7 w-14 rounded bg-[var(--surface-elevated)]" />
        </div>
      </div>
    </div>
  )
}
