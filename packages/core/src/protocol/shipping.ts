/**
 * Kind-30406 shipping option protocol helpers.
 *
 * GammaMarkets market-spec: https://github.com/GammaMarkets/market-spec
 *
 * A merchant publishes one kind-30406 event per shipping zone. Each event
 * carries the list of countries it covers. Conduit uses a single event with
 * d-tag "default" to represent the merchant's entire shipping config.
 */
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout, requireNdkConnected } from "./ndk"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
} from "./relay-settings"
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

  // ["country", code1, code2, ...]
  const countryTag = tags.find((t) => t[0] === "country")
  const countries: string[] = countryTag
    ? countryTag.slice(1).filter(Boolean)
    : []

  if (!dTag || countries.length === 0) return null

  return {
    id: `30406:${event.pubkey}:${dTag}`,
    pubkey: event.pubkey,
    dTag,
    title,
    currency,
    price,
    countries,
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
 * Publish the merchant's shipping config as kind-30406 events.
 *
 * One event is published per country in the config, each with d-tag
 * `conduit-<countryCode>`. A "catch-all" event with d-tag `conduit-default`
 * is also published listing all countries for easy lookup.
 *
 * If the config has no countries, this is a no-op.
 */
export async function publishShippingOptions(
  config: ShippingConfig,
  appId: ConduitAppId
): Promise<void> {
  if (config.countries.length === 0) return

  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")

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
    ...appendConduitClientTag([], appId),
  ]

  await event.sign(ndk.signer)
  await event.publish()
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
