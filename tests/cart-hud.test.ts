import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  getCartHudCheckoutCapability,
  getCartHudCheckoutFallbackMessage,
  getCartHudRouteMode,
  reconcileCartHudMerchant,
} from "../apps/market/src/lib/cart-hud"

describe("Market cart HUD policy", () => {
  it("shows the cart while browsing event catalogs", () => {
    for (const pathname of ["/events", "/events/", "/events/naddr1example"]) {
      expect(getCartHudRouteMode(pathname)).toBe("expanded")
    }
    for (const pathname of [
      "/eventsettings",
      "/checkout",
      "/cart",
      "/orders",
    ]) {
      expect(getCartHudRouteMode(pathname)).toBe("suppressed")
    }
  })

  it("matches the Merchant navigation selected and hover palette", () => {
    const source = readFileSync(
      new URL(
        "../apps/market/src/components/MarketCartHud.tsx",
        import.meta.url
      ),
      "utf8"
    )
    const styles = readFileSync(
      new URL("../apps/market/src/styles/index.css", import.meta.url),
      "utf8"
    )

    expect(source).toContain("var(--primary-500)_15%,transparent")
    expect(source).toContain("var(--primary-500)_9%,transparent")
    expect(source).toContain("var(--primary-500)_10%,transparent")
    expect(source).toContain("var(--primary-500)_5%,transparent")
    expect(source).toContain("shadow-[var(--shadow-glass-inset)]")
    expect(source).toContain("market-cart-hud-surface")
    expect(styles).toContain("var(--background) 92%, transparent")
    expect(styles).toContain("var(--warning) 1%, var(--surface)")
    expect(
      source.match(/var\(--primary-500\)_15%,transparent/g)?.length
    ).toBeGreaterThanOrEqual(3)
    expect(source).toContain('aria-label="Cart products"')
    expect(source).toContain("linear-gradient(to right")
    expect(source).toContain("rounded-xl border-0 p-1 pr-8")
    expect(source.match(/max-w-60/g)?.length).toBe(2)
    // Three-column header: shrink-free glyph, minmax(0,1fr) merchant rail,
    // shrink-free disclosure + CTA controls. No magic width subtraction.
    expect(source).toContain("grid-cols-[auto_minmax(0,1fr)_auto]")
    expect(source).not.toContain("calc(100%_-_7rem)")
    expect(source).toContain("min-h-11 w-fit min-w-0 max-w-60 items-center")
    expect(source.match(/<StatusPill/g)?.length).toBe(2)
    expect(source).toContain('variant="neutral"')
    expect(source).toContain("selected && expanded")
  })

  it("uses one truthful activation and disclosure interaction model", () => {
    const source = readFileSync(
      new URL(
        "../apps/market/src/components/MarketCartHud.tsx",
        import.meta.url
      ),
      "utf8"
    )

    // Single-selection merchant button group instead of tabs pointing at a
    // panel that is not a tabpanel.
    expect(source).toContain('role="group"')
    expect(source).toContain("aria-pressed={selected}")
    expect(source).not.toContain("TabsTrigger")
    // One activation path shared by pointer, Enter, and Space; activating a
    // merchant while collapsed selects and expands it, including the
    // already-selected merchant.
    expect(source).toContain("const activateMerchant = useCallback")
    expect(source).toContain(
      "onClick={() => activateMerchant(group.merchantPubkey)}"
    )
    // The disclosure toggle controls the real details panel element.
    expect(source).toContain("aria-controls={detailsPanelId}")
    expect(source).toContain("id={detailsPanelId}")
    // Bottom dock arrow points at the resulting motion: collapsed -> up.
    expect(source).toContain('!expanded && "rotate-180"')
    // Collapse restores focus out of the soon-to-be-inert panel.
    expect(source).toContain("const collapseHud = useCallback")
    expect(source).toContain("disclosureRef.current?.focus()")
    // No layout-property animation on expansion.
    expect(source).not.toContain("transition-[grid-template-rows")
    expect(source).toContain("grid transition-opacity duration-200")
    // Decorative cart glyph carries no control-like filled surface.
    expect(source).not.toContain("rounded-xl bg-primary-500 text-white")
    // Initial hydration is tracked separately from a real first-item add.
    expect(source).toContain("cartHydratedRef")
    expect(source).toContain("isInitialHydration")
  })

  it("slides the dock in and out of the bottom of the page", () => {
    const source = readFileSync(
      new URL(
        "../apps/market/src/components/MarketCartHud.tsx",
        import.meta.url
      ),
      "utf8"
    )

    expect(source).toContain(
      "transition-transform duration-200 ease-out motion-reduce:transition-none"
    )
    expect(source).toContain('entered\n          ? "translate-y-0"')
    expect(source).toContain(
      "translate-y-[calc(100%_+_var(--market-fixed-footer-height,0px))]"
    )
    expect(source).toContain("requestAnimationFrame(() => setEntered(true))")
    expect(source).toContain("setTimeout(() => setMounted(false)")
    expect(source).toContain("const HUD_EXIT_DURATION_MS = 240")
    expect(source).toContain("lastVisibleRef")
    expect(source).toContain("aria-hidden={!shouldShow}")
    expect(source).toContain("inert={!shouldShow}")
    expect(source).toContain(
      "if (!mounted || !activeGroup || !selectedMerchant)"
    )
  })

  it("expands on browse surfaces, compacts product detail, and suppresses workflows", () => {
    expect(getCartHudRouteMode("/products")).toBe("expanded")
    expect(getCartHudRouteMode("/store/merchant")).toBe("expanded")
    expect(getCartHudRouteMode("/products/30402:merchant:item")).toBe("compact")
    for (const pathname of [
      "/cart",
      "/checkout",
      "/orders",
      "/messages",
      "/wallet",
      "/network",
      "/profile",
      "/about",
      "/zapouts",
      "/u/profile",
    ]) {
      expect(getCartHudRouteMode(pathname)).toBe("suppressed")
    }
  })

  it("arms zap out only when every HUD eligibility input is ready", () => {
    expect(
      getCartHudCheckoutCapability({
        listingFresh: true,
        shopperPresetReady: true,
        walletReady: true,
        itemPricesAvailable: true,
        shippingReady: true,
        merchantLightningReady: true,
      })
    ).toEqual({
      state: "zap_ready",
      blockers: [],
    })
  })

  it("reports every unavailable HUD checkout input", () => {
    expect(
      getCartHudCheckoutCapability({
        listingFresh: false,
        shopperPresetReady: false,
        walletReady: false,
        itemPricesAvailable: false,
        shippingReady: false,
        merchantLightningReady: false,
      })
    ).toEqual({
      state: "route_to_checkout",
      blockers: [
        "listing_freshness_unavailable",
        "shopper_preset_unavailable",
        "wallet_unavailable",
        "price_unavailable",
        "shipping_unavailable",
        "merchant_lightning_unavailable",
      ],
    })
  })

  it("explains why the HUD routes through checkout", () => {
    expect(
      getCartHudCheckoutFallbackMessage({
        state: "zap_ready",
        blockers: [],
      })
    ).toBe(
      "Ready to zap out. Checkout confirms the merchant payment endpoint before paying."
    )
    expect(
      getCartHudCheckoutFallbackMessage({
        state: "route_to_checkout",
        blockers: ["price_unavailable"],
      })
    ).toBe("Checkout is needed to refresh the cart total.")
    expect(
      getCartHudCheckoutFallbackMessage({
        state: "route_to_checkout",
        blockers: ["listing_freshness_unavailable"],
      })
    ).toBe("Checkout is needed to confirm shipping and payment readiness.")
  })

  it("hands eligible HUD holds to checkout's canonical zap lifecycle", () => {
    const hud = readFileSync(
      new URL(
        "../apps/market/src/components/MarketCartHud.tsx",
        import.meta.url
      ),
      "utf8"
    )
    const checkout = readFileSync(
      new URL("../apps/market/src/routes/checkout.tsx", import.meta.url),
      "utf8"
    )
    const capability = readFileSync(
      new URL(
        "../apps/market/src/hooks/useMerchantCheckoutCapability.ts",
        import.meta.url
      ),
      "utf8"
    )
    const wallets = readFileSync(
      new URL("../apps/market/src/hooks/useWallets.ts", import.meta.url),
      "utf8"
    )

    expect(hud).toContain('to="/checkout"')
    expect(hud).toContain("<HoldToReleaseButton")
    expect(hud).toContain("Zap out")
    expect(hud).toContain('intent: "zap"')
    expect(hud).toContain("checkoutFallbackMessage")
    // Capability comes from the shared per-merchant derivation over prepared
    // readiness and the LNURL preflight, not from HUD-local wallet probing.
    expect(hud).toContain("useMerchantCheckoutCapability({")
    expect(hud).toContain("useCartReadiness(cart.items)")
    expect(hud).not.toContain("useWallet()")
    expect(hud).not.toContain("refreshBalance: true")
    expect(hud).not.toContain("getKnownWalletPaymentConstraint")
    expect(hud).not.toContain("fetchLnurlPayMetadata")
    expect(capability).toContain("const ownedWallets = useWallets({")
    expect(capability).toContain(
      "enabled: !input.wallets && enabled && input.items.length > 0"
    )
    expect(capability).toContain(
      "const wallets = input.wallets ?? ownedWallets"
    )
    expect(capability).not.toContain("useWallet()")
    expect(capability).toContain("resolveCheckoutPaymentTarget({")
    expect(capability).toContain("resolveWalletPaymentInstance(")
    expect(capability).toContain("getNwcPaymentReadiness({")
    expect(capability).toContain("getAuthSignerReadiness({")
    expect(capability).toContain(
      'if (paymentTarget.type === "webln") return webLnAvailable'
    )
    expect(wallets).toContain("NWC_MOUNT_WARM_MAX_AGE_MS = 30_000")
    expect(wallets).toContain("session.ensureWarm(")
    expect(wallets).toContain("getBuyerNwcSessionSnapshots(nextNwcWalletIds)")
    // Checkout reuses the shared preflight cache entry and requests again only
    // when it is absent, expired, or the address changed.
    expect(checkout).toContain("getFreshLnurlMetadata(merchantLud16)")
    expect(checkout).toContain("useMerchantLnurlPreflight(merchantLud16)")
    expect(checkout).toContain("queryClient.fetchQuery(")
    expect(checkout).toContain(
      "merchantLnurlPreflightQueryOptions(normalized, {"
    )
    expect(checkout).toContain("lnurlAllowsNostr: lnurlReadyForSelectedPayment")
    expect(checkout).toContain("lnurlAmountWithinRange: lnurlAmountReady")
    expect(checkout).toContain("if (!fastEligible) {")
    expect(checkout).toContain("isFastCheckoutInputPending({")
    expect(checkout).toContain("autoZapInputsResolving")
    expect(checkout).toContain(
      'walletConnecting: wallets.loading || wallet.status === "connecting"'
    )
    expect(checkout).toContain("consumeHudZapIntent(selectedMerchant)")
    expect(checkout).toContain("!autoZapAuthorization")
    expect(checkout).toContain("getHudZapAuthorizationRejection")
    // The automatic attempt claims the authorization exactly once: state
    // clears before the attempt starts, so a failed automatic zap out never
    // leaves an expired token behind for a later manual hold to inherit.
    expect(checkout).toContain("setAutoZapAuthorization(null)")
    expect(checkout).toContain("void payNowRef.current(autoZapAuthorization)")
    expect(checkout).toContain("void payNow()")
    expect(checkout).toContain("assertClaimedZapAuthorization(")
    expect(checkout).toContain("pricingIntent.totalMsats,")
    expect(checkout).toContain("authoritativeCheckoutItems")
    expect(checkout).toContain(
      'const [step, setStep] = useState<CheckoutStep>("shipping")'
    )
  })

  it("keeps a valid merchant selection and otherwise chooses the newest group", () => {
    expect(
      reconcileCartHudMerchant("merchant-b", ["merchant-a", "merchant-b"])
    ).toBe("merchant-b")
    expect(
      reconcileCartHudMerchant("removed", ["merchant-a", "merchant-b"])
    ).toBe("merchant-a")
    expect(reconcileCartHudMerchant(null, [])).toBeNull()
  })
})
