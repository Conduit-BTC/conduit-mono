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

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    for (const pair of LOCAL_PORT_PAIRS) {
      if (port === pair[sourceIndex]) {
        return `${protocol}//${hostname}:${pair[targetIndex]}`
      }
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
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Order review URL requires a safe merchant origin.")
  }

  url.pathname = "/orders"
  url.searchParams.set("order", trimmedOrderId)
  return url.toString()
}
