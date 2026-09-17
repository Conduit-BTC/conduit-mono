import {
  formatNpub,
  getProfileName,
  normalizePublicMediaUrl,
  normalizePubkey,
  type ConduitBrowserLocation,
  type Profile,
} from "@conduit/core"
import {
  isParticipationProductPreviewVerified,
  type MerchantOrganizerEventMarket,
  type MerchantOrganizerEventMarketState,
} from "./event-market"
import {
  getEventMarketMerchantFilterUrl,
  getEventMarketUrl,
} from "./market-links"
import { formatMerchantEventTimelineSchedule } from "./merchant-event-timeline"

export interface EligibleEventSignMerchant {
  pubkey: string
  productCount: number
}

export interface EventQrSignMerchant {
  pubkey: string
  name: string
  imageUrl?: string
  fallback: string
}

export interface EventQrSignSheet {
  id: string
  kind: "event" | "merchant"
  qrValue: string
  eventTitle: string
  schedule: string
  location: string
  bannerUrl?: string
  merchant?: EventQrSignMerchant
}

export interface EventSignEvidenceNotice {
  title: string
  message: string
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}

export function formatEventSignSchedule(
  market: MerchantOrganizerEventMarket,
  locale?: string
): string {
  if (market.calendarKind === 31922) {
    return formatMerchantEventTimelineSchedule(market, locale)
  }

  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: market.timezone || "UTC",
    })
    const start =
      typeof market.start === "number"
        ? formatter.format(new Date(market.start * 1_000))
        : String(market.start)
    const end =
      typeof market.end === "number"
        ? formatter.format(new Date(market.end * 1_000))
        : market.end
    return end ? `${start} - ${end}` : start
  } catch {
    return "See the event catalog for schedule details"
  }
}

export function getEventSignLocation(
  market: MerchantOrganizerEventMarket
): string {
  return (
    cleanOptionalText(market.eventLocation) ??
    cleanOptionalText(market.eventGeohash) ??
    "See the event catalog for location details"
  )
}

export function getEventSignImageFallback(title: string): string {
  const character = Array.from(title.trim())[0]
  return character?.toUpperCase() || "E"
}

export function getMerchantSignImageFallback(
  name: string,
  pubkey: string
): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .filter((character): character is string => !!character)
    .join("")
    .toUpperCase()
  if (initials && !name.startsWith("npub1")) return initials

  const normalized = normalizePubkey(pubkey)
  return normalized ? normalized.slice(0, 2).toUpperCase() : "M"
}

export function getEligibleEventSignMerchants(
  market: MerchantOrganizerEventMarket
): EligibleEventSignMerchant[] {
  const accepted = new Map<string, number>()

  for (const item of market.participation) {
    if (
      item.status !== "accepted" ||
      !isParticipationProductPreviewVerified(item)
    ) {
      continue
    }
    const pubkey = normalizePubkey(item.merchantPubkey)
    if (!pubkey) continue
    accepted.set(pubkey, (accepted.get(pubkey) ?? 0) + 1)
  }

  return Array.from(accepted, ([pubkey, productCount]) => ({
    pubkey,
    productCount,
  })).sort((a, b) => a.pubkey.localeCompare(b.pubkey))
}

export function isMerchantEligibleForEventSign(
  market: MerchantOrganizerEventMarket,
  merchantPubkey: string
): boolean {
  const normalized = normalizePubkey(merchantPubkey)
  return (
    !!normalized &&
    getEligibleEventSignMerchants(market).some(
      (merchant) => merchant.pubkey === normalized
    )
  )
}

export function buildEventQrSignSheet(
  market: MerchantOrganizerEventMarket,
  location?: ConduitBrowserLocation
): EventQrSignSheet {
  const bannerUrl = normalizePublicMediaUrl(market.imageUrl) ?? undefined
  return {
    id: `${market.collectionCoordinate}:event`,
    kind: "event",
    qrValue: getEventMarketUrl(market.naddr, location),
    eventTitle: market.title,
    schedule: formatEventSignSchedule(market),
    location: getEventSignLocation(market),
    ...(bannerUrl ? { bannerUrl } : {}),
  }
}

export function buildMerchantEventQrSignSheet(
  market: MerchantOrganizerEventMarket,
  merchantPubkey: string,
  profile?: Profile,
  location?: ConduitBrowserLocation
): EventQrSignSheet | null {
  const normalized = normalizePubkey(merchantPubkey)
  if (!normalized || !isMerchantEligibleForEventSign(market, normalized)) {
    return null
  }

  const name = getProfileName(profile) || formatNpub(normalized)
  const imageUrl = normalizePublicMediaUrl(profile?.picture) ?? undefined
  const bannerUrl = normalizePublicMediaUrl(market.imageUrl) ?? undefined

  return {
    id: `${market.collectionCoordinate}:merchant:${normalized}`,
    kind: "merchant",
    qrValue: getEventMarketMerchantFilterUrl(
      market.naddr,
      normalized,
      location
    ),
    eventTitle: market.title,
    schedule: formatEventSignSchedule(market),
    location: getEventSignLocation(market),
    ...(bannerUrl ? { bannerUrl } : {}),
    merchant: {
      pubkey: normalized,
      name,
      ...(imageUrl ? { imageUrl } : {}),
      fallback: getMerchantSignImageFallback(name, normalized),
    },
  }
}

export function buildMerchantEventQrSignSheets(
  market: MerchantOrganizerEventMarket,
  getProfile: (pubkey: string) => Profile | undefined,
  location?: ConduitBrowserLocation
): EventQrSignSheet[] {
  return getEligibleEventSignMerchants(market)
    .map((merchant) =>
      buildMerchantEventQrSignSheet(
        market,
        merchant.pubkey,
        getProfile(merchant.pubkey),
        location
      )
    )
    .filter((sheet): sheet is EventQrSignSheet => !!sheet)
    .sort(
      (a, b) =>
        a.merchant!.name.localeCompare(b.merchant!.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }) || a.merchant!.pubkey.localeCompare(b.merchant!.pubkey)
    )
}

export function getEventSignEvidenceNotice(
  state: MerchantOrganizerEventMarketState,
  batch: boolean
): EventSignEvidenceNotice | null {
  if (state === "partial") {
    return {
      title: batch
        ? "Merchant list may be incomplete"
        : "Event evidence is incomplete",
      message: batch
        ? "Some planned relay reads did not complete, so this batch may not include every accepted merchant. Refresh event evidence before printing."
        : "Some planned relay reads did not complete. Refresh event evidence before printing when possible.",
    }
  }
  if (state === "stale") {
    return {
      title: batch
        ? "Merchant list is based on stale evidence"
        : "Event evidence is stale",
      message: batch
        ? "The last verified event view is retained, but this batch may not reflect current accepted merchants. Refresh event evidence before printing."
        : "The last verified event view is retained, but it may not reflect current event details. Refresh event evidence before printing.",
    }
  }
  if (state === "active" || state === "ended") return null

  return {
    title: "Event evidence needs attention",
    message:
      "This preview uses the event evidence currently available. Refresh before printing and scan the sign to check current availability.",
  }
}
