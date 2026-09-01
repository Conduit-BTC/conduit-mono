import {
  buildMarketEventCatalogUrl,
  buildMarketProductShareUrl,
  buildMerchantEventParticipationUrl,
  inferConduitAppOrigin,
  normalizeExactEventCatalogNaddr,
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

export function inferMerchantOrigin(
  location: ConduitBrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location
): string {
  return inferConduitAppOrigin("merchant", location)
}

export function getStorefrontUrl(pubkey: string): string {
  return `${inferMarketOrigin()}/store/${encodeURIComponent(pubkeyToNpub(pubkey))}`
}

export function getProfileUrl(pubkey: string): string {
  return `${inferMarketOrigin()}/u/${encodeURIComponent(pubkeyToNpub(pubkey))}`
}

export function getProductUrl(productAddressId: string): string {
  return buildMarketProductShareUrl(inferMarketOrigin(), productAddressId)
}

export function getEventMarketUrl(
  naddr: string,
  location?: ConduitBrowserLocation
): string {
  return buildMarketEventCatalogUrl(inferMarketOrigin(location), naddr)
}

export function getMerchantEventParticipationUrl(
  naddr: string,
  location?: ConduitBrowserLocation
): string {
  return buildMerchantEventParticipationUrl(
    inferMerchantOrigin(location),
    naddr
  )
}

export interface MerchantEventsSearch {
  event?: string
}

export interface MerchantAuthHandoffSearch extends MerchantEventsSearch {
  authRequired?: true
}

/** Accept only one exact kind-30405 naddr from the Merchant route query. */
export function parseMerchantEventsSearch(
  search: Record<string, unknown>
): MerchantEventsSearch {
  const value = search.event
  if (typeof value !== "string") return {}
  try {
    return { event: normalizeExactEventCatalogNaddr(value) }
  } catch {
    return {}
  }
}

/** Preserve only the validated event reference through a signed-out handoff. */
export function parseMerchantAuthHandoffSearch(
  search: Record<string, unknown>
): MerchantAuthHandoffSearch {
  const event = parseMerchantEventsSearch(search).event
  const authRequired =
    search.authRequired === true || search.authRequired === "true"
  return {
    ...(authRequired ? { authRequired: true as const } : {}),
    ...(event ? { event } : {}),
  }
}
