import { Link } from "@tanstack/react-router"
import { Button, Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, cn } from "@conduit/ui"

import { SignerSwitch } from "./SignerSwitch"
import { useCart } from "../hooks/useCart"

function Logo({
  variant = "full",
  className,
}: {
  variant?: "full" | "bg" | "icon"
  className?: string
}) {
  const src =
    variant === "bg"
      ? "/images/logo/logo-full-bg.svg"
      : variant === "icon"
        ? "/images/logo/logo-icon.svg"
        : "/images/logo/logo-full.svg"

  return (
    <Link to="/" className={cn("flex items-center gap-3 select-none", className)}>
      <img src={src} alt="Conduit" className="h-8 w-auto" />
      <span className="hidden border-l border-[var(--border)] pl-3 font-display text-2xl font-medium tracking-tight text-[var(--text-primary)] md:block">
        market
      </span>
    </Link>
  )
}

export function MarketHeader() {
  const cart = useCart()

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
        <Logo />

        <nav className="hidden flex-1 items-center justify-end gap-2 text-sm text-[var(--text-secondary)] lg:flex">
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link to="/products" activeProps={{ className: "text-[var(--text-primary)]" }}>
              Products
            </Link>
          </Button>
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link to="/cart" activeProps={{ className: "text-[var(--text-primary)]" }}>
              Cart ({cart.totals.count})
            </Link>
          </Button>
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link
              to="/checkout"
              search={{ merchant: undefined }}
              activeProps={{ className: "text-[var(--text-primary)]" }}
            >
              Checkout
            </Link>
          </Button>
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <Link
            to="/cart"
            className="inline-flex items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] lg:hidden"
          >
            <span className="font-medium">Cart</span>
            <span>({cart.totals.count})</span>
          </Link>

          <div className="hidden lg:block">
            <SignerSwitch />
          </div>

          <div className="lg:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Open menu">
                  Menu
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[340px]">
                <SheetHeader>
                  <SheetTitle>
                    <Logo variant="icon" className="justify-start" />
                  </SheetTitle>
                </SheetHeader>

                <div className="mt-6 grid gap-2">
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/products">Products</Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/cart">Cart ({cart.totals.count})</Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/checkout" search={{ merchant: undefined }}>
                      Checkout
                    </Link>
                  </Button>
                </div>

                <div className="mt-6 border-t border-[var(--border)] pt-4">
                  <SignerSwitch />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  )
}
