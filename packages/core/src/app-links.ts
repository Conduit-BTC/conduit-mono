import { encodeProductNaddr } from "./protocol/product-reference"

export type ConduitBrowserLocation = Pick<
  Location,
  "hostname" | "protocol" | "port"
>

export type ConduitAppTarget = "market" | "merchant"

const PRODUCTION_ORIGINS: Record<ConduitAppTarget, string> = {
  market: "https://shop.conduit.market",
  merchant: "https://sell.conduit.market",
}

const APP_HOST_PAIRS = [
  ["conduit-market-coo.pages.dev", "conduit-merchant-33n.pages.dev"],
  ["conduit-market-signet.pages.dev", "conduit-merchant-signet.pages.dev"],
] as const

const LOCAL_PORT_PAIRS = [
  ["7000", "7001"],
  ["5173", "5174"],
  ["3000", "3001"],
] as const

function isConduitAppOrigin(
  origin: string | URL,
  target: ConduitAppTarget
): boolean {
  let url: URL
  try {
    url = typeof origin === "string" ? new URL(origin) : origin
  } catch {
    return false
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    return false
  }
  if (url.origin === PRODUCTION_ORIGINS[target]) return true
  const targetIndex = target === "market" ? 0 : 1
  if (
    APP_HOST_PAIRS.some(
      (pair) =>
        url.hostname === pair[targetIndex] ||
        url.hostname.endsWith(`.${pair[targetIndex]}`)
    )
  ) {
    return url.protocol === "https:"
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOCAL_PORT_PAIRS.some((pair) => url.port === pair[targetIndex])
  )
}

export function isConduitMarketOrigin(origin: string | URL): boolean {
  return isConduitAppOrigin(origin, "market")
}

export function isConduitMerchantOrigin(origin: string | URL): boolean {
  return isConduitAppOrigin(origin, "merchant")
}

function replaceHostSuffix(
  hostname: string,
  sourceHost: string,
  targetHost: string
): string | null {
  if (hostname === sourceHost) return targetHost
  if (!hostname.endsWith(`.${sourceHost}`)) return null
  return `${hostname.slice(0, -sourceHost.length)}${targetHost}`
}

/** Resolve the paired Market or Merchant origin for the current deployment. */
export function inferConduitAppOrigin(
  target: ConduitAppTarget,
  location: ConduitBrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location
): string {
  if (!location) return PRODUCTION_ORIGINS[target]

  const { hostname, protocol, port } = location
  const sourceIndex = target === "merchant" ? 0 : 1
  const targetIndex = target === "merchant" ? 1 : 0

  for (const pair of APP_HOST_PAIRS) {
    const pairedHostname = replaceHostSuffix(
      hostname,
      pair[sourceIndex],
      pair[targetIndex]
    )
    if (pairedHostname) return `${protocol}//${pairedHostname}`
  }

  for (const pair of LOCAL_PORT_PAIRS) {
    if (port === pair[sourceIndex]) {
      return `${protocol}//${hostname}:${pair[targetIndex]}`
    }
  }

  return PRODUCTION_ORIGINS[target]
}

/** Build a safe Merchant order-detail URL from a deployment origin. */
export function buildMerchantOrderReviewUrl(
  merchantOrigin: string,
  orderId: string
): string {
  const trimmedOrderId = orderId.trim()
  if (!trimmedOrderId) throw new Error("Order review URL requires an order id.")

  let url: URL
  try {
    url = new URL(merchantOrigin)
  } catch {
    throw new Error("Order review URL requires an absolute merchant origin.")
  }
  if (!isConduitMerchantOrigin(url)) {
    throw new Error("Order review URL requires a safe merchant origin.")
  }

  url.pathname = "/orders"
  url.searchParams.set("order", trimmedOrderId)
  return url.toString()
}

/** Build a stable Market product URL from a kind-30402 address coordinate. */
export function buildMarketProductShareUrl(
  marketOrigin: string,
  productAddressId: string
): string {
  let url: URL
  try {
    url = new URL(marketOrigin)
  } catch {
    throw new Error("Product share URL requires an absolute Market origin.")
  }
  if (!isConduitMarketOrigin(url)) {
    throw new Error("Product share URL requires a safe Market origin.")
  }

  const naddr = encodeProductNaddr(productAddressId)
  url.pathname = `/products/${naddr}`
  return url.toString()
}
