import { pubkeyToNpub } from "@conduit/core"

// Maps the current merchant host to its paired market origin so links open the
// buyer/merchant profile on the market app (including preview + local dev).
export function inferMarketOrigin(): string {
  if (typeof window === "undefined") return "https://conduit.market"

  const { hostname, protocol, port } = window.location
  const previewHostReplacements: [string, string][] = [
    [".conduit-merchant-33n.pages.dev", ".conduit-market-coo.pages.dev"],
    [".conduit-merchant-signet.pages.dev", ".conduit-market-signet.pages.dev"],
  ]

  for (const [merchantSuffix, marketSuffix] of previewHostReplacements) {
    if (hostname.endsWith(merchantSuffix)) {
      return `${protocol}//${hostname.slice(0, -merchantSuffix.length)}${marketSuffix}`
    }
  }

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    const localMarketPort =
      port === "7001" ? "7000" : port === "5174" ? "5173" : ""
    if (localMarketPort) return `${protocol}//${hostname}:${localMarketPort}`
  }

  return "https://conduit.market"
}

export function getStorefrontUrl(pubkey: string): string {
  return `${inferMarketOrigin()}/store/${encodeURIComponent(pubkeyToNpub(pubkey))}`
}
