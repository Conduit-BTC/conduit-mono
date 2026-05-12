import type { Product } from "@conduit/core"

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

function normalizeTag(value: string): string {
  return value.trim().toLowerCase()
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
  const selected = new Set(tags.map(normalizeTag))
  return product.tags.some((tag) => selected.has(normalizeTag(tag)))
}

function sortFacetOptions(options: FacetOption[]): FacetOption[] {
  return [...options].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.label.localeCompare(b.label)
  })
}

export function filterProductsByFacets(
  products: Product[],
  filters: ProductFacetFilters
): Product[] {
  const tags = filters.tags?.map(normalizeTag)

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
  const selectedTags = new Set((filters.tags ?? []).map(normalizeTag))
  const counts = new Map<string, number>()

  for (const product of products) {
    if (
      !matchesText(product, filters.q) ||
      !matchesAnyMerchant(product, filters.merchants)
    ) {
      continue
    }

    const uniqueTags = new Set(product.tags.map(normalizeTag).filter(Boolean))
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
