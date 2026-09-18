import { Check, ShoppingCart } from "lucide-react"
import {
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"
import { Badge } from "./Badge"
import { Button } from "./Button"
import {
  ProductImageFrame,
  type ProductImageFrameImage,
} from "./ProductImageFrame"
import { cn } from "../utils"

export type ProductCardImage = ProductImageFrameImage

export interface ProductCardProps {
  title: string
  /** Optional compact content shown to the right of the title (e.g. a badge). */
  titleAside?: ReactNode
  merchantName: string
  merchantNamePending?: boolean
  images: readonly ProductCardImage[]
  primaryPrice: string
  secondaryPrice?: string | null
  approximateUsdPrice?: string | null
  imageLoading?: "eager" | "lazy"
  /** Disable the image-only hover zoom when a parent supplies card-level motion. */
  disableImageHoverZoom?: boolean
  cartQuantity?: number
  soldOut?: boolean
  /** Optional product controls rendered between identity and price. */
  options?: ReactNode
  /** Optional classes for the product controls wrapper. */
  optionsClassName?: string
  /** Optional classes for the media wrapper. */
  mediaClassName?: string
  /** Existing fulfillment or availability context kept inside the card. */
  notice?: ReactNode
  action?: ReactNode
  onActivate?: () => void
  onMerchantActivate?: () => void
  onInvalidImage?: () => void
  /** Fires when the pointer enters the card root. */
  onPointerEnter?: PointerEventHandler<HTMLDivElement>
  /** Fires when the card root or any descendant receives focus. */
  onFocus?: FocusEventHandler<HTMLDivElement>
  className?: string
}

export function ProductCard({
  title,
  titleAside,
  merchantName,
  merchantNamePending = false,
  images,
  primaryPrice,
  secondaryPrice,
  approximateUsdPrice,
  imageLoading = "lazy",
  disableImageHoverZoom = false,
  cartQuantity = 0,
  soldOut = false,
  options,
  optionsClassName,
  mediaClassName,
  notice,
  action,
  onActivate,
  onMerchantActivate,
  onInvalidImage,
  onPointerEnter,
  onFocus,
  className,
}: ProductCardProps) {
  const firstImage = images[0]

  const merchantNameContent = merchantNamePending ? (
    <span className="inline-block max-w-full animate-pulse truncate leading-5">
      {merchantName}
    </span>
  ) : (
    merchantName
  )

  return (
    <div
      role={onActivate ? "link" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      data-availability={soldOut ? "sold-out" : "available"}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-md)] transition-[border-color,box-shadow,transform,background-color] duration-200 hover:border-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:shadow-[var(--shadow-lg)]",
        onActivate && "cursor-pointer",
        className
      )}
      onClick={onActivate}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (!onActivate || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        onActivate()
      }}
    >
      <ProductImageFrame
        image={firstImage}
        title={title}
        imageLoading={imageLoading}
        enableHoverZoom={!disableImageHoverZoom}
        soldOut={soldOut}
        onInvalidImage={onInvalidImage}
        className={mediaClassName}
      />

      <div className="flex flex-1 flex-col p-3">
        <div className="min-h-[3.25rem] space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-[var(--text-primary)]">
              {title}
            </h3>
            {titleAside || soldOut ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {titleAside}
                {soldOut ? <Badge variant="warning">Sold out</Badge> : null}
              </div>
            ) : null}
          </div>
          {onMerchantActivate ? (
            <button
              type="button"
              className="block w-full min-w-0 max-w-full truncate text-left text-xs leading-5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
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
            <div className="w-full min-w-0 max-w-full truncate text-left text-xs leading-5 text-[var(--text-muted)]">
              {merchantNameContent}
            </div>
          )}
        </div>

        {options ? (
          <div className={cn("pt-3", optionsClassName)}>{options}</div>
        ) : null}

        {notice ? (
          <div
            data-slot="product-notice"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className="mt-3 border-t border-[var(--border)] pt-3 text-xs leading-5 text-[var(--text-secondary)]"
          >
            {notice}
          </div>
        ) : null}

        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <div className="min-w-0 tabular-nums">
            <div className="min-h-5 truncate text-sm font-bold text-secondary-400">
              {primaryPrice}
            </div>
            <div className="min-h-[1rem] truncate text-xs text-[var(--text-muted)]">
              {secondaryPrice ?? "\u00a0"}
            </div>
            {approximateUsdPrice !== undefined ? (
              <div className="min-h-[1rem] truncate text-xs text-[var(--text-muted)]">
                {approximateUsdPrice ?? "\u00a0"}
              </div>
            ) : null}
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
  soldOut?: boolean
  atStockLimit?: boolean
  disabled?: boolean
  disabledLabel?: string
}

export function ProductCartAction({
  title,
  cartQuantity,
  onAddToCart,
  onIncrement,
  onDecrement,
  soldOut = false,
  atStockLimit = false,
  disabled = false,
  disabledLabel = "Unavailable",
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
        variant={soldOut || disabled || cartQuantity > 0 ? "muted" : "primary"}
        size="sm"
        disabled={soldOut || atStockLimit || disabled}
        className={cn(
          "h-7 shrink-0 gap-1 rounded-md px-2.5 text-xs font-medium transition-all duration-200",
          cartQuantity > 0 && !soldOut
            ? "border border-secondary-400/40 bg-secondary-500/10 text-secondary-300 hover:bg-secondary-500/16 [@media(hover:none)]:pointer-events-none [@media(hover:none)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-0 group-focus-within:opacity-0"
            : "",
          cartQuantity > 0 && !soldOut
            ? "[@media(hover:hover)]:group-hover:pointer-events-none group-focus-within:pointer-events-none"
            : "",
          didJustAdd ? "scale-[1.06]" : "scale-100"
        )}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (soldOut || atStockLimit || disabled) return
          onAddToCart()
        }}
      >
        {cartQuantity > 0 && !soldOut ? (
          <Check className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ShoppingCart className="h-3.5 w-3.5 shrink-0" />
        )}
        {soldOut
          ? "Sold out"
          : disabled
            ? disabledLabel
            : cartQuantity > 0
              ? `In cart (${cartQuantity})`
              : "Add"}
      </Button>

      {!soldOut &&
        !disabled &&
        cartQuantity > 0 &&
        onIncrement &&
        onDecrement && (
          <div className="pointer-events-auto absolute inset-0 flex items-center justify-center opacity-100 transition-all duration-200 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
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
                disabled={atStockLimit}
                className="flex h-full w-7 items-center justify-center text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-elevated)] disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={
                  atStockLimit
                    ? `Stock limit reached for ${title}`
                    : `Add one more ${title} to cart`
                }
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (atStockLimit) return
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
    <div className="flex animate-pulse flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)]">
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
