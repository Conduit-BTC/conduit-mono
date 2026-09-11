import { useEffect, useRef } from "react"
import type { Product } from "@conduit/core"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@conduit/ui"
import {
  getProductSelectionForAxisValue,
  getProductVariationSelectorModel,
  type MarketProductFamily,
} from "../lib/productVariations"

interface ProductVariationSelectorProps {
  family: MarketProductFamily
  selectedProduct: Product
  onSelect: (product: Product) => void
  compact?: boolean
  className?: string
  onOpenChange?: (open: boolean) => void
}

export function ProductVariationSelector({
  family,
  selectedProduct,
  onSelect,
  compact = false,
  className,
  onOpenChange,
}: ProductVariationSelectorProps) {
  const model = getProductVariationSelectorModel(family, selectedProduct)
  const openAxes = useRef(new Set<string>())
  const modelKey = model?.axes.map((axis) => axis.key).join("\0") ?? null

  useEffect(() => {
    const axes = openAxes.current
    return () => {
      axes.clear()
      onOpenChange?.(false)
    }
  }, [modelKey, onOpenChange])

  if (!model) return null

  // Product cards and rows are clickable, so selector interaction must stay
  // inside the control until the shopper makes an explicit variation choice.
  return (
    <div
      className={cn("space-y-2", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {model.axes.map((axis) => (
        <div key={axis.key} className="space-y-1.5">
          <label
            className={cn(
              "font-medium text-[var(--text-secondary)]",
              compact ? "text-[11px]" : "text-sm"
            )}
          >
            {axis.label}
          </label>
          <Select
            value={axis.selectedValue}
            onOpenChange={(open) => {
              if (open) {
                openAxes.current.add(axis.key)
              } else {
                openAxes.current.delete(axis.key)
              }
              onOpenChange?.(openAxes.current.size > 0)
            }}
            onValueChange={(value) => {
              const next = getProductSelectionForAxisValue(
                family,
                selectedProduct,
                axis.key,
                value
              )
              if (next) onSelect(next)
            }}
          >
            <SelectTrigger
              aria-label={`Choose ${axis.label.toLowerCase()}`}
              className={compact ? "h-8 px-2.5 text-xs" : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {axis.options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled || option.soldOut}
                >
                  {option.label}
                  {option.soldOut ? " — Sold out" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  )
}
