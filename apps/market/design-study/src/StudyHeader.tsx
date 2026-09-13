import { Search, ShoppingCart } from "lucide-react"
import logo from "../../public/images/logo/logo-full.svg"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  ThemeToggleButton,
} from "./ui"

type Props = {
  query: string
  onQuery: (query: string) => void
  cartCount: number
  onClearCart: () => void
}

export function StudyHeader({ query, onQuery, cartCount, onClearCart }: Props) {
  return (
    <header className="border-b border-[var(--border)]">
      <div className="study-shell study-header">
        <a
          href="#products"
          className="flex items-center gap-2"
          aria-label="Conduit Market products"
        >
          <img src={logo} alt="Conduit" className="w-28" />
          <span className="text-lg text-[var(--text-secondary)]">market</span>
        </a>
        <div className="study-search relative">
          <label htmlFor="product-search" className="sr-only">
            Search sample products
          </label>
          <Search
            className="pointer-events-none absolute top-3 left-3 size-4 text-[var(--text-secondary)]"
            aria-hidden="true"
          />
          <Input
            id="product-search"
            type="search"
            placeholder="Search products or shops"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            className="h-10 pl-9"
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <ThemeToggleButton />
          <Dialog>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                aria-label={`Demo cart, ${cartCount} items`}
              >
                <ShoppingCart className="size-4" aria-hidden="true" />
                <span className="tabular-nums">{cartCount}</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Demo cart</DialogTitle>
                <DialogDescription>
                  {cartCount} sample {cartCount === 1 ? "item" : "items"} added.
                  This counter resets on reload. No orders, payments, or real
                  cart data are created.
                </DialogDescription>
              </DialogHeader>
              <Button
                type="button"
                variant="outline"
                disabled={cartCount === 0}
                onClick={onClearCart}
              >
                Clear demo cart
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </header>
  )
}
