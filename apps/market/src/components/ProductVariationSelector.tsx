import { useId } from "react"
import type { Product } from "@conduit/core"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  cn,
} from "@conduit/ui"
import {
  getProductSelectionForAxisValue,
  getProductVariationSelectorModel,
  type MarketProductFamily,
  type ProductVariationAxisOption,
} from "../lib/productVariations"

interface ProductVariationSelectorProps {
  family: MarketProductFamily
  selectedProduct: Product
  onSelect: (product: Product) => void
  compact?: boolean
  className?: string
}

function ProductVariationSelectItem({
  option,
}: {
  option: ProductVariationAxisOption
}) {
  return (
    <SelectItem
      value={option.value}
      disabled={option.disabled || option.soldOut}
    >
      {option.label}
      {option.soldOut ? " — Sold out" : ""}
    </SelectItem>
  )
}

export function ProductVariationSelector({
  family,
  selectedProduct,
  onSelect,
  compact = false,
  className,
}: ProductVariationSelectorProps) {
  const controlId = useId()
  const model = getProductVariationSelectorModel(family, selectedProduct)
  if (!model) return null

  // Product cards and rows are clickable, so selector interaction must stay
  // inside the control until the shopper makes an explicit variation choice.
  return (
    <div
      className={cn("space-y-2", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {model.axes.map((axis, index) => {
        const selectId = `${controlId}-${index}`
        return (
          <div key={axis.key} className="space-y-1.5">
            <label
              htmlFor={selectId}
              className={cn(
                "font-medium text-[var(--text-secondary)]",
                compact ? "text-[11px]" : "text-sm"
              )}
            >
              {axis.label}
            </label>
            <Select
              value={axis.selectedValue}
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
                id={selectId}
                aria-label={`Choose ${axis.label.toLowerCase()}`}
                className={compact ? "h-8 px-2.5 text-xs" : undefined}
              >
                <SelectValue>{axis.selectedLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {axis.optionGroups
                  ? axis.optionGroups.map((group) => (
                      <SelectGroup key={group.label}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.options.map((option) => (
                          <ProductVariationSelectItem
                            key={option.value}
                            option={option}
                          />
                        ))}
                      </SelectGroup>
                    ))
                  : axis.options.map((option) => (
                      <ProductVariationSelectItem
                        key={option.value}
                        option={option}
                      />
                    ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
