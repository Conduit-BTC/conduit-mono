import {
  buildMarketEventCatalogUrl,
  buildMarketProductShareUrl,
  buildMerchantEventParticipationUrl,
  inferConduitAppOrigin,
  normalizeExactEventCatalogNaddr,
  pubkeyToNpub,
  type ConduitBrowserLocation,
  type EventMarketPerspectiveSource,
} from "@conduit/core"
import {
  MERCHANT_EVENT_RELATIONSHIP_FILTERS,
  MERCHANT_EVENT_TIMELINE_WINDOWS,
  type MerchantEventRelationshipFilter,
  type MerchantEventTimelineWindow,
} from "./merchant-event-timeline"

// Maps the current merchant host to its paired market origin so links open the
// buyer/merchant profile on the market app (including preview + local dev).
export function inferMarketOrigin(
  location: ConduitBrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location
): string {
  return inferConduitAppOrigin(
    "market",
    location,
    import.meta.env.VITE_BUILD_BRANCH
  )
}

export function inferMerchantOrigin(
  location: ConduitBrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location
): string {
  return inferConduitAppOrigin(
    "merchant",
    location,
    import.meta.env.VITE_BUILD_BRANCH
  )
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
  source?: EventMarketPerspectiveSource
  relation?: MerchantEventRelationshipFilter
  window?: MerchantEventTimelineWindow
}

export interface MerchantAuthHandoffSearch extends MerchantEventsSearch {
  authRequired?: true
}

/** Accept only one exact kind-30405 naddr from the Merchant route query. */
export function parseMerchantEventsSearch(
  search: Record<string, unknown>
): MerchantEventsSearch {
  const source = ["following", "conduit", "combined"].includes(
    search.source as string
  )
    ? (search.source as EventMarketPerspectiveSource)
    : undefined
  const relation = MERCHANT_EVENT_RELATIONSHIP_FILTERS.includes(
    search.relation as MerchantEventRelationshipFilter
  )
    ? (search.relation as MerchantEventRelationshipFilter)
    : undefined
  const window = MERCHANT_EVENT_TIMELINE_WINDOWS.includes(
    search.window as MerchantEventTimelineWindow
  )
    ? (search.window as MerchantEventTimelineWindow)
    : undefined
  let event: string | undefined
  if (typeof search.event === "string") {
    try {
      event = normalizeExactEventCatalogNaddr(search.event)
    } catch {
      event = undefined
    }
  }
  return {
    ...(event ? { event } : {}),
    ...(source ? { source } : {}),
    ...(relation ? { relation } : {}),
    ...(window ? { window } : {}),
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
