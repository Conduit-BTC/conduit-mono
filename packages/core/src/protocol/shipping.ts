/**
 * Kind-30406 shipping option protocol helpers.
 *
 * Open Markets working specification: https://github.com/OpenMarketsFoundation/specification
 *
 * The canonical fixed-shipping writer publishes one complete, product-scoped
 * Gamma kind-30406 before its referencing kind-30402.
 */
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  canonicalizeShippingCost,
  getShippingCostSats,
  normalizeCurrencyCode,
  type CommerceShippingCostLike,
  type PricingRateInput,
} from "../pricing"
import type { ProductSchema } from "../schemas"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout, fetchEventsFanoutDetailed } from "./ndk"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import type { ConduitAppId } from "./nip89"
import { appendConduitClientTag } from "./nip89"

export const CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG = "conduit-default"
export const FIXED_PRODUCT_SHIPPING_D_TAG_SUFFIX = "-shipping-standard"

const FIXED_STANDARD_UNSUPPORTED_TAGS = new Set([
  "carrier",
  "region",
  "duration",
  "location",
  "g",
  "weight-min",
  "weight-max",
  "dim-min",
  "dim-max",
  "price-weight",
  "price-volume",
  "price-distance",
  "restrict",
  "exclude",
])

export function getShippingOptionAddress(
  pubkey: string,
  dTag = CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
): string {
  return `${EVENT_KINDS.SHIPPING_OPTION}:${pubkey}:${dTag}`
}

export function getProductShippingOptionDTag(productDTag: string): string {
  const normalized = productDTag.trim()
  if (!normalized) throw new Error("Product d tag is required")
  return `${normalized}${FIXED_PRODUCT_SHIPPING_D_TAG_SUFFIX}`
}

export function getProductShippingOptionAddress(
  pubkey: string,
  productDTag: string
): string {
  return getShippingOptionAddress(
    pubkey,
    getProductShippingOptionDTag(productDTag)
  )
}

export type ProductFulfillmentIntent =
  | { kind: "digital" }
  | { kind: "coordinate_after_order" }
  | {
      kind: "fixed_standard"
      amount: number
      currency: string
      countries: string[]
    }

export function compileProductFulfillmentIntent(input: {
  format: "physical" | "digital"
  shippingPricingMode: "fixed" | "coordinate_after_order"
  amount?: number
  currency: string
  destinations: readonly ShippingCountryConfig[]
}): ProductFulfillmentIntent {
  if (input.format === "digital") return { kind: "digital" }
  if (input.shippingPricingMode === "coordinate_after_order") {
    return { kind: "coordinate_after_order" }
  }

  if (
    typeof input.amount !== "number" ||
    !Number.isFinite(input.amount) ||
    input.amount < 0
  ) {
    throw new Error("Fixed shipping requires a non-negative amount")
  }

  const currency = normalizeCurrencyCode(input.currency)
  if (!currency) throw new Error("Fixed shipping currency is required")

  const countries = Array.from(
    new Set(
      input.destinations.map((destination) =>
        destination.code.trim().toUpperCase()
      )
    )
  ).sort()
  if (
    countries.length === 0 ||
    countries.some((country) => !/^[A-Z]{2}$/.test(country))
  ) {
    throw new Error(
      "Fixed shipping requires at least one valid country destination"
    )
  }
  if (
    input.destinations.some(
      (destination) =>
        destination.restrictTo.length > 0 || destination.exclude.length > 0
    )
  ) {
    throw new Error(
      "Fixed checkout supports country destinations only. Remove postal restrictions or coordinate shipping after the order."
    )
  }

  return {
    kind: "fixed_standard",
    amount: input.amount,
    currency,
    countries,
  }
}

export interface ShippingOptionEventDraft {
  kind: typeof EVENT_KINDS.SHIPPING_OPTION
  content: string
  tags: string[][]
}

export function buildFixedShippingOptionEventDraft(input: {
  productDTag: string
  intent: Extract<ProductFulfillmentIntent, { kind: "fixed_standard" }>
  clientAppId?: ConduitAppId
}): ShippingOptionEventDraft {
  let tags: string[][] = [
    ["d", getProductShippingOptionDTag(input.productDTag)],
    ["title", "Standard Shipping"],
    ["price", String(input.intent.amount), input.intent.currency],
    ["country", ...input.intent.countries],
    ["service", "standard"],
  ]
  if (input.clientAppId) {
    tags = appendConduitClientTag(tags, input.clientAppId)
  }
  return {
    kind: EVENT_KINDS.SHIPPING_OPTION,
    content: "",
    tags,
  }
}

export type ShippingOptionAddress = {
  pubkey: string
  dTag: string
  coordinate: string
}

export function parseShippingOptionAddress(
  coordinate: string
): ShippingOptionAddress | null {
  const firstColon = coordinate.indexOf(":")
  const secondColon = coordinate.indexOf(":", firstColon + 1)
  if (
    firstColon <= 0 ||
    secondColon <= firstColon + 1 ||
    coordinate.slice(0, firstColon) !== String(EVENT_KINDS.SHIPPING_OPTION)
  ) {
    return null
  }
  const pubkey = coordinate.slice(firstColon + 1, secondColon)
  const dTag = coordinate.slice(secondColon + 1)
  if (!pubkey || !dTag) return null
  return {
    pubkey,
    dTag,
    coordinate: getShippingOptionAddress(pubkey, dTag),
  }
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
  eventId: string
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
  /** Fields outside Conduit's narrow fixed-standard launch slice. */
  launchUnsupportedTags: string[]
}

export type ProductFulfillmentResolutionReason =
  | "missing_reference"
  | "invalid_reference"
  | "provider_unsupported"
  | "legacy_inline"
  | "unresolved"
  | "conflicting"
  | "unsupported"
  | "currency_mismatch"
  | "stale"

export type PreparedProductFulfillment = {
  intent: "digital" | "coordinate_after_order" | "fixed_standard"
  status: "ready" | "order_first"
  reason?: ProductFulfillmentResolutionReason
  option?: ParsedShippingOption
}

export type ResolvableProductFulfillment = Pick<
  ProductSchema,
  | "id"
  | "pubkey"
  | "format"
  | "currency"
  | "sourcePrice"
  | "shippingCostSats"
  | "sourceShippingCost"
  | "shippingOptionId"
  | "shippingOptionDTag"
  | "shippingOptionLaunchUnsupported"
  | "shippingCountries"
  | "shippingCountryRules"
  | "updatedAt"
>

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

  const getUniqueTag = (name: string): string[] | null => {
    const matches = tags.filter((tag) => tag[0] === name)
    return matches.length === 1 ? matches[0]! : null
  }

  const dTag = getUniqueTag("d")?.[1]?.trim() ?? ""
  const title = getUniqueTag("title")?.[1]?.trim() ?? ""
  const service = getUniqueTag("service")?.[1]?.trim().toLowerCase() ?? ""

  // ["price", amount, currency]
  const priceTag = getUniqueTag("price")
  const price = priceTag ? Number(priceTag[1]) : NaN
  const currency = normalizeCurrencyCode(priceTag?.[2] ?? "")
  if (!Number.isFinite(price) || price < 0 || !currency) return null

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

  if (
    !event.id ||
    !event.pubkey ||
    !dTag ||
    !title ||
    !service ||
    countries.length === 0 ||
    countries.some((country) => !/^[A-Z]{2}$/.test(country))
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
    eventId: event.id,
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
    launchUnsupportedTags: Array.from(
      new Set(
        tags
          .map((tag) => tag[0])
          .filter((name) => FIXED_STANDARD_UNSUPPORTED_TAGS.has(name))
      )
    ).sort(),
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function getShippingOptions(
  merchantPubkey: string
): Promise<ParsedShippingOption[]> {
  const relayLists = await getRelayLists([merchantPubkey], {
    cacheOnly: false,
  })
  const readPlan = planRelayReads({
    intent: "author_products",
    authors: [merchantPubkey],
    relayLists,
    maxRelays: 12,
  })
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.SHIPPING_OPTION as number],
    authors: [merchantPubkey],
  }

  const events = (await fetchEventsFanout(filter, {
    relayUrls: readPlan.relayUrls,
  })) as NDKEvent[]

  return selectLatestShippingOptions(events)
}

export function selectLatestShippingOptions(
  events: readonly Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">[]
): ParsedShippingOption[] {
  const candidatesByCoordinate = new Map<
    string,
    Array<Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">>
  >()
  for (const event of events) {
    const dTag = event.tags?.find((tag) => tag[0] === "d")?.[1]?.trim()
    if (!event.pubkey || !dTag) continue
    const coordinate = getShippingOptionAddress(event.pubkey, dTag)
    const candidates = candidatesByCoordinate.get(coordinate) ?? []
    candidates.push(event)
    candidatesByCoordinate.set(coordinate, candidates)
  }

  const latest: ParsedShippingOption[] = []
  for (const candidates of candidatesByCoordinate.values()) {
    const newestCreatedAt = Math.max(
      ...candidates.map((candidate) => candidate.created_at ?? 0)
    )
    const newest = candidates.filter(
      (candidate) => (candidate.created_at ?? 0) === newestCreatedAt
    )
    if (new Set(newest.map((candidate) => candidate.id)).size !== 1) {
      continue
    }
    const parsed = parseShippingOptionEvent(newest[0]!)
    if (parsed) latest.push(parsed)
  }
  return latest
}

export async function getShippingOptionsByCoordinates(
  coordinates: readonly string[]
): Promise<ParsedShippingOption[]> {
  const addresses = Array.from(
    new Map(
      coordinates
        .map(parseShippingOptionAddress)
        .filter((address): address is ShippingOptionAddress => !!address)
        .map((address) => [address.coordinate, address])
    ).values()
  )
  if (addresses.length === 0) return []

  const authors = Array.from(
    new Set(addresses.map((address) => address.pubkey))
  )
  const dTags = Array.from(new Set(addresses.map((address) => address.dTag)))
  const relayLists = await getRelayLists(authors, { cacheOnly: false })
  const readPlan = planRelayReads({
    intent: "author_products",
    authors,
    relayLists,
    maxRelays: 12,
  })
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.SHIPPING_OPTION as number],
    authors,
    "#d": dTags,
    limit: 100,
  }
  const requested = new Set(addresses.map((address) => address.coordinate))
  const result = await fetchEventsFanoutDetailed(filter, {
    relayUrls: readPlan.relayUrls,
  })
  const relayStatuses = new Map(
    result.relays.map((relay) => [relay.relayUrl, relay])
  )
  if (
    relayStatuses.size !== readPlan.relayUrls.length ||
    readPlan.relayUrls.some(
      (relayUrl) => relayStatuses.get(relayUrl)?.status !== "success"
    ) ||
    result.relays.some((relay) => relay.eventCount >= 100)
  ) {
    throw new Error(
      "Fixed shipping could not be verified across the planned relays"
    )
  }

  return selectLatestShippingOptions(result.events).filter((option) =>
    requested.has(option.id)
  )
}

export function resolveProductFulfillment(
  product: ResolvableProductFulfillment,
  shippingOptions: readonly ParsedShippingOption[]
): PreparedProductFulfillment {
  if (product.format === "digital") {
    return { intent: "digital", status: "ready" }
  }
  const hasLegacyInlineShipping =
    typeof product.sourceShippingCost?.amount === "number" ||
    typeof product.shippingCostSats === "number" ||
    (product.shippingCountries?.length ?? 0) > 0 ||
    (product.shippingCountryRules?.length ?? 0) > 0
  if (!product.shippingOptionId) {
    return hasLegacyInlineShipping
      ? {
          intent: "fixed_standard",
          status: "order_first",
          reason: "legacy_inline",
        }
      : {
          intent: "coordinate_after_order",
          status: "ready",
          reason: "missing_reference",
        }
  }

  const address = parseShippingOptionAddress(product.shippingOptionId)
  if (!address) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "invalid_reference",
    }
  }
  if (address.pubkey !== product.pubkey) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "provider_unsupported",
    }
  }

  if (product.shippingOptionLaunchUnsupported) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "unsupported",
    }
  }

  if (address.dTag === CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "legacy_inline",
    }
  }

  const candidates = shippingOptions.filter(
    (option) => option.id === address.coordinate
  )
  if (candidates.length === 0) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "unresolved",
    }
  }
  const newestCreatedAt = Math.max(
    ...candidates.map((candidate) => candidate.createdAt)
  )
  const newest = candidates.filter(
    (candidate) => candidate.createdAt === newestCreatedAt
  )
  if (new Set(newest.map((candidate) => candidate.eventId)).size !== 1) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "conflicting",
    }
  }
  const option = newest[0]!
  if (
    option.service !== "standard" ||
    option.launchUnsupportedTags.length > 0
  ) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "unsupported",
    }
  }

  const productCurrency = normalizeCurrencyCode(
    product.sourcePrice?.normalizedCurrency ??
      product.sourcePrice?.currency ??
      product.currency
  )
  if (option.currency !== productCurrency) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "currency_mismatch",
    }
  }
  if (
    !Number.isFinite(product.updatedAt) ||
    product.updatedAt <= 0 ||
    option.createdAt > product.updatedAt
  ) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "stale",
    }
  }

  return {
    intent: "fixed_standard",
    status: "ready",
    option,
  }
}

export function applyPreparedProductFulfillment(
  product: ProductSchema,
  prepared: PreparedProductFulfillment
): ProductSchema {
  const withoutShipping: ProductSchema = {
    ...product,
    shippingCostSats: undefined,
    sourceShippingCost: undefined,
    shippingCountries: undefined,
    shippingCountryRules: undefined,
    canonicalShippingResolved: false,
    shippingOptionCreatedAt: undefined,
    shippingOptionLaunchUnsupported: undefined,
  }
  if (
    prepared.intent !== "fixed_standard" ||
    prepared.status !== "ready" ||
    !prepared.option
  ) {
    return prepared.intent === "digital"
      ? {
          ...withoutShipping,
          shippingOptionId: undefined,
          shippingOptionDTag: undefined,
        }
      : withoutShipping
  }

  const option = prepared.option
  return {
    ...withoutShipping,
    ...canonicalizeShippingCost(option.price, option.currency),
    shippingOptionId: option.id,
    shippingOptionDTag: option.dTag,
    shippingCountries: [...option.countries],
    shippingCountryRules: option.countryRules.map((rule) => ({
      ...rule,
      restrictTo: [...rule.restrictTo],
      exclude: [...rule.exclude],
    })),
    canonicalShippingResolved: true,
    shippingOptionCreatedAt: option.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Eligibility helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the buyer's country is covered by at least one of the
 * merchant's shipping options.
 *
 * An empty option set is unresolved, so eligibility fails closed.
 */
export function isBuyerCountryEligible(
  buyerCountry: string,
  shippingOptions: ParsedShippingOption[]
): boolean {
  if (shippingOptions.length === 0) return false
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
