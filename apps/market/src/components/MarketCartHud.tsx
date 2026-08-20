import { ChevronDown, Minus, Plus, ShoppingCart, Zap } from "lucide-react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  formatNpub,
  getProfileName,
  pubkeyToNpub,
  useAuth,
  useProfiles,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  HoldToReleaseButton,
  StatusPill,
  cn,
} from "@conduit/ui"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { useCart } from "../hooks/useCart"
import {
  useCartLnurlPreflights,
  useCartReadiness,
} from "../hooks/useCartReadiness"
import { useMerchantCheckoutCapability } from "../hooks/useMerchantCheckoutCapability"
import { useShopperPricing } from "../hooks/useShopperPricing"
import {
  getCartCommerceFingerprint,
  getCartCostSummary,
  getCartItemKey,
  getCartItemStockForAvailability,
  groupCartItems,
  isCartProductAvailabilityBlocking,
} from "../lib/cart-model"
import { getCartHudRouteMode, reconcileCartHudMerchant } from "../lib/cart-hud"
import { MerchantAvatarFallback } from "./MerchantIdentity"
import { armHudZapIntent } from "../lib/hud-zap-intent"

const HUD_EXIT_DURATION_MS = 240

export type MarketCartHudProps = {
  pathname: string
}

export function MarketCartHud({ pathname }: MarketCartHudProps) {
  const navigate = useNavigate()
  const { pubkey } = useAuth()
  const cart = useCart()
  const shopperPricing = useShopperPricing()
  const groups = useMemo(() => groupCartItems(cart.items), [cart.items])
  const merchantPubkeys = useMemo(
    () => groups.map((group) => group.merchantPubkey),
    [groups]
  )
  const profiles = useProfiles(merchantPubkeys, {
    priority: "visible",
    maxUnresolvedRefetches: 2,
  })
  // Warm one LNURL-pay metadata read per merchant Lightning address while the
  // cart has items, including on routes where the dock itself stays hidden.
  const lud16ByMerchant = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const merchantPubkey of merchantPubkeys) {
      map.set(merchantPubkey, profiles.data[merchantPubkey]?.lud16)
    }
    return map
  }, [merchantPubkeys, profiles.data])
  useCartLnurlPreflights(lud16ByMerchant)
  const routeMode = getCartHudRouteMode(pathname)
  const [expanded, setExpanded] = useState(routeMode === "expanded")
  const [activeMerchant, setActiveMerchant] = useState<string | null>(
    merchantPubkeys[0] ?? null
  )
  const [announcement, setAnnouncement] = useState("")
  const [mounted, setMounted] = useState(false)
  const [entered, setEntered] = useState(false)
  const [zapStarting, setZapStarting] = useState(false)
  const hudRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const disclosureRef = useRef<HTMLButtonElement>(null)
  const detailsPanelId = useId()
  const previousQuantitiesRef = useRef(new Map<string, number>())
  const cartHydratedRef = useRef(false)
  const previousScrollYRef = useRef(0)

  const currentMerchant = reconcileCartHudMerchant(
    activeMerchant,
    merchantPubkeys
  )
  const currentGroup = groups.find(
    (group) => group.merchantPubkey === currentMerchant
  )
  // Retain the last rendered cart so the dock can slide out instead of
  // disappearing when the cart empties or the route suppresses the HUD.
  const lastVisibleRef = useRef<{
    merchantPubkey: string
    group: NonNullable<typeof currentGroup>
  } | null>(null)
  if (currentMerchant && currentGroup) {
    lastVisibleRef.current = {
      merchantPubkey: currentMerchant,
      group: currentGroup,
    }
  }
  const shouldShow =
    routeMode !== "suppressed" && !!currentMerchant && !!currentGroup
  const selectedMerchant =
    currentMerchant ?? lastVisibleRef.current?.merchantPubkey ?? null
  const activeGroup = currentGroup ?? lastVisibleRef.current?.group
  const cartReadiness = useCartReadiness(cart.items)
  const activeReadiness = selectedMerchant
    ? cartReadiness.byMerchant.get(selectedMerchant)
    : undefined
  const activeProfile = selectedMerchant
    ? profiles.data[selectedMerchant]
    : undefined
  const merchantLud16 = activeProfile?.lud16
  const activeSummary = activeGroup
    ? getCartCostSummary(activeGroup.items, shopperPricing.quote)
    : null
  const activeTotal = activeSummary
    ? activeSummary.itemPricesAvailable
      ? shopperPricing.formatSatsAmount(activeSummary.totalSats)
      : null
    : null
  const activeAvailabilityMessage = activeReadiness?.blockingMessage ?? null
  const checkoutDisabled = !!activeAvailabilityMessage
  // Cart presence is sufficient shopper intent for the LNURL metadata
  // preflight, so the HUD decides Zap Out capability from the shared
  // per-merchant readiness and metadata evidence. Checkout still performs
  // the authoritative endpoint, amount, and invoice validation inside its
  // explicit payment flow.
  const capabilityView = useMerchantCheckoutCapability({
    items: activeGroup?.items ?? [],
    readiness: activeReadiness,
    merchantLud16,
    enabled: shouldShow,
  })
  const checkoutCapability = capabilityView.capability
  const pricingIntent = capabilityView.pricingIntent
  const checkoutFallbackMessage = capabilityView.fallbackMessage
  // Collapsing hides and inerts the panel. If focus is inside, move it to
  // the disclosure toggle first so keyboard and screen-reader users are not
  // dropped at the document root.
  const collapseHud = useCallback(() => {
    const panel = panelRef.current
    if (
      panel &&
      document.activeElement instanceof HTMLElement &&
      panel.contains(document.activeElement)
    ) {
      disclosureRef.current?.focus()
    }
    setExpanded(false)
  }, [])

  // One activation path for pointer, Enter, and Space: selecting a merchant
  // while collapsed both selects it and expands the panel, including when the
  // activated merchant is already selected.
  const activateMerchant = useCallback((merchantPubkey: string) => {
    setActiveMerchant(merchantPubkey)
    setExpanded(true)
  }, [])

  useEffect(() => {
    setExpanded(routeMode === "expanded")
    if (pathname !== "/checkout") setZapStarting(false)
  }, [pathname, routeMode])

  useEffect(() => {
    if (currentMerchant !== activeMerchant) setActiveMerchant(currentMerchant)
  }, [activeMerchant, currentMerchant])

  useEffect(() => {
    if (shouldShow) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(frame)
    }
    setEntered(false)
    const timer = setTimeout(() => setMounted(false), HUD_EXIT_DURATION_MS)
    return () => clearTimeout(timer)
  }, [shouldShow])

  useEffect(() => {
    const previous = previousQuantitiesRef.current
    const next = new Map<string, number>()
    let increasedMerchant: string | null = null
    let increasedTitle: string | null = null
    let increasedQuantity = 0
    for (const item of cart.items) {
      const key = getCartItemKey(item)
      next.set(key, item.quantity)
      if (item.quantity > (previous.get(key) ?? 0)) {
        increasedMerchant = item.merchantPubkey
        increasedTitle = item.title
        increasedQuantity = item.quantity
      }
    }
    previousQuantitiesRef.current = next
    // The first pass observes whatever the persisted cart restored; announcing
    // or expanding for it would misreport hydration as a shopper action. Any
    // later increase is a real mutation, including the session's first item.
    const isInitialHydration = !cartHydratedRef.current
    cartHydratedRef.current = true
    if (isInitialHydration || !increasedMerchant) return
    setActiveMerchant(increasedMerchant)
    setExpanded(true)
    setAnnouncement(
      increasedTitle
        ? `Cart updated: ${increasedTitle}, quantity ${increasedQuantity}`
        : `Cart updated: ${cart.totals.count} items`
    )
  }, [cart.items, cart.totals.count])

  useEffect(() => {
    if (routeMode === "suppressed" || groups.length === 0) return
    previousScrollYRef.current = window.scrollY
    const onScroll = () => {
      const nextY = window.scrollY
      if (nextY - previousScrollYRef.current >= 24) collapseHud()
      previousScrollYRef.current = nextY
    }
    const onFocus = (event: FocusEvent) => {
      if (
        window.innerWidth < 768 &&
        event.target instanceof HTMLElement &&
        event.target.matches(
          "input, textarea, select, [contenteditable='true']"
        )
      ) {
        collapseHud()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapseHud()
    }
    const visualViewport = window.visualViewport
    const onViewportResize = () => {
      if (visualViewport && visualViewport.height < window.innerHeight * 0.75) {
        collapseHud()
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    document.addEventListener("focusin", onFocus)
    window.addEventListener("keydown", onKeyDown)
    visualViewport?.addEventListener("resize", onViewportResize)
    return () => {
      window.removeEventListener("scroll", onScroll)
      document.removeEventListener("focusin", onFocus)
      window.removeEventListener("keydown", onKeyDown)
      visualViewport?.removeEventListener("resize", onViewportResize)
    }
  }, [collapseHud, groups.length, routeMode])

  useEffect(() => {
    const root = document.documentElement
    const element = hudRef.current
    if (!element || !mounted) {
      root.style.removeProperty("--market-hud-height")
      return
    }
    const updateHeight = () => {
      root.style.setProperty(
        "--market-hud-height",
        `${Math.ceil(element.getBoundingClientRect().height)}px`
      )
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty("--market-hud-height")
    }
  }, [expanded, mounted])

  if (!mounted || !activeGroup || !selectedMerchant) {
    return null
  }

  const merchantName =
    getProfileName(activeProfile) ?? `Store ${formatNpub(selectedMerchant, 6)}`
  const zapReady = checkoutCapability.outcome === "zap_candidate"
  const startZapOut = () => {
    if (!zapReady || zapStarting || !pubkey || pricingIntent?.status !== "ok") {
      return
    }
    setZapStarting(true)
    armHudZapIntent({
      merchantPubkey: selectedMerchant,
      buyerPubkey: pubkey,
      cartFingerprint: getCartCommerceFingerprint(activeGroup.items),
      totalMsats: pricingIntent.totalMsats,
      createdAt: Date.now(),
    })
    void navigate({
      to: "/checkout",
      search: {
        merchant: pubkeyToNpub(selectedMerchant),
        intent: "zap",
      },
    })
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-30 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out motion-reduce:transition-none sm:px-4",
        entered
          ? "translate-y-0"
          : "translate-y-[calc(100%_+_var(--market-fixed-footer-height,0px))]"
      )}
      style={{ bottom: "var(--market-fixed-footer-height, 0px)" }}
    >
      <section
        ref={hudRef}
        aria-label="Cart inventory"
        aria-hidden={!shouldShow}
        inert={!shouldShow}
        className="market-cart-hud-surface pointer-events-auto mx-auto w-full max-w-4xl overflow-hidden rounded-2xl border border-[var(--border)] shadow-[0_12px_34px_color-mix(in_srgb,var(--shadow)_22%,transparent)] backdrop-blur"
      >
        <div className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
          <span
            aria-hidden="true"
            className="flex h-10 w-8 shrink-0 items-center justify-center text-primary-500"
          >
            <ShoppingCart className="h-6 w-6" />
          </span>

          {groups.length > 1 ? (
            <div
              role="group"
              aria-label="Store carts"
              className="flex h-auto w-fit min-w-0 max-w-full justify-start justify-self-start gap-1 overflow-x-auto rounded-xl border-0 p-1 pr-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{
                maskImage:
                  "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
                WebkitMaskImage:
                  "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
              }}
            >
              {groups.map((group) => {
                const profile = profiles.data[group.merchantPubkey]
                const groupSummary = getCartCostSummary(
                  group.items,
                  shopperPricing.quote
                )
                const groupTotal = shopperPricing.formatSatsAmount(
                  groupSummary.totalSats
                )
                const selected = group.merchantPubkey === selectedMerchant
                return (
                  <button
                    key={group.merchantPubkey}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => activateMerchant(group.merchantPubkey)}
                    className={cn(
                      "market-cart-hud-item flex min-h-11 max-w-60 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:transition-none",
                      selected
                        ? "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]"
                        : "border-transparent text-[var(--text-secondary)] hover:border-[color-mix(in_srgb,var(--primary-500)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] hover:text-[var(--text-primary)]"
                    )}
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarImage src={profile?.picture} alt="" />
                      <AvatarFallback>
                        <MerchantAvatarFallback iconClassName="h-4 w-4" />
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 text-left leading-tight">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="block max-w-32 truncate">
                          {getProfileName(profile) ??
                            formatNpub(group.merchantPubkey, 6)}
                        </span>
                        <StatusPill
                          variant="neutral"
                          aria-label={`${group.totalItems} cart ${group.totalItems === 1 ? "item" : "items"}`}
                          className="border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-2 py-0.5 text-[0.68rem] font-semibold tabular-nums text-[var(--text-primary)]"
                        >
                          {group.totalItems}
                        </StatusPill>
                      </span>
                      {selected && expanded ? (
                        <span className="block max-w-44 truncate text-xs font-normal text-[var(--text-muted)]">
                          {groupSummary.itemPricesAvailable
                            ? groupTotal.primary
                            : "Total unavailable"}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <Link
              to="/store/$pubkey"
              params={{ pubkey: selectedMerchant }}
              aria-label={`Open ${merchantName} store`}
              className="flex min-h-11 w-fit min-w-0 max-w-60 items-center justify-self-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-3 text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={activeProfile?.picture} alt="" />
                <AvatarFallback>
                  <MerchantAvatarFallback iconClassName="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 text-left text-sm font-medium leading-tight">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="block truncate">{merchantName}</span>
                  <StatusPill
                    variant="neutral"
                    aria-label={`${activeGroup.totalItems} cart ${activeGroup.totalItems === 1 ? "item" : "items"}`}
                    className="border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-2 py-0.5 text-[0.68rem] font-semibold tabular-nums text-[var(--text-primary)]"
                  >
                    {activeGroup.totalItems}
                  </StatusPill>
                </span>
                {expanded && activeSummary ? (
                  <span className="block truncate text-xs font-normal text-[var(--text-muted)]">
                    {activeTotal?.primary ?? "Total unavailable"}
                  </span>
                ) : null}
              </span>
            </Link>
          )}

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <Button
              ref={disclosureRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={expanded ? "Collapse cart" : "Expand cart"}
              aria-expanded={expanded}
              aria-controls={detailsPanelId}
              className="h-11 w-11 shrink-0 text-[var(--text-muted)]"
              onClick={() => (expanded ? collapseHud() : setExpanded(true))}
            >
              {/* Bottom-anchored dock: expanding raises content (up), collapsing
                  lowers it (down), so the arrow points at the resulting motion. */}
              <ChevronDown
                className={cn(
                  "h-5 w-5 transition-transform motion-reduce:transition-none",
                  !expanded && "rotate-180"
                )}
                aria-hidden="true"
              />
            </Button>
            {!expanded &&
              (checkoutDisabled ? (
                <>
                  <Button
                    size="sm"
                    disabled
                    aria-describedby={`${detailsPanelId}-blocked-reason`}
                    title={
                      activeAvailabilityMessage ??
                      "Checking current product stock"
                    }
                  >
                    Checkout
                  </Button>
                  <span
                    id={`${detailsPanelId}-blocked-reason`}
                    role="status"
                    className="sr-only"
                  >
                    {activeAvailabilityMessage ??
                      "Checking current product stock"}
                  </span>
                </>
              ) : zapReady ? (
                <HoldToReleaseButton
                  size="sm"
                  disabled={zapStarting}
                  canComplete={() =>
                    checkoutCapability.outcome === "zap_candidate" &&
                    !zapStarting
                  }
                  onHoldComplete={startZapOut}
                  chargedLabel="Release to zap out"
                >
                  <Zap className="h-4 w-4" aria-hidden="true" />
                  Zap out
                </HoldToReleaseButton>
              ) : (
                <Button asChild size="sm">
                  <Link
                    to="/checkout"
                    search={{ merchant: pubkeyToNpub(selectedMerchant) }}
                    title={checkoutFallbackMessage}
                  >
                    Checkout
                  </Link>
                </Button>
              ))}
          </div>
        </div>

        <div
          id={detailsPanelId}
          ref={panelRef}
          className={cn(
            "grid transition-opacity duration-200 motion-reduce:transition-none",
            expanded
              ? "grid-rows-[1fr] border-t border-[var(--border)] opacity-100"
              : "grid-rows-[0fr] opacity-0"
          )}
          aria-hidden={!expanded}
          inert={!expanded}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="space-y-3 p-3 sm:p-4">
              {groups.length > 1 ? (
                <Link
                  to="/store/$pubkey"
                  params={{ pubkey: selectedMerchant }}
                  aria-label={`Open ${merchantName} store`}
                  className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-lg px-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <Avatar className="h-7 w-7">
                    <AvatarImage src={activeProfile?.picture} alt="" />
                    <AvatarFallback>
                      <MerchantAvatarFallback iconClassName="h-4 w-4" />
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{merchantName}</span>
                </Link>
              ) : null}
              <div
                role="region"
                aria-label="Cart products"
                className="flex max-w-full snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-1 pr-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{
                  maskImage:
                    "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
                  WebkitMaskImage:
                    "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
                }}
              >
                {activeGroup.items.map((item) => {
                  const display = shopperPricing.formatPrice(item)
                  const availability =
                    activeReadiness?.availabilityByProductId.get(item.productId)
                  const currentStock = getCartItemStockForAvailability(
                    item,
                    availability
                  )
                  const itemUnavailable =
                    isCartProductAvailabilityBlocking(availability)
                  return (
                    <article
                      key={getCartItemKey(item)}
                      className="market-cart-hud-item flex w-[17rem] shrink-0 snap-start items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-2.5 transition-colors motion-reduce:transition-none"
                    >
                      <Link
                        to="/products/$productId"
                        params={{ productId: item.productId }}
                        className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        aria-label={`Open ${item.title}`}
                      >
                        {item.image ? (
                          <img
                            src={item.image}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full items-center justify-center text-[var(--text-muted)]">
                            <ShoppingCart
                              className="h-5 w-5"
                              aria-hidden="true"
                            />
                          </span>
                        )}
                      </Link>
                      <div className="min-w-0 flex-1">
                        <Link
                          to="/products/$productId"
                          params={{ productId: item.productId }}
                          className="block truncate text-sm font-medium text-[var(--text-primary)] hover:text-primary-500"
                        >
                          {item.title}
                        </Link>
                        <div className="truncate text-xs text-[var(--text-muted)]">
                          {display.primary}
                        </div>
                        {itemUnavailable ? (
                          <div className="mt-1 text-xs font-medium text-[var(--error)]">
                            {availability?.status === "sold_out"
                              ? "Sold out"
                              : `Only ${currentStock ?? 0} available`}
                          </div>
                        ) : null}
                        <div className="mt-1 flex justify-end">
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-9 w-9"
                              aria-label={`Decrease ${item.title} quantity`}
                              onClick={() => {
                                if (item.quantity <= 1) cart.removeItem(item)
                                else cart.setQuantity(item, item.quantity - 1)
                              }}
                            >
                              <Minus className="h-4 w-4" aria-hidden="true" />
                            </Button>
                            <span
                              key={item.quantity}
                              className="market-cart-hud-value w-8 text-center text-sm font-semibold tabular-nums"
                            >
                              {item.quantity}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-9 w-9"
                              aria-label={`Increase ${item.title} quantity`}
                              disabled={
                                activeReadiness?.isChecking === true ||
                                itemUnavailable ||
                                (typeof currentStock === "number" &&
                                  item.quantity >= currentStock)
                              }
                              onClick={() =>
                                cart.addItem(
                                  { ...item, stock: currentStock },
                                  1
                                )
                              }
                            >
                              <Plus className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                <span
                  role="status"
                  className="max-w-md text-xs text-[var(--text-muted)]"
                >
                  {activeAvailabilityMessage ??
                    (activeReadiness?.isChecking
                      ? "Checking stock…"
                      : activeReadiness?.isRefreshing
                        ? "Refreshing availability…"
                        : checkoutFallbackMessage)}
                </span>
                <div className="flex shrink-0 gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/cart"
                      search={{ merchant: pubkeyToNpub(selectedMerchant) }}
                    >
                      View cart
                    </Link>
                  </Button>
                  {checkoutDisabled ? (
                    <Button
                      size="sm"
                      disabled
                      title={
                        activeAvailabilityMessage ??
                        "Checking current product stock"
                      }
                    >
                      Continue to checkout
                    </Button>
                  ) : zapReady ? (
                    <HoldToReleaseButton
                      size="sm"
                      disabled={zapStarting}
                      canComplete={() =>
                        checkoutCapability.outcome === "zap_candidate" &&
                        !zapStarting
                      }
                      onHoldComplete={startZapOut}
                      chargedLabel="Release to zap out"
                    >
                      <Zap className="h-4 w-4" aria-hidden="true" />
                      Continue to Zap Out
                    </HoldToReleaseButton>
                  ) : (
                    <Button asChild size="sm">
                      <Link
                        to="/checkout"
                        search={{ merchant: pubkeyToNpub(selectedMerchant) }}
                        title={checkoutFallbackMessage}
                      >
                        Continue to checkout
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </section>
    </div>
  )
}
