import { useNavigate } from "@tanstack/react-router"
import { formatPubkey, type Product } from "@conduit/core"
import { Button, Card, cn } from "@conduit/ui"

type ProductGridCardProps = {
  product: Product
  onAddToCart: () => void
}

export function ProductGridCard({ product, onAddToCart }: ProductGridCardProps) {
  const navigate = useNavigate()

  const imageUrl = product.images[0]?.url
  const fallbackUrl = "/images/placeholders/product.png"

  return (
    <Card
      role="link"
      tabIndex={0}
      className={cn(
        "group cursor-pointer overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-md transition-colors duration-300 hover:border-[var(--accent)]"
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
      <div className="relative">
        <div className="aspect-video bg-[var(--background)]">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={product.images[0]?.alt ?? product.title}
              className="h-full w-full object-cover"
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
      </div>

      <div className="grid gap-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="line-clamp-1 text-base font-semibold text-[var(--text-primary)]">
              {product.title}
            </div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">
              {formatPubkey(product.pubkey, 8)}
            </div>
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-bold text-[var(--text-primary)]">
              {product.price} {product.currency}
            </div>
            {product.summary && (
              <div className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">
                {product.summary}
              </div>
            )}
          </div>

          <Button
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onAddToCart()
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function ProductGridCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-md">
      <div className="aspect-video bg-[var(--surface-elevated)]" />
      <div className="grid gap-2 p-3">
        <div className="h-4 w-2/3 rounded bg-[var(--surface-elevated)]" />
        <div className="h-3 w-1/3 rounded bg-[var(--surface-elevated)]" />
        <div className="flex items-end justify-between gap-3 pt-2">
          <div className="grid w-full gap-2">
            <div className="h-5 w-1/2 rounded bg-[var(--surface-elevated)]" />
            <div className="h-3 w-full rounded bg-[var(--surface-elevated)]" />
            <div className="h-3 w-5/6 rounded bg-[var(--surface-elevated)]" />
          </div>
          <div className="h-8 w-16 shrink-0 rounded bg-[var(--surface-elevated)]" />
        </div>
      </div>
    </div>
  )
}
