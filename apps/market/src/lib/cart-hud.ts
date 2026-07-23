export type CartHudRouteMode = "expanded" | "compact" | "suppressed"

export type CartHudCheckoutBlocker =
  | "listing_freshness_unavailable"
  | "shopper_preset_unavailable"
  | "price_unavailable"
  | "shipping_unavailable"
  | "merchant_lightning_unavailable"

export type CartHudCheckoutCapability = {
  state: "route_to_checkout"
  blockers: CartHudCheckoutBlocker[]
}

export type CartHudCapabilityInput = {
  itemPricesAvailable: boolean
  shippingReady: boolean
  merchantLightningReady: boolean
}

const SUPPRESSED_ROUTES = new Set([
  "/about",
  "/cart",
  "/checkout",
  "/messages",
  "/network",
  "/orders",
  "/profile",
  "/wallet",
  "/zapouts",
])

export function getCartHudRouteMode(pathname: string): CartHudRouteMode {
  if (
    pathname === "/" ||
    pathname === "/products" ||
    pathname === "/products/"
  ) {
    return "expanded"
  }
  if (pathname.startsWith("/store/")) return "expanded"
  if (pathname.startsWith("/products/")) return "compact"
  if (pathname.startsWith("/u/")) return "suppressed"
  return SUPPRESSED_ROUTES.has(pathname) ? "suppressed" : "suppressed"
}

export function getCartHudCheckoutCapability(
  input: CartHudCapabilityInput
): CartHudCheckoutCapability {
  const blockers: CartHudCheckoutBlocker[] = [
    "listing_freshness_unavailable",
    "shopper_preset_unavailable",
  ]
  if (!input.itemPricesAvailable) blockers.push("price_unavailable")
  if (!input.shippingReady) blockers.push("shipping_unavailable")
  if (!input.merchantLightningReady) {
    blockers.push("merchant_lightning_unavailable")
  }
  return { state: "route_to_checkout", blockers }
}

export function reconcileCartHudMerchant(
  current: string | null,
  merchants: readonly string[]
): string | null {
  if (current && merchants.includes(current)) return current
  return merchants[0] ?? null
}
