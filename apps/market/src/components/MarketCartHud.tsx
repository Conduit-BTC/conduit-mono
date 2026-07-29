import { ChevronDown, Minus, Plus, ShoppingCart, Zap } from "lucide-react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  fetchLnurlPayMetadata,
  formatNpub,
  getProfileName,
  hasWebLN,
  pubkeyToNpub,
  useAuth,
  useProfiles,
  validateAddressConsistency,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  HoldToReleaseButton,
  StatusPill,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
} from "@conduit/ui"
import { useEffect, useMemo, useRef, useState } from "react"
import { useCart } from "../hooks/useCart"
import { useCartProductAvailability } from "../hooks/useCartProductAvailability"
import { useShopperPricing } from "../hooks/useShopperPricing"
import { useWallet } from "../hooks/useWallet"
import {
  getCartAvailabilityBlockingMessage,
  getCartCostSummary,
  getCartItemIdentity,
  getCartItemKey,
  cartItemsMatchCurrentProducts,
  groupCartItems,
} from "../lib/cart-model"
import {
  getCartHudCheckoutCapability,
  getCartHudCheckoutFallbackMessage,
  getCartHudRouteMode,
  reconcileCartHudMerchant,
} from "../lib/cart-hud"
import { MerchantAvatarFallback } from "./MerchantIdentity"
import { buildCheckoutPricingIntent } from "../lib/checkout-payment"
import { readCheckoutShippingSession } from "../lib/checkout-session"
import { validateShippingFields } from "../lib/checkout-validation"
import {
  armHudZapIntent,
  getHudZapCartFingerprint,
} from "../lib/hud-zap-intent"
import {
  getCartShippingDestinationEligibility,
  hasPhysicalItemsMissingShippingZone,
} from "../lib/cart-shipping-options"

const HUD_EXIT_DURATION_MS = 240

export type MarketCartHudProps = {
  pathname: string
}

export function MarketCartHud({ pathname }: MarketCartHudProps) {
  const navigate = useNavigate()
  const { pubkey, status: authStatus } = useAuth()
  const cart = useCart()
  const shopperPricing = useShopperPricing()
  const wallet = useWallet()
  const groups = useMemo(() => groupCartItems(cart.items), [cart.items])
  const merchantPubkeys = useMemo(
    () => groups.map((group) => group.merchantPubkey),
    [groups]
  )
  const profiles = useProfiles(merchantPubkeys, {
    priority: "visible",
    maxUnresolvedRefetches: 2,
  })
  const routeMode = getCartHudRouteMode(pathname)
  const [expanded, setExpanded] = useState(routeMode === "expanded")
  const [activeMerchant, setActiveMerchant] = useState<string | null>(
    merchantPubkeys[0] ?? null
  )
  const [announcement, setAnnouncement] = useState("")
  const [mounted, setMounted] = useState(false)
  const [entered, setEntered] = useState(false)
  const [webLnAvailable, setWebLnAvailable] = useState(false)
  const [zapStarting, setZapStarting] = useState(false)
  const hudRef = useRef<HTMLElement>(null)
  const previousQuantitiesRef = useRef(new Map<string, number>())
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
  const cartAvailability = useCartProductAvailability(currentGroup?.items ?? [])
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
  const activeAvailabilityMessage = activeGroup
    ? getCartAvailabilityBlockingMessage(
        activeGroup.items,
        cartAvailability.availabilityByProductId
      )
    : null
  const checkoutDisabled = !!activeAvailabilityMessage
  const isAllDigital = Boolean(
    activeGroup?.items.length &&
    activeGroup.items.every((item) => item.format === "digital")
  )
  const shippingPreset = readCheckoutShippingSession()
  const shippingAddress = {
    name: `${shippingPreset.firstName.trim()} ${shippingPreset.lastName.trim()}`.trim(),
    street: [shippingPreset.street.trim(), shippingPreset.line2.trim()]
      .filter(Boolean)
      .join(", "),
    city: shippingPreset.city.trim(),
    state: (shippingPreset.state ?? "").trim() || undefined,
    postalCode: shippingPreset.postalCode.trim(),
    country: shippingPreset.country.trim().toUpperCase(),
  }
  const shippingPresetReady =
    isAllDigital ||
    (validateShippingFields(shippingPreset).length === 0 &&
      validateAddressConsistency(shippingAddress).canDirectPay)
  const shippingDestinationReady = Boolean(
    isAllDigital ||
    (activeGroup &&
      !hasPhysicalItemsMissingShippingZone(activeGroup.items) &&
      getCartShippingDestinationEligibility(
        {
          country: shippingAddress.country,
          postalCode: shippingAddress.postalCode,
        },
        activeGroup.items,
        []
      ).eligible === true)
  )
  const pricingIntent = activeGroup
    ? buildCheckoutPricingIntent(activeGroup.items, shopperPricing.quote)
    : null
  const listingTermsCurrent = Boolean(
    activeGroup &&
    cartItemsMatchCurrentProducts(activeGroup.items, cartAvailability.products)
  )
  const automaticWalletReady =
    webLnAvailable ||
    (wallet.status === "pay-capable" && Boolean(wallet.connection))
  const lnurlMetadata = useQuery({
    queryKey: ["cart-hud-lnurl", merchantLud16],
    queryFn: () => fetchLnurlPayMetadata(merchantLud16!),
    enabled: Boolean(merchantLud16 && pricingIntent?.status === "ok"),
    staleTime: 5 * 60 * 1000,
  })
  const lnurlAmountReady = Boolean(
    pricingIntent?.status === "ok" &&
    lnurlMetadata.data &&
    pricingIntent.totalMsats >= lnurlMetadata.data.minSendable &&
    pricingIntent.totalMsats <= lnurlMetadata.data.maxSendable
  )
  const checkoutCapability = getCartHudCheckoutCapability({
    listingFresh:
      shouldShow &&
      cartAvailability.isFresh &&
      !cartAvailability.hasUnavailableItems &&
      listingTermsCurrent,
    shopperPresetReady: shippingPresetReady,
    walletReady:
      authStatus === "connected" && Boolean(pubkey) && automaticWalletReady,
    itemPricesAvailable:
      activeSummary?.itemPricesAvailable === true &&
      pricingIntent?.status === "ok",
    shippingReady:
      shippingPresetReady &&
      shippingDestinationReady &&
      activeSummary?.shippingReadyForZap === true,
    merchantLightningReady: Boolean(merchantLud16),
    lnurlReady: lnurlAmountReady,
  })
  const checkoutFallbackMessage =
    getCartHudCheckoutFallbackMessage(checkoutCapability)
  useEffect(() => {
    const check = () => setWebLnAvailable(hasWebLN())
    check()
    window.addEventListener("focus", check)
    return () => window.removeEventListener("focus", check)
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
    if (!increasedMerchant || previous.size === 0) return
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
      if (nextY - previousScrollYRef.current >= 24) setExpanded(false)
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
        setExpanded(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false)
    }
    const visualViewport = window.visualViewport
    const onViewportResize = () => {
      if (visualViewport && visualViewport.height < window.innerHeight * 0.75) {
        setExpanded(false)
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
  }, [groups.length, routeMode])

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
  const zapReady = checkoutCapability.state === "zap_ready"
  const startZapOut = () => {
    if (!zapReady || zapStarting || !pubkey || pricingIntent?.status !== "ok") {
      return
    }
    setZapStarting(true)
    armHudZapIntent({
      merchantPubkey: selectedMerchant,
      buyerPubkey: pubkey,
      cartFingerprint: getHudZapCartFingerprint(activeGroup.items),
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
        <div className="flex min-h-14 items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white">
            <ShoppingCart className="h-5 w-5" aria-hidden="true" />
          </span>

          {groups.length > 1 ? (
            <Tabs
              value={selectedMerchant}
              onValueChange={setActiveMerchant}
              className="mr-auto min-w-0 w-fit max-w-[calc(100%_-_7rem)] flex-none"
            >
              <TabsList
                aria-label="Store carts"
                className="flex h-auto w-fit max-w-full justify-start gap-1 overflow-x-auto rounded-xl border-0 p-1 pr-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                    <TabsTrigger
                      key={group.merchantPubkey}
                      value={group.merchantPubkey}
                      className="market-cart-hud-item min-h-11 max-w-60 shrink-0 gap-2 rounded-lg border border-transparent px-3 data-[state=active]:border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] data-[state=active]:bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-[var(--shadow-glass-inset)] data-[state=inactive]:hover:border-[color-mix(in_srgb,var(--primary-500)_10%,transparent)] data-[state=inactive]:hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] data-[state=inactive]:hover:text-[var(--text-primary)]"
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
                    </TabsTrigger>
                  )
                })}
              </TabsList>
            </Tabs>
          ) : (
            <Link
              to="/store/$pubkey"
              params={{ pubkey: selectedMerchant }}
              aria-label={`Open ${merchantName} store`}
              className="mr-auto flex min-h-11 w-fit min-w-0 max-w-60 flex-none items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-3 text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
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

          <button
            type="button"
            aria-label={expanded ? "Collapse cart" : "Expand cart"}
            aria-expanded={expanded}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform motion-reduce:transition-none",
                expanded && "rotate-180"
              )}
              aria-hidden="true"
            />
          </button>
          {!expanded &&
            (checkoutDisabled ? (
              <Button
                size="sm"
                disabled
                title={
                  activeAvailabilityMessage ?? "Checking current product stock"
                }
              >
                Checkout
              </Button>
            ) : zapReady ? (
              <HoldToReleaseButton
                size="sm"
                disabled={zapStarting}
                canComplete={() =>
                  checkoutCapability.state === "zap_ready" && !zapStarting
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

        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none",
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
                  const identity = getCartItemIdentity(item)
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
                        <div className="mt-1 flex justify-end">
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_4%,var(--surface))] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-500)_8%,var(--surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                              aria-label={`Decrease ${item.title} quantity`}
                              onClick={() => {
                                if (item.quantity <= 1)
                                  cart.removeItem(identity)
                                else
                                  cart.setQuantity(identity, item.quantity - 1)
                              }}
                            >
                              <Minus className="h-4 w-4" aria-hidden="true" />
                            </button>
                            <span
                              key={item.quantity}
                              className="market-cart-hud-value w-8 text-center text-sm font-semibold tabular-nums"
                            >
                              {item.quantity}
                            </span>
                            <button
                              type="button"
                              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_4%,var(--surface))] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-500)_8%,var(--surface))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                              aria-label={`Increase ${item.title} quantity`}
                              onClick={() =>
                                cart.addItem(
                                  {
                                    productId: item.productId,
                                    merchantPubkey: item.merchantPubkey,
                                    title: item.title,
                                    price: item.price,
                                    currency: item.currency,
                                    priceSats: item.priceSats,
                                    sourcePrice: item.sourcePrice,
                                    image: item.image,
                                    tags: item.tags,
                                    format: item.format,
                                    shippingCostSats: item.shippingCostSats,
                                    sourceShippingCost: item.sourceShippingCost,
                                    shippingOptionId: item.shippingOptionId,
                                    shippingOptionDTag: item.shippingOptionDTag,
                                    shippingCountries: item.shippingCountries,
                                    shippingCountryRules:
                                      item.shippingCountryRules,
                                    publicZapEnabled: item.publicZapEnabled,
                                    zapMessagePolicy: item.zapMessagePolicy,
                                    publicZapPolicyKnown:
                                      item.publicZapPolicyKnown,
                                  },
                                  1
                                )
                              }
                            >
                              <Plus className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                <span className="max-w-md text-xs text-[var(--text-muted)]">
                  {checkoutFallbackMessage}
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
                        checkoutCapability.state === "zap_ready" && !zapStarting
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
