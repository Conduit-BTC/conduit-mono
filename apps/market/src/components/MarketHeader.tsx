import {
  ChevronDown,
  CircleUser,
  LoaderCircle,
  LogOut,
  MessagesSquare,
  Radio,
  ReceiptText,
  Search,
  ShoppingCart,
  Wallet,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  config,
  formatNpub,
  useAuth,
  useNdkState,
  useProfile,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@conduit/ui"

import { SignerSwitch } from "./SignerSwitch"
import { useCart } from "../hooks/useCart"
import { useWallet } from "../hooks/useWallet"

type NavState = "top" | "scrolled" | "hidden"

const headerActionClassName =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 sm:px-3"

const accountControlClassName =
  "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-2xl bg-primary-500 px-3 text-sm font-semibold text-white transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"

function accountMenuItemClassName(
  variant: "default" | "danger" = "default"
): string {
  return cn(
    "min-h-11 cursor-pointer rounded-xl px-3 py-2 text-[15px] font-medium",
    variant === "danger"
      ? "text-[var(--error)] focus:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus:text-[var(--error)]"
      : "text-[var(--text-primary)] focus:bg-[color-mix(in_srgb,var(--primary-500)_6%,transparent)] focus:text-[var(--text-primary)]"
  )
}

function Logo() {
  return (
    <Link to="/" className="flex shrink-0 select-none items-center gap-2">
      <img
        src="/images/logo/logo-full.svg"
        alt="Conduit"
        width={386}
        height={115}
        decoding="async"
        fetchPriority="high"
        className="h-8 w-[6.75rem] shrink-0 object-contain"
      />
      <span className="border-l border-[var(--border)] pl-2 font-display text-2xl font-medium text-[var(--text-primary)]">
        market
      </span>
    </Link>
  )
}

function HeaderAction({
  label,
  icon,
  active = false,
  enabled = true,
  className,
  labelClassName = "hidden xl:inline",
  count,
  onClick,
}: {
  label: string
  icon: ReactNode
  active?: boolean
  enabled?: boolean
  className?: string
  labelClassName?: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-disabled={!enabled}
      title={enabled ? label : `Connect to use ${label.toLowerCase()}`}
      onClick={onClick}
      className={cn(
        headerActionClassName,
        active && enabled
          ? "bg-[var(--surface-elevated)] text-[var(--text-primary)]"
          : "text-[var(--text-primary)] hover:bg-[var(--surface-elevated)]",
        !enabled &&
          "text-[var(--text-muted)] opacity-60 hover:bg-transparent hover:text-[var(--text-muted)]",
        className
      )}
    >
      {icon}
      <span className={labelClassName}>{label}</span>
      {typeof count === "number" ? (
        <span className="tabular-nums text-[var(--text-muted)]">({count})</span>
      ) : null}
    </button>
  )
}

function AccountMenuItem({
  icon,
  label,
  detail,
  variant = "default",
  onSelect,
}: {
  icon: ReactNode
  label: string
  detail?: string
  variant?: "default" | "danger"
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={accountMenuItemClassName(variant)}
    >
      <span className="mr-3 inline-flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {detail ? (
          <span className="block truncate text-[10px] font-medium text-[var(--text-muted)]">
            {detail}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  )
}

function AccountMenuLink({
  icon,
  label,
  detail,
  to,
  onClick,
}: {
  icon: ReactNode
  label: string
  detail?: string
  to: "/profile" | "/network" | "/wallet"
  onClick: () => void
}) {
  return (
    <DropdownMenuItem asChild className={accountMenuItemClassName()}>
      <Link to={to} onClick={onClick}>
        <span className="mr-3 inline-flex size-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          {detail ? (
            <span className="block truncate text-[10px] font-medium text-[var(--text-muted)]">
              {detail}
            </span>
          ) : null}
        </span>
      </Link>
    </DropdownMenuItem>
  )
}

function AccountControl({
  connected,
  displayName,
  npub,
  avatarUrl,
  walletStatusLabel,
  authPending,
  onConnect,
  onDisconnect,
}: {
  connected: boolean
  displayName: string
  npub?: string
  avatarUrl?: string | null
  walletStatusLabel?: string
  authPending: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  const [open, setOpen] = useState(false)

  if (!connected) {
    return (
      <button
        type="button"
        className={cn(accountControlClassName, "min-w-[5.25rem]")}
        aria-busy={authPending}
        onClick={onConnect}
      >
        Connect
      </button>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-12 items-center gap-3 rounded-[16px] bg-primary-500 px-3 text-left text-white transition-colors hover:bg-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 sm:min-w-[12.75rem]"
          aria-label="Open account menu"
        >
          <Avatar className="size-8 shrink-0 border border-[color-mix(in_srgb,var(--on-primary)_24%,transparent)]">
            <AvatarImage src={avatarUrl ?? undefined} alt={displayName} />
            <AvatarFallback className="bg-primary-600 text-xs text-white">
              {displayName.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="hidden min-w-0 flex-1 sm:block">
            <span className="block truncate text-sm font-semibold">
              {displayName}
            </span>
            {npub ? (
              <span className="block truncate text-[11px] text-white/70">
                {npub}
              </span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-white/70 transition-transform duration-150",
              open && "rotate-180"
            )}
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={10}
        className="w-[14rem] rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-overlay)] p-3 shadow-[var(--shadow-dialog)]"
      >
        <AccountMenuLink
          icon={<CircleUser className="size-4" />}
          label="Profile"
          to="/profile"
          onClick={() => setOpen(false)}
        />
        <AccountMenuLink
          icon={<Radio className="size-4" />}
          label="Network"
          to="/network"
          onClick={() => setOpen(false)}
        />
        <AccountMenuLink
          icon={<Wallet className="size-4" />}
          label="Wallet"
          detail={walletStatusLabel}
          to="/wallet"
          onClick={() => setOpen(false)}
        />
        <DropdownMenuSeparator className="mx-0 my-2 bg-[var(--border)]" />
        <AccountMenuItem
          icon={<LogOut className="size-4" />}
          label="Disconnect"
          variant="danger"
          onSelect={() => {
            setOpen(false)
            onDisconnect()
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MarketHeader() {
  const { pubkey, status, disconnect } = useAuth()
  const { status: ndkStatus } = useNdkState()
  const { data: profile, refetch } = useProfile(pubkey)
  const wallet = useWallet()
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
  const [connectOpen, setConnectOpen] = useState(false)
  const [navState, setNavState] = useState<NavState>("top")
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const currentQuery = typeof search.q === "string" ? search.q : ""
  const isBrowseRoute = pathname === "/products"
  const connected = status === "connected" && !!pubkey
  const authPending = status === "connecting" || status === "restoring"
  const displayName = connected
    ? (profile?.displayName ?? profile?.name ?? formatNpub(pubkey, 6))
    : "Connect"
  const walletStatusLabel =
    wallet.status === "pay-capable"
      ? "Ready"
      : wallet.status === "unreachable"
        ? "Saved"
        : wallet.status === "disconnected"
          ? "Not connected"
          : undefined
  const normalizedSearchValue = searchValue.trim()
  const pendingSearch = useMemo(
    () =>
      isBrowseRoute && searchDirty && normalizedSearchValue !== currentQuery,
    [currentQuery, isBrowseRoute, normalizedSearchValue, searchDirty]
  )

  useEffect(() => {
    if (ndkStatus === "connected" && pubkey) {
      void refetch()
    }
  }, [ndkStatus, pubkey, refetch])

  useEffect(() => {
    // Mirror the URL query into the input only when the user isn't actively
    // typing. Otherwise the debounced navigate that WE trigger echoes the
    // (stale, trimmed) query back and clobbers in-flight keystrokes, which
    // shows up as dropped/reordered characters.
    if (searchInputRef.current === document.activeElement) return
    setSearchValue(currentQuery)
    setSearchDirty(false)
  }, [currentQuery, pathname])

  useEffect(() => {
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
  }, [])

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

  function handleProtectedRoute(to: "/messages" | "/orders"): void {
    if (!connected) {
      setConnectOpen(true)
      return
    }

    void navigate({ to })
  }

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur transition-transform duration-300 ease-out",
        navState === "hidden" ? "-translate-y-full" : "translate-y-0",
        navState === "scrolled" ? "shadow-md" : ""
      )}
    >
      <div className="market-header-layout mx-auto min-h-16 max-w-7xl px-4 py-3">
        <div className="market-header-brand flex min-w-0 items-center gap-2">
          <Logo />
          {config.lightningNetwork !== "mainnet" && (
            <Badge
              variant="secondary"
              className={cn(
                "border text-[10px] uppercase tracking-wider",
                config.lightningNetwork === "mock"
                  ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                  : "border-blue-500/30 bg-blue-500/10 text-blue-400"
              )}
            >
              {config.lightningNetwork}
            </Badge>
          )}
        </div>

        <div className="market-header-search w-full min-w-0">
          <form
            className="relative"
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(event) => {
                setSearchValue(event.target.value)
                setSearchDirty(true)
              }}
              placeholder="Search"
              aria-label="Search products"
              className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-0"
            />
            <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 text-[var(--text-muted)]">
              {pendingSearch ? (
                <LoaderCircle className="size-4 animate-spin" />
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

        <nav
          aria-label="Market navigation"
          className="market-header-utility-nav flex min-w-0 items-center gap-1.5"
        >
          <HeaderAction
            label="Messages"
            icon={<MessagesSquare className="size-4" aria-hidden="true" />}
            enabled={connected}
            active={pathname === "/messages"}
            labelClassName="hidden lg:inline"
            onClick={() => handleProtectedRoute("/messages")}
          />
          <HeaderAction
            label="Orders"
            icon={<ReceiptText className="size-4" aria-hidden="true" />}
            enabled={connected}
            active={pathname === "/orders"}
            labelClassName="hidden lg:inline"
            onClick={() => handleProtectedRoute("/orders")}
          />
          <HeaderAction
            label="Cart"
            icon={<ShoppingCart className="size-4" aria-hidden="true" />}
            active={pathname === "/cart"}
            labelClassName="hidden sm:inline"
            count={cart.totals.count}
            onClick={() => void navigate({ to: "/cart" })}
          />
        </nav>

        <div className="market-header-account-slot">
          <AccountControl
            connected={connected}
            displayName={displayName}
            npub={pubkey ? formatNpub(pubkey, 8) : undefined}
            avatarUrl={profile?.picture}
            walletStatusLabel={walletStatusLabel}
            authPending={authPending}
            onConnect={() => setConnectOpen(true)}
            onDisconnect={disconnect}
          />
        </div>
      </div>

      {!connected && (
        <SignerSwitch
          open={connectOpen}
          onOpenChange={setConnectOpen}
          hideTrigger
        />
      )}
    </header>
  )
}
