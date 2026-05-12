import { Check, ImageOff, ShoppingCart } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Button } from "./Button"
import { cn } from "../utils"

export type ProductCardImage = {
  url: string
  alt?: string
}

export interface ProductCardProps {
  title: string
  merchantName: string
  merchantNamePending?: boolean
  images: readonly ProductCardImage[]
  primaryPrice: string
  secondaryPrice?: string | null
  imageLoading?: "eager" | "lazy"
  cartQuantity?: number
  action?: ReactNode
  onActivate?: () => void
  onMerchantActivate?: () => void
  onInvalidImage?: () => void
  className?: string
}

export function ProductCard({
  title,
  merchantName,
  merchantNamePending = false,
  images,
  primaryPrice,
  secondaryPrice,
  imageLoading = "lazy",
  cartQuantity = 0,
  action,
  onActivate,
  onMerchantActivate,
  onInvalidImage,
  className,
}: ProductCardProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const [imageIndex, setImageIndex] = useState(0)
  const activeImage = images[imageIndex]
  const imageKey = images.map((image) => image.url).join("|")

  useEffect(() => {
    setImageFailed(false)
    setImageIndex(0)
  }, [imageKey, title])

  const merchantNameContent = merchantNamePending ? (
    <span className="inline-block max-w-full animate-pulse truncate">
      {merchantName}
    </span>
  ) : (
    merchantName
  )

  return (
    <div
      role={onActivate ? "link" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-md)] transition-[border-color,box-shadow,transform,background-color] duration-200 hover:border-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:shadow-[var(--shadow-lg)]",
        onActivate && "cursor-pointer",
        className
      )}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (!onActivate || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        onActivate()
      }}
    >
      <div className="aspect-[4/3] overflow-hidden border-b border-[var(--border)] bg-[var(--background)]">
        {activeImage && !imageFailed ? (
          <img
            src={activeImage.url}
            alt={activeImage.alt ?? title}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            decoding="async"
            loading={imageLoading}
            onError={() => {
              if (imageIndex < images.length - 1) {
                setImageIndex((current) => current + 1)
                return
              }
              setImageFailed(true)
              onInvalidImage?.()
            }}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--surface-elevated)] text-[var(--text-muted)]">
            <ImageOff className="h-6 w-6" aria-hidden="true" />
            <span className="px-4 text-center text-xs">Image unavailable</span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="min-h-[3.25rem] space-y-1">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-[var(--text-primary)]">
            {title}
          </h3>
          {onMerchantActivate ? (
            <button
              type="button"
              className="truncate text-left text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              aria-label={merchantNamePending ? "Open store" : undefined}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onMerchantActivate()
              }}
            >
              {merchantNameContent}
            </button>
          ) : (
            <div className="truncate text-left text-xs text-[var(--text-muted)]">
              {merchantNameContent}
            </div>
          )}
        </div>

        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <div className="min-w-0">
            <div className="min-h-5 truncate text-sm font-bold text-secondary-400">
              {primaryPrice}
            </div>
            <div className="min-h-[1rem] truncate text-xs text-[var(--text-muted)]">
              {secondaryPrice ?? "\u00a0"}
            </div>
          </div>
          {action ? (
            <div className="relative shrink-0">{action}</div>
          ) : cartQuantity > 0 ? (
            <div className="relative shrink-0">
              <Button
                variant="muted"
                size="sm"
                className="h-7 shrink-0 gap-1 rounded-md border border-secondary-400/40 bg-secondary-500/10 px-2.5 text-xs font-medium text-secondary-300"
              >
                <Check className="h-3.5 w-3.5 shrink-0" />
                In cart ({cartQuantity})
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export interface ProductCartActionProps {
  title: string
  cartQuantity: number
  onAddToCart: () => void
  onIncrement?: () => void
  onDecrement?: () => void
}

export function ProductCartAction({
  title,
  cartQuantity,
  onAddToCart,
  onIncrement,
  onDecrement,
}: ProductCartActionProps) {
  const [didJustAdd, setDidJustAdd] = useState(false)
  const previousQuantityRef = useRef(cartQuantity)

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
    <>
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
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
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
              aria-label={`Remove one ${title} from cart`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
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
              aria-label={`Add one more ${title} to cart`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onIncrement()
              }}
            >
              +
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export function ProductCardSkeleton() {
  return (
    <div className="flex h-full animate-pulse flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)]">
      <div className="aspect-[4/3] bg-[var(--surface-elevated)]" />
      <div className="flex flex-1 flex-col p-3">
        <div className="min-h-[3.25rem] space-y-1.5">
          <div className="h-4 w-4/5 rounded bg-[var(--surface-elevated)]" />
          <div className="h-4 w-3/5 rounded bg-[var(--surface-elevated)]" />
          <div className="h-3 w-1/2 rounded bg-[var(--surface-elevated)]" />
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <div className="space-y-1">
            <div className="h-5 w-20 rounded bg-[var(--surface-elevated)]" />
            <div className="h-3 w-16 rounded bg-[var(--surface-elevated)]" />
          </div>
          <div className="h-7 w-14 rounded bg-[var(--surface-elevated)]" />
        </div>
      </div>
    </div>
  )
}
