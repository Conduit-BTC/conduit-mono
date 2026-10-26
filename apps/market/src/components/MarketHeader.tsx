import {
  CircleUser,
  LoaderCircle,
  MessagesSquare,
  Radio,
  ReceiptText,
  Search,
  Settings2,
  ShoppingCart,
  Wallet,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  config,
  formatNpub,
  useAuth,
  useProfile,
  useUnreadDirectMessageCount,
} from "@conduit/core"
import {
  AccountMenu,
  Badge,
  Button,
  Input,
  SearchSuggestions,
  ThemeToggleButton,
  cn,
  getSearchSuggestionInputProps,
  useSearchSuggestionKeyboard,
  useSignIn,
} from "@conduit/ui"

import { useCart } from "../hooks/useCart"
import { useMarketHeaderSuggestions } from "../hooks/useMarketHeaderSuggestions"
import { DEFAULT_MARKET_CATALOG_SOURCE } from "../lib/productCatalogRead"
import { resolveActiveSuggestionIndex } from "../lib/accountSearch"
import { MARKET_SEARCH_SETTLE_MS } from "../lib/searchPolicy"

const SEARCH_SUGGESTIONS_LISTBOX_ID = "market-search-suggestions"

export type MarketChromeState = "top" | "scrolled" | "hidden"

const headerActionClassName =
  "inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 sm:px-3"

function Logo() {
  return (
    <Link
      to="/"
      aria-label="Conduit Market home"
      className="flex shrink-0 select-none items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span className="h-8 w-6 shrink-0 overflow-hidden sm:w-[6.75rem]">
        <img
          src="/images/logo/logo-full.svg"
          alt=""
          aria-hidden="true"
          width={386}
          height={115}
          decoding="async"
          fetchPriority="high"
          className="h-8 w-[6.75rem] max-w-none object-left"
          draggable="false"
        />
      </span>
      <span className="shrink-0 border-l border-[var(--border)] pl-2 font-display text-xl font-medium text-[var(--text-primary)] sm:text-2xl">
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
  ariaLabel,
  className,
  labelClassName = "hidden xl:inline",
  badge,
  onClick,
}: {
  label: string
  icon: ReactNode
  active?: boolean
  enabled?: boolean
  ariaLabel?: string
  className?: string
  labelClassName?: string
  /** Count pinned to the icon's top-right corner; hidden at zero. */
  badge?: number
  onClick: () => void
}) {
  return (
    // eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes.
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-disabled={!enabled}
      aria-current={active ? "page" : undefined}
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
      {typeof badge === "number" ? (
        <span className="relative inline-flex">
          {icon}
          {badge > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-2.5 -top-2 inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--radius-sm)] bg-primary-500 px-1 text-[10px] font-semibold leading-none tabular-nums text-white"
            >
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </span>
      ) : (
        icon
      )}
      <span className={labelClassName}>{label}</span>
    </button>
  )
}

export function MarketHeader({
  chromeState,
}: {
  chromeState: MarketChromeState
}) {
  const {
    pubkey,
    accountPubkey,
    status,
    connect,
    signerReadiness,
    authGeneration,
  } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const { data: profile } = useProfile(pubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
  })
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
  const { requestSignIn, disconnectAccount } = useSignIn()
  const [searchFocused, setSearchFocused] = useState(false)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(
    null
  )
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const currentQuery = typeof search.q === "string" ? search.q : ""
  /** The header box is the product search; the Merchants page filters itself. */
  const isBrowseRoute = pathname === "/products"
  const connected = status === "connected" && !!pubkey
  const unreadMessages = useUnreadDirectMessageCount(
    connected ? pubkey : null
  ).count
  const authPending = status === "connecting" || status === "restoring"
  const displayName = connected
    ? (profile?.displayName ?? profile?.name ?? formatNpub(pubkey, 6))
    : "Connect"
  const normalizedSearchValue = searchValue.trim()
  const pendingSearch = useMemo(
    () =>
      isBrowseRoute && searchDirty && normalizedSearchValue !== currentQuery,
    [currentQuery, isBrowseRoute, normalizedSearchValue, searchDirty]
  )
  const searchSuggestionsEnabled =
    searchFocused &&
    searchDirty &&
    !suggestionsDismissed &&
    normalizedSearchValue.length > 0
  const routeCatalogSource =
    search.source === "following" ||
    search.source === "conduit" ||
    search.source === "combined"
      ? search.source
      : DEFAULT_MARKET_CATALOG_SOURCE
  const handleSuggestionSelected = useCallback(() => {
    setSuggestionsDismissed(true)
    setSearchDirty(false)
    setSearchValue("")
    searchInputRef.current?.blur()
  }, [])
  const {
    sellerDirectory,
    suggestionModel,
    evidence: suggestionEvidence,
    loading: suggestionLoading,
    open: suggestionsOpen,
    emptyMessage: suggestionEmptyMessage,
    selectSuggestion,
  } = useMarketHeaderSuggestions({
    catalogSource: routeCatalogSource,
    enabled: searchSuggestionsEnabled,
    isBrowseRoute,
    pageSuppliesCatalog:
      (isBrowseRoute && currentQuery.trim().length === 0) ||
      pathname === "/merchants" ||
      (pathname === "/cart" &&
        cart.items.length > 0 &&
        !search.merchant &&
        !search.purchase),
    listboxId: SEARCH_SUGGESTIONS_LISTBOX_ID,
    merchantFilter: search.merchant,
    onSelect: handleSuggestionSelected,
    query: searchValue,
  })
  const suggestionGroups = suggestionModel.groups
  const suggestionItems = suggestionModel.items
  const activeSuggestion = resolveActiveSuggestionIndex(
    suggestionItems,
    activeSuggestionId
  )
  const setActiveSuggestion = useCallback(
    (index: number) => {
      setActiveSuggestionId(
        index >= 0 ? (suggestionItems[index]?.id ?? null) : null
      )
    },
    [suggestionItems]
  )
  const suggestionFooter = [
    suggestionEvidence,
    isBrowseRoute ? null : "Press Enter to search products.",
  ]
    .filter((sentence): sentence is string => !!sentence)
    .join(" ")
  useEffect(() => {
    setActiveSuggestionId(null)
  }, [normalizedSearchValue])

  const onSearchKeyDown = useSearchSuggestionKeyboard({
    open: suggestionsOpen,
    count: suggestionItems.length,
    activeIndex: activeSuggestion,
    onActiveIndexChange: setActiveSuggestion,
    onSelectActive: () =>
      selectSuggestion(suggestionItems[activeSuggestion]?.id),
    onDismiss: () => setSuggestionsDismissed(true),
  })

  useEffect(() => {
    // Mirror the URL query into the input only when the user isn't actively
    // typing. Otherwise the debounced navigate that WE trigger echoes the
    // (stale, trimmed) query back and clobbers in-flight keystrokes, which
    // shows up as dropped/reordered characters.
    if (searchInputRef.current === document.activeElement) return
    // Only the catalog query belongs in this box. Another page's `q`, such as
    // the Merchants filter, must not look like a pending product search.
    setSearchValue(isBrowseRoute ? currentQuery : "")
    setSearchDirty(false)
  }, [currentQuery, isBrowseRoute, pathname])

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
        // Keep the perspective and any other browse parameter; only q changes.
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          q: normalizedSearchValue || undefined,
        }),
        replace: true,
      })
    }, MARKET_SEARCH_SETTLE_MS)

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
      // Staying on the catalog keeps its perspective; arriving fresh does not.
      search: isBrowseRoute
        ? (previous: Record<string, unknown>) => ({
            ...previous,
            q: normalizedSearchValue || undefined,
          })
        : { q: normalizedSearchValue || undefined },
      replace: isBrowseRoute,
    })
    setSearchDirty(false)
  }

  function handleProtectedRoute(to: "/messages" | "/orders"): void {
    if (!accountPubkey) {
      requestSignIn(() => void navigate({ to }))
      return
    }

    void navigate({ to })
  }

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface-overlay)] transition-transform duration-200 ease-out motion-reduce:transition-none",
        chromeState === "hidden" ? "-translate-y-full" : "translate-y-0",
        chromeState === "scrolled" ? "shadow-md" : ""
      )}
    >
      <div className="market-header-layout mx-auto min-h-16 max-w-7xl px-4 py-3">
        <div className="market-header-brand flex min-w-0 items-center gap-2">
          <Logo />
          {config.lightningNetwork !== "mainnet" && (
            <Badge
              variant="secondary"
              className={cn(
                "hidden border text-[10px] uppercase tracking-wider sm:inline-flex",
                config.lightningNetwork === "mock"
                  ? "border-warning/30 bg-warning/10 text-[var(--warning-text)]"
                  : "border-info/30 bg-info/10 text-[var(--info-text)]"
              )}
            >
              {config.lightningNetwork}
            </Badge>
          )}
        </div>

        <div className="market-header-lower-row flex min-w-0 items-center gap-3">
          <div className="market-header-search min-w-0 flex-1">
            <form
              className="relative"
              onSubmit={(event) => {
                event.preventDefault()
                submitSearch()
              }}
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <Input
                ref={searchInputRef}
                value={searchValue}
                onChange={(event) => {
                  setSearchValue(event.target.value)
                  setSearchDirty(true)
                  setSuggestionsDismissed(false)
                }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search"
                aria-label="Search products, categories, merchants, and accounts"
                autoComplete="off"
                className="h-11 bg-[var(--surface-elevated)] pl-9 pr-3 focus-visible:ring-offset-0 sm:pr-9"
                {...getSearchSuggestionInputProps({
                  listboxId: SEARCH_SUGGESTIONS_LISTBOX_ID,
                  open: suggestionsOpen,
                  activeIndex: activeSuggestion,
                })}
              />
              <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 text-[var(--text-muted)]">
                {pendingSearch ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : null}
                {!pendingSearch && (
                  <span className="hidden h-5 min-w-5 items-center justify-center rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] font-medium text-[var(--text-muted)] sm:inline-flex">
                    /
                  </span>
                )}
              </div>
              {suggestionsOpen ? (
                <div className="absolute inset-x-0 top-full z-50 mt-2">
                  <SearchSuggestions
                    id={SEARCH_SUGGESTIONS_LISTBOX_ID}
                    ariaLabel="Matching categories, merchants, and accounts"
                    groups={suggestionGroups}
                    activeIndex={activeSuggestion}
                    onActiveIndexChange={setActiveSuggestion}
                    onSelect={(item) => selectSuggestion(item.id)}
                    loading={suggestionLoading}
                    emptyMessage={suggestionEmptyMessage}
                    footer={
                      suggestionFooter ||
                      sellerDirectory.eligibilityState === "partial" ||
                      sellerDirectory.eligibilityState === "unavailable" ||
                      sellerDirectory.catalogEvidenceIncomplete ? (
                        <span className="flex items-center justify-between gap-2">
                          <span>{suggestionFooter}</span>
                          {sellerDirectory.eligibilityState === "partial" ||
                          sellerDirectory.eligibilityState === "unavailable" ||
                          sellerDirectory.catalogEvidenceIncomplete ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 shrink-0 px-2 text-[11px]"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={sellerDirectory.retry}
                            >
                              Try again
                            </Button>
                          ) : null}
                        </span>
                      ) : null
                    }
                  />
                </div>
              ) : !isBrowseRoute &&
                searchDirty &&
                normalizedSearchValue.length > 0 ? (
                <div className="pointer-events-none absolute left-1 top-full mt-1 text-[11px] text-[var(--text-muted)]">
                  Press Enter to search
                </div>
              ) : null}
            </form>
          </div>

          {connected ? (
            <nav
              aria-label="Buyer navigation"
              className="market-header-utility-nav flex shrink-0 items-center gap-1.5"
            >
              <HeaderAction
                label="Messages"
                ariaLabel={`Messages, ${unreadMessages} unread`}
                icon={<MessagesSquare className="size-6" aria-hidden="true" />}
                active={pathname === "/messages"}
                labelClassName="sr-only"
                badge={unreadMessages}
                onClick={() => handleProtectedRoute("/messages")}
              />
              <HeaderAction
                label="Orders"
                icon={<ReceiptText className="size-6" aria-hidden="true" />}
                active={pathname === "/orders"}
                labelClassName="hidden lg:inline"
                onClick={() => handleProtectedRoute("/orders")}
              />
            </nav>
          ) : null}
        </div>

        <div className="market-header-account-slot flex min-w-0 items-center gap-1.5">
          <nav aria-label="Market navigation" className="flex min-w-0">
            <HeaderAction
              label="Cart"
              ariaLabel={`Cart, ${cart.totals.count} ${
                cart.totals.count === 1 ? "item" : "items"
              }`}
              icon={<ShoppingCart className="size-6" aria-hidden="true" />}
              active={pathname === "/cart"}
              labelClassName="sr-only"
              badge={cart.totals.count}
              className="px-1.5 sm:px-3"
              onClick={() => void navigate({ to: "/cart" })}
            />
          </nav>
          <ThemeToggleButton />
          <AccountMenu
            key={accountPubkey ?? "guest"}
            accountPresent={!!accountPubkey}
            recoveryRequired={
              !!accountPubkey && signerReadiness === "unavailable"
            }
            incompatible={signerReadiness === "incompatible"}
            onReconnect={() => connect({ mode: "restore" })}
            items={[
              {
                label: "Profile",
                content: (
                  <Link to="/profile">
                    <CircleUser className="size-4" />
                    Profile
                  </Link>
                ),
              },
              {
                label: "Preferences",
                content: (
                  <Link to="/preferences">
                    <Settings2 className="size-4" />
                    Preferences
                  </Link>
                ),
              },
              {
                label: "Network",
                content: (
                  <Link to="/network">
                    <Radio className="size-4" />
                    Network
                  </Link>
                ),
              },
              {
                label: "Wallets",
                content: (
                  <Link to="/wallet">
                    <Wallet className="size-4" />
                    Wallets
                  </Link>
                ),
              },
            ]}
            displayName={displayName}
            pubkeyLabel={pubkey ? formatNpub(pubkey, 8) : undefined}
            avatarUrl={profile?.picture}
            pending={authPending}
            onConnect={() => requestSignIn()}
            onDisconnect={disconnectAccount}
          />
        </div>
      </div>
    </header>
  )
}
