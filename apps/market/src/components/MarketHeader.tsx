import {
  LoaderCircle,
  MessagesSquare,
  ReceiptText,
  Search,
  Settings,
  ShoppingCart,
  Store,
} from "lucide-react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { config, formatPubkey, useAuth, useProfile } from "@conduit/core"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  cn,
} from "@conduit/ui"
import { useEffect, useMemo, useRef, useState } from "react"

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
    <Link
      to="/"
      className={cn("flex items-center gap-3 select-none", className)}
    >
      <img src={src} alt="Conduit" className="h-8 w-auto" />
      <span className="hidden border-l border-[var(--border)] pl-3 font-display text-2xl font-medium tracking-tight text-[var(--text-primary)] md:block">
        market
      </span>
    </Link>
  )
}

function UserMenu() {
  const { pubkey, status, disconnect } = useAuth()
  const { data: profile } = useProfile(pubkey)
  const [open, setOpen] = useState(false)

  if (!pubkey || status !== "connected") return null

  const displayName = profile?.displayName ?? profile?.name ?? null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="primary"
        size="sm"
        className="text-xs"
        onClick={() => setOpen(true)}
      >
        {profile?.picture && (
          <img
            src={profile.picture}
            alt=""
            className="h-5 w-5 rounded-full object-cover"
          />
        )}
        {displayName ?? formatPubkey(pubkey, 4)}
      </Button>
      <DialogContent className="max-w-sm border-[var(--border)] bg-[var(--surface-dialog)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)]">
        <DialogHeader>
          <DialogTitle>Disconnect signer?</DialogTitle>
          <DialogDescription className="text-sm leading-7 text-[var(--text-secondary)]">
            You can reconnect later, but checkout, orders, and merchant
            follow-up will require signing in again.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-secondary)]">
          {displayName && (
            <div className="font-medium text-[var(--text-primary)]">
              {displayName}
            </div>
          )}
          <div className="font-mono">{formatPubkey(pubkey, 12)}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              disconnect()
              setOpen(false)
            }}
          >
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [searchDirty, setSearchDirty] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [navState, setNavState] = useState<NavState>("top")
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const currentQuery = typeof search.q === "string" ? search.q : ""
  const isBrowseRoute = pathname === "/products"
  const normalizedSearchValue = searchValue.trim()
  const pendingSearch = useMemo(
    () =>
      isBrowseRoute && searchDirty && normalizedSearchValue !== currentQuery,
    [currentQuery, isBrowseRoute, normalizedSearchValue, searchDirty]
  )

  useEffect(() => {
    setSearchValue(currentQuery)
    setSearchDirty(false)
  }, [currentQuery, pathname])

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "/") return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return
      }

      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  useEffect(() => {
    if (!searchDirty) return
    if (!isBrowseRoute) return

    const timeoutId = window.setTimeout(() => {
      if (normalizedSearchValue === currentQuery) {
        return
      }

      navigate({
        to: "/products",
        search: {
          q: normalizedSearchValue || undefined,
        },
        replace: true,
      })
    }, 260)

    return () => window.clearTimeout(timeoutId)
  }, [
    currentQuery,
    isBrowseRoute,
    navigate,
    normalizedSearchValue,
    searchDirty,
  ])

  function submitSearch(): void {
    navigate({
      to: "/products",
      search: {
        q: normalizedSearchValue || undefined,
      },
      replace: pathname === "/products",
    })
    setSearchDirty(false)
  }

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur transition-transform duration-300 ease-out",
        navState === "hidden" && !menuOpen
          ? "-translate-y-full"
          : "translate-y-0",
        navState === "scrolled" ? "shadow-md" : ""
      )}
    >
      <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center gap-3 px-4 py-3 lg:flex-nowrap">
        <Logo />
        {config.lightningNetwork !== "mainnet" && (
          <Badge
            variant="secondary"
            className={cn(
              "text-[10px] uppercase tracking-wider border",
              config.lightningNetwork === "mock"
                ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                : "border-blue-500/30 bg-blue-500/10 text-blue-400"
            )}
          >
            {config.lightningNetwork}
          </Badge>
        )}

        <nav className="hidden items-center gap-1 text-sm text-[var(--text-secondary)] lg:flex">
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link
              to="/products"
              activeProps={{ className: "text-[var(--text-primary)]" }}
            >
              <Store className="h-4 w-4" />
              Shop
            </Link>
          </Button>
          <Button asChild variant="ghost" className="h-10 px-3">
            <Link
              to="/settings"
              activeProps={{ className: "text-[var(--text-primary)]" }}
            >
              <Settings className="h-4 w-4" />
              Relays
            </Link>
          </Button>
        </nav>

        <div className="order-last w-full pb-5 lg:order-none lg:ml-2 lg:flex-1 lg:pb-0">
          <form
            className="relative"
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => {
                setSearchValue(e.target.value)
                setSearchDirty(true)
              }}
              placeholder="Search"
              aria-label="Search products"
              className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-0"
            />
            <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 text-[var(--text-muted)]">
              {pendingSearch ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : null}
              {!pendingSearch && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] font-medium text-[var(--text-muted)]">
                  /
                </span>
              )}
            </div>
            {!isBrowseRoute &&
              searchDirty &&
              normalizedSearchValue.length > 0 && (
                <div className="pointer-events-none absolute left-1 top-full mt-1 text-[11px] text-[var(--text-muted)]">
                  Press Enter to search
                </div>
              )}
          </form>
        </div>

        <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
          {status === "connected" && (
            <Button
              asChild
              variant="ghost"
              className="hidden h-10 px-3 lg:inline-flex"
            >
              <Link
                to="/messages"
                activeProps={{ className: "text-[var(--text-primary)]" }}
              >
                <MessagesSquare className="h-4 w-4" />
                Messages
              </Link>
            </Button>
          )}

          {status === "connected" && (
            <Button
              asChild
              variant="ghost"
              className="hidden h-10 px-3 lg:inline-flex"
            >
              <Link
                to="/orders"
                activeProps={{ className: "text-[var(--text-primary)]" }}
              >
                <ReceiptText className="h-4 w-4" />
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
              <ShoppingCart className="h-3.5 w-3.5" />
              Cart
              <span className="text-[var(--text-muted)]">
                ({cart.totals.count})
              </span>
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
                      menuOpen
                        ? "translate-y-0 rotate-45"
                        : "-translate-y-[6px]"
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
                      menuOpen
                        ? "translate-y-0 -rotate-45"
                        : "translate-y-[6px]"
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
                      <Store className="h-4 w-4" />
                      Shop
                    </Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/cart" onClick={() => setMenuOpen(false)}>
                      <ShoppingCart className="h-4 w-4" />
                      Cart ({cart.totals.count})
                    </Link>
                  </Button>
                  <Button asChild variant="ghost" className="justify-start">
                    <Link to="/settings" onClick={() => setMenuOpen(false)}>
                      <Settings className="h-4 w-4" />
                      Relays
                    </Link>
                  </Button>
                  {status === "connected" && (
                    <Button asChild variant="ghost" className="justify-start">
                      <Link to="/messages" onClick={() => setMenuOpen(false)}>
                        <MessagesSquare className="h-4 w-4" />
                        Messages
                      </Link>
                    </Button>
                  )}
                  {status === "connected" && (
                    <Button asChild variant="ghost" className="justify-start">
                      <Link to="/orders" onClick={() => setMenuOpen(false)}>
                        <ReceiptText className="h-4 w-4" />
                        Orders
                      </Link>
                    </Button>
                  )}
                  {status === "connected" && (
                    <Button asChild variant="ghost" className="justify-start">
                      <Link to="/profile" onClick={() => setMenuOpen(false)}>
                        Profile
                      </Link>
                    </Button>
                  )}
                </div>

                <div className="mt-6 border-t border-[var(--border)] pt-4">
                  {status === "connected" && pubkey ? (
                    <UserMenu />
                  ) : (
                    <SignerSwitch />
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  )
}
