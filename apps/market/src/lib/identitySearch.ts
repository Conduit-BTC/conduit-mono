import { normalizeFacetValues } from "./facets"

export type IdentitySearch = {
  q?: string
  sort?: "newest" | "price_asc" | "price_desc"
  tag?: string[]
}

export function validateIdentitySearch(
  raw: Record<string, unknown>
): IdentitySearch {
  const tags = normalizeFacetValues(raw.tag).map((tag) => tag.toLowerCase())
  return {
    q: typeof raw.q === "string" ? raw.q : undefined,
    sort: (["newest", "price_asc", "price_desc"] as const).includes(
      raw.sort as NonNullable<IdentitySearch["sort"]>
    )
      ? (raw.sort as IdentitySearch["sort"])
      : undefined,
    tag: tags.length > 0 ? Array.from(new Set(tags)) : undefined,
  }
}
