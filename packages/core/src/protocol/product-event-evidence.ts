import {
  canonicalizeProductPrice,
  canonicalizeShippingCost,
  isBtcLikeCurrency,
  isMsatsLikeCurrency,
  isSatsLikeCurrency,
  MSATS_PER_SAT,
  normalizeCurrencyCode,
  SATS_PER_BTC,
} from "../pricing"
import type { ProductSchema, ProductShippingOptionReference } from "../schemas"

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const PRODUCT_PREVIEW_TITLE_MAX_LENGTH = 200
const PRODUCT_PREVIEW_SUMMARY_MAX_LENGTH = 5_000
const PRODUCT_PREVIEW_IMAGE_LIMIT = 8
const PRODUCT_PREVIEW_IMAGE_URL_MAX_LENGTH = 2_048
const PRODUCT_PREVIEW_IMAGE_ALT_MAX_LENGTH = 300
const CONTROL_CHARACTER = /\p{Cc}/u

export interface SignedProductPriceTag {
  price: number
  currency: string
}

type SignedProductPreviewEvidenceBase = Pick<
  ProductSchema,
  "title" | "summary" | "images" | "type" | "format" | "stock"
>

export type SignedProductPreviewEvidence = SignedProductPreviewEvidenceBase &
  (
    | ({
        priceStatus: "resolved"
      } & Pick<
        ProductSchema,
        "price" | "currency" | "priceSats" | "sourcePrice"
      >)
    | { priceStatus: "malformed" }
  )

type NormalizedProductPriceSemantics = {
  amount: number
  currency: string
}

function normalizedPriceCurrencyIdentity(currency: string): string {
  const normalized = normalizeCurrencyCode(currency)
  if (isSatsLikeCurrency(normalized)) return "SATS"
  if (isMsatsLikeCurrency(normalized)) return "MSATS"
  if (isBtcLikeCurrency(normalized)) return "BTC"
  return normalized
}

function normalizeSourcePriceSemantics(
  price: unknown,
  currency: unknown
): NormalizedProductPriceSemantics | null {
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price < 0 ||
    typeof currency !== "string"
  ) {
    return null
  }
  const normalizedCurrency = normalizedPriceCurrencyIdentity(currency)
  return normalizedCurrency
    ? {
        amount: Object.is(price, -0) ? 0 : price,
        currency: normalizedCurrency,
      }
    : null
}

function normalizeProductPriceSemantics(
  price: unknown,
  currency: unknown
): NormalizedProductPriceSemantics | null {
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    price < 0 ||
    typeof currency !== "string"
  ) {
    return null
  }
  const normalizedCurrency = normalizeCurrencyCode(currency)
  if (!normalizedCurrency) return null

  if (isSatsLikeCurrency(normalizedCurrency)) {
    return Number.isSafeInteger(price)
      ? { amount: price, currency: "SATS" }
      : null
  }
  if (isMsatsLikeCurrency(normalizedCurrency)) {
    const sats = price / MSATS_PER_SAT
    return Number.isSafeInteger(sats)
      ? { amount: sats, currency: "SATS" }
      : null
  }
  if (isBtcLikeCurrency(normalizedCurrency)) {
    const sats = price * SATS_PER_BTC
    const roundedSats = Math.round(sats)
    return Number.isSafeInteger(roundedSats) &&
      Math.abs(sats - roundedSats) <= 1e-6
      ? { amount: roundedSats, currency: "SATS" }
      : null
  }

  return {
    amount: Object.is(price, -0) ? 0 : price,
    currency: normalizedCurrency,
  }
}

function hasSameProductPriceSemantics(
  left: NormalizedProductPriceSemantics | null,
  right: NormalizedProductPriceSemantics | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.amount === right.amount &&
    left.currency === right.currency
  )
}

function getJsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function legacyPriceEvidenceConflicts(
  legacyContent: unknown,
  standardPrice: SignedProductPriceTag
): boolean {
  const legacy = getJsonRecord(legacyContent)
  if (!legacy) return false

  const standardSemantics = normalizeProductPriceSemantics(
    standardPrice.price,
    standardPrice.currency
  )
  const standardSourceSemantics = normalizeSourcePriceSemantics(
    standardPrice.price,
    standardPrice.currency
  )
  const hasLegacyPrice = hasOwn(legacy, "price")
  const hasLegacyCurrency = hasOwn(legacy, "currency")
  if (
    (hasLegacyPrice || hasLegacyCurrency) &&
    (!hasLegacyPrice ||
      !hasLegacyCurrency ||
      !hasSameProductPriceSemantics(
        normalizeProductPriceSemantics(legacy.price, legacy.currency),
        standardSemantics
      ))
  ) {
    return true
  }

  if (hasOwn(legacy, "sourcePrice")) {
    const source = getJsonRecord(legacy.sourcePrice)
    if (
      !source ||
      typeof source.currency !== "string" ||
      typeof source.normalizedCurrency !== "string" ||
      normalizedPriceCurrencyIdentity(source.currency) !==
        normalizedPriceCurrencyIdentity(source.normalizedCurrency) ||
      !hasSameProductPriceSemantics(
        normalizeSourcePriceSemantics(source.amount, source.currency),
        standardSourceSemantics
      )
    ) {
      return true
    }
  }

  if (hasOwn(legacy, "priceSats")) {
    if (
      typeof legacy.priceSats !== "number" ||
      !Number.isSafeInteger(legacy.priceSats) ||
      legacy.priceSats < 0 ||
      standardSemantics?.currency !== "SATS" ||
      legacy.priceSats !== standardSemantics.amount
    ) {
      return true
    }
  }

  return false
}

/** Shared strict price decision for display parsing and public authorization. */
export function signedProductPriceEvidenceIsMalformed(input: {
  standardPrice: SignedProductPriceTag | null
  legacyContent: unknown
}): boolean {
  return (
    input.standardPrice === null ||
    normalizeProductPriceSemantics(
      input.standardPrice.price,
      input.standardPrice.currency
    ) === null ||
    legacyPriceEvidenceConflicts(input.legacyContent, input.standardPrice)
  )
}

/** Parse the one required NIP-99/Gamma price tag without compatibility fallback. */
export function parseSignedProductPriceTag(
  tags: readonly string[][] | undefined
): SignedProductPriceTag | null {
  const priceTags = (tags ?? []).filter((tag) => tag[0] === "price")
  if (priceTags.length !== 1) return null
  const tag = priceTags[0]!
  const rawAmount = typeof tag[1] === "string" ? tag[1].trim() : ""
  const amount = NON_NEGATIVE_DECIMAL.test(rawAmount) ? Number(rawAmount) : NaN
  const currency = typeof tag[2] === "string" ? tag[2].trim() : ""
  return Number.isFinite(amount) && amount >= 0 && currency
    ? { price: amount, currency }
    : null
}

function exactTrimmedTagValue(
  tags: readonly string[][] | undefined,
  name: string,
  maxLength: number
): string | undefined {
  const matching = (tags ?? []).filter((tag) => tag[0] === name)
  if (matching.length !== 1 || typeof matching[0]?.[1] !== "string") {
    return undefined
  }
  const value = matching[0][1].trim()
  return value && value.length <= maxLength && !CONTROL_CHARACTER.test(value)
    ? value
    : undefined
}

function signedContentProjection(content: string): {
  legacyContent: unknown
  title?: string
  summary?: string
  images: ProductSchema["images"]
  type?: ProductSchema["type"]
  format?: ProductSchema["format"]
  stock?: number
} {
  const trimmed = content.trim()
  let legacyContent: unknown
  try {
    legacyContent = JSON.parse(trimmed || "{}")
  } catch {
    return {
      legacyContent: undefined,
      ...(trimmed
        ? { summary: trimmed.slice(0, PRODUCT_PREVIEW_SUMMARY_MAX_LENGTH) }
        : {}),
      images: [],
    }
  }
  if (
    !legacyContent ||
    typeof legacyContent !== "object" ||
    Array.isArray(legacyContent)
  ) {
    return { legacyContent, images: [] }
  }
  const record = legacyContent as Record<string, unknown>
  const rawSummary =
    typeof record.summary === "string"
      ? record.summary
      : typeof record.description === "string"
        ? record.description
        : undefined
  const rawTitle =
    typeof record.title === "string"
      ? record.title
      : typeof record.name === "string"
        ? record.name
        : undefined
  const type =
    record.type === "simple" ||
    record.type === "variable" ||
    record.type === "variation"
      ? record.type
      : undefined
  const format =
    record.format === "physical" || record.format === "digital"
      ? record.format
      : undefined
  const stock =
    typeof record.stock === "number" &&
    Number.isSafeInteger(record.stock) &&
    record.stock >= 0
      ? record.stock
      : undefined
  const images = Array.isArray(record.images)
    ? record.images.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return []
        const image = value as Record<string, unknown>
        if (
          typeof image.url !== "string" ||
          !/^https?:\/\//i.test(image.url) ||
          image.url.length > PRODUCT_PREVIEW_IMAGE_URL_MAX_LENGTH
        ) {
          return []
        }
        return [
          {
            url: image.url,
            ...(typeof image.alt === "string" && image.alt.trim()
              ? {
                  alt: image.alt
                    .trim()
                    .slice(0, PRODUCT_PREVIEW_IMAGE_ALT_MAX_LENGTH),
                }
              : {}),
          },
        ]
      })
    : []
  return {
    legacyContent,
    ...(rawTitle?.trim() && !CONTROL_CHARACTER.test(rawTitle)
      ? {
          title: rawTitle.trim().slice(0, PRODUCT_PREVIEW_TITLE_MAX_LENGTH),
        }
      : {}),
    ...(rawSummary?.trim()
      ? {
          summary: rawSummary
            .trim()
            .slice(0, PRODUCT_PREVIEW_SUMMARY_MAX_LENGTH),
        }
      : {}),
    images,
    ...(type ? { type } : {}),
    ...(format ? { format } : {}),
    ...(stock !== undefined ? { stock } : {}),
  }
}

/** Bounded display projection from one exact signed kind-30402 revision. */
export function projectSignedProductPreviewEvidence(event: {
  tags: readonly string[][] | undefined
  content: string
}): SignedProductPreviewEvidence | null {
  const content = signedContentProjection(event.content)
  const titleTags = (event.tags ?? []).filter((tag) => tag[0] === "title")
  if (titleTags.length > 1) return null
  const taggedTitle = exactTrimmedTagValue(
    event.tags,
    "title",
    PRODUCT_PREVIEW_TITLE_MAX_LENGTH
  )
  if (titleTags.length === 1 && !taggedTitle) return null
  const title = taggedTitle ?? content.title
  if (!title) return null

  const taggedSummary = exactTrimmedTagValue(
    event.tags,
    "summary",
    PRODUCT_PREVIEW_SUMMARY_MAX_LENGTH
  )
  const tagImages = (event.tags ?? []).flatMap((tag) => {
    const url = tag[0] === "image" ? tag[1]?.trim() : undefined
    return url &&
      /^https?:\/\//i.test(url) &&
      url.length <= PRODUCT_PREVIEW_IMAGE_URL_MAX_LENGTH
      ? [{ url }]
      : []
  })
  const typeTags = (event.tags ?? []).filter((tag) => tag[0] === "type")
  if (typeTags.length > 1) return null
  const typeTag = typeTags.length === 1 ? typeTags[0] : undefined
  if (
    typeTag &&
    typeTag[1] !== "simple" &&
    typeTag[1] !== "variable" &&
    typeTag[1] !== "variation"
  ) {
    return null
  }
  if (typeTag?.[2] && typeTag[2] !== "physical" && typeTag[2] !== "digital") {
    return null
  }
  const type = typeTag
    ? typeTag[1] === "variable" || typeTag[1] === "variation"
      ? typeTag[1]
      : "simple"
    : (content.type ?? "simple")
  const format = typeTag
    ? typeTag[2] === "digital"
      ? "digital"
      : "physical"
    : (content.format ?? "physical")
  const stockTags = (event.tags ?? []).filter((tag) => tag[0] === "stock")
  const rawStock =
    stockTags.length === 1 ? stockTags[0]?.[1]?.trim() : undefined
  const stock =
    rawStock && /^\d+$/.test(rawStock) ? Number(rawStock) : undefined
  const base: SignedProductPreviewEvidenceBase = {
    title,
    ...(taggedSummary || content.summary
      ? { summary: taggedSummary ?? content.summary }
      : {}),
    images: [...tagImages, ...content.images].slice(
      0,
      PRODUCT_PREVIEW_IMAGE_LIMIT
    ),
    type,
    format,
    ...(Number.isSafeInteger(stock) && stock! >= 0
      ? { stock }
      : content.stock !== undefined
        ? { stock: content.stock }
        : {}),
  }

  const price = parseSignedProductPriceTag(event.tags)
  if (
    signedProductPriceEvidenceIsMalformed({
      standardPrice: price,
      legacyContent: content.legacyContent,
    }) ||
    !price
  ) {
    return { ...base, priceStatus: "malformed" }
  }
  const canonical = canonicalizeProductPrice<
    Pick<ProductSchema, "price" | "currency" | "priceSats" | "sourcePrice">
  >({ price: price.price, currency: price.currency })
  return {
    ...base,
    priceStatus: "resolved",
    price: canonical.price,
    currency: canonical.currency,
    ...(canonical.priceSats !== undefined
      ? { priceSats: canonical.priceSats }
      : {}),
    ...(canonical.sourcePrice
      ? { sourcePrice: { ...canonical.sourcePrice } }
      : {}),
  }
}

/** Preserve every shipping_option occurrence, including malformed extras. */
export function parseSignedProductShippingOptionTags(
  tags: readonly string[][] | undefined,
  productCurrency: string | undefined
): {
  shippingOptionId?: string
  shippingOptionDTag?: string
  extraCost?: Pick<ProductSchema, "shippingCostSats" | "sourceShippingCost">
  shippingOptionRefs: ProductShippingOptionReference[]
} {
  const parsed: ProductShippingOptionReference[] = []
  let compatibilityExtraCost:
    Pick<ProductSchema, "shippingCostSats" | "sourceShippingCost"> | undefined
  for (const tag of tags ?? []) {
    if (tag[0] !== "shipping_option") continue
    const coordinate = tag[1]?.trim() ?? ""
    const parts = coordinate.split(":")
    const hasExtraCost = tag.length === 3
    const hasSupportedShape = tag.length === 2 || hasExtraCost
    const rawExtraCost = tag[2]
    const normalizedRawExtraCost = rawExtraCost?.trim() ?? ""
    const amount =
      typeof rawExtraCost === "string" &&
      NON_NEGATIVE_DECIMAL.test(normalizedRawExtraCost)
        ? Number(normalizedRawExtraCost)
        : NaN
    const extraCost =
      hasExtraCost &&
      coordinate &&
      productCurrency &&
      Number.isFinite(amount) &&
      amount >= 0
        ? canonicalizeShippingCost(amount, productCurrency)
        : undefined
    const sourceExtraCost = extraCost?.sourceShippingCost
    const malformed =
      !coordinate ||
      !hasSupportedShape ||
      (hasExtraCost && extraCost === undefined)
    parsed.push({
      coordinate,
      dTag:
        coordinate && parts.length >= 3 ? parts.slice(2).join(":") : undefined,
      ...(malformed ? { extraCostMalformed: true } : {}),
      ...(sourceExtraCost ? { extraCost: sourceExtraCost } : {}),
    })
    if (!malformed && !compatibilityExtraCost && extraCost) {
      compatibilityExtraCost = extraCost
    }
  }

  const first = parsed[0]
  return {
    ...(first
      ? {
          shippingOptionId: first.coordinate,
          shippingOptionDTag: first.dTag,
        }
      : {}),
    extraCost: compatibilityExtraCost,
    shippingOptionRefs: parsed,
  }
}

/** Strict projection used by public participation and ACK authorization. */
export function projectSignedProductFulfillmentEvidence(event: {
  tags: readonly string[][] | undefined
  content: string
}): Pick<
  ProductSchema,
  | "shippingOptionId"
  | "shippingOptionDTag"
  | "shippingOptionRefs"
  | "priceEvidenceMalformed"
> {
  const price = parseSignedProductPriceTag(event.tags)
  let legacyContent: unknown
  try {
    legacyContent = JSON.parse(event.content || "{}")
  } catch {
    // Non-JSON content is the standard NIP-99 Markdown representation.
  }
  const priceEvidenceMalformed = signedProductPriceEvidenceIsMalformed({
    standardPrice: price,
    legacyContent,
  })
  const shipping = parseSignedProductShippingOptionTags(
    event.tags,
    price?.currency
  )
  return {
    ...(shipping.shippingOptionId
      ? { shippingOptionId: shipping.shippingOptionId }
      : {}),
    ...(shipping.shippingOptionDTag
      ? { shippingOptionDTag: shipping.shippingOptionDTag }
      : {}),
    shippingOptionRefs: shipping.shippingOptionRefs,
    ...(priceEvidenceMalformed
      ? { priceEvidenceMalformed: true as const }
      : {}),
  }
}
