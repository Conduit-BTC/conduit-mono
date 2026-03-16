import { useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { formatPubkey, useProfile, type Product } from "@conduit/core"
import { Button, cn } from "@conduit/ui"
import { getProductPriceDisplay } from "../lib/pricing"

type ProductGridCardProps = {
  product: Product
  onAddToCart?: () => void
  btcUsdRate?: number | null
  cartQuantity?: number
  onIncrement?: () => void
  onDecrement?: () => void
}

export function ProductGridCard({
  product,
  onAddToCart,
  btcUsdRate,
  cartQuantity = 0,
  onIncrement,
  onDecrement,
}: ProductGridCardProps) {
  const navigate = useNavigate()
  const { data: profile } = useProfile(product.pubkey)
  const [didJustAdd, setDidJustAdd] = useState(false)
  const previousQuantityRef = useRef(cartQuantity)

  const imageUrl = product.images[0]?.url
  const fallbackUrl = "/images/placeholders/product.png"

  const merchantName = profile?.displayName || profile?.name || formatPubkey(product.pubkey, 6)
  const { primary, secondary } = getProductPriceDisplay(product, btcUsdRate ?? null)

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

  return (
    <div
      role="link"
      tabIndex={0}
      className={cn(
        "group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-white/16 bg-[color-mix(in_oklab,var(--surface)_92%,white)] text-[var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_10px_24px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow,transform,background-color] duration-200 hover:border-white/26 hover:bg-[color-mix(in_oklab,var(--surface)_89%,white)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_32px_rgba(0,0,0,0.16)]"
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
      <div className="aspect-[4/3] overflow-hidden border-b border-white/10 bg-[color-mix(in_oklab,var(--background)_96%,white)]">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={product.images[0]?.alt ?? product.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).src = fallbackUrl
            }}
          />
        ) : (
          <img
            src={fallbackUrl}
            alt=""
            className="h-full w-full object-cover opacity-90"
            loading="lazy"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="min-h-[3.25rem] space-y-1">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-[var(--text-primary)]">
            {product.title}
          </h3>
          <p className="truncate text-xs text-[var(--text-muted)]">{merchantName}</p>
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <div className="min-w-0">
            <div className="text-sm font-bold text-secondary-400">{primary}</div>
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
                  <svg
                    className="h-3.5 w-3.5 shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  <svg
                    className="h-3.5 w-3.5 shrink-0"
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
                )}
                {cartQuantity > 0 ? `In cart (${cartQuantity})` : "Add"}
              </Button>

              {cartQuantity > 0 && onIncrement && onDecrement && (
                <div className="pointer-events-none absolute inset-0 hidden items-center justify-center opacity-0 transition-all duration-200 md:flex md:group-hover:pointer-events-auto md:group-hover:opacity-100">
                  <div className="flex h-7 items-center overflow-hidden rounded-md border border-secondary-400/40 bg-[var(--surface)] shadow-[0_6px_16px_rgba(0,0,0,0.28)]">
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
                    <div className="flex h-full min-w-8 items-center justify-center border-x border-white/10 px-1 text-xs font-medium text-[var(--text-primary)]">
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
