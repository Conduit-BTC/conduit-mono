import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  getCartHudCheckoutCapability,
  getCartHudCheckoutFallbackMessage,
  getCartHudRouteMode,
  reconcileCartHudMerchant,
} from "../apps/market/src/lib/cart-hud"

describe("Market cart HUD policy", () => {
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
    expect(source).toContain(
      'className="mr-auto min-w-0 w-fit max-w-[calc(100%_-_7rem)] flex-none"'
    )
    expect(source).toContain("min-h-11 w-fit min-w-0 max-w-60 flex-none")
    expect(source.match(/<StatusPill/g)?.length).toBe(2)
    expect(source).toContain('variant="neutral"')
    expect(source).toContain("selected && expanded")
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

    expect(hud).toContain('to="/checkout"')
    expect(hud).toContain("<HoldToReleaseButton")
    expect(hud).toContain("Zap out")
    expect(hud).toContain('intent: "zap"')
    expect(hud).toContain("checkoutFallbackMessage")
    expect(hud).toContain("const wallet = useWallet()")
    expect(hud).not.toContain("refreshBalance: true")
    expect(hud).not.toContain("getKnownWalletPaymentConstraint")
    expect(hud).not.toContain("fetchLnurlPayMetadata")
    expect(checkout).toContain("fetchLnurlPayMetadata(merchantLud16)")
    expect(checkout).toContain("lnurlAllowsNostr: lnurlReadyForSelectedPayment")
    expect(checkout).toContain("lnurlAmountWithinRange: lnurlAmountReady")
    expect(checkout).toContain("if (!fastEligible) {")
    expect(checkout).toContain("isFastCheckoutInputPending({")
    expect(checkout).toContain("autoZapInputsResolving")
    expect(checkout).toContain("consumeHudZapIntent(selectedMerchant)")
    expect(checkout).toContain("!autoZapAuthorization")
    expect(checkout).toContain("isHudZapAuthorizationValid")
    expect(checkout).toContain("void payNowRef.current()")
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
