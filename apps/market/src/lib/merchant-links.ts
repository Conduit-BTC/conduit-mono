import {
  inferConduitAppOrigin,
  type ConduitBrowserLocation,
} from "@conduit/core"

/**
 * Map the current Market host to its paired Merchant origin so order
 * notifications stay inside the production, preview, signet, or local
 * environment that created them.
 */
export function inferMerchantOrigin(
  location: ConduitBrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location
): string {
  return inferConduitAppOrigin("merchant", location)
}
