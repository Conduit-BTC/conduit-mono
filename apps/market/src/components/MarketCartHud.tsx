import {
  ChevronDown,
  Download,
  Minus,
  Plus,
  ShoppingCart,
  Store,
  Truck,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  getProfilePaymentAddress,
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
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useCart } from "../hooks/useCart"
import {
  useCartLnurlPreflights,
  useCartReadiness,
} from "../hooks/useCartReadiness"
import { useMerchantCheckoutCapability } from "../hooks/useMerchantCheckoutCapability"
import { useShopperPricing } from "../hooks/useShopperPricing"
import {
  getCartCommerceFingerprint,
  getCartItemKey,
  getCartItemStockEvidenceForAvailability,
  getCartItemStockForAvailability,
  getCartItemFulfillmentType,
  getCartPurchaseReference,
  groupCartPurchases,
  isCartProductAvailabilityBlocking,
  type CartPurchaseGroup,
} from "../lib/cart-model"
import { getCartHudRouteMode, reconcileCartHudMerchant } from "../lib/cart-hud"
import { MerchantAvatarFallback } from "./MerchantIdentity"
import { armHudZapIntent } from "../lib/hud-zap-intent"

const HUD_EXIT_DURATION_MS = 240

type PurchaseContext = {
  Icon: LucideIcon
  compactLabel: string
  label: string
  selectedLabel: string
}

function getPurchaseContext(group: CartPurchaseGroup): PurchaseContext {
  if (group.kind === "pickup") {
    const pickupTitle = group.items.find(
      (item) => item.fulfillment?.type === "pickup"
    )?.fulfillment
    const pickupDetail =
      pickupTitle?.type === "pickup"
        ? pickupTitle.option.location?.trim() ||
          pickupTitle.option.title?.trim()
        : ""
    return {
      Icon: Store,
      compactLabel: pickupDetail || "Event pickup",
      label: pickupDetail ? `Event pickup - ${pickupDetail}` : "Event pickup",
      selectedLabel: pickupDetail || "Event pickup",
    }
  }

  const digitalOnly = group.items.every(
    (item) => getCartItemFulfillmentType(item) === "digital"
  )
  return {
    Icon: digitalOnly ? Download : Truck,
    compactLabel: digitalOnly ? "Digital delivery" : "Delivery",
    label: digitalOnly ? "Digital delivery" : "Delivery",
    selectedLabel: digitalOnly ? "Digital delivery" : "Delivery",
  }
}

function PurchaseContextLabel({
  group,
  compact = false,
}: {
  group: CartPurchaseGroup
  compact?: boolean
}) {
  const context = getPurchaseContext(group)
  const { Icon } = context
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1 text-xs text-[var(--text-muted)]">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "min-w-0",
          compact ? "truncate" : "whitespace-normal break-words"
        )}
      >
        {compact ? context.compactLabel : context.selectedLabel}
      </span>
    </span>
  )
}

export type MarketCartHudProps = {
  pathname: string
}

export function MarketCartHud({ pathname }: MarketCartHudProps) {
  const navigate = useNavigate()
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const cart = useCart()
  const shopperPricing = useShopperPricing()
  const groups = useMemo(() => groupCartPurchases(cart.items), [cart.items])
  const merchantPubkeys = useMemo(
    () => Array.from(new Set(groups.map((group) => group.merchantPubkey))),
    [groups]
  )
  const profiles = useProfiles(merchantPubkeys, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    priority: "visible",
    maxUnresolvedRefetches: 2,
  })
  // Warm one LNURL-pay metadata read per merchant Lightning address while the
  // cart has items, including on routes where the dock itself stays hidden.
  const lud16ByMerchant = useMemo(() => {
    const map = new Map<string, string | undefined>()
    for (const merchantPubkey of merchantPubkeys) {
      map.set(
        merchantPubkey,
        getProfilePaymentAddress(profiles.profileContexts[merchantPubkey])
      )
    }
    return map
  }, [merchantPubkeys, profiles.profileContexts])
  useCartLnurlPreflights(lud16ByMerchant)
  const routeMode = getCartHudRouteMode(pathname)
  const [expanded, setExpanded] = useState(routeMode === "expanded")
  const [activePurchase, setActivePurchase] = useState<string | null>(
    groups[0]?.id ?? null
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
  const previousMutationSequenceRef = useRef(cart.mutationSequence)
  const previousScrollYRef = useRef(0)
  const hudResizeInProgressRef = useRef(false)

  const currentPurchase = reconcileCartHudMerchant(
    activePurchase,
    groups.map((group) => group.id)
  )
  const currentGroup = groups.find((group) => group.id === currentPurchase)
  const duplicatePurchaseContexts = useMemo(() => {
    const contextCounts = new Map<string, number>()
    for (const group of groups) {
      const context = getPurchaseContext(group).label
      contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1)
    }
    return new Set(
      Array.from(contextCounts)
        .filter(([, count]) => count > 1)
        .map(([context]) => context)
    )
  }, [groups])
  // Retain the last rendered cart so the dock can slide out instead of
  // disappearing when the cart empties or the route suppresses the HUD.
  const lastVisibleRef = useRef<{
    group: NonNullable<typeof currentGroup>
  } | null>(null)
  useLayoutEffect(() => {
    if (currentGroup) lastVisibleRef.current = { group: currentGroup }
  }, [currentGroup])
  const shouldShow =
    routeMode !== "suppressed" && !!currentPurchase && !!currentGroup
  const activeGroup = currentGroup ?? lastVisibleRef.current?.group
  const selectedMerchant = activeGroup?.merchantPubkey ?? null
  const cartReadiness = useCartReadiness(cart.items)
  const activeReadiness = activeGroup
    ? cartReadiness.byPurchase.get(activeGroup.id)
    : undefined
  const activeProfile = selectedMerchant
    ? profiles.data[selectedMerchant]
    : undefined
  const merchantLud16 = getProfilePaymentAddress(
    selectedMerchant ? profiles.profileContexts[selectedMerchant] : undefined
  )
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
  const activatePurchase = useCallback((purchaseId: string) => {
    setActivePurchase(purchaseId)
    setExpanded(true)
  }, [])

  useEffect(() => {
    setExpanded(routeMode === "expanded")
    if (pathname !== "/checkout") setZapStarting(false)
  }, [pathname, routeMode])

  useEffect(() => {
    if (currentPurchase !== activePurchase) setActivePurchase(currentPurchase)
  }, [activePurchase, currentPurchase])

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
    if (!cart.hydrated) return
    const observedMutation =
      cart.mutationSequence !== previousMutationSequenceRef.current
    previousMutationSequenceRef.current = cart.mutationSequence
    const previous = previousQuantitiesRef.current
    const next = new Map<string, number>()
    let increasedPurchase: string | null = null
    let increasedTitle: string | null = null
    let increasedQuantity = 0
    for (const item of cart.items) {
      const key = item.cartLineId ?? getCartItemKey(item)
      next.set(key, item.quantity)
      if (item.quantity > (previous.get(key) ?? 0)) {
        increasedPurchase =
          groups.find((group) =>
            group.items.some(
              (candidate) => candidate.cartLineId === item.cartLineId
            )
          )?.id ?? null
        increasedTitle = item.title
        increasedQuantity = item.quantity
      }
    }
    previousQuantitiesRef.current = next
    // Initial hydration does not advance the session-local mutation sequence,
    // so a restored cart stays quiet. A mutation that races hydration does
    // advance it and must still announce and expand the shopper's first add.
    if (!observedMutation || !increasedPurchase) return
    setActivePurchase(increasedPurchase)
    setExpanded(true)
    setAnnouncement(
      increasedTitle
        ? `Cart updated: ${increasedTitle}, quantity ${increasedQuantity}`
        : `Cart updated: ${cart.totals.count} items`
    )
  }, [
    cart.hydrated,
    cart.items,
    cart.mutationSequence,
    cart.totals.count,
    groups,
  ])

  useEffect(() => {
    if (routeMode === "suppressed" || groups.length === 0) return
    previousScrollYRef.current = window.scrollY
    const onScroll = () => {
      const nextY = window.scrollY
      if (hudResizeInProgressRef.current) {
        previousScrollYRef.current = nextY
        return
      }
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
    let settleFrame: number | null = null
    const updateHeight = () => {
      hudResizeInProgressRef.current = true
      root.style.setProperty(
        "--market-hud-height",
        `${Math.ceil(element.getBoundingClientRect().height)}px`
      )
      if (settleFrame !== null) cancelAnimationFrame(settleFrame)
      settleFrame = requestAnimationFrame(() => {
        previousScrollYRef.current = window.scrollY
        hudResizeInProgressRef.current = false
        settleFrame = null
      })
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (settleFrame !== null) cancelAnimationFrame(settleFrame)
      hudResizeInProgressRef.current = false
      root.style.removeProperty("--market-hud-height")
    }
  }, [expanded, mounted])

  if (!mounted || !activeGroup || !selectedMerchant) {
    return null
  }

  const merchantName =
    getProfileName(activeProfile) ??
    `Merchant ${formatNpub(selectedMerchant, 6)}`
  const zapReady = checkoutCapability.outcome === "zap_candidate"
  const startZapOut = () => {
    if (!zapReady || zapStarting || !pubkey || pricingIntent?.status !== "ok") {
      return
    }
    setZapStarting(true)
    armHudZapIntent({
      merchantPubkey: selectedMerchant,
      purchaseId: activeGroup.id,
      buyerPubkey: pubkey,
      cartFingerprint: getCartCommerceFingerprint(activeGroup.items),
      totalMsats: pricingIntent.totalMsats,
      createdAt: Date.now(),
    })
    void navigate({
      to: "/checkout",
      search: {
        merchant: pubkeyToNpub(selectedMerchant),
        purchase: activeGroup.id,
        intent: "zap",
      },
    })
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-30 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out motion-reduce:transition-none sm:px-4",
        entered
          ? "translate-y-[var(--market-footer-hidden-shift,0px)]"
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
              aria-label="Cart purchases"
              className="flex h-auto w-fit min-w-0 max-w-full justify-start justify-self-start gap-1 overflow-x-auto rounded-xl border-0 p-1 pr-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{
                maskImage:
                  "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
                WebkitMaskImage:
                  "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
              }}
            >
              {groups.map((group, index) => {
                const profile = profiles.data[group.merchantPubkey]
                const selected = group.id === activeGroup.id
                const context = getPurchaseContext(group)
                const contextCollides = duplicatePurchaseContexts.has(
                  context.label
                )
                const purchaseReference = getCartPurchaseReference(group.id)
                const merchantLabel =
                  getProfileName(profile) ?? formatNpub(group.merchantPubkey, 6)
                return (
                  <button
                    key={group.id}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${merchantLabel}, ${group.totalItems} cart ${group.totalItems === 1 ? "item" : "items"}, ${context.label}${contextCollides ? `, reference ${purchaseReference}` : ""}, purchase ${index + 1}`}
                    onClick={() => activatePurchase(group.id)}
                    className={cn(
                      "market-cart-hud-item flex min-h-11 max-w-60 shrink-0 items-center gap-2 rounded-lg border px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:transition-none sm:px-3",
                      selected
                        ? "border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)]"
                        : "border-transparent text-[var(--text-secondary)] hover:border-[color-mix(in_srgb,var(--primary-500)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--primary-500)_5%,transparent)] hover:text-[var(--text-primary)]"
                    )}
                  >
                    <Avatar className="h-7 w-7 shrink-0">
                      <AvatarImage src={profile?.picture} alt="" />
                      <AvatarFallback>
                        <MerchantAvatarFallback iconClassName="h-4 w-4" />
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden min-w-0 max-w-full text-left leading-tight sm:block">
                      <span className="block max-w-32 truncate">
                        {merchantLabel}
                      </span>
                      <PurchaseContextLabel group={group} compact />
                      {contextCollides ? (
                        <span
                          data-testid="desktop-purchase-reference"
                          className="block whitespace-nowrap font-mono text-[0.625rem] leading-tight text-[var(--text-muted)]"
                        >
                          #{index + 1} {purchaseReference}
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 text-left text-[0.68rem] leading-tight sm:hidden">
                      <span className="block">
                        {group.kind === "pickup" ? "Pickup" : "Delivery"}
                      </span>
                      <span
                        data-testid="purchase-cue"
                        className="block font-mono text-[var(--text-muted)]"
                      >
                        #{index + 1} {purchaseReference}
                      </span>
                    </span>
                    <StatusPill
                      variant="neutral"
                      aria-label={`${group.totalItems} cart ${group.totalItems === 1 ? "item" : "items"}`}
                      className="border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-2 py-0.5 text-[0.68rem] font-semibold tabular-nums text-[var(--text-primary)]"
                    >
                      {group.totalItems}
                    </StatusPill>
                  </button>
                )
              })}
            </div>
          ) : (
            <button
              type="button"
              aria-label={`${merchantName}, ${activeGroup.totalItems} cart ${activeGroup.totalItems === 1 ? "item" : "items"}, ${getPurchaseContext(activeGroup).label}`}
              onClick={() => activatePurchase(activeGroup.id)}
              className="flex min-h-11 w-fit min-w-0 max-w-60 items-center justify-self-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-2 text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:px-3"
            >
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarImage src={activeProfile?.picture} alt="" />
                <AvatarFallback>
                  <MerchantAvatarFallback iconClassName="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <span className="hidden min-w-0 text-left text-sm font-medium leading-tight sm:block">
                <span className="block truncate">{merchantName}</span>
                <PurchaseContextLabel group={activeGroup} compact />
              </span>
              <StatusPill
                variant="neutral"
                aria-label={`${activeGroup.totalItems} cart ${activeGroup.totalItems === 1 ? "item" : "items"}`}
                className="border-[color-mix(in_srgb,var(--primary-500)_15%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] px-2 py-0.5 text-[0.68rem] font-semibold tabular-nums text-[var(--text-primary)]"
              >
                {activeGroup.totalItems}
              </StatusPill>
            </button>
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
                    search={{
                      merchant: pubkeyToNpub(selectedMerchant),
                      purchase: activeGroup.id,
                    }}
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
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  to="/store/$pubkey"
                  params={{ pubkey: selectedMerchant }}
                  aria-label={`Open ${merchantName} merchant page`}
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
                <span
                  data-testid="selected-purchase-context"
                  className="min-w-0 max-w-full"
                >
                  <PurchaseContextLabel group={activeGroup} />
                </span>
              </div>
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
                  const currentStockEvidence =
                    getCartItemStockEvidenceForAvailability(availability)
                  const itemUnavailable =
                    isCartProductAvailabilityBlocking(availability)
                  return (
                    <article
                      key={item.cartLineId ?? getCartItemKey(item)}
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
                                else cart.decrementItem(item)
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
                                cart.incrementItem(
                                  item,
                                  1,
                                  currentStockEvidence
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
                {activeAvailabilityMessage ||
                activeReadiness?.isChecking ||
                activeReadiness?.isRefreshing ? (
                  <span
                    role="status"
                    className="max-w-md text-xs text-[var(--text-muted)]"
                  >
                    {activeAvailabilityMessage ??
                      (activeReadiness?.isChecking
                        ? "Checking stock…"
                        : "Refreshing availability…")}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/cart"
                      search={{
                        merchant: pubkeyToNpub(selectedMerchant),
                        purchase: activeGroup.id,
                      }}
                    >
                      View full cart
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
                        search={{
                          merchant: pubkeyToNpub(selectedMerchant),
                          purchase: activeGroup.id,
                        }}
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
