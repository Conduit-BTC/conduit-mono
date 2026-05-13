/**
 * Kind-30406 shipping option protocol helpers.
 *
 * GammaMarkets market-spec: https://github.com/GammaMarkets/market-spec
 *
 * Conduit publishes one consolidated kind-30406 event with d-tag
 * "conduit-default" to represent the merchant's current shipping config.
 */
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout, requireNdkConnected } from "./ndk"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
} from "./relay-settings"
import { publishWithPlanner } from "./relay-publish"
import type { ConduitAppId } from "./nip89"
import { appendConduitClientTag } from "./nip89"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShippingCountryConfig {
  /** ISO-3166-1 alpha-2 country code */
  code: string
  /** Human-readable country name */
  name: string
  /** Postal code / prefix patterns that are allowed (empty = all) */
  restrictTo: string[]
  /** Postal code / prefix patterns that are excluded */
  exclude: string[]
}

export interface ShippingConfig {
  countries: ShippingCountryConfig[]
}

/** Parsed representation of a kind-30406 event */
export interface ParsedShippingOption {
  /** Addressable id: "30406:<pubkey>:<d>" */
  id: string
  pubkey: string
  dTag: string
  title: string
  /** ISO-4217 currency code */
  currency: string
  /** Price in smallest unit (sats for BTC, cents for USD, etc.) */
  price: number
  /** ISO-3166-1 alpha-2 country codes this option covers */
  countries: string[]
  /** Country-specific postal include/exclude rules from CND-7. */
  countryRules: ShippingCountryConfig[]
  /** Service label (e.g. "standard", "express") */
  service: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Internal relay helpers (mirrors pattern in commerce.ts)
// ---------------------------------------------------------------------------

function commerceReadRelayUrls(): string[] {
  return getCommerceReadRelayUrls({
    fallbackRelayUrls:
      config.commerceRelayUrls.length > 0
        ? config.commerceRelayUrls
        : config.publicRelayUrls,
  })
}

function publicReadRelayUrls(): string[] {
  return getGeneralReadRelayUrls({
    fallbackRelayUrls:
      config.publicRelayUrls.length > 0 ? config.publicRelayUrls : undefined,
  })
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseShippingOptionEvent(
  event: Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">
): ParsedShippingOption | null {
  const tags = event.tags ?? []

  const getTag = (name: string): string | null => {
    const t = tags.find((t) => t[0] === name)
    return t?.[1] ?? null
  }

  const dTag = getTag("d") ?? ""
  const title = getTag("title") ?? "Shipping"
  const service = getTag("service") ?? "standard"

  // ["price", amount, currency]
  const priceTag = tags.find((t) => t[0] === "price")
  const price = priceTag ? Number(priceTag[1] ?? 0) : 0
  const currency = priceTag?.[2] ?? "USD"
  if (!Number.isFinite(price)) return null

  // ["country", code1, code2, ...] or repeated ["country", code]
  const countries = Array.from(
    new Set(
      tags
        .filter((t) => t[0] === "country")
        .flatMap((t) => t.slice(1))
        .map((country) => country.trim().toUpperCase())
        .filter(Boolean)
    )
  )

  if (!dTag || countries.length === 0) return null

  const countryRules = countries.map((code) => ({
    code,
    name: code,
    restrictTo:
      tags
        .find((t) => t[0] === "restrict" && t[1]?.toUpperCase() === code)
        ?.slice(2)
        .filter(Boolean) ?? [],
    exclude:
      tags
        .find((t) => t[0] === "exclude" && t[1]?.toUpperCase() === code)
        ?.slice(2)
        .filter(Boolean) ?? [],
  }))

  return {
    id: `30406:${event.pubkey}:${dTag}`,
    pubkey: event.pubkey,
    dTag,
    title,
    currency,
    price,
    countries,
    countryRules,
    service,
    createdAt: (event.created_at ?? 0) * 1000,
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function getShippingOptions(
  merchantPubkey: string
): Promise<ParsedShippingOption[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.SHIPPING_OPTION as number],
    authors: [merchantPubkey],
  }

  const relayUrls = [
    ...new Set([...commerceReadRelayUrls(), ...publicReadRelayUrls()]),
  ]

  const events = (await fetchEventsFanout(filter, { relayUrls })) as NDKEvent[]

  return events
    .map((e) => parseShippingOptionEvent(e))
    .filter((o): o is ParsedShippingOption => o !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Publish the merchant's shipping config as one consolidated kind-30406 event
 * with d-tag `conduit-default`.
 *
 * If the config has no countries, Conduit still publishes an empty replacement
 * event so older shipping destinations are cleared from relays.
 */
export async function publishShippingOptions(
  config: ShippingConfig,
  appId: ConduitAppId
): Promise<void> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signerPubkey = (await ndk.signer.user()).pubkey

  const now = Math.floor(Date.now() / 1000)
  const allCodes = config.countries.map((c) => c.code)

  // One consolidated event covering all countries (d-tag: conduit-default)
  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.SHIPPING_OPTION as number
  event.created_at = now
  event.content = ""
  event.tags = [
    ["d", "conduit-default"],
    ["title", "Standard Shipping"],
    ["service", "standard"],
    ["price", "0", "USD"],
    ["country", ...allCodes],
    ...config.countries.flatMap((country) => [
      ...(country.restrictTo.length > 0
        ? [["restrict", country.code, ...country.restrictTo]]
        : []),
      ...(country.exclude.length > 0
        ? [["exclude", country.code, ...country.exclude]]
        : []),
    ]),
    ...appendConduitClientTag([], appId),
  ]

  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: signerPubkey,
  })
}

// ---------------------------------------------------------------------------
// Eligibility helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the buyer's country is covered by at least one of the
 * merchant's shipping options.
 *
 * When no shipping options are found (merchant hasn't published kind-30406),
 * we default to `true` so checkout is not blocked.
 */
export function isBuyerCountryEligible(
  buyerCountry: string,
  shippingOptions: ParsedShippingOption[]
): boolean {
  if (shippingOptions.length === 0) return true
  return shippingOptions.some((opt) =>
    opt.countries.some((c) => c.toUpperCase() === buyerCountry.toUpperCase())
  )
}

export function normalizeShippingPostalCode(postalCode: string): string {
  return postalCode.trim().toUpperCase().replace(/\s+/g, "")
}

function postalPatternMatches(pattern: string, postalCode: string): boolean {
  const normalizedPattern = normalizeShippingPostalCode(pattern)
  const normalizedPostal = normalizeShippingPostalCode(postalCode)
  if (!normalizedPattern) return false
  if (normalizedPattern.endsWith("**")) {
    return normalizedPostal.startsWith(normalizedPattern.slice(0, -2))
  }
  return normalizedPostal === normalizedPattern
}

export type ShippingDestinationEligibility =
  | { eligible: true }
  | { eligible: false; reason: "country_unsupported" | "postal_restricted" }
  | { eligible: null; reason: "unknown" }

export function getShippingDestinationEligibility(
  destination: { country: string; postalCode: string },
  shippingOptions: ParsedShippingOption[]
): ShippingDestinationEligibility {
  if (shippingOptions.length === 0) {
    return { eligible: null, reason: "unknown" }
  }

  const country = destination.country.trim().toUpperCase()
  const rules = shippingOptions
    .flatMap((option) => option.countryRules)
    .filter((rule) => rule.code.toUpperCase() === country)

  if (rules.length === 0)
    return { eligible: false, reason: "country_unsupported" }

  const postalCode = normalizeShippingPostalCode(destination.postalCode)
  const allowed = rules.some((rule) => {
    const restrictTo = rule.restrictTo ?? []
    const exclude = rule.exclude ?? []
    const included =
      restrictTo.length === 0 ||
      restrictTo.some((pattern) => postalPatternMatches(pattern, postalCode))
    const excluded = exclude.some((pattern) =>
      postalPatternMatches(pattern, postalCode)
    )
    return included && !excluded
  })

  return allowed
    ? { eligible: true }
    : { eligible: false, reason: "postal_restricted" }
}
