import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  canonicalizeProductPrice,
  normalizeCommercePrice,
  normalizeCurrencyCode,
  type SourcePriceQuote,
} from "../pricing"
import { productSchema, type ProductSchema } from "../schemas"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"

const PRODUCT_IMAGE_URL_PATTERN = /^https?:\/\//i

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

  let tags: string[][] = [
    ["d", normalizedDTag],
    ["title", product.title],
    ["price", String(priceAmount), priceCurrency],
    ["type", product.type, product.format],
  ]

  if (content) tags.push(["summary", content])

  if (product.sourceShippingCost) {
    tags.push([
      "shipping_cost",
      String(product.sourceShippingCost.amount),
      product.sourceShippingCost.currency,
    ])
  } else if (typeof product.shippingCostSats === "number") {
    tags.push(["shipping_cost", String(product.shippingCostSats)])
  }

  if (product.shippingOptionId) {
    tags.push(["shipping_option", product.shippingOptionId])
  }
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
  for (const image of product.images) {
    tags.push(["image", image.url])
  }
  for (const tag of product.tags) {
    const normalizedTag = tag.trim()
    if (normalizedTag) tags.push(["t", normalizedTag])
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
  return product.images.filter((image) =>
    PRODUCT_IMAGE_URL_PATTERN.test(image.url)
  )
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

function parseShippingCostTag(tags: string[][] | undefined): {
  shippingCostSats?: number
  sourceShippingCost?: SourcePriceQuote
} {
  const tag = tags?.find((t) => t[0] === "shipping_cost")
  const raw = tag?.[1]
  if (typeof raw !== "string") return {}

  const amount = Number(raw)
  const currency = typeof tag?.[2] === "string" ? tag[2] : "SATS"
  if (!Number.isFinite(amount) || amount < 0) return {}

  const sourceShippingCost = {
    amount,
    currency,
    normalizedCurrency: normalizeCurrencyCode(currency),
  }

  if (amount === 0) {
    return { shippingCostSats: 0, sourceShippingCost }
  }

  const normalized = normalizeCommercePrice(amount, currency)
  if (normalized.status === "ok" && !normalized.approximate) {
    return {
      shippingCostSats: normalized.sats,
      sourceShippingCost,
    }
  }

  return { sourceShippingCost }
}

function parseShippingOptionTag(tags: string[][] | undefined): {
  shippingOptionId?: string
  shippingOptionDTag?: string
} {
  const ref = getTagValue(tags, "shipping_option")
  if (!ref) return {}
  const parts = ref.split(":")
  return {
    shippingOptionId: ref,
    shippingOptionDTag:
      parts.length >= 3 ? parts.slice(2).join(":") : undefined,
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

  // Try legacy Conduit JSON content first for already-published listings.
  try {
    const parsed = JSON.parse(event.content || "{}") as Partial<ProductSchema>
    const candidate: Partial<ProductSchema> = {
      ...parsed,
      id: parsed.id ?? (dTag ? `30402:${event.pubkey}:${dTag}` : event.id),
      pubkey: parsed.pubkey ?? event.pubkey,
      createdAt: parsed.createdAt ?? createdAtMs,
      updatedAt: parsed.updatedAt ?? createdAtMs,
    }

    const pricedCandidate =
      typeof candidate.price === "number"
        ? canonicalizeProductPrice({
            ...candidate,
            currency: candidate.currency ?? "USD",
          } as ProductSchema)
        : candidate
    const res = productSchema.safeParse(pricedCandidate)
    if (res.success) return res.data
  } catch {
    // fall through
  }

  // Fallback: market-spec/NIP-99 style tags + markdown content.
  const fromContent = (event.content || "").trim()
  const title =
    getTagValue(event.tags, "title") ??
    fromContent.split("\n")[0]?.slice(0, 200) ??
    "Untitled"

  const priceInfo = parsePriceTag(event.tags)
  const shippingCost = parseShippingCostTag(event.tags)
  const shippingOption = parseShippingOptionTag(event.tags)
  const shippingRules = parseShippingCountryRules(event.tags)
  const summaryTag = getTagValue(event.tags, "summary")
  const locationTag = getTagValue(event.tags, "location")

  // market-spec: ["type", "simple|variable|variation", "digital|physical"]
  const typeTag = event.tags?.find((t) => t[0] === "type")
  const format: "physical" | "digital" =
    typeTag?.[2] === "digital" ? "digital" : "physical"

  const images = getTagValues(event.tags, "image")
    .filter((url) => url.startsWith("http://") || url.startsWith("https://"))
    .map((url) => ({ url }))

  const tags = getTagValues(event.tags, "t")

  const fallback: ProductSchema = productSchema.parse(
    canonicalizeProductPrice({
      id: dTag ? `30402:${event.pubkey}:${dTag}` : event.id,
      pubkey: event.pubkey,
      title,
      summary:
        summaryTag ?? (fromContent ? fromContent.slice(0, 5000) : undefined),
      price: priceInfo?.price ?? 0,
      currency: priceInfo?.currency ?? "USD",
      format,
      ...shippingCost,
      ...shippingOption,
      ...shippingRules,
      images,
      tags,
      location: locationTag ?? undefined,
      createdAt: createdAtMs,
      updatedAt: createdAtMs,
    })
  )

  return fallback
}
