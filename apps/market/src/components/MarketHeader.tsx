import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { config, formatPubkey, useAuth } from "@conduit/core"
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  cn,
} from "@conduit/ui"
import { type FormEvent, useEffect, useState } from "react"

import { SignerSwitch } from "./SignerSwitch"
import { useCart } from "../hooks/useCart"

type NavState = "top" | "scrolled" | "hidden"

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

function UserMenu() {
  const { pubkey, status, disconnect } = useAuth()
  const navigate = useNavigate()

  if (!pubkey || status === "disconnected" || status === "error") return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary" size="sm" className="font-mono text-xs">
          {formatPubkey(pubkey, 4)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={() => navigate({ to: "/profile" })}>
          Profile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={disconnect}>
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CartIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 3h2l.4 2m0 0L7 13h10l2-8H5.4M5.4 5H19M7 13l-1 5h12M9 18a1 1 0 100 2 1 1 0 000-2zm8 0a1 1 0 100 2 1 1 0 000-2z"
      />
    </svg>
  )
}

function StoreIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 9.5l1.6-4.8A1 1 0 015.55 4h12.9a1 1 0 01.95.7L21 9.5M4 10h16v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8zm4 4h3m2 0h3"
      />
    </svg>
  )
}

export function MarketHeader() {
  const { pubkey, status } = useAuth()
  const cart = useCart()
  const navigate = useNavigate()
  const { pathname, search } = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      search: state.location.search as Record<string, unknown>,
    }),
  })
  const [searchValue, setSearchValue] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const [navState, setNavState] = useState<NavState>("top")

  useEffect(() => {
    setSearchValue(typeof search.q === "string" ? search.q : "")
  }, [search.q])

  useEffect(() => {
    if (menuOpen) {
      setNavState("top")
      return
    }

    let lastScrollY = window.scrollY
    let ticking = false
    let currentState: NavState = window.scrollY <= 12 ? "top" : "scrolled"

    const updateNavState = (): void => {
      const currentY = window.scrollY
      let nextState = currentState

      if (currentY <= 12) {
        nextState = "top"
      } else if (currentY > lastScrollY + 5) {
        nextState = "hidden"
      } else if (currentY < lastScrollY - 5) {
        nextState = "scrolled"
      }

      lastScrollY = currentY
      ticking = false

      if (nextState !== currentState) {
        currentState = nextState
        setNavState(nextState)
      }
    }

    setNavState(currentState)

    const onScroll = (): void => {
      if (!ticking) {
        window.requestAnimationFrame(updateNavState)
        ticking = true
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [menuOpen])

  function submitSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    navigate({
      to: "/products",
      search: {
        q: searchValue.trim() || undefined,
      },
    })
  }

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur transition-transform duration-300 ease-out",
        navState === "hidden" && !menuOpen ? "-translate-y-full" : "translate-y-0",
        navState === "scrolled" ? "shadow-[0_8px_24px_rgba(0,0,0,0.22)]" : ""
      )}
    >
      <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center gap-3 px-4 py-3 lg:flex-nowrap">
        <Logo />
        {config.lightningNetwork !== "mainnet" && (
          <Badge variant="secondary" className={cn(
            "text-[10px] uppercase tracking-wider border",
            config.lightningNetwork === "mock"
              ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
              : "border-blue-500/30 bg-blue-500/10 text-blue-400"
          )}>
            {config.lightningNetwork}
          </Badge>
        )}

        <nav className="hidden items-center gap-1 text-sm text-[var(--text-secondary)] lg:flex">
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link to="/products" activeProps={{ className: "text-[var(--text-primary)]" }}>
              <StoreIcon className="h-4 w-4" />
              Shop
            </Link>
          </Button>
        </nav>

        <form onSubmit={submitSearch} className="order-last w-full lg:order-none lg:ml-2 lg:flex-1">
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="Search"
              aria-label="Search products"
              className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
          {status === "connected" && (
            <Button asChild variant="ghost" className="hidden h-10 px-3 lg:inline-flex">
              <Link to="/orders" activeProps={{ className: "text-[var(--text-primary)]" }}>
                Orders
              </Link>
            </Button>
          )}

          <Button
            asChild
            variant={pathname === "/cart" ? "muted" : "ghost"}
            size="sm"
            className="h-10 px-2.5 text-xs sm:px-3 sm:text-sm"
          >
            <Link to="/cart">
              <CartIcon className="h-3.5 w-3.5" />
              Cart
              <span className="text-[var(--text-muted)]">({cart.totals.count})</span>
            </Link>
          </Button>

          <div className="hidden min-w-[7rem] items-center justify-end lg:flex">
            {status === "connected" && pubkey ? <UserMenu /> : <SignerSwitch />}
          </div>

          <div className="lg:hidden">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label={menuOpen ? "Close menu" : "Open menu"}
                  aria-expanded={menuOpen}
                  className="relative inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-transparent text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40"
                >
                  <span
                    className={cn(
                      "absolute block h-0.5 w-[18px] rounded-full bg-current transition-transform duration-300 ease-out",
                      menuOpen ? "translate-y-0 rotate-45" : "-translate-y-[6px]"
                    )}
                  />
                  <span
                    className={cn(
                      "absolute block h-0.5 w-[18px] rounded-full bg-current transition-all duration-300 ease-out",
                      menuOpen ? "opacity-0" : "opacity-100"
                    )}
                  />
                  <span
                    className={cn(
                      "absolute block h-0.5 w-[18px] rounded-full bg-current transition-transform duration-300 ease-out",
                      menuOpen ? "translate-y-0 -rotate-45" : "translate-y-[6px]"
                    )}
                  />
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[340px]">
                <SheetHeader>
                  <SheetTitle>
                    <Logo variant="icon" className="justify-start" />
                  </SheetTitle>
                </SheetHeader>

                <div className="mt-6 grid gap-2">
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/products" onClick={() => setMenuOpen(false)}>
                      <StoreIcon className="h-4 w-4" />
                      Shop
                    </Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/cart" onClick={() => setMenuOpen(false)}>
                      <CartIcon className="h-4 w-4" />
                      Cart ({cart.totals.count})
                    </Link>
                  </Button>
                  {status === "connected" && (
                    <Button asChild variant="ghost" className="justify-start">
                      <Link to="/orders" onClick={() => setMenuOpen(false)}>Orders</Link>
                    </Button>
                  )}
                  {status === "connected" && (
                    <Button asChild variant="ghost" className="justify-start">
                      <Link to="/profile" onClick={() => setMenuOpen(false)}>Profile</Link>
                    </Button>
                  )}
                </div>

                <div className="mt-6 border-t border-[var(--border)] pt-4">
                  {status === "connected" && pubkey ? <UserMenu /> : <SignerSwitch />}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  )
}
