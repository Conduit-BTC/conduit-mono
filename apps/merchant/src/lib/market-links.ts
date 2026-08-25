import {
  inferConduitAppOrigin,
  pubkeyToNpub,
  type ConduitBrowserLocation,
} from "@conduit/core"

// Maps the current merchant host to its paired market origin so links open the
// buyer/merchant profile on the market app (including preview + local dev).
export function inferMarketOrigin(
  location: ConduitBrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location
): string {
  return inferConduitAppOrigin("market", location)
}

export function getStorefrontUrl(pubkey: string): string {
  return `${inferMarketOrigin()}/store/${encodeURIComponent(pubkeyToNpub(pubkey))}`
}

export function getProfileUrl(pubkey: string): string {
  return `${inferMarketOrigin()}/u/${encodeURIComponent(pubkeyToNpub(pubkey))}`
}
