/**
 * Kind-30406 shipping option protocol helpers.
 *
 * Open Markets working specification: https://github.com/OpenMarketsFoundation/specification
 *
 * The canonical fixed-shipping writer publishes one complete, product-scoped
 * Gamma kind-30406 before its referencing kind-30402.
 */
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  db,
  type CachedProductTombstone,
  type CachedShippingOptionFrontier,
} from "../db"
import {
  canonicalizeShippingCost,
  getShippingCostSats,
  normalizeCurrencyAmount,
  normalizeCurrencyCode,
  type CommerceShippingCostLike,
  type PricingRateInput,
} from "../pricing"
import type { ProductSchema } from "../schemas"
import { EVENT_KINDS } from "./kinds"
import {
  normalizeAddressSubdivisionCode,
  supportsAddressPostalPolicy,
} from "./address-validation"
import {
  attachEventSourceRelayUrl,
  fetchEventsFanout,
  fetchEventsFanoutDetailed,
  getEventSourceRelayUrls,
  type FetchEventsFanoutResult,
} from "./ndk"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import type { ConduitAppId } from "./nip89"
import { appendConduitClientTag } from "./nip89"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export const CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG = "conduit-default"
export const FIXED_PRODUCT_SHIPPING_D_TAG_SUFFIX = "-shipping-standard"
export const SHIPPING_DESTINATION_SCHEMA_VERSION = "1"
export const SHIPPING_OPTION_READ_BATCH_SIZE = 50

const SHIPPING_OPTION_READ_LIMIT = 100
const SHIPPING_DELETION_READ_LIMIT = 300
const SHIPPING_OPTION_READ_CONCURRENCY = 3
const SHIPPING_OPTION_FRONTIER_CONFLICT_LIMIT = 2
const SHIPPING_TOMBSTONE_PREFIX = "shipping:"
const SHIPPING_TOMBSTONE_FALLBACK_BASE =
  "conduit:shipping-tombstone-fallback:v1:"
const SHIPPING_TOMBSTONE_FALLBACK_EVENT_PREFIX = `${SHIPPING_TOMBSTONE_FALLBACK_BASE}event:`
const SHIPPING_TOMBSTONE_FALLBACK_PENDING_PREFIX = `${SHIPPING_TOMBSTONE_FALLBACK_BASE}pending:`
const HEX_64 = /^[0-9a-f]{64}$/i
let shippingFallbackBatchSequence = 0

export interface ShippingDeletionFallbackStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ShippingTestOverrides {
  fetchEventsFanoutDetailed?: typeof fetchEventsFanoutDetailed
  getCachedDeletionTombstones?: (
    targetIds: readonly string[]
  ) => Promise<CachedProductTombstone[]>
  putCachedDeletionTombstones?: (
    rows: CachedProductTombstone[]
  ) => Promise<void>
  getCachedOptionFrontiers?: (
    coordinates: readonly string[]
  ) => Promise<CachedShippingOptionFrontier[]>
  putCachedOptionFrontiers?: (
    rows: CachedShippingOptionFrontier[]
  ) => Promise<void>
  deletionFallbackStorage?: ShippingDeletionFallbackStorage | null
  now?: () => number
}

let shippingTestOverrides: ShippingTestOverrides = {}
const volatileShippingDeletionTombstones = new Map<
  string,
  CachedProductTombstone
>()
const volatileShippingOptionFrontiers = new Map<
  string,
  CachedShippingOptionFrontier
>()

export function __setShippingTestOverrides(
  overrides: Partial<ShippingTestOverrides>
): void {
  shippingTestOverrides = { ...shippingTestOverrides, ...overrides }
}

export function __resetShippingTestOverrides(): void {
  shippingTestOverrides = {}
  volatileShippingDeletionTombstones.clear()
  volatileShippingOptionFrontiers.clear()
}

const FIXED_STANDARD_SUPPORTED_TAGS = new Set([
  "d",
  "title",
  "price",
  "country",
  "service",
  "destination_schema",
  "destination",
  "client",
])
const FIXED_STANDARD_PRICE_AMOUNT = /^\d+(?:\.\d+)?$/
const SHIPPING_POSTAL_SELECTOR_VALUE = /^[A-Z0-9]+$/
const SHIPPING_SUBDIVISION_CODE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/

function normalizeFixedShippingAmount(
  amount: number,
  currency: string,
  label: string
): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${label} requires a non-negative amount`)
  }
  const normalized = normalizeCurrencyAmount(amount, currency)
  if (normalized.status === "invalid") {
    throw new Error(`${label} is invalid: ${normalized.reason}`)
  }
  if (normalized.amount !== amount) {
    throw new Error(
      `${label} must use at most ${normalized.fractionDigits} decimal places for ${normalized.normalizedCurrency}`
    )
  }
  return normalized.amount
}

function serializePlainDecimalAmount(amount: number): string {
  const value = String(amount)
  if (!/[eE]/.test(value)) return value

  const [coefficient, exponentText] = value.toLowerCase().split("e")
  const exponent = Number(exponentText)
  if (!coefficient || !Number.isInteger(exponent)) return value

  const negative = coefficient.startsWith("-")
  const unsignedCoefficient = negative ? coefficient.slice(1) : coefficient
  const decimalIndex = unsignedCoefficient.indexOf(".")
  const digits = unsignedCoefficient.replace(".", "")
  const integerDigits = decimalIndex === -1 ? digits.length : decimalIndex
  const expandedDecimalIndex = integerDigits + exponent
  const expanded =
    expandedDecimalIndex <= 0
      ? `0.${"0".repeat(-expandedDecimalIndex)}${digits}`
      : expandedDecimalIndex >= digits.length
        ? `${digits}${"0".repeat(expandedDecimalIndex - digits.length)}`
        : `${digits.slice(0, expandedDecimalIndex)}.${digits.slice(expandedDecimalIndex)}`

  return negative ? `-${expanded}` : expanded
}

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

export interface FixedShippingRateZone {
  amount: number
  currency: string
  countryRules: ShippingCountryConfig[]
  countries: string[]
  /** True when at least one destination inherited the product-level amount. */
  usesProductFallback: boolean
  /** Present only for the experimental, versioned destination grammar. */
  destinationSchema?: typeof SHIPPING_DESTINATION_SCHEMA_VERSION
}

export type ProductFulfillmentIntent =
  | { kind: "digital" }
  | { kind: "coordinate_after_order" }
  | {
      kind: "fixed_standard"
      zones: FixedShippingRateZone[]
    }

export function getFixedShippingRateZones(
  intent: Extract<ProductFulfillmentIntent, { kind: "fixed_standard" }>
): FixedShippingRateZone[] {
  if (Array.isArray(intent.zones)) {
    return intent.zones.map((zone) => {
      const currency = normalizeCurrencyCode(zone.currency)
      if (!currency) throw new Error("Fixed shipping currency is required")
      return {
        ...zone,
        amount: normalizeFixedShippingAmount(
          zone.amount,
          currency,
          "Fixed shipping rate"
        ),
        currency,
      }
    })
  }

  // Runtime compatibility for already-restored drafts created before the
  // per-zone intent shape. New TypeScript callers cannot construct this shape.
  const legacy = intent as unknown as {
    amount?: unknown
    currency?: unknown
    countries?: unknown
  }
  if (
    typeof legacy.amount !== "number" ||
    !Number.isFinite(legacy.amount) ||
    legacy.amount < 0 ||
    typeof legacy.currency !== "string" ||
    !Array.isArray(legacy.countries)
  ) {
    throw new Error("Fixed shipping destination policies are invalid")
  }
  const countries = Array.from(
    new Set(
      legacy.countries.flatMap((country) =>
        typeof country === "string" && /^[A-Za-z]{2}$/.test(country)
          ? [country.toUpperCase()]
          : []
      )
    )
  ).sort()
  if (countries.length === 0) {
    throw new Error("Fixed shipping requires a country destination")
  }
  const currency = normalizeCurrencyCode(legacy.currency)
  if (!currency) throw new Error("Fixed shipping currency is required")
  return [
    {
      amount: normalizeFixedShippingAmount(
        legacy.amount,
        currency,
        "Fixed shipping rate"
      ),
      currency,
      countries,
      countryRules: countries.map((code) => ({
        code,
        name: code,
        restrictTo: [],
        exclude: [],
      })),
      usesProductFallback: true,
    },
  ]
}

type ShippingAuthoringDestination = ShippingCountryConfig & {
  rate?: {
    amount: number
    currency: string
  }
}

function normalizeShippingPostalPattern(pattern: string): string {
  const trimmed = pattern.trim().toUpperCase()
  const prefix = trimmed.endsWith("*")
  const withoutWildcard = prefix ? trimmed.replace(/\*+$/, "") : trimmed
  const value = withoutWildcard.replace(/[ -]/g, "")
  if (!value || !SHIPPING_POSTAL_SELECTOR_VALUE.test(value)) {
    throw new Error(
      "Postal rules must use letters and numbers with an optional trailing * for a prefix"
    )
  }
  return prefix ? `${value}*` : value
}

function normalizeShippingSubdivision(
  country: string,
  subdivision: string
): string {
  const normalized = subdivision.trim().toUpperCase()
  const localCode = normalized.startsWith(`${country}-`)
    ? normalized.slice(country.length + 1)
    : normalized
  const complete = normalizeAddressSubdivisionCode(country, localCode)
  if (!complete || !SHIPPING_SUBDIVISION_CODE.test(complete)) {
    throw new Error(
      `Conduit cannot validate subdivision ${subdivision || "(blank)"} for ${country}`
    )
  }
  return complete
}

function normalizeShippingCountryRule(
  destination: ShippingCountryConfig
): ShippingCountryConfig {
  const code = destination.code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(
      "Fixed shipping requires at least one valid country destination"
    )
  }

  const restrictTo = Array.from(
    new Set(destination.restrictTo.map(normalizeShippingPostalPattern))
  ).sort()
  const exclude = Array.from(
    new Set(destination.exclude.map(normalizeShippingPostalPattern))
  ).sort()
  if (
    (restrictTo.length > 0 || exclude.length > 0) &&
    !supportsAddressPostalPolicy(code)
  ) {
    throw new Error(
      `Conduit cannot safely validate postal destination rules for ${code}`
    )
  }

  const includeSubdivisions = Array.from(
    new Set(
      (destination.includeSubdivisions ?? []).map((subdivision) =>
        normalizeShippingSubdivision(code, subdivision)
      )
    )
  ).sort()
  const excludeSubdivisions = Array.from(
    new Set(
      (destination.excludeSubdivisions ?? []).map((subdivision) =>
        normalizeShippingSubdivision(code, subdivision)
      )
    )
  ).sort()
  const includeCountry =
    destination.includeCountry === true &&
    (includeSubdivisions.length > 0 || restrictTo.length > 0)

  return {
    code,
    name: destination.name.trim() || code,
    restrictTo,
    exclude,
    ...(includeCountry ? { includeCountry: true } : {}),
    ...(includeSubdivisions.length > 0 ? { includeSubdivisions } : {}),
    ...(excludeSubdivisions.length > 0 ? { excludeSubdivisions } : {}),
    ...(destination.excludeCountry === true ? { excludeCountry: true } : {}),
  }
}

function canonicalShippingCountryRule(rule: ShippingCountryConfig): object {
  return {
    code: rule.code,
    ...(rule.includeCountry === true ? { includeCountry: true } : {}),
    excludeCountry: rule.excludeCountry === true,
    includeSubdivisions: rule.includeSubdivisions ?? [],
    excludeSubdivisions: rule.excludeSubdivisions ?? [],
    restrictTo: rule.restrictTo,
    exclude: rule.exclude,
  }
}

function canonicalShippingPolicy(
  zone: Pick<FixedShippingRateZone, "countryRules">
): string {
  return JSON.stringify(
    zone.countryRules
      .map(canonicalShippingCountryRule)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
  )
}

function hasDetailedDestinationPolicy(
  rules: readonly ShippingCountryConfig[]
): boolean {
  return rules.some(
    (rule) =>
      rule.restrictTo.length > 0 ||
      rule.exclude.length > 0 ||
      (rule.includeSubdivisions?.length ?? 0) > 0 ||
      (rule.excludeSubdivisions?.length ?? 0) > 0 ||
      rule.excludeCountry === true
  )
}

export function getProductShippingZoneDTag(
  productDTag: string,
  zone: Pick<FixedShippingRateZone, "countryRules">
): string {
  const policyHash = bytesToHex(
    sha256(new TextEncoder().encode(canonicalShippingPolicy(zone)))
  ).slice(0, 24)
  return `${getProductShippingOptionDTag(productDTag)}-${policyHash}`
}

export function getProductShippingZoneAddress(
  pubkey: string,
  productDTag: string,
  zone: Pick<FixedShippingRateZone, "countryRules">
): string {
  return getShippingOptionAddress(
    pubkey,
    getProductShippingZoneDTag(productDTag, zone)
  )
}

export function compileProductFulfillmentIntent(input: {
  format: "physical" | "digital"
  shippingPricingMode: "fixed" | "coordinate_after_order"
  amount?: number
  currency: string
  destinations: readonly ShippingAuthoringDestination[]
  allowExperimentalDestinationPolicy?: boolean
}): ProductFulfillmentIntent {
  if (input.format === "digital") return { kind: "digital" }
  if (input.shippingPricingMode === "coordinate_after_order") {
    return { kind: "coordinate_after_order" }
  }

  const currency = normalizeCurrencyCode(input.currency)
  if (!currency) throw new Error("Fixed shipping currency is required")

  const fallbackAmount =
    input.amount === undefined
      ? undefined
      : normalizeFixedShippingAmount(
          input.amount,
          currency,
          "Fixed shipping fallback"
        )
  if (input.destinations.length === 0) {
    throw new Error(
      "Fixed shipping requires at least one valid country destination"
    )
  }

  const zonesByRate = new Map<string, FixedShippingRateZone>()
  for (const destination of input.destinations) {
    const rule = normalizeShippingCountryRule(destination)
    const amount = destination.rate?.amount ?? fallbackAmount
    const rateCurrency = normalizeCurrencyCode(
      destination.rate?.currency ?? currency
    )
    if (amount === undefined) {
      throw new Error(
        `Fixed shipping requires a destination rate or product fallback for ${rule.code}`
      )
    }
    if (!rateCurrency || rateCurrency !== currency) {
      throw new Error(
        "Fixed shipping destination currency must match the product currency"
      )
    }
    const normalizedAmount = normalizeFixedShippingAmount(
      amount,
      rateCurrency,
      `Fixed shipping destination rate for ${rule.code}`
    )
    if (
      hasDetailedDestinationPolicy([rule]) &&
      input.allowExperimentalDestinationPolicy !== true
    ) {
      throw new Error(
        "Detailed destination policies are available only in the preview rollout. Remove subdivision/postal rules or coordinate shipping after the order."
      )
    }

    const key = JSON.stringify([
      rateCurrency,
      serializePlainDecimalAmount(normalizedAmount),
    ])
    const zone = zonesByRate.get(key) ?? {
      amount: normalizedAmount,
      currency: rateCurrency,
      countryRules: [],
      countries: [],
      usesProductFallback: false,
    }
    zone.countryRules.push(rule)
    zone.countries.push(rule.code)
    zone.usesProductFallback ||= destination.rate === undefined
    if (hasDetailedDestinationPolicy([rule])) {
      zone.destinationSchema = SHIPPING_DESTINATION_SCHEMA_VERSION
    }
    zonesByRate.set(key, zone)
  }

  const zones = Array.from(zonesByRate.values()).map((zone) => ({
    ...zone,
    countries: Array.from(new Set(zone.countries)).sort(),
    countryRules: Array.from(
      new Map(
        zone.countryRules.map((rule) => [
          JSON.stringify(canonicalShippingCountryRule(rule)),
          rule,
        ])
      ).values()
    ).sort((left, right) =>
      JSON.stringify(canonicalShippingCountryRule(left)).localeCompare(
        JSON.stringify(canonicalShippingCountryRule(right))
      )
    ),
  }))
  const policyRates = new Map<string, string>()
  for (const zone of zones) {
    const policy = canonicalShippingPolicy(zone)
    const rate = JSON.stringify([
      zone.currency,
      serializePlainDecimalAmount(zone.amount),
    ])
    const existingRate = policyRates.get(policy)
    if (existingRate && existingRate !== rate) {
      throw new Error(
        "Fixed shipping has two different rates for the same destination policy"
      )
    }
    policyRates.set(policy, rate)
  }

  return {
    kind: "fixed_standard",
    zones: zones.sort((left, right) =>
      canonicalShippingPolicy(left).localeCompare(
        canonicalShippingPolicy(right)
      )
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
  if (getFixedShippingRateZones(input.intent).length !== 1) {
    throw new Error("Expected exactly one fixed shipping destination policy")
  }
  return buildFixedShippingOptionEventDrafts(input)[0]!
}

export function getFixedShippingOptionDTags(
  productDTag: string,
  intent: Extract<ProductFulfillmentIntent, { kind: "fixed_standard" }>
): string[] {
  const zones = getFixedShippingRateZones(intent)
  const preserveLegacyCoordinate =
    zones.length === 1 &&
    zones[0]?.destinationSchema === undefined &&
    zones[0]?.usesProductFallback === true

  return zones.map((zone) =>
    preserveLegacyCoordinate
      ? getProductShippingOptionDTag(productDTag)
      : getProductShippingZoneDTag(productDTag, zone)
  )
}

export function getFixedShippingOptionAddresses(
  pubkey: string,
  productDTag: string,
  intent: Extract<ProductFulfillmentIntent, { kind: "fixed_standard" }>
): string[] {
  return getFixedShippingOptionDTags(productDTag, intent).map((dTag) =>
    getShippingOptionAddress(pubkey, dTag)
  )
}

function shippingDestinationTags(zone: FixedShippingRateZone): string[][] {
  if (zone.destinationSchema !== SHIPPING_DESTINATION_SCHEMA_VERSION) return []

  const tags: string[][] = [
    ["destination_schema", SHIPPING_DESTINATION_SCHEMA_VERSION],
  ]
  for (const rule of zone.countryRules) {
    const includeSubdivisions = rule.includeSubdivisions ?? []
    if (
      rule.includeCountry === true ||
      (includeSubdivisions.length === 0 && rule.restrictTo.length === 0)
    ) {
      tags.push(["destination", "include", "country", rule.code])
    }
    for (const subdivision of includeSubdivisions) {
      tags.push(["destination", "include", "subdivision", subdivision])
    }
    for (const postal of rule.restrictTo) {
      const prefix = postal.endsWith("*")
      tags.push([
        "destination",
        "include",
        "postal",
        rule.code,
        prefix ? "prefix" : "exact",
        prefix ? postal.slice(0, -1) : postal,
      ])
    }
    for (const subdivision of rule.excludeSubdivisions ?? []) {
      tags.push(["destination", "exclude", "subdivision", subdivision])
    }
    if (rule.excludeCountry) {
      tags.push(["destination", "exclude", "country", rule.code])
    }
    for (const postal of rule.exclude) {
      const prefix = postal.endsWith("*")
      tags.push([
        "destination",
        "exclude",
        "postal",
        rule.code,
        prefix ? "prefix" : "exact",
        prefix ? postal.slice(0, -1) : postal,
      ])
    }
  }
  return tags
}

export function buildFixedShippingOptionEventDrafts(input: {
  productDTag: string
  intent: Extract<ProductFulfillmentIntent, { kind: "fixed_standard" }>
  clientAppId?: ConduitAppId
}): ShippingOptionEventDraft[] {
  const zones = getFixedShippingRateZones(input.intent)
  const dTags = getFixedShippingOptionDTags(input.productDTag, input.intent)

  return zones.map((zone, index) => {
    const dTag = dTags[index]!
    let tags: string[][] = [
      ["d", dTag],
      ["title", "Standard Shipping"],
      ["price", serializePlainDecimalAmount(zone.amount), zone.currency],
      ["country", ...zone.countries],
      ["service", "standard"],
      ...shippingDestinationTags(zone),
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

export interface ShippingOptionDeletionEventDraft {
  kind: typeof EVENT_KINDS.DELETION
  content: string
  tags: string[][]
}

/**
 * Build a canonical NIP-09 withdrawal for one shipping-option coordinate.
 *
 * The address tag is mandatory even when the exact event id is known. Relays
 * may suppress an exact-id-deleted replaceable event, so bounded readers cannot
 * otherwise map that unseen event id back to its kind-30406 coordinate.
 */
export function buildShippingOptionDeletionEventDraft(input: {
  merchantPubkey: string
  coordinate: string
  eventId?: string | null
  clientAppId?: ConduitAppId
}): ShippingOptionDeletionEventDraft {
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(merchantPubkey)) {
    throw new Error("Shipping deletion merchant pubkey is invalid")
  }

  const address = parseShippingOptionAddress(input.coordinate)
  if (!address || address.pubkey.toLowerCase() !== merchantPubkey) {
    throw new Error(
      "Shipping deletion requires a same-author kind-30406 coordinate"
    )
  }

  const eventId = input.eventId?.trim().toLowerCase()
  if (input.eventId != null && !/^[0-9a-f]{64}$/.test(eventId ?? "")) {
    throw new Error("Shipping deletion event id is invalid")
  }

  let tags: string[][] = [
    ...(eventId ? [["e", eventId]] : []),
    ["a", getShippingOptionAddress(merchantPubkey, address.dTag)],
    ["k", String(EVENT_KINDS.SHIPPING_OPTION)],
  ]
  if (input.clientAppId) {
    tags = appendConduitClientTag(tags, input.clientAppId)
  }

  return {
    kind: EVENT_KINDS.DELETION,
    content: "",
    tags,
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
  /** Preserve an explicit whole-country include alongside narrower selectors. */
  includeCountry?: boolean
  /** Complete ISO 3166-2 codes included instead of the whole country. */
  includeSubdivisions?: string[]
  /** Complete ISO 3166-2 codes removed from this policy. */
  excludeSubdivisions?: string[]
  /** A versioned policy may explicitly subtract the whole country. */
  excludeCountry?: boolean
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
  /** Versioned destination grammar used by this option, when present. */
  destinationSchema?: string
  /** True when the versioned destination policy is malformed or unknown. */
  destinationPolicyUnsupported?: boolean
  /** Service label (e.g. "standard", "express") */
  service: string
  createdAt: number
  /** Relays that returned or acknowledged this exact option coordinate. */
  sourceRelayUrls?: string[]
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
  | "destination_incomplete"

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

function legacyCountryRules(
  tags: readonly string[][],
  countries: readonly string[]
): ShippingCountryConfig[] {
  return countries.map((code) => ({
    code,
    name: code,
    restrictTo:
      tags
        .find((tag) => tag[0] === "restrict" && tag[1]?.toUpperCase() === code)
        ?.slice(2)
        .filter(Boolean) ?? [],
    exclude:
      tags
        .find((tag) => tag[0] === "exclude" && tag[1]?.toUpperCase() === code)
        ?.slice(2)
        .filter(Boolean) ?? [],
  }))
}

interface ParsedDestinationPolicyResult {
  countryRules: ShippingCountryConfig[]
  destinationSchema?: string
  destinationPolicyUnsupported: boolean
}

function parseDestinationPolicy(
  tags: readonly string[][],
  countries: readonly string[]
): ParsedDestinationPolicyResult {
  const schemaTags = tags.filter((tag) => tag[0] === "destination_schema")
  const destinationTags = tags.filter((tag) => tag[0] === "destination")
  if (schemaTags.length === 0) {
    return {
      countryRules: legacyCountryRules(tags, countries),
      destinationPolicyUnsupported: destinationTags.length > 0,
    }
  }

  const schema = schemaTags[0]?.[1]
  const unsupported = (): ParsedDestinationPolicyResult => ({
    countryRules: legacyCountryRules(tags, countries),
    ...(typeof schema === "string" && schema
      ? { destinationSchema: schema }
      : {}),
    destinationPolicyUnsupported: true,
  })
  if (
    schemaTags.length !== 1 ||
    schemaTags[0]?.length !== 2 ||
    schema !== SHIPPING_DESTINATION_SCHEMA_VERSION
  ) {
    return unsupported()
  }

  const ruleByCountry = new Map<string, ShippingCountryConfig>()
  const includedCountries = new Set<string>()
  const wholeCountryIncludes = new Set<string>()
  let includeCount = 0
  const getRule = (country: string): ShippingCountryConfig => {
    const current = ruleByCountry.get(country)
    if (current) return current
    const created: ShippingCountryConfig = {
      code: country,
      name: country,
      restrictTo: [],
      exclude: [],
      includeSubdivisions: [],
      excludeSubdivisions: [],
    }
    ruleByCountry.set(country, created)
    return created
  }

  for (const tag of destinationTags) {
    const effect = tag[1]
    const selector = tag[2]
    if (effect !== "include" && effect !== "exclude") return unsupported()

    if (selector === "country") {
      const country = tag[3] ?? ""
      if (tag.length !== 4 || !/^[A-Z]{2}$/.test(country)) {
        return unsupported()
      }
      const rule = getRule(country)
      if (effect === "include") {
        includeCount += 1
        includedCountries.add(country)
        wholeCountryIncludes.add(country)
      } else {
        rule.excludeCountry = true
      }
      continue
    }

    if (selector === "subdivision") {
      const subdivision = tag[3] ?? ""
      if (tag.length !== 4 || !SHIPPING_SUBDIVISION_CODE.test(subdivision)) {
        return unsupported()
      }
      const country = subdivision.slice(0, 2)
      if (!normalizeAddressSubdivisionCode(country, subdivision.slice(3))) {
        return unsupported()
      }
      const rule = getRule(country)
      const target =
        effect === "include"
          ? (rule.includeSubdivisions ??= [])
          : (rule.excludeSubdivisions ??= [])
      target.push(subdivision)
      if (effect === "include") {
        includeCount += 1
        includedCountries.add(country)
      }
      continue
    }

    if (selector === "postal") {
      const country = tag[3] ?? ""
      const mode = tag[4]
      const value = tag[5] ?? ""
      if (
        tag.length !== 6 ||
        !/^[A-Z]{2}$/.test(country) ||
        !supportsAddressPostalPolicy(country) ||
        (mode !== "exact" && mode !== "prefix") ||
        !SHIPPING_POSTAL_SELECTOR_VALUE.test(value)
      ) {
        return unsupported()
      }
      const rule = getRule(country)
      const normalized = mode === "prefix" ? `${value}*` : value
      const target = effect === "include" ? rule.restrictTo : rule.exclude
      target.push(normalized)
      if (effect === "include") {
        includeCount += 1
        includedCountries.add(country)
      }
      continue
    }

    return unsupported()
  }

  const summary = [...countries].sort()
  const derivedSummary = Array.from(includedCountries).sort()
  if (
    destinationTags.length === 0 ||
    includeCount === 0 ||
    JSON.stringify(summary) !== JSON.stringify(derivedSummary)
  ) {
    return unsupported()
  }

  const countryRules = Array.from(ruleByCountry.values())
    .filter((rule) => includedCountries.has(rule.code))
    .map((rule) => {
      const restrictTo = Array.from(new Set(rule.restrictTo)).sort()
      const includeSubdivisions = Array.from(
        new Set(rule.includeSubdivisions ?? [])
      ).sort()
      const includeCountry =
        wholeCountryIncludes.has(rule.code) &&
        (includeSubdivisions.length > 0 || restrictTo.length > 0)
      return {
        ...rule,
        restrictTo,
        exclude: Array.from(new Set(rule.exclude)).sort(),
        ...(includeCountry ? { includeCountry: true } : {}),
        includeSubdivisions,
        excludeSubdivisions: Array.from(
          new Set(rule.excludeSubdivisions ?? [])
        ).sort(),
      }
    })
    .sort((left, right) => left.code.localeCompare(right.code))

  return {
    countryRules,
    destinationSchema: SHIPPING_DESTINATION_SCHEMA_VERSION,
    destinationPolicyUnsupported: false,
  }
}

export function parseShippingOptionEvent(
  event: Pick<NDKEvent, "id" | "pubkey" | "tags" | "created_at">
): ParsedShippingOption | null {
  const tags = event.tags ?? []

  const getUniqueTag = (name: string): string[] | null => {
    const matches = tags.filter((tag) => tag[0] === name)
    return matches.length === 1 ? matches[0]! : null
  }

  const dTagEntry = getUniqueTag("d")
  const titleTag = getUniqueTag("title")
  const priceTag = getUniqueTag("price")
  const serviceTag = getUniqueTag("service")
  const clientTags = tags.filter((tag) => tag[0] === "client")
  if (
    dTagEntry?.length !== 2 ||
    titleTag?.length !== 2 ||
    priceTag?.length !== 3 ||
    serviceTag?.length !== 2 ||
    clientTags.length > 1 ||
    clientTags.some(
      (tag) => tag.length !== 4 || tag.slice(1).some((value) => !value.trim())
    )
  ) {
    return null
  }

  const dTag = dTagEntry[1] ?? ""
  const title = titleTag[1]?.trim() ?? ""
  const serviceValue = serviceTag[1] ?? ""
  const service = serviceValue.toLowerCase()
  if (dTag !== dTag.trim() || serviceValue !== serviceValue.trim()) return null

  // ["price", amount, currency]
  const priceAmount = priceTag[1] ?? ""
  const priceCurrency = priceTag[2] ?? ""
  if (!FIXED_STANDARD_PRICE_AMOUNT.test(priceAmount)) return null
  if (!priceCurrency || priceCurrency !== priceCurrency.trim()) return null
  const price = Number(priceAmount)
  const currency = normalizeCurrencyCode(priceCurrency)
  if (
    !Number.isFinite(price) ||
    price < 0 ||
    (price === 0 && /[1-9]/.test(priceAmount)) ||
    !currency
  ) {
    return null
  }
  const normalizedPrice = normalizeCurrencyAmount(price, currency)
  if (
    normalizedPrice.status === "invalid" ||
    normalizedPrice.amount !== price
  ) {
    return null
  }

  // ["country", code1, code2, ...] or repeated ["country", code]
  const countryTags = tags.filter((tag) => tag[0] === "country")
  const countryValues = countryTags.flatMap((tag) => tag.slice(1))
  if (
    countryTags.length === 0 ||
    countryTags.some((tag) => tag.length < 2) ||
    countryValues.some((country) => !/^[A-Za-z]{2}$/.test(country))
  ) {
    return null
  }
  const countries = Array.from(
    new Set(countryValues.map((country) => country.toUpperCase()))
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

  const destinationPolicy = parseDestinationPolicy(tags, countries)

  return {
    eventId: event.id,
    id: getShippingOptionAddress(event.pubkey, dTag),
    pubkey: event.pubkey,
    dTag,
    title,
    currency,
    price: normalizedPrice.amount,
    countries,
    countryRules: destinationPolicy.countryRules,
    destinationSchema: destinationPolicy.destinationSchema,
    destinationPolicyUnsupported:
      destinationPolicy.destinationPolicyUnsupported,
    service,
    createdAt: (event.created_at ?? 0) * 1000,
    ...(getEventSourceRelayUrls(event as NDKEvent).length > 0
      ? { sourceRelayUrls: getEventSourceRelayUrls(event as NDKEvent) }
      : {}),
    launchUnsupportedTags: Array.from(
      new Set(
        tags
          .map((tag) => tag[0] ?? "")
          .filter((name) => !FIXED_STANDARD_SUPPORTED_TAGS.has(name))
      )
    ).sort(),
  }
}

// ---------------------------------------------------------------------------
// Durable deletion evidence
// ---------------------------------------------------------------------------

function shippingNow(): number {
  return shippingTestOverrides.now?.() ?? Date.now()
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function shippingTombstoneIdForAddress(addressId: string): string {
  return `${SHIPPING_TOMBSTONE_PREFIX}a:${addressId}`
}

function shippingTombstoneIdForEvent(pubkey: string, eventId: string): string {
  return `${SHIPPING_TOMBSTONE_PREFIX}e:${pubkey}:${eventId}`
}

function cloneSignedEvent(
  event: SignedPublicNostrEvent
): SignedPublicNostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
}

function getShippingEventCoordinate(
  event: Pick<SignedPublicNostrEvent, "pubkey" | "tags">
): { coordinate: string; pubkey: string; dTag: string } | null {
  const pubkey = event.pubkey.toLowerCase()
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]?.trim()
  if (!dTag) return null
  return {
    coordinate: getShippingOptionAddress(pubkey, dTag),
    pubkey,
    dTag,
  }
}

function validateCachedShippingOptionFrontier(
  row: CachedShippingOptionFrontier
): SignedPublicNostrEvent[] {
  const address = parseShippingOptionAddress(row.coordinate)
  if (
    !address ||
    row.pubkey !== address.pubkey ||
    row.dTag !== address.dTag ||
    !Number.isSafeInteger(row.strongestCreatedAt) ||
    row.strongestCreatedAt < 0 ||
    row.signedEvents.length === 0
  ) {
    throw new Error("Invalid cached fixed shipping option frontier")
  }

  const validated = new Map<string, SignedPublicNostrEvent>()
  for (const event of row.signedEvents) {
    const eventAddress = getShippingEventCoordinate(event)
    if (
      event.kind !== EVENT_KINDS.SHIPPING_OPTION ||
      !isValidSignedPublicNostrEvent(event) ||
      eventAddress?.coordinate !== row.coordinate ||
      event.created_at !== row.strongestCreatedAt
    ) {
      throw new Error("Invalid cached fixed shipping option frontier")
    }
    validated.set(event.id, cloneSignedEvent(event))
  }

  return Array.from(validated.values()).sort((a, b) => a.id.localeCompare(b.id))
}

function observedShippingOptionEvents(
  events: readonly NDKEvent[],
  coordinates: ReadonlySet<string>
): SignedPublicNostrEvent[] {
  const observed = new Map<string, SignedPublicNostrEvent>()
  for (const event of events) {
    const rawEvent = event.rawEvent() as SignedPublicNostrEvent
    const address = getShippingEventCoordinate(rawEvent)
    if (
      rawEvent.kind !== EVENT_KINDS.SHIPPING_OPTION ||
      !isValidSignedPublicNostrEvent(rawEvent) ||
      !address ||
      !coordinates.has(address.coordinate)
    ) {
      continue
    }
    observed.set(rawEvent.id, cloneSignedEvent(rawEvent))
  }
  return Array.from(observed.values())
}

function observedShippingOptionSourceRelayUrls(
  events: readonly NDKEvent[],
  coordinates: ReadonlySet<string>
): Map<string, string[]> {
  const sources = new Map<string, string[]>()
  for (const event of events) {
    const rawEvent = event.rawEvent() as SignedPublicNostrEvent
    const address = getShippingEventCoordinate(rawEvent)
    if (
      rawEvent.kind !== EVENT_KINDS.SHIPPING_OPTION ||
      !isValidSignedPublicNostrEvent(rawEvent) ||
      !address ||
      !coordinates.has(address.coordinate)
    ) {
      continue
    }
    sources.set(
      address.coordinate,
      uniqueStrings([
        ...(sources.get(address.coordinate) ?? []),
        ...getEventSourceRelayUrls(event),
      ])
    )
  }
  return sources
}

function selectShippingOptionFrontierUpdates(
  coordinates: readonly string[],
  observedEvents: readonly SignedPublicNostrEvent[],
  existingRows: readonly CachedShippingOptionFrontier[],
  observedSourceRelayUrls: ReadonlyMap<string, readonly string[]> = new Map(),
  acknowledgedAuthorWriteRelayUrls: ReadonlyMap<
    string,
    readonly string[]
  > = new Map()
): {
  selectedRows: CachedShippingOptionFrontier[]
  updatedRows: CachedShippingOptionFrontier[]
} {
  const existingByCoordinate = new Map(
    existingRows.map((row) => [row.coordinate, row] as const)
  )
  const observedByCoordinate = new Map<string, SignedPublicNostrEvent[]>()
  for (const event of observedEvents) {
    const address = getShippingEventCoordinate(event)
    if (!address) continue
    const current = observedByCoordinate.get(address.coordinate) ?? []
    current.push(event)
    observedByCoordinate.set(address.coordinate, current)
  }

  const selectedRows: CachedShippingOptionFrontier[] = []
  const updatedRows: CachedShippingOptionFrontier[] = []
  for (const coordinate of uniqueStrings(coordinates)) {
    const existing = existingByCoordinate.get(coordinate)
    const existingEvents = existing
      ? validateCachedShippingOptionFrontier(existing)
      : []
    const candidates = [
      ...existingEvents,
      ...(observedByCoordinate.get(coordinate) ?? []),
    ]
    if (candidates.length === 0) continue

    const strongestCreatedAt = Math.max(
      ...candidates.map((event) => event.created_at)
    )
    const strongestEvents = Array.from(
      new Map(
        candidates
          .filter((event) => event.created_at === strongestCreatedAt)
          .map((event) => [event.id, cloneSignedEvent(event)] as const)
      ).values()
    )
      .sort((a, b) => a.id.localeCompare(b.id))
      // One signed event proves the revision; two prove ambiguity. Retaining
      // more equal-timestamp conflicts cannot make payment safer and would
      // let rotating relay subsets grow one IndexedDB row without bound.
      .slice(0, SHIPPING_OPTION_FRONTIER_CONFLICT_LIMIT)
    const address = getShippingEventCoordinate(strongestEvents[0]!)!
    const existingIds = existingEvents.map((event) => event.id).sort()
    const strongestIds = strongestEvents.map((event) => event.id)
    const sourceRelayUrls = uniqueStrings([
      ...(existing?.sourceRelayUrls ?? []),
      ...(observedSourceRelayUrls.get(coordinate) ?? []),
    ])
    const authorWriteRelayUrls = uniqueStrings([
      ...(existing?.authorWriteRelayUrls ?? []),
      ...(acknowledgedAuthorWriteRelayUrls.get(coordinate) ?? []),
    ])
    const changed =
      !existing ||
      existing.strongestCreatedAt !== strongestCreatedAt ||
      existingIds.length !== strongestIds.length ||
      existingIds.some((id, index) => id !== strongestIds[index]) ||
      sourceRelayUrls.length !== (existing.sourceRelayUrls?.length ?? 0) ||
      authorWriteRelayUrls.length !==
        (existing.authorWriteRelayUrls?.length ?? 0)
    const selected = changed
      ? {
          coordinate,
          pubkey: address.pubkey,
          dTag: address.dTag,
          strongestCreatedAt,
          signedEvents: strongestEvents,
          ...(sourceRelayUrls.length > 0 ? { sourceRelayUrls } : {}),
          ...(authorWriteRelayUrls.length > 0 ? { authorWriteRelayUrls } : {}),
          cachedAt: shippingNow(),
        }
      : existing
    selectedRows.push(selected)
    if (changed) updatedRows.push(selected)
  }

  return { selectedRows, updatedRows }
}

function signedEventsFromShippingOptionFrontiers(
  rows: readonly CachedShippingOptionFrontier[]
): SignedPublicNostrEvent[] {
  return rows.flatMap(validateCachedShippingOptionFrontier)
}

function sourceRelayUrlsFromShippingOptionFrontiers(
  rows: readonly CachedShippingOptionFrontier[]
): Map<string, string[]> {
  return new Map(
    rows.map((row) => [
      row.coordinate,
      uniqueStrings(row.sourceRelayUrls ?? []),
    ])
  )
}

function authorWriteRelayUrlsFromShippingOptionFrontiers(
  rows: readonly CachedShippingOptionFrontier[]
): Map<string, string[]> {
  return new Map(
    rows.map((row) => [
      row.coordinate,
      uniqueStrings(row.authorWriteRelayUrls ?? []),
    ])
  )
}

function getVolatileShippingOptionFrontiers(
  coordinates: readonly string[]
): CachedShippingOptionFrontier[] {
  return uniqueStrings(coordinates).flatMap((coordinate) => {
    const row = volatileShippingOptionFrontiers.get(coordinate)
    return row ? [row] : []
  })
}

function rememberVolatileShippingOptionFrontiers(
  coordinates: readonly string[],
  observedEvents: readonly SignedPublicNostrEvent[],
  observedSourceRelayUrls: ReadonlyMap<string, readonly string[]>,
  acknowledgedAuthorWriteRelayUrls: ReadonlyMap<
    string,
    readonly string[]
  > = new Map()
): CachedShippingOptionFrontier[] {
  const existing = getVolatileShippingOptionFrontiers(coordinates)
  const selected = selectShippingOptionFrontierUpdates(
    coordinates,
    observedEvents,
    existing,
    observedSourceRelayUrls,
    acknowledgedAuthorWriteRelayUrls
  )
  for (const row of selected.updatedRows) {
    volatileShippingOptionFrontiers.set(row.coordinate, row)
  }
  return selected.selectedRows
}

async function mergeObservedShippingOptionFrontiers(
  coordinates: readonly string[],
  observedEvents: readonly NDKEvent[],
  acknowledgedAuthorWriteRelayUrls: ReadonlyMap<
    string,
    readonly string[]
  > = new Map()
): Promise<{
  shippingEvents: NDKEvent[]
  retainedEventIds: string[]
}> {
  const requested = new Set(coordinates)
  const observed = observedShippingOptionEvents(observedEvents, requested)
  const observedSourceRelayUrls = observedShippingOptionSourceRelayUrls(
    observedEvents,
    requested
  )
  let selectedRows: CachedShippingOptionFrontier[]

  try {
    // Record signed positive evidence before touching durable storage. A
    // transient write failure must not let a later relay omission roll the
    // same runtime back to an older replaceable event.
    const volatileRows = rememberVolatileShippingOptionFrontiers(
      coordinates,
      observed,
      observedSourceRelayUrls,
      acknowledgedAuthorWriteRelayUrls
    )
    const volatileEvents = signedEventsFromShippingOptionFrontiers(volatileRows)
    const volatileSourceRelayUrls =
      sourceRelayUrlsFromShippingOptionFrontiers(volatileRows)
    const volatileAuthorWriteRelayUrls =
      authorWriteRelayUrlsFromShippingOptionFrontiers(volatileRows)
    const usesOverrides =
      shippingTestOverrides.getCachedOptionFrontiers !== undefined ||
      shippingTestOverrides.putCachedOptionFrontiers !== undefined
    if (usesOverrides) {
      if (
        !shippingTestOverrides.getCachedOptionFrontiers ||
        !shippingTestOverrides.putCachedOptionFrontiers
      ) {
        throw new Error("Incomplete fixed shipping option cache override")
      }
      const existing =
        await shippingTestOverrides.getCachedOptionFrontiers(coordinates)
      const selected = selectShippingOptionFrontierUpdates(
        coordinates,
        volatileEvents,
        existing,
        volatileSourceRelayUrls,
        volatileAuthorWriteRelayUrls
      )
      if (selected.updatedRows.length > 0) {
        await shippingTestOverrides.putCachedOptionFrontiers(
          selected.updatedRows
        )
      }
      selectedRows = selected.selectedRows
    } else {
      selectedRows = await db.transaction(
        "rw",
        db.shippingOptionFrontiers,
        async () => {
          const existing = (
            await db.shippingOptionFrontiers.bulkGet([...coordinates])
          ).filter(
            (row): row is CachedShippingOptionFrontier => row !== undefined
          )
          const selected = selectShippingOptionFrontierUpdates(
            coordinates,
            volatileEvents,
            existing,
            volatileSourceRelayUrls,
            volatileAuthorWriteRelayUrls
          )
          if (selected.updatedRows.length > 0) {
            await db.shippingOptionFrontiers.bulkPut(selected.updatedRows)
          }
          return selected.selectedRows
        }
      )
    }
  } catch {
    throw new Error("Fixed shipping option evidence could not be verified")
  }

  // Keep the monotonic runtime frontier for the page lifetime. Another
  // overlapping call can observe a stronger event while this call awaits
  // IndexedDB; merge that current authority synchronously before gating so
  // this call cannot return the older event.
  selectedRows = selectShippingOptionFrontierUpdates(
    coordinates,
    signedEventsFromShippingOptionFrontiers(
      getVolatileShippingOptionFrontiers(coordinates)
    ),
    selectedRows,
    sourceRelayUrlsFromShippingOptionFrontiers(
      getVolatileShippingOptionFrontiers(coordinates)
    ),
    authorWriteRelayUrlsFromShippingOptionFrontiers(
      getVolatileShippingOptionFrontiers(coordinates)
    )
  ).selectedRows

  const liveRows = selectShippingOptionFrontierUpdates(
    coordinates,
    observed,
    [],
    observedSourceRelayUrls
  ).selectedRows
  const liveByCoordinate = new Map(
    liveRows.map((row) => [row.coordinate, row] as const)
  )
  const retainedEventIds = uniqueStrings(
    signedEventsFromShippingOptionFrontiers(selectedRows).map(
      (event) => event.id
    )
  )

  const shippingEvents = selectedRows.flatMap((row) => {
    const live = liveByCoordinate.get(row.coordinate)
    if (!live || live.strongestCreatedAt !== row.strongestCreatedAt) return []
    const retainedEvents = validateCachedShippingOptionFrontier(row)
    const retainedIds = retainedEvents.map((event) => event.id).sort()
    const liveEvents = validateCachedShippingOptionFrontier(live)
    const liveIds = liveEvents.map((event) => event.id).sort()
    if (
      retainedIds.length !== liveIds.length ||
      retainedIds.some((id, index) => id !== liveIds[index])
    ) {
      return []
    }
    // The retained frontier is only an authority gate. Pricing always comes
    // from the complete, currently verified relay observation.
    return liveEvents.map((event) => {
      const ndkEvent = new NDKEvent(undefined, event)
      for (const relayUrl of row.sourceRelayUrls ?? []) {
        attachEventSourceRelayUrl(ndkEvent, relayUrl)
      }
      return ndkEvent
    })
  })

  return { shippingEvents, retainedEventIds }
}

/**
 * Retain a signed option and the relays that acknowledged it before the
 * referencing product is published. Withdrawal delivery later reuses this
 * per-coordinate provenance even if the merchant's relay list changes.
 */
export async function cacheSignedShippingOptionEvent(
  event: NDKEvent,
  sourceRelayUrls: readonly string[]
): Promise<void> {
  const rawEvent = event.rawEvent() as SignedPublicNostrEvent
  const address = getShippingEventCoordinate(rawEvent)
  if (
    rawEvent.kind !== EVENT_KINDS.SHIPPING_OPTION ||
    !isValidSignedPublicNostrEvent(rawEvent) ||
    !address
  ) {
    throw new Error("Expected a valid signed fixed shipping option")
  }
  if (sourceRelayUrls.length === 0) {
    throw new Error("Fixed shipping option relay provenance is required")
  }

  const observed = new NDKEvent(undefined, cloneSignedEvent(rawEvent))
  for (const relayUrl of uniqueStrings(sourceRelayUrls)) {
    attachEventSourceRelayUrl(observed, relayUrl)
  }
  const merged = await mergeObservedShippingOptionFrontiers(
    [address.coordinate],
    [observed],
    new Map([[address.coordinate, uniqueStrings(sourceRelayUrls)]])
  )
  if (!merged.retainedEventIds.includes(rawEvent.id)) {
    throw new Error("Fixed shipping option evidence could not be retained")
  }
}

/**
 * Read only validated relay provenance for deletion routing. This deliberately
 * does not expose retained option content for pricing or eligibility when the
 * current relay plan no longer observes the exact signed event.
 */
async function getCachedShippingOptionRelayUrls(
  coordinates: readonly string[],
  field: "sourceRelayUrls" | "authorWriteRelayUrls",
  failureMessage: string
): Promise<Map<string, string[]>> {
  const requested = new Set(
    uniqueStrings(coordinates).flatMap((coordinate) => {
      const parsed = parseShippingOptionAddress(coordinate)
      return parsed?.coordinate === coordinate ? [coordinate] : []
    })
  )
  if (requested.size === 0) return new Map()

  try {
    const requestedCoordinates = Array.from(requested)
    const durableRows = shippingTestOverrides.getCachedOptionFrontiers
      ? await shippingTestOverrides.getCachedOptionFrontiers(
          requestedCoordinates
        )
      : (await db.shippingOptionFrontiers.bulkGet(requestedCoordinates)).filter(
          (row): row is CachedShippingOptionFrontier => row !== undefined
        )
    const relayUrls = new Map<string, string[]>()
    for (const row of [
      ...durableRows,
      ...getVolatileShippingOptionFrontiers(requestedCoordinates),
    ]) {
      if (!requested.has(row.coordinate)) continue
      validateCachedShippingOptionFrontier(row)
      relayUrls.set(
        row.coordinate,
        uniqueStrings([
          ...(relayUrls.get(row.coordinate) ?? []),
          ...(row[field] ?? []),
        ])
      )
    }
    return relayUrls
  } catch {
    throw new Error(failureMessage)
  }
}

export async function getCachedShippingOptionSourceRelayUrls(
  coordinates: readonly string[]
): Promise<Map<string, string[]>> {
  return await getCachedShippingOptionRelayUrls(
    coordinates,
    "sourceRelayUrls",
    "Fixed shipping option relay provenance could not be read"
  )
}

/**
 * Read only relay targets that positively acknowledged a locally authored
 * option write. Unlike observed source provenance, these targets may answer a
 * NIP-42 challenge through the current external signer during withdrawal.
 */
export async function getCachedShippingOptionAuthorWriteRelayUrls(
  coordinates: readonly string[]
): Promise<Map<string, string[]>> {
  return await getCachedShippingOptionRelayUrls(
    coordinates,
    "authorWriteRelayUrls",
    "Fixed shipping option author-write provenance could not be read"
  )
}

function shippingTombstonesFromDeletionEvent(
  event: NDKEvent
): CachedProductTombstone[] {
  const rawEvent = event.rawEvent() as SignedPublicNostrEvent
  if (
    event.kind !== EVENT_KINDS.DELETION ||
    !isValidSignedPublicNostrEvent(rawEvent)
  ) {
    throw new Error("Expected a valid signed shipping deletion event")
  }

  const signedEvent = cloneSignedEvent(rawEvent)
  const pubkey = signedEvent.pubkey.toLowerCase()
  const deletionEventId = signedEvent.id.toLowerCase()
  const sourceRelayUrls = getEventSourceRelayUrls(event)
  const cachedAt = shippingNow()
  const rows = new Map<string, CachedProductTombstone>()

  for (const [tagName, tagValue] of signedEvent.tags) {
    if (tagName === "e" && tagValue && HEX_64.test(tagValue)) {
      const eventId = tagValue.toLowerCase()
      const id = shippingTombstoneIdForEvent(pubkey, eventId)
      rows.set(id, {
        id,
        pubkey,
        eventId,
        deletedAt: signedEvent.created_at,
        deletionEventId,
        signedEvent,
        sourceRelayUrls,
        observedLocally: false,
        cachedAt,
      })
      continue
    }

    if (tagName === "a") {
      const address = parseShippingOptionAddress(tagValue)
      if (!address || address.pubkey !== pubkey) continue
      const id = shippingTombstoneIdForAddress(address.coordinate)
      rows.set(id, {
        id,
        pubkey,
        addressId: address.coordinate,
        deletedAt: signedEvent.created_at,
        deletionEventId,
        signedEvent,
        sourceRelayUrls,
        observedLocally: false,
        cachedAt,
      })
    }
  }

  return Array.from(rows.values())
}

function getShippingDeletionFallbackStorage(): ShippingDeletionFallbackStorage | null {
  if (shippingTestOverrides.deletionFallbackStorage !== undefined) {
    return shippingTestOverrides.deletionFallbackStorage
  }
  if (typeof window === "undefined") return null
  return window.localStorage
}

function parseShippingDeletionFallbackEvent(
  value: unknown,
  expectedEventId?: string
): SignedPublicNostrEvent {
  const event = value as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.kind !== EVENT_KINDS.DELETION ||
    (expectedEventId !== undefined && event.id !== expectedEventId)
  ) {
    throw new Error("Invalid fixed shipping deletion fallback")
  }
  const cloned = cloneSignedEvent(event)
  if (
    shippingTombstonesFromDeletionEvent(new NDKEvent(undefined, cloned))
      .length === 0
  ) {
    throw new Error("Invalid fixed shipping deletion fallback")
  }
  return cloned
}

function parseShippingDeletionFallbackJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error("Invalid fixed shipping deletion fallback")
  }
}

function snapshotShippingDeletionFallbackKeys(
  storage: ShippingDeletionFallbackStorage
): string[] {
  const expectedLength = storage.length
  const keys: string[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const key = storage.key(index)
    if (key === null) {
      throw new Error("Fixed shipping deletion fallback changed during read")
    }
    keys.push(key)
  }
  if (storage.length !== expectedLength) {
    throw new Error("Fixed shipping deletion fallback changed during read")
  }
  return keys.sort()
}

function loadShippingDeletionFallback(): {
  events: SignedPublicNostrEvent[]
  pendingKeys: string[]
} {
  const storage = getShippingDeletionFallbackStorage()
  if (!storage) return { events: [], pendingKeys: [] }

  const firstKeySnapshot = snapshotShippingDeletionFallbackKeys(storage)
  const secondKeySnapshot = snapshotShippingDeletionFallbackKeys(storage)
  if (
    firstKeySnapshot.length !== secondKeySnapshot.length ||
    firstKeySnapshot.some((key, index) => key !== secondKeySnapshot[index])
  ) {
    throw new Error("Fixed shipping deletion fallback changed during read")
  }

  const eventKeys: string[] = []
  const pendingKeys: string[] = []
  for (const key of secondKeySnapshot) {
    if (key.startsWith(SHIPPING_TOMBSTONE_FALLBACK_EVENT_PREFIX)) {
      eventKeys.push(key)
    } else if (key.startsWith(SHIPPING_TOMBSTONE_FALLBACK_PENDING_PREFIX)) {
      pendingKeys.push(key)
    }
  }

  const events = new Map<string, SignedPublicNostrEvent>()
  for (const key of uniqueStrings(eventKeys)) {
    const raw = storage.getItem(key)
    // A concurrent writer may replace a pending snapshot with per-event keys,
    // or a migrator may remove a covered key. Never authorize from a torn
    // enumeration; a later read can retry against the stable journal/DB state.
    if (raw === null) {
      throw new Error("Fixed shipping deletion fallback changed during read")
    }
    const eventId = key.slice(SHIPPING_TOMBSTONE_FALLBACK_EVENT_PREFIX.length)
    if (!HEX_64.test(eventId)) {
      throw new Error("Invalid fixed shipping deletion fallback")
    }
    const event = parseShippingDeletionFallbackEvent(
      parseShippingDeletionFallbackJson(raw),
      eventId
    )
    events.set(event.id, event)
  }

  for (const key of uniqueStrings(pendingKeys)) {
    const raw = storage.getItem(key)
    if (raw === null) {
      throw new Error("Fixed shipping deletion fallback changed during read")
    }
    const parsed = parseShippingDeletionFallbackJson(raw) as {
      version?: unknown
      events?: unknown
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.events) ||
      parsed.events.length === 0
    ) {
      throw new Error("Invalid fixed shipping deletion fallback")
    }
    for (const candidate of parsed.events) {
      const event = parseShippingDeletionFallbackEvent(candidate)
      events.set(event.id, event)
    }
  }

  return {
    events: Array.from(events.values()).sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    pendingKeys: uniqueStrings(pendingKeys),
  }
}

function createShippingDeletionFallbackPendingKey(): string {
  shippingFallbackBatchSequence += 1
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${shippingNow()}-${shippingFallbackBatchSequence}-${Math.random().toString(36).slice(2)}`
  return `${SHIPPING_TOMBSTONE_FALLBACK_PENDING_PREFIX}${random}`
}

function storeShippingDeletionFallback(
  rows: readonly CachedProductTombstone[]
): void {
  const storage = getShippingDeletionFallbackStorage()
  if (!storage) {
    throw new Error("Fixed shipping deletion fallback is unavailable")
  }

  const events = signedDeletionEventsFromShippingTombstones(rows)
  const expectedEventIds = uniqueStrings(rows.map((row) => row.deletionEventId))
  if (
    events.length !== expectedEventIds.length ||
    events.some((event) => !expectedEventIds.includes(event.id))
  ) {
    throw new Error("Invalid fixed shipping deletion fallback")
  }

  // The snapshot is one atomic localStorage write containing the complete
  // batch. If any later per-event write fails, a fresh runtime can still
  // recover every signed withdrawal instead of seeing a partial journal.
  const pendingKey = createShippingDeletionFallbackPendingKey()
  storage.setItem(
    pendingKey,
    JSON.stringify({
      version: 1,
      events: events.map(cloneSignedEvent),
    })
  )
  for (const event of events) {
    storage.setItem(
      `${SHIPPING_TOMBSTONE_FALLBACK_EVENT_PREFIX}${event.id}`,
      JSON.stringify(cloneSignedEvent(event))
    )
  }
  storage.removeItem(pendingKey)
}

function removeShippingDeletionFallback(
  eventIds: readonly string[],
  pendingKeys: readonly string[] = []
): void {
  const storage = getShippingDeletionFallbackStorage()
  if (!storage) return
  for (const eventId of uniqueStrings(eventIds)) {
    storage.removeItem(`${SHIPPING_TOMBSTONE_FALLBACK_EVENT_PREFIX}${eventId}`)
  }
  for (const key of uniqueStrings(pendingKeys)) {
    if (!key.startsWith(SHIPPING_TOMBSTONE_FALLBACK_PENDING_PREFIX)) {
      throw new Error("Invalid fixed shipping deletion fallback key")
    }
    storage.removeItem(key)
  }
}

function selectShippingTombstoneUpdates(
  rows: readonly CachedProductTombstone[],
  existingRows: readonly CachedProductTombstone[]
): CachedProductTombstone[] {
  const selected = new Map(existingRows.map((row) => [row.id, row] as const))
  const changed = new Map<string, CachedProductTombstone>()

  for (const row of rows) {
    const existing = selected.get(row.id)
    if (!existing) {
      selected.set(row.id, row)
      changed.set(row.id, row)
      continue
    }

    const candidateWins =
      row.deletedAt > existing.deletedAt ||
      (row.deletedAt === existing.deletedAt &&
        row.deletionEventId <= existing.deletionEventId)
    const winner = candidateWins ? row : existing
    const sourceRelayUrls = uniqueStrings([
      ...(existing.sourceRelayUrls ?? []),
      ...(row.sourceRelayUrls ?? []),
    ])
    const merged: CachedProductTombstone = {
      ...winner,
      sourceRelayUrls,
      observedLocally:
        existing.observedLocally === true || row.observedLocally === true,
      cachedAt: Math.max(existing.cachedAt, row.cachedAt),
    }
    if (
      candidateWins ||
      sourceRelayUrls.length !== (existing.sourceRelayUrls?.length ?? 0) ||
      merged.observedLocally !== existing.observedLocally
    ) {
      selected.set(row.id, merged)
      changed.set(row.id, merged)
    }
  }

  return Array.from(changed.values())
}

async function loadCachedShippingTombstones(
  targetIds: readonly string[]
): Promise<CachedProductTombstone[]> {
  // Read and validate the independent journal before consulting IndexedDB. A
  // prior tab may have observed a withdrawal while the primary write path was
  // transiently unavailable.
  const fallback = loadShippingDeletionFallback()
  const fallbackEvents = fallback.events
  const fallbackRows = fallbackEvents.flatMap((event) =>
    shippingTombstonesFromDeletionEvent(new NDKEvent(undefined, event))
  )
  if (fallbackRows.length > 0) {
    try {
      await persistPrimaryShippingTombstones(fallbackRows)
      removeShippingDeletionFallback(
        fallbackEvents.map((event) => event.id),
        fallback.pendingKeys
      )
    } catch {
      // The validated fallback remains restart-durable and participates in the
      // current authorization decision until the primary cache recovers.
    }
  }

  const persistedRows = await loadPrimaryShippingTombstones(targetIds)
  return selectShippingTombstoneUpdates(
    [
      ...persistedRows.filter(isValidCachedShippingTombstone),
      ...fallbackRows.filter((row) => targetIds.includes(row.id)),
    ],
    []
  )
}

async function loadPrimaryShippingTombstones(
  targetIds: readonly string[]
): Promise<CachedProductTombstone[]> {
  const rows = shippingTestOverrides.getCachedDeletionTombstones
    ? await shippingTestOverrides.getCachedDeletionTombstones(targetIds)
    : (await db.productTombstones.bulkGet([...targetIds])).filter(
        (row): row is CachedProductTombstone => row !== undefined
      )
  return rows.filter((row) => row.id.startsWith(SHIPPING_TOMBSTONE_PREFIX))
}

function isValidCachedShippingTombstone(row: CachedProductTombstone): boolean {
  if (!row.signedEvent || !isValidSignedPublicNostrEvent(row.signedEvent)) {
    return false
  }
  try {
    return shippingTombstonesFromDeletionEvent(
      new NDKEvent(undefined, row.signedEvent)
    ).some(
      (derived) =>
        derived.id === row.id &&
        derived.pubkey === row.pubkey &&
        derived.deletedAt === row.deletedAt &&
        derived.deletionEventId === row.deletionEventId
    )
  } catch {
    return false
  }
}

function primaryShippingTombstoneCovers(
  expected: CachedProductTombstone,
  persisted: CachedProductTombstone
): boolean {
  if (
    expected.id !== persisted.id ||
    expected.pubkey !== persisted.pubkey ||
    !isValidCachedShippingTombstone(persisted)
  ) {
    return false
  }
  return expected.addressId
    ? persisted.addressId === expected.addressId &&
        persisted.deletedAt >= expected.deletedAt
    : persisted.eventId === expected.eventId
}

async function persistPrimaryShippingTombstones(
  rows: CachedProductTombstone[]
): Promise<void> {
  const events = signedDeletionEventsFromShippingTombstones(rows)
  const expectedEventIds = uniqueStrings(rows.map((row) => row.deletionEventId))
  if (
    events.length !== expectedEventIds.length ||
    events.some((event) => !expectedEventIds.includes(event.id))
  ) {
    throw new Error("Invalid fixed shipping deletion evidence")
  }
  // A journal key owns the complete signed event, not only the target that
  // happened to be queried. Persist every valid shipping target before that
  // key can be removed so a multi-target withdrawal cannot be partially lost.
  const rowsToPersist = selectShippingTombstoneUpdates(
    [
      ...events.flatMap((event) =>
        shippingTombstonesFromDeletionEvent(new NDKEvent(undefined, event))
      ),
      ...rows,
    ],
    []
  )
  await storeCachedShippingTombstones(rowsToPersist)
  const persistedRows = await loadPrimaryShippingTombstones(
    uniqueStrings(rowsToPersist.map((row) => row.id))
  )
  if (
    rowsToPersist.some(
      (expected) =>
        !persistedRows.some((persisted) =>
          primaryShippingTombstoneCovers(expected, persisted)
        )
    )
  ) {
    throw new Error("Fixed shipping deletion evidence was not retained")
  }
}

async function storeCachedShippingTombstones(
  rows: CachedProductTombstone[]
): Promise<void> {
  if (rows.length === 0) return
  if (shippingTestOverrides.putCachedDeletionTombstones) {
    const ids = uniqueStrings(rows.map((row) => row.id))
    const existingRows = shippingTestOverrides.getCachedDeletionTombstones
      ? await shippingTestOverrides.getCachedDeletionTombstones(ids)
      : []
    const rowsToStore = selectShippingTombstoneUpdates(
      rows,
      existingRows.filter(isValidCachedShippingTombstone)
    )
    if (rowsToStore.length > 0) {
      await shippingTestOverrides.putCachedDeletionTombstones(rowsToStore)
    }
    return
  }

  const ids = uniqueStrings(rows.map((row) => row.id))
  await db.transaction("rw", db.productTombstones, async () => {
    const existingRows = (await db.productTombstones.bulkGet(ids)).filter(
      (row): row is CachedProductTombstone => row !== undefined
    )
    const rowsToStore = selectShippingTombstoneUpdates(
      rows,
      existingRows.filter(isValidCachedShippingTombstone)
    )
    if (rowsToStore.length > 0) {
      await db.productTombstones.bulkPut(rowsToStore)
    }
  })
}

function rememberVolatileShippingTombstones(
  rows: readonly CachedProductTombstone[]
): void {
  const updates = selectShippingTombstoneUpdates(
    rows,
    Array.from(volatileShippingDeletionTombstones.values())
  )
  for (const row of updates) {
    volatileShippingDeletionTombstones.set(row.id, row)
  }
}

async function flushVolatileShippingTombstones(): Promise<boolean> {
  const pendingRows = Array.from(volatileShippingDeletionTombstones.values())
  if (pendingRows.length === 0) return true
  let fallbackStored = false
  try {
    // This must happen before the first async IndexedDB operation. A tab can
    // close or another tab can read while IndexedDB is stalled, so the exact
    // signed withdrawal needs an independent write-ahead record first.
    storeShippingDeletionFallback(pendingRows)
    fallbackStored = true
  } catch {
    // IndexedDB may still retain and verify the evidence below.
  }
  let primaryStored = false
  try {
    await persistPrimaryShippingTombstones(pendingRows)
    primaryStored = true
  } catch {
    // The write-ahead journal remains authoritative until primary storage
    // recovers. If neither store retained the evidence, fail closed below.
  }
  if (!fallbackStored && !primaryStored) return false
  if (primaryStored && fallbackStored) {
    try {
      removeShippingDeletionFallback(
        pendingRows.map((row) => row.deletionEventId)
      )
    } catch {
      // The primary cache already retained exact signed evidence. Cleanup
      // failure can only leave a safe duplicate.
    }
  }
  for (const row of pendingRows) {
    if (volatileShippingDeletionTombstones.get(row.id) === row) {
      volatileShippingDeletionTombstones.delete(row.id)
    }
  }
  return true
}

export async function cacheSignedShippingDeletionEvent(
  event: NDKEvent
): Promise<CachedProductTombstone[]> {
  const tombstones = shippingTombstonesFromDeletionEvent(event).map((row) => ({
    ...row,
    observedLocally: true,
  }))
  if (!tombstones.some((row) => row.addressId?.startsWith("30406:"))) {
    throw new Error("Deletion event does not contain a valid shipping target")
  }
  rememberVolatileShippingTombstones(tombstones)
  if (!(await flushVolatileShippingTombstones())) {
    throw new Error("Fixed shipping deletion evidence could not be retained")
  }
  return tombstones
}

async function rememberObservedShippingDeletionEvidence(
  observedDeletionEvents: readonly NDKEvent[],
  targetIds: readonly string[]
): Promise<CachedProductTombstone[]> {
  const targetIdSet = new Set(targetIds)
  const observedRows: CachedProductTombstone[] = []
  for (const event of observedDeletionEvents) {
    try {
      observedRows.push(
        ...shippingTombstonesFromDeletionEvent(event).filter((row) =>
          targetIdSet.has(row.id)
        )
      )
    } catch {
      // Relay data is untrusted. Invalid signatures and malformed targets do
      // not become durable deletion evidence.
    }
  }
  rememberVolatileShippingTombstones(observedRows)
  if (!(await flushVolatileShippingTombstones())) {
    throw new Error("Fixed shipping deletion evidence could not be retained")
  }
  return observedRows
}

function signedDeletionEventsFromShippingTombstones(
  rows: readonly CachedProductTombstone[]
): SignedPublicNostrEvent[] {
  const events = new Map<string, SignedPublicNostrEvent>()
  for (const row of rows) {
    if (!row.id.startsWith(SHIPPING_TOMBSTONE_PREFIX) || !row.signedEvent) {
      continue
    }
    const signedEvent = row.signedEvent
    if (!isValidSignedPublicNostrEvent(signedEvent)) continue
    const validatedRows = shippingTombstonesFromDeletionEvent(
      new NDKEvent(undefined, signedEvent)
    )
    if (!validatedRows.some((validated) => validated.id === row.id)) continue
    events.set(signedEvent.id, cloneSignedEvent(signedEvent))
  }
  return Array.from(events.values())
}

async function getMergedShippingDeletionEvidence(
  targetIds: readonly string[]
): Promise<SignedPublicNostrEvent[]> {
  const targetIdSet = new Set(targetIds)
  const volatileRows = Array.from(
    volatileShippingDeletionTombstones.values()
  ).filter((row) => targetIdSet.has(row.id))
  let persistedRows: CachedProductTombstone[]
  try {
    persistedRows = await loadCachedShippingTombstones(targetIds)
  } catch {
    throw new Error("Fixed shipping deletion evidence could not be verified")
  }

  return signedDeletionEventsFromShippingTombstones([
    ...persistedRows,
    ...volatileRows,
  ])
}

async function runShippingFetchEventsFanoutDetailed(
  filter: NDKFilter,
  options: Parameters<typeof fetchEventsFanoutDetailed>[1]
): Promise<FetchEventsFanoutResult> {
  const impl =
    shippingTestOverrides.fetchEventsFanoutDetailed ?? fetchEventsFanoutDetailed
  return await impl(filter, options)
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
  const coordinates = events.flatMap((event) => {
    const dTag = event.tags.find((tag) => tag[0] === "d")?.[1]?.trim()
    return event.pubkey && dTag
      ? [getShippingOptionAddress(event.pubkey, dTag)]
      : []
  })
  return await getShippingOptionsByCoordinates(coordinates)
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
        deletion.tags.some(
          (tag) =>
            (tag[0] === "e" && tag[1] === event.id) ||
            (tag[0] === "a" &&
              tag[1] === coordinate &&
              (deletion.created_at ?? 0) >= (event.created_at ?? 0))
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
    result.eventsVerified !== true ||
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
      const observedShippingEvents = requireCompleteShippingRead(
        await runShippingFetchEventsFanoutDetailed(
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
      const { shippingEvents, retainedEventIds } =
        await mergeObservedShippingOptionFrontiers(
          batch.coordinates,
          observedShippingEvents
        )
      const addressDeletionResult = await runShippingFetchEventsFanoutDetailed(
        {
          kinds: [EVENT_KINDS.DELETION as number],
          authors: [batch.pubkey],
          "#a": batch.coordinates,
          limit: SHIPPING_DELETION_READ_LIMIT,
        },
        { relayUrls: readPlan.relayUrls }
      )
      await rememberObservedShippingDeletionEvidence(
        addressDeletionResult.events,
        batch.coordinates.map(shippingTombstoneIdForAddress)
      )
      requireCompleteShippingRead(
        addressDeletionResult,
        readPlan.relayUrls,
        SHIPPING_DELETION_READ_LIMIT
      )
      const eventIds = uniqueStrings([
        ...retainedEventIds,
        ...observedShippingOptionEvents(
          observedShippingEvents,
          new Set(batch.coordinates)
        ).map((event) => event.id),
      ])
      if (eventIds.length > 0) {
        const eventDeletionResult = await runShippingFetchEventsFanoutDetailed(
          {
            kinds: [EVENT_KINDS.DELETION as number],
            authors: [batch.pubkey],
            "#e": eventIds,
            limit: SHIPPING_DELETION_READ_LIMIT,
          },
          { relayUrls: readPlan.relayUrls }
        )
        await rememberObservedShippingDeletionEvidence(
          eventDeletionResult.events,
          eventIds.map((eventId) =>
            shippingTombstoneIdForEvent(batch.pubkey, eventId)
          )
        )
        requireCompleteShippingRead(
          eventDeletionResult,
          readPlan.relayUrls,
          SHIPPING_DELETION_READ_LIMIT
        )
      }
      return {
        shippingEvents,
        deletionEventIds: eventIds,
        pubkey: batch.pubkey,
      }
    }
  )

  const shippingEvents = batchResults.flatMap((result) => result.shippingEvents)
  const deletionTargetIds = uniqueStrings([
    ...Array.from(requested, shippingTombstoneIdForAddress),
    ...batchResults.flatMap((result) =>
      result.deletionEventIds.map((eventId) =>
        shippingTombstoneIdForEvent(result.pubkey, eventId)
      )
    ),
  ])
  const deletionEvents =
    await getMergedShippingDeletionEvidence(deletionTargetIds)
  return selectLatestShippingOptions(shippingEvents, deletionEvents).filter(
    (option) => requested.has(option.id)
  )
}

export function resolveProductFulfillment(
  product: ResolvableProductFulfillment,
  shippingOptions: readonly ParsedShippingOption[],
  destination?: {
    country?: string
    state?: string
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
      option.launchUnsupportedTags.length > 0 ||
      option.destinationPolicyUnsupported
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
    if (matchingOptions.length === 1 && destination.country?.trim()) {
      const eligibility = getShippingDestinationEligibility(
        {
          country: destination.country,
          state: destination.state ?? "",
          postalCode: destination.postalCode ?? "",
        },
        matchingOptions
      )
      if (eligibility.eligible === null) {
        return {
          intent: "fixed_standard",
          status: "order_first",
          reason: "destination_incomplete",
          options: resolvedOptions,
        }
      }
      if (eligibility.eligible === false) matchingOptions = []
    }
  } else if (destination?.country?.trim()) {
    const eligibility = resolvedOptions.map((option) => ({
      option,
      result: getShippingDestinationEligibility(
        {
          country: destination.country ?? "",
          state: destination.state ?? "",
          postalCode: destination.postalCode ?? "",
        },
        [option]
      ),
    }))
    matchingOptions = eligibility.flatMap(({ option, result }) =>
      result.eligible === true ? [option] : []
    )
    if (eligibility.some(({ result }) => result.eligible === null)) {
      return {
        intent: "fixed_standard",
        status: "order_first",
        reason: "destination_incomplete",
        options: resolvedOptions,
      }
    }
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
      options: resolvedOptions,
    }
  }
  if (matchingOptions.length > 1) {
    return {
      intent: "fixed_standard",
      status: "order_first",
      reason: "ambiguous_destination",
      options: resolvedOptions,
    }
  }
  const option = matchingOptions[0]!

  return {
    intent: "fixed_standard",
    status: "ready",
    option,
    ...(resolvedOptions.length > 1 ? { options: resolvedOptions } : {}),
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
  const firstColon = product.id.indexOf(":")
  const secondColon = product.id.indexOf(":", firstColon + 1)
  const productDTag =
    firstColon > 0 &&
    secondColon > firstColon + 1 &&
    product.id.slice(0, firstColon) === String(EVENT_KINDS.PRODUCT)
      ? product.id.slice(secondColon + 1)
      : null
  const shippingZones = options.map((option) => ({
    shippingOptionId: option.id,
    shippingOptionDTag: option.dTag,
    amount: option.price,
    currency: option.currency,
    countries: [...option.countries],
    countryRules: option.countryRules.map((rule) => ({
      ...rule,
      restrictTo: [...rule.restrictTo],
      exclude: [...rule.exclude],
      ...(rule.includeSubdivisions
        ? { includeSubdivisions: [...rule.includeSubdivisions] }
        : {}),
      ...(rule.excludeSubdivisions
        ? { excludeSubdivisions: [...rule.excludeSubdivisions] }
        : {}),
    })),
    ...(option.destinationSchema
      ? { destinationSchema: option.destinationSchema }
      : {}),
    ...(options.length === 1 &&
    productDTag &&
    option.dTag === getProductShippingOptionDTag(productDTag)
      ? { usesProductFallback: true }
      : {}),
    ...(option.sourceRelayUrls?.length
      ? { sourceRelayUrls: [...option.sourceRelayUrls] }
      : {}),
  }))
  const base: ProductSchema = {
    ...withoutShipping,
    shippingOptionIds: options.map((option) => option.id),
    shippingOptionDTags: options.map((option) => option.dTag),
    shippingCountries: Array.from(
      new Set(options.flatMap((option) => option.countries))
    ).sort(),
    shippingCountryRules: options.flatMap((option) =>
      option.countryRules.map((rule) => ({
        ...rule,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
        ...(rule.includeSubdivisions
          ? { includeSubdivisions: [...rule.includeSubdivisions] }
          : {}),
        ...(rule.excludeSubdivisions
          ? { excludeSubdivisions: [...rule.excludeSubdivisions] }
          : {}),
      }))
    ),
    shippingZones,
    ...(options.length > 0
      ? {
          shippingOptionCreatedAt: Math.max(
            ...options.map((option) => option.createdAt)
          ),
        }
      : {}),
  }
  const option = prepared.option
  return option
    ? {
        ...base,
        ...canonicalizeShippingCost(option.price, option.currency),
        shippingOptionId: option.id,
        shippingOptionDTag: option.dTag,
        canonicalShippingResolved: true,
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
  return postalCode.trim().toUpperCase().replace(/[ -]/g, "")
}

function postalPatternMatches(pattern: string, postalCode: string): boolean {
  const normalizedPattern = normalizeShippingPostalCode(pattern)
  const normalizedPostal = normalizeShippingPostalCode(postalCode)
  if (!normalizedPattern) return false
  if (normalizedPattern.endsWith("*")) {
    return normalizedPostal.startsWith(normalizedPattern.replace(/\*+$/, ""))
  }
  return normalizedPostal === normalizedPattern
}

export type ShippingDestinationEligibility =
  | { eligible: true }
  | {
      eligible: false
      reason:
        "country_unsupported" | "postal_restricted" | "subdivision_restricted"
    }
  | { eligible: null; reason: "unknown" }

export function getShippingDestinationEligibility(
  destination: { country: string; state?: string; postalCode: string },
  shippingOptions: ParsedShippingOption[]
): ShippingDestinationEligibility {
  if (shippingOptions.length === 0) {
    return { eligible: null, reason: "unknown" }
  }

  const country = destination.country.trim().toUpperCase()
  const relevantOptions = shippingOptions.filter((option) =>
    option.countries.includes(country)
  )
  if (relevantOptions.length === 0) {
    return { eligible: false, reason: "country_unsupported" }
  }
  if (
    relevantOptions.some(
      (option) =>
        option.destinationPolicyUnsupported ||
        (option.destinationSchema !== undefined &&
          option.destinationSchema !== SHIPPING_DESTINATION_SCHEMA_VERSION)
    )
  ) {
    return { eligible: null, reason: "unknown" }
  }
  const postalCode = normalizeShippingPostalCode(destination.postalCode)
  let unknown = false
  let sawRules = false
  let requiresAnyPostal = false
  let requiresAnySubdivision = false
  let subdivisionRejected = false
  let postalRejected = false
  for (const option of relevantOptions) {
    const rules = option.countryRules.filter(
      (rule) => rule.code.toUpperCase() === country
    )
    if (rules.length === 0) continue
    sawRules = true
    const restrictTo = Array.from(
      new Set(rules.flatMap((rule) => rule.restrictTo ?? []))
    )
    const exclude = Array.from(
      new Set(rules.flatMap((rule) => rule.exclude ?? []))
    )
    const includeSubdivisions = Array.from(
      new Set(rules.flatMap((rule) => rule.includeSubdivisions ?? []))
    )
    const excludeSubdivisions = Array.from(
      new Set(rules.flatMap((rule) => rule.excludeSubdivisions ?? []))
    )
    const includesWholeCountry = rules.some(
      (rule) =>
        rule.includeCountry === true ||
        ((rule.includeSubdivisions?.length ?? 0) === 0 &&
          rule.restrictTo.length === 0)
    )
    const requiresPostal = restrictTo.length > 0 || exclude.length > 0
    const requiresSubdivision =
      includeSubdivisions.length > 0 || excludeSubdivisions.length > 0
    requiresAnyPostal ||= requiresPostal
    requiresAnySubdivision ||= requiresSubdivision
    if (
      requiresPostal &&
      (!postalCode || !supportsAddressPostalPolicy(country))
    ) {
      unknown = true
      continue
    }
    const subdivision = requiresSubdivision
      ? normalizeAddressSubdivisionCode(country, destination.state)
      : null
    if (requiresSubdivision && !subdivision) {
      unknown = true
      continue
    }
    const hasSpecificIncludes =
      includeSubdivisions.length > 0 || restrictTo.length > 0
    const included =
      includesWholeCountry ||
      !hasSpecificIncludes ||
      includeSubdivisions.includes(subdivision ?? "") ||
      restrictTo.some((pattern) => postalPatternMatches(pattern, postalCode))
    const excludedBySubdivision = excludeSubdivisions.includes(
      subdivision ?? ""
    )
    const excludedByPostal = exclude.some((pattern) =>
      postalPatternMatches(pattern, postalCode)
    )
    subdivisionRejected ||= excludedBySubdivision
    postalRejected ||= excludedByPostal
    if (
      included &&
      !rules.some((rule) => rule.excludeCountry) &&
      !excludedBySubdivision &&
      !excludedByPostal
    ) {
      return { eligible: true }
    }
  }

  if (unknown) return { eligible: null, reason: "unknown" }
  if (!sawRules) return { eligible: false, reason: "country_unsupported" }
  if (subdivisionRejected) {
    return { eligible: false, reason: "subdivision_restricted" }
  }
  if (postalRejected || requiresAnyPostal) {
    return { eligible: false, reason: "postal_restricted" }
  }
  if (requiresAnySubdivision) {
    return { eligible: false, reason: "subdivision_restricted" }
  }
  return { eligible: false, reason: "country_unsupported" }
}
