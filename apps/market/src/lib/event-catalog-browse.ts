import type { EventCatalogProduct } from "./event-market-adapter"
import { getPendingMerchantName } from "./marketBrowseModel"

export type EventCatalogMerchant = {
  pubkey: string
  name: string
  count: number
}

export type EventCatalogMerchantGroup = {
  pubkey: string
  name: string
  products: EventCatalogProduct[]
}

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim()
}

/** Browse only the event's already-loaded catalog; preserve its evidence objects. */
export function buildEventCatalogBrowse({
  products,
  merchantNames,
  search,
  merchant,
}: {
  products: readonly EventCatalogProduct[]
  merchantNames: Record<string, string>
  search: string
  merchant: string
}): {
  products: EventCatalogProduct[]
  groups: EventCatalogMerchantGroup[]
  merchants: EventCatalogMerchant[]
} {
  const nameFor = (pubkey: string) =>
    merchantNames[pubkey]?.trim() || getPendingMerchantName(pubkey)
  const compareNames = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  const merchantMap = new Map<string, EventCatalogMerchant>()
  for (const entry of products) {
    const pubkey = entry.product.pubkey
    const existing = merchantMap.get(pubkey)
    if (existing) existing.count += 1
    else merchantMap.set(pubkey, { pubkey, name: nameFor(pubkey), count: 1 })
  }
  const merchants = Array.from(merchantMap.values()).sort(
    (a, b) => compareNames(a.name, b.name) || a.pubkey.localeCompare(b.pubkey)
  )
  const query = normalizeSearch(search)
  const visible = products.filter(({ product }) => {
    if (merchant && product.pubkey !== merchant) return false
    return (
      !query ||
      normalizeSearch(product.title).includes(query) ||
      normalizeSearch(nameFor(product.pubkey)).includes(query)
    )
  })
  visible.sort((a, b) => {
    return (
      compareNames(a.product.title, b.product.title) ||
      a.product.id.localeCompare(b.product.id)
    )
  })
  const groupMap = new Map<string, EventCatalogProduct[]>()
  for (const entry of visible) {
    const pubkey = entry.product.pubkey
    const group = groupMap.get(pubkey)
    if (group) group.push(entry)
    else groupMap.set(pubkey, [entry])
  }
  return {
    products: visible,
    merchants,
    groups: merchants.flatMap(({ pubkey, name }) => {
      const entries = groupMap.get(pubkey)
      return entries ? [{ pubkey, name, products: entries }] : []
    }),
  }
}
