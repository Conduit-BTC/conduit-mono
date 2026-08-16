import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  canonicalizeProductPrice,
  canonicalizeShippingCost,
  isSatsLikeCurrency,
  type CommerceShippingCostLike,
  normalizeCurrencyCode,
} from "../pricing"
import {
  productSchema,
  type ProductSchema,
  type ProductZapMessagePolicy,
} from "../schemas"
import { normalizePublicMediaUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"

export const MAX_PRODUCT_IMAGE_CANDIDATES = 12
const PRODUCT_JSON_DISPLAY_PROJECTION_MAX_DEPTH = 3
const PRODUCT_TITLE_MAX_LENGTH = 200
const PRODUCT_SUMMARY_MAX_LENGTH = 5000
const PRODUCT_ADDRESS_PATTERN = /^30402:([0-9a-f]{64}):(.+)$/i
export const PRODUCT_PUBLIC_ZAPS_TAG = "checkout_public_zaps"
export const PRODUCT_ZAP_MESSAGE_POLICY_TAG = "checkout_zap_message_policy"
const PRODUCT_PUBLIC_ZAPS_LEGACY_TAG = "public_zaps"
const PRODUCT_ZAP_MESSAGE_POLICY_LEGACY_TAG = "zap_message_policy"

export interface ProductListingEventDraft {
  kind: typeof EVENT_KINDS.PRODUCT
  content: string
  tags: string[][]
}

export interface BuildProductListingEventDraftInput {
  product: ProductSchema
  dTag: string
  clientAppId?: ConduitAppId
}

export interface ProductDeletionEventTarget {
  eventId: string
  addressId?: string
}

export interface ProductDeletionEventDraft {
  kind: typeof EVENT_KINDS.DELETION
  content: string
  tags: string[][]
}

export interface BuildProductDeletionEventDraftInput {
  merchantPubkey: string
  targets: readonly ProductDeletionEventTarget[]
  clientAppId?: ConduitAppId
}

export function canonicalizeProductTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []

  const canonicalTags: string[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    if (typeof tag !== "string") continue
    const canonicalTag = tag.trim().toLowerCase()
    if (!canonicalTag || seen.has(canonicalTag)) continue

    seen.add(canonicalTag)
    canonicalTags.push(canonicalTag)
  }

  return canonicalTags
}

function parseProductTypeTag(tags: string[][] | undefined): {
  type?: ProductSchema["type"]
  format?: ProductSchema["format"]
} {
  const typeTag = tags?.find((tag) => tag[0] === "type")
  const type =
    typeTag?.[1] === "simple" ||
    typeTag?.[1] === "variable" ||
    typeTag?.[1] === "variation"
      ? typeTag[1]
      : undefined
  const format =
    typeTag?.[2] === "digital" || typeTag?.[2] === "physical"
      ? typeTag[2]
      : undefined
  return { type, format }
}

function parseProductVisibilityTag(
  tags: string[][] | undefined
): ProductSchema["visibility"] | undefined {
  const value = tags
    ?.find((tag) => tag[0] === "visibility")?.[1]
    ?.trim()
    .toLowerCase()

  if (value === "public" || value === "on-sale") return "public"
  if (value === "hidden" || value === "private") return "private"
  return undefined
}

function canonicalizeProductSpecifications(
  specifications: ProductSchema["specifications"] | undefined
): ProductSchema["specifications"] {
  const canonical: ProductSchema["specifications"] = []
  const seen = new Set<string>()

  for (const specification of specifications ?? []) {
    const key = specification.key.trim()
    const value = specification.value.trim()
    if (!key || !value) continue

    const identity = JSON.stringify([key.toLowerCase(), value.toLowerCase()])
    if (seen.has(identity)) continue
    seen.add(identity)
    canonical.push({ key, value })
  }

  return canonical
}

function parseProductSpecifications(
  tags: string[][] | undefined
): ProductSchema["specifications"] {
  return canonicalizeProductSpecifications(
    (tags ?? [])
      .filter((tag) => tag[0] === "spec")
      .map((tag) => ({
        key: tag[1] ?? "",
        value: tag[2] ?? "",
      }))
  )
}

function normalizeVariationParentProductId(
  value: string | undefined,
  merchantPubkey?: string
): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined

  const match = PRODUCT_ADDRESS_PATTERN.exec(normalized)
  if (!match || !match[2]?.trim()) return undefined

  const parentPubkey = match[1]!.toLowerCase()
  if (merchantPubkey && parentPubkey !== merchantPubkey.trim().toLowerCase()) {
    return undefined
  }
  return `30402:${parentPubkey}:${match[2]}`
}

function parseVariationParentProductId(
  tags: string[][] | undefined,
  productType: ProductSchema["type"]
): string | undefined {
  if (productType !== "variation") return undefined

  const productReferences = (tags ?? [])
    .filter((tag) => tag[0] === "a" && tag[1]?.startsWith("30402:"))
    .map((tag) => tag[1]!.trim())

  if (productReferences.length !== 1) return undefined
  return normalizeVariationParentProductId(productReferences[0])
}

/**
 * Build one NIP-09 request for one product or a complete variable-product
 * family. A single request keeps the local tombstone projection atomic.
 */
export function buildProductDeletionEventDraft({
  merchantPubkey,
  targets,
  clientAppId,
}: BuildProductDeletionEventDraftInput): ProductDeletionEventDraft {
  const normalizedMerchantPubkey = merchantPubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalizedMerchantPubkey)) {
    throw new Error("Merchant pubkey must be 64 lowercase hex characters")
  }

  const uniqueTargets = Array.from(
    new Map(
      targets.map((target) => [
        `${target.eventId.trim()}\u0000${target.addressId?.trim() ?? ""}`,
        {
          eventId: target.eventId.trim(),
          addressId: target.addressId?.trim(),
        },
      ])
    ).values()
  )
  if (uniqueTargets.length === 0) {
    throw new Error("At least one product deletion target is required")
  }

  for (const target of uniqueTargets) {
    if (!target.eventId)
      throw new Error("Product deletion event id is required")
    if (
      target.addressId &&
      normalizeVariationParentProductId(
        target.addressId,
        normalizedMerchantPubkey
      ) !== target.addressId
    ) {
      throw new Error(
        "Product deletion address must be a same-merchant kind-30402 coordinate"
      )
    }
  }

  let tags: string[][] = [
    ...uniqueTargets.map((target) => ["e", target.eventId]),
    ["k", String(EVENT_KINDS.PRODUCT)],
    ["p", normalizedMerchantPubkey],
    ...uniqueTargets
      .filter(
        (target): target is { eventId: string; addressId: string } =>
          !!target.addressId
      )
      .map((target) => ["a", target.addressId]),
  ]
  if (clientAppId) tags = appendConduitClientTag(tags, clientAppId)

  return {
    kind: EVENT_KINDS.DELETION,
    content: "",
    tags,
  }
}

/**
 * Build a spec-aligned kind-30402 listing draft.
 *
 * NIP-99/Gamma expect `content` to be the human-readable listing
 * description. Structured commerce data belongs in tags.
 */
export function buildProductListingEventDraft({
  product,
  dTag,
  clientAppId,
}: BuildProductListingEventDraftInput): ProductListingEventDraft {
  const normalizedDTag = dTag.trim()
  if (!normalizedDTag) throw new Error("Product d tag is required")

  const content = product.summary?.trim() ?? ""
  const sourcePrice = product.sourcePrice
  const priceAmount = sourcePrice?.amount ?? product.price
  const priceCurrency = sourcePrice?.currency ?? product.currency
  const emittedZapMessagePolicy: ProductZapMessagePolicy =
    product.zapMessagePolicy === "custom" ? "custom" : "generic_only"
  const specifications = canonicalizeProductSpecifications(
    product.specifications
  )
  const parentProductId = normalizeVariationParentProductId(
    product.parentProductId,
    product.pubkey
  )
  if (product.type === "variation" && !parentProductId) {
    throw new Error(
      "Variation products require one same-merchant kind-30402 parent coordinate"
    )
  }
  if (product.type !== "variation" && product.parentProductId?.trim()) {
    throw new Error("Only variation products may reference a parent product")
  }

  let tags: string[][] = [
    ["d", normalizedDTag],
    ["title", product.title],
    ["price", String(priceAmount), priceCurrency],
    ["type", product.type, product.format],
    [
      PRODUCT_PUBLIC_ZAPS_TAG,
      product.publicZapEnabled === false ? "false" : "true",
    ],
    [PRODUCT_ZAP_MESSAGE_POLICY_TAG, emittedZapMessagePolicy],
  ]

  if (parentProductId) tags.push(["a", parentProductId])
  for (const specification of specifications) {
    tags.push(["spec", specification.key, specification.value])
  }

  if (content) tags.push(["summary", content])

  if (
    typeof product.stock === "number" &&
    Number.isSafeInteger(product.stock) &&
    product.stock >= 0
  ) {
    tags.push(["stock", String(product.stock)])
  }

  if (product.sourceShippingCost) {
    tags.push([
      "shipping_cost",
      String(product.sourceShippingCost.amount),
      product.sourceShippingCost.currency,
    ])
  } else if (typeof product.shippingCostSats === "number") {
    tags.push(["shipping_cost", String(product.shippingCostSats)])
  }

  const shippingOptionTag = buildShippingOptionTag(product, priceCurrency)
  if (shippingOptionTag) tags.push(shippingOptionTag)
  if (product.shippingCountries && product.shippingCountries.length > 0) {
    tags.push(["shipping_country", ...product.shippingCountries])
  }
  for (const rule of product.shippingCountryRules ?? []) {
    if (rule.restrictTo.length > 0) {
      tags.push(["shipping_restrict", rule.code, ...rule.restrictTo])
    }
    if (rule.exclude.length > 0) {
      tags.push(["shipping_exclude", rule.code, ...rule.exclude])
    }
  }
  for (const image of getProductProtocolImages(product)) {
    tags.push(["image", image.url])
  }
  for (const tag of canonicalizeProductTags(product.tags)) {
    tags.push(["t", tag])
  }

  if (clientAppId) {
    tags = appendConduitClientTag(tags, clientAppId)
  }

  return {
    kind: EVENT_KINDS.PRODUCT,
    content,
    tags,
  }
}

export function getProductImageCandidates(
  product: Pick<ProductSchema, "images">
): Array<{ url: string; alt?: string }> {
  const candidates: Array<{ url: string; alt?: string }> = []
  const seen = new Set<string>()

  for (const image of getProductProtocolImages(product)) {
    const url = normalizePublicMediaUrl(image.url)
    if (!url || seen.has(url)) continue

    seen.add(url)
    candidates.push({ ...image, url })
    if (candidates.length >= MAX_PRODUCT_IMAGE_CANDIDATES) break
  }

  return candidates
}

/**
 * Preserve every structurally valid HTTP(S) image committed by the protocol
 * event, in signed order. This is evidence retention, not permission to load
 * the URL. Request/render boundaries must use getProductImageCandidates.
 */
export function getProductProtocolImages(
  product: Pick<ProductSchema, "images">
): Array<{ url: string; alt?: string }> {
  const images: Array<{ url: string; alt?: string }> = []

  for (const image of Array.isArray(product.images) ? product.images : []) {
    if (!image || typeof image !== "object") continue
    if (
      typeof image.url !== "string" ||
      !image.url ||
      image.url !== image.url.trim() ||
      image.url.length > 4_096
    ) {
      continue
    }
    try {
      const parsed = new URL(image.url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue
      }
    } catch {
      continue
    }
    images.push({
      url: image.url,
      ...(typeof image.alt === "string" && image.alt ? { alt: image.alt } : {}),
    })
  }

  return images
}

export function hasMarketVisibleProductImage(
  product: Pick<ProductSchema, "images">
): boolean {
  return getProductImageCandidates(product).length > 0
}

function getTagValue(
  tags: string[][] | undefined,
  name: string
): string | null {
  if (!tags) return null
  for (const t of tags) {
    if (t[0] === name && typeof t[1] === "string") return t[1]
  }
  return null
}

function getTagValues(tags: string[][] | undefined, name: string): string[] {
  if (!tags) return []
  return tags
    .filter((t) => t[0] === name && typeof t[1] === "string")
    .map((t) => t[1] as string)
}

function parsePriceTag(
  tags: string[][] | undefined
): { price: number; currency: string } | null {
  if (!tags) return null
  for (const t of tags) {
    if (t[0] !== "price") continue
    const amount = typeof t[1] === "string" ? Number(t[1]) : NaN
    const currency = typeof t[2] === "string" ? t[2] : undefined
    if (!Number.isFinite(amount) || !currency) continue
    return { price: amount, currency }
  }
  return null
}

function parseShippingCostTag(
  tags: string[][] | undefined
): CommerceShippingCostLike {
  const tag = tags?.find((t) => t[0] === "shipping_cost")
  const raw = tag?.[1]
  if (typeof raw !== "string") return {}

  const amount = Number(raw)
  const currency = typeof tag?.[2] === "string" ? tag[2] : "SATS"
  if (!Number.isFinite(amount) || amount < 0) return {}

  return canonicalizeShippingCost(amount, currency)
}

function getProductShippingOptionExtraCostTag(
  product: ProductSchema,
  productCurrency: string
): string | null {
  const normalizedProductCurrency = normalizeCurrencyCode(productCurrency)
  const sourceShippingCurrency = product.sourceShippingCost?.normalizedCurrency

  if (
    product.sourceShippingCost &&
    sourceShippingCurrency === normalizedProductCurrency
  ) {
    return String(product.sourceShippingCost.amount)
  }

  if (
    typeof product.shippingCostSats === "number" &&
    (product.shippingCostSats === 0 ||
      isSatsLikeCurrency(normalizedProductCurrency))
  ) {
    return String(product.shippingCostSats)
  }

  return null
}

function buildShippingOptionTag(
  product: ProductSchema,
  productCurrency: string
): string[] | null {
  if (!product.shippingOptionId) return null

  const tag = ["shipping_option", product.shippingOptionId]
  const extraCost = getProductShippingOptionExtraCostTag(
    product,
    productCurrency
  )
  if (extraCost !== null) tag.push(extraCost)
  return tag
}

function parseStockTag(
  tags: string[][] | undefined
): Pick<ProductSchema, "stock"> {
  if (!tags) return {}

  for (const tag of tags) {
    if (tag[0] !== "stock" || typeof tag[1] !== "string") continue

    const raw = tag[1].trim()
    if (!/^\d+$/.test(raw)) continue

    const stock = Number(raw)
    if (!Number.isSafeInteger(stock)) continue

    return { stock }
  }

  return {}
}

function parseShippingOptionTag(
  tags: string[][] | undefined,
  productCurrency: string | undefined
): {
  shippingOptionId?: string
  shippingOptionDTag?: string
  extraCost?: CommerceShippingCostLike
} {
  const tag = tags?.find((t) => t[0] === "shipping_option")
  const ref = tag?.[1]
  if (!ref) return {}
  const parts = ref.split(":")

  const rawExtraCost = tag?.[2]
  const amount =
    typeof rawExtraCost === "string" && rawExtraCost.trim()
      ? Number(rawExtraCost)
      : NaN
  const extraCost =
    productCurrency && Number.isFinite(amount) && amount >= 0
      ? canonicalizeShippingCost(amount, productCurrency)
      : undefined

  return {
    shippingOptionId: ref,
    shippingOptionDTag:
      parts.length >= 3 ? parts.slice(2).join(":") : undefined,
    extraCost,
  }
}

function parseShippingCountryRules(tags: string[][] | undefined): {
  shippingCountries?: string[]
  shippingCountryRules?: ProductSchema["shippingCountryRules"]
} {
  if (!tags) return {}
  const shippingCountries = Array.from(
    new Set(
      tags
        .filter((t) => t[0] === "shipping_country")
        .flatMap((t) => t.slice(1))
        .map((country) => country.trim().toUpperCase())
        .filter(Boolean)
    )
  )
  if (shippingCountries.length === 0) return {}

  return {
    shippingCountries,
    shippingCountryRules: shippingCountries.map((code) => ({
      code,
      name: code,
      restrictTo:
        tags
          .find(
            (t) => t[0] === "shipping_restrict" && t[1]?.toUpperCase() === code
          )
          ?.slice(2)
          .filter(Boolean) ?? [],
      exclude:
        tags
          .find(
            (t) => t[0] === "shipping_exclude" && t[1]?.toUpperCase() === code
          )
          ?.slice(2)
          .filter(Boolean) ?? [],
    })),
  }
}

function parseProductShippingTags(
  tags: string[][] | undefined,
  productCurrency: string | undefined
): Partial<ProductSchema> {
  const shippingCost = parseShippingCostTag(tags)
  const shippingOption = parseShippingOptionTag(tags, productCurrency)
  const { extraCost, ...shippingOptionFields } = shippingOption

  return {
    ...(Object.keys(shippingCost).length > 0
      ? shippingCost
      : (extraCost ?? {})),
    ...shippingOptionFields,
    ...parseShippingCountryRules(tags),
  }
}

type ParsedProductPublicZapEnabled = {
  value: boolean
  known: boolean
}

type ParsedProductZapMessagePolicy = {
  value: ProductZapMessagePolicy
  known: boolean
}

function parseProductPublicZapEnabled(
  tags: string[][] | undefined
): ParsedProductPublicZapEnabled {
  const raw =
    getTagValue(tags, PRODUCT_PUBLIC_ZAPS_TAG) ??
    getTagValue(tags, PRODUCT_PUBLIC_ZAPS_LEGACY_TAG)
  const normalized = raw?.trim().toLowerCase()

  switch (normalized) {
    case "false":
    case "disabled":
    case "disable":
    case "no":
    case "0":
      return { value: false, known: true }
    case "true":
    case "enabled":
    case "enable":
    case "yes":
    case "1":
      return { value: true, known: true }
    case undefined:
      return { value: true, known: false }
    default:
      return { value: true, known: false }
  }
}

function parseProductZapMessagePolicy(
  tags: string[][] | undefined
): ParsedProductZapMessagePolicy {
  const raw =
    getTagValue(tags, PRODUCT_ZAP_MESSAGE_POLICY_TAG) ??
    getTagValue(tags, PRODUCT_ZAP_MESSAGE_POLICY_LEGACY_TAG)
  const normalized = raw?.trim().toLowerCase()

  switch (normalized) {
    case "product_reference":
    case "product":
      return { value: "generic_only", known: true }
    case "custom":
    case "shopper_custom":
      return { value: "custom", known: true }
    case "generic_only":
    case "generic":
      return { value: "generic_only", known: true }
    case undefined:
      return { value: "generic_only", known: false }
    default:
      return { value: "generic_only", known: false }
  }
}

function parseProductZapPolicy(
  tags: string[][] | undefined
): Pick<
  ProductSchema,
  "publicZapEnabled" | "zapMessagePolicy" | "publicZapPolicyKnown"
> {
  const publicZapEnabled = parseProductPublicZapEnabled(tags)
  const zapMessagePolicy = parseProductZapMessagePolicy(tags)

  return {
    publicZapEnabled: publicZapEnabled.value,
    zapMessagePolicy: zapMessagePolicy.value,
    publicZapPolicyKnown: publicZapEnabled.known && zapMessagePolicy.known,
  }
}

export type ProductJsonDisplayProjection = {
  isJson: boolean
  title?: string
  summary?: string
}

type ProductSummaryCleanupContext = {
  title: string
  priceInfo: { price: number; currency: string } | null
  tags: string[]
}

function getStringField(
  record: Record<string, unknown>,
  names: string[],
  maxLength?: number
): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value !== "string") continue

    const trimmed = value.trim()
    if (trimmed) return trimmed.slice(0, maxLength)
  }

  return undefined
}

export function projectProductJsonDisplayFields(
  content: string
): ProductJsonDisplayProjection | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { isJson: true }
  }

  const record = parsed as Record<string, unknown>
  return {
    isJson: true,
    title: getStringField(record, ["title", "name"], PRODUCT_TITLE_MAX_LENGTH),
    summary: getStringField(
      record,
      ["summary", "description"],
      PRODUCT_SUMMARY_MAX_LENGTH
    ),
  }
}

export function normalizeProductJsonDisplaySummary(
  summary: string | undefined
): string | undefined {
  if (!summary) return undefined

  let normalized = summary
  for (
    let depth = 0;
    depth < PRODUCT_JSON_DISPLAY_PROJECTION_MAX_DEPTH;
    depth += 1
  ) {
    const projection = projectProductJsonDisplayFields(normalized)
    if (!projection?.isJson) return normalized
    if (!projection.summary) return undefined
    normalized = projection.summary
  }

  return projectProductJsonDisplayFields(normalized)?.isJson
    ? undefined
    : normalized
}

function normalizeSummaryMetadataLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function isGeneratedListedByMetadataLine(line: string): boolean {
  const trimmed = line.trim()
  const marker = trimmed[0]
  if ((marker !== "*" && marker !== "_") || !trimmed.endsWith(marker)) {
    return false
  }

  return normalizeSummaryMetadataLine(trimmed).startsWith("listed by ")
}

function isBareFormatMetadataLine(normalizedLine: string): boolean {
  return (
    normalizedLine === "physical product" ||
    normalizedLine === "digital product"
  )
}

function isBarePriceMetadataLine(
  normalizedLine: string,
  priceInfo: ProductSummaryCleanupContext["priceInfo"]
): boolean {
  if (!priceInfo) return false

  const price = `${priceInfo.price} ${priceInfo.currency}`.toLowerCase()
  return normalizedLine === price
}

function isLabeledPriceMetadataLine(
  normalizedLine: string,
  priceInfo: ProductSummaryCleanupContext["priceInfo"]
): boolean {
  if (!priceInfo) return false

  const price = `${priceInfo.price} ${priceInfo.currency}`.toLowerCase()
  return normalizedLine.startsWith(`price: ${price}`)
}

function isLabeledCategoryMetadataLine(
  normalizedLine: string,
  tags: string[]
): boolean {
  if (!normalizedLine.startsWith("category: ")) return false

  const category = normalizedLine.slice("category: ".length).trim()
  return tags
    .map((tag) => normalizeSummaryMetadataLine(tag))
    .some((tag) => tag === category)
}

function isLabeledTypeMetadataLine(normalizedLine: string): boolean {
  return (
    normalizedLine === "type: physical product" ||
    normalizedLine === "type: digital product"
  )
}

function isTitleMetadataLine(normalizedLine: string, title: string): boolean {
  return normalizedLine === normalizeSummaryMetadataLine(title)
}

function findNextNonBlankLineIndex(
  normalizedLines: string[],
  startIndex: number
): number | null {
  for (let index = startIndex; index < normalizedLines.length; index += 1) {
    if (normalizedLines[index]) return index
  }

  return null
}

function compactSummaryLines(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function normalizeProductSummaryForDisplay(
  summary: string | undefined,
  context: ProductSummaryCleanupContext
): string | undefined {
  if (!summary) return undefined

  summary = normalizeProductJsonDisplaySummary(summary)
  if (!summary) return undefined

  const lines = summary.replace(/\r\n?/g, "\n").split("\n")
  const normalizedLines = lines.map(normalizeSummaryMetadataLine)
  const indexesToRemove = new Set<number>()

  for (const [index, normalizedLine] of normalizedLines.entries()) {
    if (!normalizedLine) continue

    const isMarkdownTitle =
      lines[index].trim().startsWith("#") &&
      isTitleMetadataLine(normalizedLine, context.title)

    if (
      isMarkdownTitle ||
      isGeneratedListedByMetadataLine(lines[index]) ||
      isLabeledPriceMetadataLine(normalizedLine, context.priceInfo) ||
      isLabeledCategoryMetadataLine(normalizedLine, context.tags) ||
      isLabeledTypeMetadataLine(normalizedLine)
    ) {
      indexesToRemove.add(index)
    }
  }

  for (const [index, normalizedLine] of normalizedLines.entries()) {
    if (!isBarePriceMetadataLine(normalizedLine, context.priceInfo)) continue

    const categoryIndex = findNextNonBlankLineIndex(normalizedLines, index + 1)
    if (categoryIndex === null) continue

    const formatIndex = findNextNonBlankLineIndex(
      normalizedLines,
      categoryIndex + 1
    )
    const attributionIndex =
      formatIndex === null
        ? null
        : findNextNonBlankLineIndex(normalizedLines, formatIndex + 1)
    if (
      formatIndex !== null &&
      isBareFormatMetadataLine(normalizedLines[formatIndex]) &&
      attributionIndex !== null &&
      isGeneratedListedByMetadataLine(lines[attributionIndex])
    ) {
      indexesToRemove.add(index)
      indexesToRemove.add(categoryIndex)
      indexesToRemove.add(formatIndex)
    }
  }

  const cleaned = compactSummaryLines(
    lines.filter((_, index) => !indexesToRemove.has(index))
  )

  return cleaned || undefined
}

/**
 * Best-effort parser for kind-30402 product events.
 *
 * MVP note:
 * - Interop varies across de-commerce implementations.
 * - We first try legacy JSON content matching our `productSchema`.
 * - If content is not a legacy product object, we fall back to fields from
 *   NIP-99/Gamma tags and Markdown content.
 */
export function parseProductEvent(
  event: Pick<NDKEvent, "content" | "pubkey" | "created_at" | "tags" | "id">
): ProductSchema {
  const createdAtMs = (event.created_at ?? 0) * 1000
  const dTag = getTagValue(event.tags, "d")
  const zapPolicy = parseProductZapPolicy(event.tags)
  const stockTag = parseStockTag(event.tags)
  const productTypeTag = parseProductTypeTag(event.tags)
  const visibilityTag = parseProductVisibilityTag(event.tags)
  const specifications = parseProductSpecifications(event.tags)

  // Try legacy Conduit JSON content first for already-published listings.
  try {
    const parsed = JSON.parse(event.content || "{}") as Partial<ProductSchema>
    const shippingTags = parseProductShippingTags(
      event.tags,
      parsed.currency ?? parsePriceTag(event.tags)?.currency
    )
    const candidate: Partial<ProductSchema> = {
      ...parsed,
      ...shippingTags,
      ...stockTag,
      tags: canonicalizeProductTags(
        Array.isArray(parsed.tags) ? parsed.tags : getTagValues(event.tags, "t")
      ),
      ...(productTypeTag.type ? { type: productTypeTag.type } : {}),
      ...(productTypeTag.format ? { format: productTypeTag.format } : {}),
      ...(visibilityTag ? { visibility: visibilityTag } : {}),
      specifications,
      // Compatibility content may describe the product, but it cannot replace
      // identity or time committed to by the signed event envelope.
      id: dTag ? `30402:${event.pubkey}:${dTag}` : event.id,
      pubkey: event.pubkey,
      ...zapPolicy,
      createdAt: createdAtMs,
      updatedAt: createdAtMs,
    }
    candidate.parentProductId = parseVariationParentProductId(
      event.tags,
      candidate.type ?? "simple"
    )
    candidate.images = getProductProtocolImages({
      images: Array.isArray(parsed.images) ? parsed.images : [],
    })

    const pricedCandidate =
      typeof candidate.price === "number"
        ? canonicalizeProductPrice({
            ...candidate,
            currency: candidate.currency ?? "USD",
          } as ProductSchema)
        : candidate
    const res = productSchema.safeParse(pricedCandidate)
    if (res.success) {
      const normalizedSummary = normalizeProductSummaryForDisplay(
        res.data.summary,
        {
          title: res.data.title,
          priceInfo: {
            price: res.data.sourcePrice?.amount ?? res.data.price,
            currency: res.data.sourcePrice?.currency ?? res.data.currency,
          },
          tags: res.data.tags,
        }
      )

      return normalizedSummary === res.data.summary
        ? res.data
        : { ...res.data, summary: normalizedSummary }
    }
  } catch {
    // fall through
  }

  // Fallback: market-spec/NIP-99 style tags + markdown content.
  const fromContent = (event.content || "").trim()
  const jsonContentProjection = projectProductJsonDisplayFields(fromContent)
  const markdownContent = jsonContentProjection?.isJson ? "" : fromContent
  const markdownTitle = markdownContent
    .split("\n")[0]
    ?.trim()
    .slice(0, PRODUCT_TITLE_MAX_LENGTH)
  const title =
    getTagValue(event.tags, "title") ??
    jsonContentProjection?.title ??
    (markdownTitle || undefined) ??
    "Untitled"

  const priceInfo = parsePriceTag(event.tags)
  const shippingTags = parseProductShippingTags(event.tags, priceInfo?.currency)
  const summaryTag = getTagValue(event.tags, "summary")
  const locationTag = getTagValue(event.tags, "location")

  // market-spec: ["type", "simple|variable|variation", "digital|physical"]
  const type = productTypeTag.type ?? "simple"
  const format: "physical" | "digital" =
    productTypeTag.format === "digital" ? "digital" : "physical"
  const parentProductId = parseVariationParentProductId(event.tags, type)

  const images = getProductProtocolImages({
    images: getTagValues(event.tags, "image").map((url) => ({ url })),
  })

  const tags = canonicalizeProductTags(getTagValues(event.tags, "t"))
  const summaryContext: ProductSummaryCleanupContext = {
    title,
    priceInfo,
    tags,
  }
  const summary =
    normalizeProductSummaryForDisplay(
      summaryTag ?? undefined,
      summaryContext
    ) ??
    normalizeProductSummaryForDisplay(
      jsonContentProjection?.summary,
      summaryContext
    ) ??
    normalizeProductSummaryForDisplay(
      markdownContent ? markdownContent.slice(0, 5000) : undefined,
      summaryContext
    )

  const fallback: ProductSchema = productSchema.parse(
    canonicalizeProductPrice({
      id: dTag ? `30402:${event.pubkey}:${dTag}` : event.id,
      pubkey: event.pubkey,
      title,
      summary,
      price: priceInfo?.price ?? 0,
      currency: priceInfo?.currency ?? "USD",
      type,
      parentProductId,
      specifications,
      format,
      ...(visibilityTag ? { visibility: visibilityTag } : {}),
      ...shippingTags,
      ...zapPolicy,
      ...stockTag,
      images,
      tags,
      location: locationTag ?? undefined,
      createdAt: createdAtMs,
      updatedAt: createdAtMs,
    })
  )

  return fallback
}
