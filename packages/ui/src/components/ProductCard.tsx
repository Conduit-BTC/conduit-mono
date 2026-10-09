import { Check, Minus, Plus, ShoppingCart } from "lucide-react"
import {
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react"
import type { ProductImage } from "@conduit/core"
import { Badge } from "./Badge"
import { Button } from "./Button"
import { ProductImageFrame } from "./ProductImageFrame"
import { cn } from "../utils"

export type ProductCardImage = ProductImage

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
  /** Multiple merchant management actions need their own row. */
  actionLayout?: "inline" | "stacked"
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
  actionLayout = "inline",
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
        "group flex h-full min-w-0 flex-col rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)]",
        onActivate &&
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
        className
      )}
      onClick={onActivate}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          !onActivate ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return
        event.preventDefault()
        onActivate()
      }}
    >
      <ProductImageFrame
        image={firstImage}
        title={title}
        imageLoading={imageLoading}
        enableHoverZoom={Boolean(onActivate) && !disableImageHoverZoom}
        soldOut={soldOut}
        onInvalidImage={onInvalidImage}
        className={cn("rounded-t-[calc(var(--radius-md)-1px)]", mediaClassName)}
      />

      <div className="flex min-w-0 flex-1 flex-col p-2 sm:p-3">
        <div className="min-w-0 space-y-0.5 sm:space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h3
              title={title}
              className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-[var(--text-primary)]"
            >
              {title}
            </h3>
            {titleAside || (soldOut && !action) ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {titleAside}
                {soldOut && !action ? (
                  <Badge variant="warning">Sold out</Badge>
                ) : null}
              </div>
            ) : null}
          </div>
          {onMerchantActivate ? (
            <button
              type="button"
              className="block min-h-11 sm:min-h-6 w-full min-w-0 max-w-full truncate text-left text-sm font-medium leading-normal text-[var(--text-secondary)] underline-offset-4 transition-colors hover:text-[var(--text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              title={merchantName}
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
            <div
              title={merchantName}
              className="w-full min-w-0 max-w-full truncate text-left text-sm font-medium leading-normal text-[var(--text-secondary)]"
            >
              {merchantNameContent}
            </div>
          )}
        </div>

        {options ? (
          <div
            className={cn("pt-2", optionsClassName)}
            onClick={(event) => event.stopPropagation()}
          >
            {options}
          </div>
        ) : null}

        {notice ? (
          <div
            data-slot="product-notice"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className="mt-3 border-t border-[var(--border)] pt-3 text-sm leading-normal text-[var(--text-secondary)]"
          >
            {notice}
          </div>
        ) : null}

        <div
          className={cn(
            "mt-auto flex min-w-0 flex-wrap items-end justify-between gap-1.5 pt-2 sm:gap-2"
          )}
        >
          <div
            data-slot="product-price"
            className={cn(
              "min-w-min flex-1 tabular-nums",
              actionLayout === "stacked" && "basis-full",
              cartQuantity > 0 && "min-w-20"
            )}
          >
            <div
              title={primaryPrice.replace(/[~≈]\s*/g, "")}
              className={cn(
                "min-h-5 whitespace-nowrap text-sm font-semibold",
                /₿|\bsats?\b|\bBTC\b/i.test(primaryPrice)
                  ? "text-[var(--bitcoin-price)]"
                  : "text-[var(--text-primary)]"
              )}
            >
              {primaryPrice.replace(/[~≈]\s*/g, "")}
            </div>
            <div className="min-h-[1rem] w-0 min-w-full truncate text-xs text-[var(--text-secondary)]">
              {secondaryPrice?.replace(/[~≈]\s*/g, "") ?? "\u00a0"}
            </div>
            {approximateUsdPrice !== undefined ? (
              <div className="min-h-[1rem] w-0 min-w-full truncate text-xs text-[var(--text-secondary)]">
                {approximateUsdPrice?.replace(/[~≈]\s*/g, "") ?? "\u00a0"}
              </div>
            ) : null}
          </div>
          {action ? (
            <div className="relative shrink-0">{action}</div>
          ) : cartQuantity > 0 ? (
            <div className="relative shrink-0">
              <span className="inline-flex items-center gap-1.5 text-sm text-[var(--success-text)]">
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
                In cart ({cartQuantity})
              </span>
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
  const canAdjust =
    !soldOut && !disabled && cartQuantity > 0 && onIncrement && onDecrement
  return (
    <div
      role="group"
      aria-label={`Cart action for ${title}`}
      className={cn(
        "inline-flex items-center",
        canAdjust &&
          "overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]"
      )}
    >
      <Button
        variant={
          canAdjust
            ? "ghost"
            : soldOut || disabled || cartQuantity > 0
              ? "muted"
              : "primary"
        }
        size={canAdjust ? "icon" : "sm"}
        className={
          canAdjust
            ? "rounded-none sm:size-8"
            : cn(
                "min-w-11 gap-1 px-2 min-[360px]:gap-1.5",
                soldOut && "w-11 px-1 sm:w-auto sm:px-2",
                disabled &&
                  !soldOut &&
                  "px-1 text-xs min-[360px]:px-2 min-[360px]:text-sm"
              )
        }
        disabled={canAdjust ? false : soldOut || atStockLimit || disabled}
        aria-label={
          canAdjust
            ? `Remove one ${title} from cart`
            : !soldOut && !disabled && cartQuantity === 0
              ? `Add ${title} to cart`
              : undefined
        }
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (canAdjust) onDecrement?.()
          else if (!soldOut && !atStockLimit && !disabled) onAddToCart()
        }}
      >
        {canAdjust ? (
          <Minus className="size-3.5" aria-hidden="true" />
        ) : (
          <>
            {!soldOut && !disabled && (
              <ShoppingCart className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {soldOut ? (
              "Sold out"
            ) : disabled ? (
              disabledLabel
            ) : cartQuantity > 0 ? (
              `In cart (${cartQuantity})`
            ) : (
              <span className="hidden min-[360px]:inline">Add</span>
            )}
          </>
        )}
      </Button>
      {canAdjust && (
        <>
          <span
            className="min-w-8 text-center text-sm tabular-nums"
            aria-live="polite"
            aria-atomic="true"
          >
            {cartQuantity}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-none sm:size-8"
            disabled={atStockLimit}
            aria-label={
              atStockLimit
                ? `Stock limit reached for ${title}`
                : `Add one more ${title} to cart`
            }
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!atStockLimit) onIncrement?.()
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  )
}

export function ProductCardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="aspect-[4/3] rounded-t-[calc(var(--radius-md)-1px)] border-b border-[var(--border)] bg-[var(--surface-elevated)]" />
      <div className="flex min-w-0 flex-1 flex-col p-2 sm:p-3">
        <div className="min-w-0 space-y-1.5">
          <div className="h-4 w-4/5 rounded bg-[var(--surface-elevated)]" />
          <div className="h-4 w-3/5 rounded bg-[var(--surface-elevated)]" />
          <div className="h-3 w-1/2 rounded bg-[var(--surface-elevated)]" />
        </div>
        <div
          className={cn(
            "mt-auto flex min-w-0 items-end justify-between gap-2 pt-2",
            "flex-wrap"
          )}
        >
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
