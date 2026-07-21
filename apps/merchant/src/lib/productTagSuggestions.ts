import { canonicalizeProductTags, type Product } from "@conduit/core"

export interface ProductTagCatalogEntry {
  tag: string
  count: number
}

export function buildProductTagCatalog(
  products: ReadonlyArray<Pick<Product, "tags">>
): ProductTagCatalogEntry[] {
  const counts = new Map<string, number>()

  for (const product of products) {
    for (const tag of canonicalizeProductTags(product.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag)
  )
}

export function getProductTagSuggestions(
  catalog: readonly ProductTagCatalogEntry[],
  selectedTags: readonly string[],
  query: string
): ProductTagCatalogEntry[] {
  const canonicalQuery = canonicalizeProductTags([query])[0]
  if (!canonicalQuery) return []

  const selected = new Set(canonicalizeProductTags(selectedTags))

  return catalog
    .filter(
      (entry) => !selected.has(entry.tag) && entry.tag.includes(canonicalQuery)
    )
    .sort((a, b) => {
      const prefixRankA = a.tag.startsWith(canonicalQuery) ? 0 : 1
      const prefixRankB = b.tag.startsWith(canonicalQuery) ? 0 : 1

      return (
        prefixRankA - prefixRankB ||
        b.count - a.count ||
        a.tag.localeCompare(b.tag)
      )
    })
}
