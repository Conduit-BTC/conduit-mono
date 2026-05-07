import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { productSchema, type ProductSchema } from "../schemas"

const PRODUCT_IMAGE_URL_PATTERN = /^https?:\/\//i

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

/**
 * Best-effort parser for kind-30402 product events.
 *
 * MVP note:
 * - Interop varies across de-commerce implementations.
 * - We first try JSON content matching our `productSchema`.
 * - If content isn't JSON, we fall back to minimal fields from tags/content.
 */
export function parseProductEvent(
  event: Pick<NDKEvent, "content" | "pubkey" | "created_at" | "tags" | "id">
): ProductSchema {
  const createdAtMs = (event.created_at ?? 0) * 1000
  const dTag = getTagValue(event.tags, "d")

  // Try JSON content first (preferred for Conduit).
  try {
    const parsed = JSON.parse(event.content || "{}") as Partial<ProductSchema>
    const candidate: Partial<ProductSchema> = {
      ...parsed,
      id: parsed.id ?? (dTag ? `30402:${event.pubkey}:${dTag}` : event.id),
      pubkey: parsed.pubkey ?? event.pubkey,
      createdAt: parsed.createdAt ?? createdAtMs,
      updatedAt: parsed.updatedAt ?? createdAtMs,
    }

    const res = productSchema.safeParse(candidate)
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
  const summaryTag = getTagValue(event.tags, "summary")
  const locationTag = getTagValue(event.tags, "location")

  const images = getTagValues(event.tags, "image")
    .filter((url) => url.startsWith("http://") || url.startsWith("https://"))
    .map((url) => ({ url }))

  const tags = getTagValues(event.tags, "t")

  const fallback: ProductSchema = productSchema.parse({
    id: dTag ? `30402:${event.pubkey}:${dTag}` : event.id,
    pubkey: event.pubkey,
    title,
    summary:
      summaryTag ?? (fromContent ? fromContent.slice(0, 5000) : undefined),
    price: priceInfo?.price ?? 0,
    currency: priceInfo?.currency ?? "USD",
    images,
    tags,
    location: locationTag ?? undefined,
    createdAt: createdAtMs,
    updatedAt: createdAtMs,
  })

  return fallback
}
