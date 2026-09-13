import { useState } from "react"
import { Plus } from "lucide-react"
import { formatSats, type StudyProduct } from "./fixtures"
import { ProductArtwork } from "./ProductArtwork"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui"

export function StudyProductCard({
  product,
  onAdd,
}: {
  product: StudyProduct
  onAdd: (product: StudyProduct, option?: string) => void
}) {
  const [option, setOption] = useState(product.options?.[0])
  return (
    <li className="study-card" data-product-id={product.id}>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="study-product-link"
            aria-label={`View ${product.title}`}
          >
            <ProductArtwork product={product} />
            <h2 className="line-clamp-2 min-h-10 px-3 pt-3 text-left text-sm font-semibold text-balance sm:px-4 sm:text-base">
              {product.title}
            </h2>
          </button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="pr-7 text-balance">
              {product.title}
            </DialogTitle>
            <DialogDescription>
              Sample listing from {product.store}. This is a design preview, not
              a product for sale.
            </DialogDescription>
          </DialogHeader>
          <ProductArtwork product={product} />
          <p className="font-semibold tabular-nums">
            {formatSats(product.sats)}
          </p>
          <p className="text-sm text-[var(--text-secondary)] text-pretty">
            Use this space to explore product details. Shipping, checkout, and
            merchant links are intentionally disconnected.
          </p>
        </DialogContent>
      </Dialog>
      <div className="flex flex-1 flex-col gap-3 p-3 pt-2 sm:p-4 sm:pt-2">
        <p className="text-xs text-[var(--text-secondary)] sm:text-sm">
          {product.store}
        </p>
        {product.options && (
          <Select value={option} onValueChange={setOption}>
            <SelectTrigger aria-label={`Option for ${product.title}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {product.options.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="text-sm font-semibold tabular-nums">
            {formatSats(product.sats)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10"
            disabled={product.soldOut}
            aria-label={
              product.soldOut
                ? `${product.title} is sold out`
                : `Add ${product.title} to demo cart`
            }
            onClick={() => onAdd(product, option)}
          >
            {!product.soldOut && <Plus className="size-4" aria-hidden="true" />}
            {product.soldOut ? "Sold out" : "Add"}
          </Button>
        </div>
      </div>
    </li>
  )
}
