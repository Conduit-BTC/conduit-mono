/**
 * Kind-30406 shipping option protocol helpers.
 *
 * Open Markets working specification: https://github.com/OpenMarketsFoundation/specification
 *
 * Conduit publishes one consolidated kind-30406 event with d-tag
 * "conduit-default" to represent the merchant's current shipping config.
 */
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  getShippingCostSats,
  type CommerceShippingCostLike,
  type PricingRateInput,
} from "../pricing"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanoutDetailed,
  getNdk,
  type FetchEventsFanoutResult,
} from "./ndk"
import { publishWithPlanner } from "./relay-publish"
import {
  getRelayListsDetailed,
  type RelayListResolutionState,
} from "./relay-list"
import { planRelayReads } from "./relay-planner"
import type { ConduitAppId } from "./nip89"
import { appendConduitClientTag } from "./nip89"

export const CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG = "conduit-default"

export function getShippingOptionAddress(
  pubkey: string,
  dTag = CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
): string {
  return `${EVENT_KINDS.SHIPPING_OPTION}:${pubkey}:${dTag}`
}

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

export type ShippingOptionsReadCoverage = "complete" | "partial" | "unavailable"

export interface ShippingOptionsReadResult {
  options: ParsedShippingOption[]
  coverage: ShippingOptionsReadCoverage
}

export interface ShippingOptionsReadOptions {
  /**
   * Refresh relay-list discovery and attempt the complete bounded relay plan.
   * Protected canaries use this mode so partial evidence cannot authorize a
   * persistent action. UI callers can keep the best-effort array helper.
   */
  strict?: boolean
}

export type ResolvedCartShippingCostStatus =
  "not_required" | "included" | "priced" | "manual"

export interface CartShippingCostLine extends CommerceShippingCostLike {
  productId: string
  quantity: number
  format?: "physical" | "digital"
}

export interface ResolvedCartShippingCostSummary {
  status: ResolvedCartShippingCostStatus
  totalSats: number
  missingProductIds: string[]
}

export function resolveCartShippingCost(
  items: CartShippingCostLine[],
  rateInput: PricingRateInput = null
): ResolvedCartShippingCostSummary {
  const physicalItems = items.filter((item) => item.format !== "digital")
  if (physicalItems.length === 0) {
    return {
      status: "not_required",
      totalSats: 0,
      missingProductIds: [],
    }
  }

  const missingProductIds: string[] = []
  let totalSats = 0

  for (const item of physicalItems) {
    const shippingCost = getShippingCostSats(item, rateInput)
    if (!shippingCost) {
      missingProductIds.push(item.productId)
      continue
    }

    const quantity = Number.isFinite(item.quantity)
      ? Math.max(1, Math.floor(item.quantity))
      : 1
    totalSats += shippingCost.sats * quantity
  }

  if (missingProductIds.length > 0) {
    return {
      status: "manual",
      totalSats: 0,
      missingProductIds,
    }
  }

  return {
    status: totalSats === 0 ? "included" : "priced",
    totalSats,
    missingProductIds: [],
  }
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

  if (!dTag) return null
  if (
    countries.length === 0 &&
    dTag !== CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
  ) {
    return null
  }

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
    id: getShippingOptionAddress(event.pubkey, dTag),
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

type ShippingOptionEvent = Pick<
  NDKEvent,
  "id" | "pubkey" | "tags" | "created_at"
>

function getShippingOptionDTag(event: ShippingOptionEvent): string | null {
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]
  return dTag || null
}

function isLaterShippingOptionWinner(
  candidate: ShippingOptionEvent,
  current: ShippingOptionEvent
): boolean {
  const candidateCreatedAt = candidate.created_at ?? 0
  const currentCreatedAt = current.created_at ?? 0
  return (
    candidateCreatedAt > currentCreatedAt ||
    (candidateCreatedAt === currentCreatedAt && candidate.id < current.id)
  )
}

export function parseLatestShippingOptions(
  events: readonly ShippingOptionEvent[]
): ParsedShippingOption[] {
  const winnerByAddress = new Map<string, ShippingOptionEvent>()
  for (const event of events) {
    const dTag = getShippingOptionDTag(event)
    if (!dTag) continue
    const address = `${event.pubkey}:${dTag}`
    const current = winnerByAddress.get(address)
    if (!current || isLaterShippingOptionWinner(event, current)) {
      winnerByAddress.set(address, event)
    }
  }

  return Array.from(winnerByAddress.values())
    .sort((left, right) => {
      const createdAtDifference =
        (right.created_at ?? 0) - (left.created_at ?? 0)
      return createdAtDifference || left.id.localeCompare(right.id)
    })
    .map((event) => parseShippingOptionEvent(event))
    .filter((option): option is ParsedShippingOption => option !== null)
}

export function deriveShippingOptionsReadCoverage(
  relayUrls: readonly string[],
  result: FetchEventsFanoutResult
): ShippingOptionsReadCoverage {
  if (relayUrls.length === 0 || result.eventsVerified !== true) {
    return "unavailable"
  }
  const statusByRelay = new Map(
    result.relays.map((relay) => [relay.relayUrl, relay.status] as const)
  )
  if (
    relayUrls.every((relayUrl) => statusByRelay.get(relayUrl) === "success")
  ) {
    return "complete"
  }
  return relayUrls.some((relayUrl) => {
    const status = statusByRelay.get(relayUrl)
    return status === "success" || status === "partial"
  })
    ? "partial"
    : "unavailable"
}

function getRelayListReadCoverage(
  state: RelayListResolutionState | undefined
): ShippingOptionsReadCoverage {
  if (state === "network" || state === "missing") return "complete"
  if (
    state === "fresh-cache" ||
    state === "stale-cache" ||
    state === "partial-network"
  ) {
    return "partial"
  }
  return "unavailable"
}

function combineShippingOptionsReadCoverage(
  ...coverages: ShippingOptionsReadCoverage[]
): ShippingOptionsReadCoverage {
  if (coverages.includes("unavailable")) return "unavailable"
  if (coverages.includes("partial")) return "partial"
  return "complete"
}

export async function getShippingOptionsDetailed(
  merchantPubkey: string,
  options: ShippingOptionsReadOptions = {}
): Promise<ShippingOptionsReadResult> {
  const relayListResult = await getRelayListsDetailed([merchantPubkey], {
    cacheOnly: false,
    skipCache: options.strict === true,
  })
  const readPlan = planRelayReads({
    intent: "author_products",
    authors: [merchantPubkey],
    relayLists: relayListResult.relayLists,
    maxRelays: 12,
    skipHealthFilter: options.strict === true,
  })
  const relayListCoverage = getRelayListReadCoverage(
    relayListResult.resolutionStates.get(merchantPubkey)
  )
  const authorHintsComplete = readPlan.hintRelayUrls.every((relayUrl) =>
    readPlan.relayUrls.includes(relayUrl)
  )
  const planCoverage =
    authorHintsComplete && readPlan.parkedRelayUrls.length === 0
      ? "complete"
      : "partial"
  if (options.strict && readPlan.relayUrls.length === 0) {
    return { options: [], coverage: "unavailable" }
  }
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.SHIPPING_OPTION as number],
    authors: [merchantPubkey],
  }

  const result = await fetchEventsFanoutDetailed(filter, {
    relayUrls: readPlan.relayUrls,
    skipHealthFilter: options.strict === true,
  })

  return {
    options: parseLatestShippingOptions(result.events),
    coverage: combineShippingOptionsReadCoverage(
      relayListCoverage,
      planCoverage,
      deriveShippingOptionsReadCoverage(readPlan.relayUrls, result)
    ),
  }
}

export async function getShippingOptions(
  merchantPubkey: string
): Promise<ParsedShippingOption[]> {
  return (await getShippingOptionsDetailed(merchantPubkey)).options
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
  const ndk = getNdk()
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
    ["d", CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG],
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
    authenticatedPubkey: signerPubkey,
    deliveryMode: "critical",
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
