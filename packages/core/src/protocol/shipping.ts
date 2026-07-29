/**
 * Kind-30406 shipping option protocol helpers.
 *
 * GammaMarkets market-spec: https://github.com/GammaMarkets/market-spec
 *
 * The canonical fixed-shipping writer publishes one complete, product-scoped
 * Gamma kind-30406 per distinct country-rate zone before its referencing
 * kind-30402.
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
import {
  fetchEventsFanout,
  fetchEventsFanoutDetailed,
  type FetchEventsFanoutResult,
} from "./ndk"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import type { ConduitAppId } from "./nip89"
import { appendConduitClientTag } from "./nip89"

export const CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG = "conduit-default"
export const FIXED_PRODUCT_SHIPPING_D_TAG_SUFFIX = "-shipping-standard"
export const SHIPPING_OPTION_READ_BATCH_SIZE = 50

const SHIPPING_OPTION_READ_LIMIT = 100
const SHIPPING_DELETION_READ_LIMIT = 300
const SHIPPING_OPTION_READ_CONCURRENCY = 3

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

export function getProductShippingZoneDTag(
  productDTag: string,
  countries: readonly string[]
): string {
  const normalizedCountries = Array.from(
    new Set(countries.map((country) => country.trim().toUpperCase()))
  ).sort()
  if (
    normalizedCountries.length === 0 ||
    normalizedCountries.some((country) => !/^[A-Z]{2}$/.test(country))
  ) {
    throw new Error("Shipping zone requires at least one valid country")
  }
  return `${getProductShippingOptionDTag(productDTag)}-${normalizedCountries
    .map((country) => country.toLowerCase())
    .join("-")}`
}

export function getProductShippingZoneAddress(
  pubkey: string,
  productDTag: string,
  countries: readonly string[]
): string {
  return getShippingOptionAddress(
    pubkey,
    getProductShippingZoneDTag(productDTag, countries)
  )
}

export interface FixedShippingRateZone {
  amount: number
  currency: string
  countries: string[]
  usesProductFallback: boolean
}

export type ProductFulfillmentIntent =
  | { kind: "digital" }
  | { kind: "coordinate_after_order" }
  | {
      kind: "fixed_standard"
      zones: FixedShippingRateZone[]
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

  const currency = normalizeCurrencyCode(input.currency)
  if (!currency) throw new Error("Fixed shipping currency is required")

  const fallbackAmount =
    typeof input.amount === "number" &&
    Number.isFinite(input.amount) &&
    input.amount >= 0
      ? input.amount
      : undefined
  if (
    input.amount !== undefined &&
    (fallbackAmount === undefined || !Number.isFinite(input.amount))
  ) {
    throw new Error("Fixed shipping fallback requires a non-negative amount")
  }

  const destinationsByCountry = new Map<string, ShippingCountryConfig>()
  for (const destination of input.destinations) {
    const country = destination.code.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error(
        "Fixed shipping requires at least one valid country destination"
      )
    }
    const existing = destinationsByCountry.get(country)
    if (existing) {
      const existingCurrency = normalizeCurrencyCode(
        existing.rate?.currency ?? currency
      )
      const nextCurrency = normalizeCurrencyCode(
        destination.rate?.currency ?? currency
      )
      if (
        existing.rate?.amount !== destination.rate?.amount ||
        existingCurrency !== nextCurrency
      ) {
        throw new Error(`Fixed shipping has conflicting rates for ${country}`)
      }
      continue
    }
    destinationsByCountry.set(country, destination)
  }
  const countries = Array.from(destinationsByCountry.keys()).sort()
  if (countries.length === 0) {
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

  const groupedZones = new Map<
    string,
    {
      amount: number
      currency: string
      countries: string[]
      usesProductFallback: boolean
    }
  >()
  for (const country of countries) {
    const destination = destinationsByCountry.get(country)!
    const explicitRate = destination.rate
    if (
      explicitRate &&
      (!Number.isFinite(explicitRate.amount) || explicitRate.amount < 0)
    ) {
      throw new Error(
        `Fixed shipping requires a non-negative zone rate for ${country}`
      )
    }
    const amount = explicitRate?.amount ?? fallbackAmount
    const rateCurrency = normalizeCurrencyCode(
      explicitRate?.currency ?? currency
    )
    if (amount === undefined) {
      throw new Error(
        `Fixed shipping requires a zone rate or product fallback for ${country}`
      )
    }
    if (!rateCurrency || rateCurrency !== currency) {
      throw new Error(
        "Fixed shipping zone currency must match the product currency"
      )
    }
    const key = `${rateCurrency}\u0000${amount}`
    const group = groupedZones.get(key) ?? {
      amount,
      currency: rateCurrency,
      countries: [],
      usesProductFallback: false,
    }
    group.countries.push(country)
    group.usesProductFallback ||= explicitRate === undefined
    groupedZones.set(key, group)
  }

  return {
    kind: "fixed_standard",
    zones: Array.from(groupedZones.values())
      .map((zone) => ({
        ...zone,
        countries: zone.countries.sort(),
      }))
      .sort((a, b) =>
        a.countries.join(",").localeCompare(b.countries.join(","))
      ),
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
  if (input.intent.zones.length !== 1) {
    throw new Error("Expected exactly one fixed shipping zone")
  }
  const zone = input.intent.zones[0]!
  let tags: string[][] = [
    ["d", getProductShippingOptionDTag(input.productDTag)],
    ["title", "Standard Shipping"],
    ["price", String(zone.amount), zone.currency],
    ["country", ...zone.countries],
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

export function buildFixedShippingOptionEventDrafts(input: {
  productDTag: string
  intent: Extract<ProductFulfillmentIntent, { kind: "fixed_standard" }>
  clientAppId?: ConduitAppId
}): ShippingOptionEventDraft[] {
  return input.intent.zones.map((zone) => {
    let tags: string[][] = [
      ["d", getProductShippingZoneDTag(input.productDTag, zone.countries)],
      ["title", `Standard Shipping (${zone.countries.join(", ")})`],
      ["price", String(zone.amount), zone.currency],
      ["country", ...zone.countries],
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
  })
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
  /** Optional flat checkout rate for this country/zone. */
  rate?: {
    amount: number
    currency: string
  }
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
  | "destination_unsupported"
  | "ambiguous_destination"

export type PreparedProductFulfillment = {
  intent: "digital" | "coordinate_after_order" | "fixed_standard"
  status: "ready" | "order_first"
  reason?: ProductFulfillmentResolutionReason
  option?: ParsedShippingOption
  options?: ParsedShippingOption[]
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
  | "shippingOptionIds"
  | "shippingOptionDTags"
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
  events: readonly Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">[],
  deletionEvents: readonly Pick<
    NDKEvent,
    "id" | "pubkey" | "tags" | "created_at"
  >[] = []
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
  for (const [coordinate, candidates] of candidatesByCoordinate) {
    const newestCreatedAt = Math.max(
      ...candidates.map((candidate) => candidate.created_at ?? 0)
    )
    const newest = candidates.filter(
      (candidate) => (candidate.created_at ?? 0) === newestCreatedAt
    )
    if (new Set(newest.map((candidate) => candidate.id)).size !== 1) {
      continue
    }
    const event = newest[0]!
    const deleted = deletionEvents.some(
      (deletion) =>
        deletion.pubkey === event.pubkey &&
        (deletion.created_at ?? 0) >= (event.created_at ?? 0) &&
        deletion.tags.some(
          (tag) =>
            (tag[0] === "e" && tag[1] === event.id) ||
            (tag[0] === "a" && tag[1] === coordinate)
        )
    )
    if (deleted) continue

    const parsed = parseShippingOptionEvent(event)
    if (parsed) latest.push(parsed)
  }
  return latest
}

export interface ShippingOptionReadBatch {
  pubkey: string
  coordinates: string[]
  dTags: string[]
}

export function buildShippingOptionReadBatches(
  coordinates: readonly string[]
): ShippingOptionReadBatch[] {
  const addressesByAuthor = new Map<string, ShippingOptionAddress[]>()
  const seen = new Set<string>()
  for (const coordinate of coordinates) {
    const address = parseShippingOptionAddress(coordinate)
    if (!address || seen.has(address.coordinate)) continue
    seen.add(address.coordinate)
    const addresses = addressesByAuthor.get(address.pubkey) ?? []
    addresses.push(address)
    addressesByAuthor.set(address.pubkey, addresses)
  }

  const batches: ShippingOptionReadBatch[] = []
  for (const [pubkey, addresses] of addressesByAuthor) {
    for (
      let offset = 0;
      offset < addresses.length;
      offset += SHIPPING_OPTION_READ_BATCH_SIZE
    ) {
      const batch = addresses.slice(
        offset,
        offset + SHIPPING_OPTION_READ_BATCH_SIZE
      )
      batches.push({
        pubkey,
        coordinates: batch.map((address) => address.coordinate),
        dTags: batch.map((address) => address.dTag),
      })
    }
  }
  return batches
}

function requireCompleteShippingRead(
  result: FetchEventsFanoutResult,
  relayUrls: readonly string[],
  queryLimit: number
): NDKEvent[] {
  const relayStatuses = new Map(
    result.relays.map((relay) => [relay.relayUrl, relay])
  )
  if (
    relayStatuses.size !== relayUrls.length ||
    relayUrls.some(
      (relayUrl) => relayStatuses.get(relayUrl)?.status !== "success"
    ) ||
    result.relays.some((relay) => relay.eventCount >= queryLimit)
  ) {
    throw new Error(
      "Fixed shipping could not be verified across the planned relays"
    )
  }
  return result.events
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () =>
      worker()
    )
  )
  return results
}

export async function getShippingOptionsByCoordinates(
  coordinates: readonly string[]
): Promise<ParsedShippingOption[]> {
  const batches = buildShippingOptionReadBatches(coordinates)
  if (batches.length === 0) return []

  const authors = Array.from(new Set(batches.map((batch) => batch.pubkey)))
  const relayLists = await getRelayLists(authors, { cacheOnly: false })
  const requested = new Set(batches.flatMap((batch) => batch.coordinates))
  const batchResults = await mapWithConcurrency(
    batches,
    SHIPPING_OPTION_READ_CONCURRENCY,
    async (batch) => {
      const readPlan = planRelayReads({
        intent: "author_products",
        authors: [batch.pubkey],
        relayLists,
        maxRelays: 12,
      })
      const shippingEvents = requireCompleteShippingRead(
        await fetchEventsFanoutDetailed(
          {
            kinds: [EVENT_KINDS.SHIPPING_OPTION as number],
            authors: [batch.pubkey],
            "#d": batch.dTags,
            limit: SHIPPING_OPTION_READ_LIMIT,
          },
          { relayUrls: readPlan.relayUrls }
        ),
        readPlan.relayUrls,
        SHIPPING_OPTION_READ_LIMIT
      )
      const addressDeletionEvents = requireCompleteShippingRead(
        await fetchEventsFanoutDetailed(
          {
            kinds: [EVENT_KINDS.DELETION as number],
            authors: [batch.pubkey],
            "#a": batch.coordinates,
            limit: SHIPPING_DELETION_READ_LIMIT,
          },
          { relayUrls: readPlan.relayUrls }
        ),
        readPlan.relayUrls,
        SHIPPING_DELETION_READ_LIMIT
      )
      const eventIds = Array.from(
        new Set(shippingEvents.map((event) => event.id).filter(Boolean))
      )
      const eventDeletionEvents =
        eventIds.length === 0
          ? []
          : requireCompleteShippingRead(
              await fetchEventsFanoutDetailed(
                {
                  kinds: [EVENT_KINDS.DELETION as number],
                  authors: [batch.pubkey],
                  "#e": eventIds,
                  limit: SHIPPING_DELETION_READ_LIMIT,
                },
                { relayUrls: readPlan.relayUrls }
              ),
              readPlan.relayUrls,
              SHIPPING_DELETION_READ_LIMIT
            )
      return {
        shippingEvents,
        deletionEvents: [...addressDeletionEvents, ...eventDeletionEvents],
      }
    }
  )

  return selectLatestShippingOptions(
    batchResults.flatMap((result) => result.shippingEvents),
    batchResults.flatMap((result) => result.deletionEvents)
  ).filter((option) => requested.has(option.id))
}

export function resolveProductFulfillment(
  product: ResolvableProductFulfillment,
  shippingOptions: readonly ParsedShippingOption[],
  destination?: {
    country?: string
    postalCode?: string
    shippingOptionId?: string
  }
): PreparedProductFulfillment {
  if (product.format === "digital") {
    return { intent: "digital", status: "ready" }
  }
  const hasLegacyInlineShipping =
    typeof product.sourceShippingCost?.amount === "number" ||
    typeof product.shippingCostSats === "number" ||
    (product.shippingCountries?.length ?? 0) > 0 ||
    (product.shippingCountryRules?.length ?? 0) > 0
  const productShippingOptionIds = Array.from(
    new Set(
      product.shippingOptionIds?.length
        ? product.shippingOptionIds
        : product.shippingOptionId
          ? [product.shippingOptionId]
          : []
    )
  )
  if (productShippingOptionIds.length === 0) {
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

  const addresses = productShippingOptionIds.map(parseShippingOptionAddress)
  if (addresses.some((address) => !address)) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "invalid_reference",
    }
  }
  const parsedAddresses = addresses as ShippingOptionAddress[]
  if (parsedAddresses.some((address) => address.pubkey !== product.pubkey)) {
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

  if (
    parsedAddresses.some(
      (address) => address.dTag === CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG
    )
  ) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "legacy_inline",
    }
  }

  const productCurrency = normalizeCurrencyCode(
    product.sourcePrice?.normalizedCurrency ??
      product.sourcePrice?.currency ??
      product.currency
  )
  const resolvedOptions: ParsedShippingOption[] = []
  for (const address of parsedAddresses) {
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
    resolvedOptions.push(option)
  }

  let matchingOptions = resolvedOptions
  if (destination?.shippingOptionId) {
    matchingOptions = resolvedOptions.filter(
      (option) => option.id === destination.shippingOptionId
    )
  } else if (destination?.country?.trim()) {
    const country = destination.country.trim().toUpperCase()
    const postalCode = destination.postalCode ?? ""
    matchingOptions = resolvedOptions.filter((option) => {
      const eligibility = getShippingDestinationEligibility(
        { country, postalCode },
        [option]
      )
      return eligibility.eligible === true
    })
  } else if (resolvedOptions.length > 1) {
    return {
      intent: "fixed_standard",
      status: "ready",
      options: resolvedOptions,
    }
  }

  if (matchingOptions.length === 0) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "destination_unsupported",
    }
  }
  if (matchingOptions.length > 1) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "ambiguous_destination",
    }
  }
  const option = matchingOptions[0]!

  return {
    intent: "fixed_standard",
    status: "ready",
    option,
    options: resolvedOptions,
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
    shippingZones: undefined,
  }
  if (prepared.intent !== "fixed_standard" || prepared.status !== "ready") {
    return prepared.intent === "digital"
      ? {
          ...withoutShipping,
          shippingOptionId: undefined,
          shippingOptionDTag: undefined,
          shippingOptionIds: undefined,
          shippingOptionDTags: undefined,
        }
      : withoutShipping
  }

  const options = prepared.options ?? (prepared.option ? [prepared.option] : [])
  const shippingZones = options.map((option) => ({
    shippingOptionId: option.id,
    shippingOptionDTag: option.dTag,
    amount: option.price,
    currency: option.currency,
    countries: [...option.countries],
  }))
  const countries = Array.from(
    new Set(options.flatMap((option) => option.countries))
  ).sort()
  const base: ProductSchema = {
    ...withoutShipping,
    shippingCountries: countries,
    shippingCountryRules: options.flatMap((option) =>
      option.countryRules.map((rule) => ({
        ...rule,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
      }))
    ),
    shippingZones,
  }
  const option = prepared.option
  return option
    ? {
        ...base,
        ...canonicalizeShippingCost(option.price, option.currency),
        shippingOptionId: option.id,
        shippingOptionDTag: option.dTag,
        canonicalShippingResolved: true,
        shippingOptionCreatedAt: option.createdAt,
      }
    : base
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
