import { Search } from "lucide-react"
import { useMemo, type ReactNode } from "react"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Combobox,
  Input,
} from "@conduit/ui"
import { buildEventCatalogBrowse } from "../lib/event-catalog-browse"
import type { EventCatalogProduct } from "../lib/event-market-adapter"
import type { MerchantIdentityView } from "../lib/marketBrowseModel"
import { PRODUCT_GRID_CLASS_NAME } from "./ProductGridCard"

export function EventCatalogBrowser({
  products,
  identities,
  search,
  merchant,
  selectedMerchantName,
  onSearchChange,
  onMerchantChange,
  children,
  renderProduct,
}: {
  products: EventCatalogProduct[]
  identities: Record<string, MerchantIdentityView>
  search: string
  merchant: string
  selectedMerchantName?: string
  onSearchChange: (search: string) => void
  onMerchantChange: (merchantPubkey: string) => void
  children?: ReactNode
  renderProduct: (
    entry: EventCatalogProduct,
    index: number,
    onMerchantActivate: () => void
  ) => ReactNode
}) {
  const browse = useMemo(
    () =>
      buildEventCatalogBrowse({
        products,
        merchantNames: Object.fromEntries(
          Object.entries(identities).map(([pubkey, identity]) => [
            pubkey,
            identity.displayName,
          ])
        ),
        search,
        merchant,
      }),
    [products, identities, search, merchant]
  )
  const productIndexes = useMemo(
    () =>
      new Map(
        browse.groups
          .flatMap((group) => group.products)
          .map((entry, index) => [
            `${entry.product.pubkey}:${entry.product.id}`,
            index,
          ])
      ),
    [browse.groups]
  )
  const hasFilters = search.trim().length > 0 || merchant !== ""
  const clearFilters = () => {
    onSearchChange("")
    onMerchantChange("")
  }
  const selectMerchant = (pubkey: string) => {
    onSearchChange("")
    onMerchantChange(pubkey)
  }
  const renderGrid = (entries: EventCatalogProduct[]) => (
    <ul className={`${PRODUCT_GRID_CLASS_NAME} items-start`}>
      {entries.map((entry) => (
        <li key={entry.product.id} className="min-w-0 space-y-2">
          {renderProduct(
            entry,
            productIndexes.get(`${entry.product.pubkey}:${entry.product.id}`) ??
              0,
            () => selectMerchant(entry.product.pubkey)
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <section aria-label="Event products" className="space-y-5">
      <p role="status" aria-live="polite" className="sr-only">
        {hasFilters
          ? `${browse.products.length} of ${products.length}`
          : products.length}{" "}
        {products.length === 1 ? "product" : "products"}
        {!hasFilters && browse.merchants.length > 0
          ? ` from ${browse.merchants.length} ${browse.merchants.length === 1 ? "merchant" : "merchants"}`
          : ""}
      </p>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="relative min-w-0">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-3 size-4 text-[var(--text-muted)]"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            aria-label="Search products or merchants"
            placeholder="Search products or merchants"
            className="pl-9"
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="event-merchant" className="sr-only">
            Merchant
          </label>
          <Combobox
            id="event-merchant"
            value={merchant || "all"}
            onValueChange={(value) =>
              onMerchantChange(value === "all" ? "" : value)
            }
            searchPlaceholder="Find a merchant"
            emptyText="No matching merchants"
            selectedLabel={
              merchant
                ? (browse.merchants.find((entry) => entry.pubkey === merchant)
                    ?.name ??
                  selectedMerchantName ??
                  "Selected merchant")
                : "All merchants"
            }
            options={[
              {
                value: "all",
                label: "All merchants",
                meta: String(products.length),
              },
              ...browse.merchants.map((entry) => ({
                value: entry.pubkey,
                label: entry.name,
                meta: String(entry.count),
              })),
            ]}
          />
        </div>
      </div>
      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      ) : null}
      {children}
      {browse.products.length === 0 && products.length > 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
          <h3 className="text-balance font-medium text-[var(--text-primary)]">
            No matching products
          </h3>
          <p className="mt-2 text-pretty text-sm text-[var(--text-secondary)]">
            Try another search or clear your filters to browse this event.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {browse.groups.map((group) => (
            <section
              key={group.pubkey}
              aria-label={`${group.name} products`}
              className="space-y-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar className="size-9 shrink-0">
                  <AvatarImage
                    src={identities[group.pubkey]?.picture}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                  <AvatarFallback>{group.name.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <h3 className="min-w-0 break-words text-balance text-lg font-semibold text-[var(--text-primary)]">
                  {group.name}
                </h3>
                <span className="shrink-0 text-sm tabular-nums text-[var(--text-muted)]">
                  {group.products.length}{" "}
                  {group.products.length === 1 ? "product" : "products"}
                </span>
              </div>
              {renderGrid(group.products)}
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
