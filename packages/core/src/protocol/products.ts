import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { productSchema, type ProductSchema } from "../schemas"

function getTagValue(tags: string[][] | undefined, name: string): string | null {
  if (!tags) return null
  for (const t of tags) {
    if (t[0] === name && typeof t[1] === "string") return t[1]
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
export function parseProductEvent(event: Pick<NDKEvent, "content" | "pubkey" | "created_at" | "tags" | "id">): ProductSchema {
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

  // Fallback: minimal display. Price/currency may be missing on-wire in some implementations.
  const fromContent = (event.content || "").slice(0, 200)
  const title = getTagValue(event.tags, "title") ?? (fromContent || "Untitled")
  const fallback: ProductSchema = productSchema.parse({
    id: dTag ? `30402:${event.pubkey}:${dTag}` : event.id,
    pubkey: event.pubkey,
    title,
    summary: event.content ? event.content.slice(0, 5000) : undefined,
    price: 0,
    currency: "SAT",
    createdAt: createdAtMs,
    updatedAt: createdAtMs,
  })

  return fallback
}
