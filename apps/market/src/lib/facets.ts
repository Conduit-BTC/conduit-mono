import { canonicalizeProductTags, type Product } from "@conduit/core"

export interface FacetOption {
  value: string
  label: string
  count: number
  selected: boolean
}

export interface ProductFacetFilters {
  q?: string
  merchants?: string[]
  tags?: string[]
}

export interface CategorySuggestionFilters {
  query: string
  merchants?: string[]
  limit?: number
}

export function normalizeFacetValues(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []

  return Array.from(
    new Set(
      values
        .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
}

function matchesText(product: Product, q: string | undefined): boolean {
  if (!q) return true
  const query = q.toLowerCase()

  return (
    product.title.toLowerCase().includes(query) ||
    (product.summary?.toLowerCase().includes(query) ?? false)
  )
}

function matchesAnyMerchant(
  product: Product,
  merchants: readonly string[] | undefined
): boolean {
  if (!merchants || merchants.length === 0) return true
  return merchants.includes(product.pubkey)
}

function matchesAnyTag(
  product: Product,
  tags: readonly string[] | undefined
): boolean {
  if (!tags || tags.length === 0) return true
  const selected = new Set(canonicalizeProductTags(tags))
  return canonicalizeProductTags(product.tags).some((tag) => selected.has(tag))
}

function sortFacetOptions(options: FacetOption[]): FacetOption[] {
  return [...options].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.label.localeCompare(b.label)
  })
}

function normalizeSuggestionText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
}

function getCategorySuggestionRank(
  label: string,
  query: string
): number | null {
  const normalizedLabel = normalizeSuggestionText(label)
  if (normalizedLabel === query) return 0
  if (normalizedLabel.startsWith(query)) return 1
  if (
    normalizedLabel.split(/[\s/_-]+/).some((word) => word.startsWith(query))
  ) {
    return 2
  }
  return normalizedLabel.includes(query) ? 3 : null
}

export function filterProductsByFacets(
  products: Product[],
  filters: ProductFacetFilters
): Product[] {
  const tags = canonicalizeProductTags(filters.tags)

  return products.filter(
    (product) =>
      matchesText(product, filters.q) &&
      matchesAnyMerchant(product, filters.merchants) &&
      matchesAnyTag(product, tags)
  )
}

export function getCategoryFacetOptions(
  products: Product[],
  filters: ProductFacetFilters
): FacetOption[] {
  const selectedTags = new Set(canonicalizeProductTags(filters.tags))
  const counts = new Map<string, number>()

  for (const product of products) {
    if (
      !matchesText(product, filters.q) ||
      !matchesAnyMerchant(product, filters.merchants)
    ) {
      continue
    }

    const uniqueTags = canonicalizeProductTags(product.tags)
    for (const tag of uniqueTags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  for (const tag of selectedTags) {
    if (!counts.has(tag)) counts.set(tag, 0)
  }

  return sortFacetOptions(
    Array.from(counts.entries())
      .map(([tag, count]) => ({
        value: tag,
        label: tag,
        count,
        selected: selectedTags.has(tag),
      }))
      .filter((option) => option.count > 0 || option.selected)
  )
}

/**
 * Ranks category suggestions from the already prepared catalog. Facet order is
 * retained as the tie-breaker, so equally relevant tags stay deterministic by
 * usage count and then label without presenting those counts as global truth.
 */
export function getCategorySuggestionOptions(
  products: Product[],
  filters: CategorySuggestionFilters
): FacetOption[] {
  const query = normalizeSuggestionText(filters.query)
  if (!query) return []

  return getCategoryFacetOptions(products, {
    merchants: filters.merchants,
  })
    .map((option, index) => ({
      index,
      option,
      rank: getCategorySuggestionRank(option.label, query),
    }))
    .filter(
      (
        candidate
      ): candidate is {
        index: number
        option: FacetOption
        rank: number
      } => candidate.rank !== null
    )
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, Math.max(0, filters.limit ?? 5))
    .map(({ option }) => option)
}

export function getStoreFacetOptions(
  products: Product[],
  filters: ProductFacetFilters,
  getLabel: (pubkey: string) => string
): FacetOption[] {
  const selectedMerchants = new Set(filters.merchants ?? [])
  const counts = new Map<string, number>()

  for (const product of products) {
    if (
      !matchesText(product, filters.q) ||
      !matchesAnyTag(product, filters.tags)
    ) {
      continue
    }

    counts.set(product.pubkey, (counts.get(product.pubkey) ?? 0) + 1)
  }

  for (const merchant of selectedMerchants) {
    if (!counts.has(merchant)) counts.set(merchant, 0)
  }

  return sortFacetOptions(
    Array.from(counts.entries())
      .map(([merchant, count]) => ({
        value: merchant,
        label: getLabel(merchant),
        count,
        selected: selectedMerchants.has(merchant),
      }))
      .filter((option) => option.count > 0 || option.selected)
  )
}
