import type { Product } from "@conduit/core"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@conduit/ui"
import { getProductVariationSelectorModel } from "../lib/productVariations"

interface ProductVariationSelectorProps {
  product: Product
  selectedProductId: string
  onSelect: (product: Product) => void
  compact?: boolean
  className?: string
}

export function ProductVariationSelector({
  product,
  selectedProductId,
  onSelect,
  compact = false,
  className,
}: ProductVariationSelectorProps) {
  const model = getProductVariationSelectorModel(product)
  if (!model) return null

  return (
    <div
      className={cn("space-y-1.5", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <label
        className={cn(
          "font-medium text-[var(--text-secondary)]",
          compact ? "text-[11px]" : "text-sm"
        )}
      >
        {model.label}
      </label>
      <Select
        value={selectedProductId}
        onValueChange={(productId) => {
          const option = model.options.find(
            (candidate) => candidate.product.id === productId
          )
          if (option) onSelect(option.product)
        }}
      >
        <SelectTrigger
          aria-label={`Choose ${model.label.toLowerCase()}`}
          className={compact ? "h-8 px-2.5 text-xs" : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {model.options.map((option) => (
            <SelectItem
              key={option.product.id}
              value={option.product.id}
              disabled={option.soldOut}
            >
              {option.label}
              {option.soldOut ? " — Sold out" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
