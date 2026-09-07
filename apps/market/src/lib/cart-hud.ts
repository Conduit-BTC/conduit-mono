export type CartHudRouteMode = "expanded" | "compact" | "suppressed"

export type CartHudCheckoutBlocker =
  | "listing_freshness_unavailable"
  | "shopper_preset_unavailable"
  | "wallet_unavailable"
  | "price_unavailable"
  | "shipping_unavailable"
  | "merchant_lightning_unavailable"

export type CartHudCheckoutCapability = {
  state: "zap_ready" | "route_to_checkout"
  blockers: CartHudCheckoutBlocker[]
}

export type CartHudCapabilityInput = {
  listingFresh: boolean
  shopperPresetReady: boolean
  walletReady: boolean
  itemPricesAvailable: boolean
  shippingReady: boolean
  merchantLightningReady: boolean
}

export function getCartHudRouteMode(pathname: string): CartHudRouteMode {
  if (
    pathname === "/" ||
    pathname === "/products" ||
    pathname === "/products/"
  ) {
    return "expanded"
  }
  if (
    pathname.startsWith("/store/") ||
    pathname === "/events" ||
    pathname.startsWith("/events/")
  ) {
    return "expanded"
  }
  if (pathname.startsWith("/products/")) return "compact"
  return "suppressed"
}

export function getCartHudCheckoutCapability(
  input: CartHudCapabilityInput
): CartHudCheckoutCapability {
  const blockers: CartHudCheckoutBlocker[] = []
  if (!input.listingFresh) blockers.push("listing_freshness_unavailable")
  if (!input.shopperPresetReady) blockers.push("shopper_preset_unavailable")
  if (!input.walletReady) blockers.push("wallet_unavailable")
  if (!input.itemPricesAvailable) blockers.push("price_unavailable")
  if (!input.shippingReady) blockers.push("shipping_unavailable")
  if (!input.merchantLightningReady) {
    blockers.push("merchant_lightning_unavailable")
  }
  return {
    state: blockers.length === 0 ? "zap_ready" : "route_to_checkout",
    blockers,
  }
}

export function getCartHudCheckoutFallbackMessage(
  capability: CartHudCheckoutCapability
): string {
  if (capability.state === "zap_ready") {
    return "Ready to zap out. Checkout confirms the merchant payment endpoint before paying."
  }
  if (capability.blockers.includes("price_unavailable")) {
    return "Checkout is needed to refresh the cart total."
  }
  if (capability.blockers.includes("shipping_unavailable")) {
    return "Checkout is needed to confirm shipping."
  }
  if (capability.blockers.includes("merchant_lightning_unavailable")) {
    return "Checkout is needed to choose an available payment path."
  }
  if (capability.blockers.includes("wallet_unavailable")) {
    return "Checkout is needed because an automatic wallet payment is not ready."
  }
  return "Checkout is needed to confirm shipping and payment readiness."
}

export function reconcileCartHudMerchant(
  current: string | null,
  merchants: readonly string[]
): string | null {
  if (current && merchants.includes(current)) return current
  return merchants[0] ?? null
}
