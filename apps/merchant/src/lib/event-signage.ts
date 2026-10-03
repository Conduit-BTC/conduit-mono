import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  formatNpub,
  getProfileName,
  normalizePublicMediaUrl,
  normalizePubkey,
  type ConduitBrowserLocation,
  type Profile,
  type ParsedEventMarketRoster,
  type ParsedEventMarketCalendar,
} from "@conduit/core"
import {
  getEventMarketMerchantFilterUrl,
  getEventMarketUrl,
} from "./market-links"

export interface EventQrSignMerchant {
  pubkey: string
  name: string
  imageUrl?: string
  bannerUrl?: string
  fallback: string
}

export interface EventQrSignSheet {
  id: string
  kind: "event" | "merchant"
  url: string
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

// qrcode.react uses QR version 40 at most. Keep printable values below the
// medium-error-correction byte-mode ceiling, with room for segment overhead.
export const EVENT_SIGN_QR_MAX_BYTES = 2_200

export function isEventSignQrValueWithinBudget(value: string): boolean {
  return new TextEncoder().encode(value).length <= EVENT_SIGN_QR_MAX_BYTES
}

function buildEventSignQrUrl(
  naddr: string,
  merchantPubkey: string | undefined,
  location?: ConduitBrowserLocation,
  occurrenceCoordinate?: string
): string {
  const baseUrl = (reference: string) =>
    merchantPubkey
      ? getEventMarketMerchantFilterUrl(reference, merchantPubkey, location)
      : getEventMarketUrl(reference, location)
  const buildUrl = (reference: string) => {
    const url = new URL(baseUrl(reference))
    if (occurrenceCoordinate)
      url.searchParams.set("occurrence", occurrenceCoordinate)
    return url.toString()
  }
  const decoded = decodeEventMarketReference(naddr, [30409])
  if (!decoded) return buildUrl(naddr)

  let selectedRelayHints: string[] = []
  let selectedUrl = buildUrl(encodeEventMarketNaddr(decoded.coordinate))
  for (const relayHint of decoded.relayHints) {
    const candidateRelayHints = [...selectedRelayHints, relayHint]
    const candidateUrl = buildUrl(
      encodeEventMarketNaddr(decoded.coordinate, candidateRelayHints)
    )
    if (!isEventSignQrValueWithinBudget(candidateUrl)) continue
    selectedRelayHints = candidateRelayHints
    selectedUrl = candidateUrl
  }
  return selectedUrl
}

/** Date-only end is exclusive; timed dates use each signed timezone. */
export function formatFutureEventSignSchedule(
  calendar: ParsedEventMarketCalendar,
  locale?: string
): string {
  if (calendar.kind === 31922) {
    const format = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    })
    const start = format.format(calendar.start)
    const lastDay =
      calendar.end === undefined
        ? calendar.start
        : Math.max(calendar.start, calendar.end - 86_400_000)
    return lastDay > calendar.start
      ? `${start} – ${format.format(lastDay)}`
      : start
  }
  const format = (time: number, timezone?: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone || calendar.startTzid || "UTC",
    }).format(time)
  const start = format(calendar.start, calendar.startTzid)
  return calendar.end === undefined
    ? start
    : `${start} – ${format(calendar.end, calendar.endTzid)}`
}

function destinationUrl(
  naddr: string,
  merchant: string | undefined,
  location: ConduitBrowserLocation | undefined,
  occurrence: string | undefined
): string {
  const url = new URL(
    merchant
      ? getEventMarketMerchantFilterUrl(naddr, merchant, location)
      : getEventMarketUrl(naddr, location)
  )
  if (occurrence) url.searchParams.set("occurrence", occurrence)
  return url.toString()
}

/** Future signs always resolve to the kind-30409 catalog and its merchant filter. */
export function buildFutureEventQrSignSheets(input: {
  occurrenceCoordinate?: string
  market: ParsedEventMarketRoster
  calendar: ParsedEventMarketCalendar
  profiles?: Record<string, Profile | undefined>
  relayHints?: readonly string[]
  location?: ConduitBrowserLocation
}): EventQrSignSheet[] {
  const { market, calendar, profiles, location } = input
  const naddr = encodeEventMarketNaddr(market.coordinate, input.relayHints)
  const eventTitle = calendar.title
  const schedule = formatFutureEventSignSchedule(calendar)
  const eventLocation =
    calendar.locations.join(", ") ||
    calendar.geohash ||
    "See the event catalog for location details"
  const bannerUrl = normalizePublicMediaUrl(calendar.image) ?? undefined
  const event: EventQrSignSheet = {
    id: `${market.coordinate}:event`,
    kind: "event",
    url: destinationUrl(naddr, undefined, location, input.occurrenceCoordinate),
    qrValue: buildEventSignQrUrl(
      naddr,
      undefined,
      location,
      input.occurrenceCoordinate
    ),
    eventTitle,
    schedule,
    location: eventLocation,
    ...(bannerUrl ? { bannerUrl } : {}),
  }
  const booths = market.merchants.map((row): EventQrSignSheet => {
    const candidateProfile = profiles?.[row.pubkey]
    const profile =
      candidateProfile?.pubkey === row.pubkey ? candidateProfile : undefined
    const name = getProfileName(profile) ?? formatNpub(row.pubkey)
    const imageUrl = normalizePublicMediaUrl(profile?.picture) ?? undefined
    const merchantBannerUrl =
      normalizePublicMediaUrl(profile?.banner) ?? undefined
    return {
      id: `${market.coordinate}:${row.pubkey}`,
      kind: "merchant",
      url: destinationUrl(
        naddr,
        row.pubkey,
        location,
        input.occurrenceCoordinate
      ),
      qrValue: buildEventSignQrUrl(
        naddr,
        row.pubkey,
        location,
        input.occurrenceCoordinate
      ),
      eventTitle,
      schedule,
      location: row.assignment,
      ...(bannerUrl ? { bannerUrl } : {}),
      merchant: {
        pubkey: row.pubkey,
        name,
        ...(imageUrl ? { imageUrl } : {}),
        ...(merchantBannerUrl ? { bannerUrl: merchantBannerUrl } : {}),
        fallback: getMerchantSignImageFallback(name, row.pubkey),
      },
    }
  })
  booths.sort(
    (left, right) =>
      left.merchant!.name.localeCompare(right.merchant!.name) ||
      left.merchant!.pubkey.localeCompare(right.merchant!.pubkey)
  )
  return [event, ...booths]
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

export type EventSignEvidenceState =
  "current" | "partial" | "stale" | "unavailable"

export function getEventSignEvidenceNotice(
  state: EventSignEvidenceState,
  batch: boolean
): EventSignEvidenceNotice | null {
  if (state === "partial") {
    return {
      title: batch
        ? "Merchant list may be incomplete"
        : "Event evidence is incomplete",
      message: batch
        ? "Some planned relay reads did not complete, so this batch may not include every approved merchant. Refresh event evidence before printing."
        : "Some planned relay reads did not complete. Refresh event evidence before printing when possible.",
    }
  }
  if (state === "stale") {
    return {
      title: batch
        ? "Merchant list is based on stale evidence"
        : "Event evidence is stale",
      message: batch
        ? "The last verified event view is retained, but this batch may not reflect current approved merchants. Refresh event evidence before printing."
        : "The last verified event view is retained, but it may not reflect current event details. Refresh event evidence before printing.",
    }
  }
  if (state === "current") return null

  return {
    title: "Event evidence needs attention",
    message:
      "This preview uses the event evidence currently available. Refresh before printing and scan the sign to check current availability.",
  }
}

export type EventSignPreviewMode = "event" | "merchant" | "merchant-batch"

export function getEventSignPreviewEvidenceNotice(
  state: EventSignEvidenceState,
  mode: EventSignPreviewMode
): EventSignEvidenceNotice | null {
  return getEventSignEvidenceNotice(state, mode === "merchant-batch")
}
