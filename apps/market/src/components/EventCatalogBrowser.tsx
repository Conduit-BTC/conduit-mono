import { Search } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import type { PricingRateInput } from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Combobox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import {
  buildEventCatalogBrowse,
  type EventCatalogSort,
} from "../lib/event-catalog-browse"
import type { EventCatalogProduct } from "../lib/event-market-adapter"
import type { MerchantIdentityView } from "../lib/marketBrowseModel"
import { PRODUCT_GRID_CLASS_NAME } from "./ProductGridCard"

const SORT_OPTIONS: { value: EventCatalogSort; label: string }[] = [
  { value: "name", label: "Name A–Z" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "merchant", label: "Merchant A–Z" },
]

export function EventCatalogBrowser({
  products,
  identities,
  btcUsdRate,
  children,
  renderProduct,
}: {
  products: EventCatalogProduct[]
  identities: Record<string, MerchantIdentityView>
  btcUsdRate: PricingRateInput
  children?: ReactNode
  renderProduct: (
    entry: EventCatalogProduct,
    index: number,
    onMerchantActivate: () => void
  ) => ReactNode
}) {
  const [search, setSearch] = useState("")
  const [merchant, setMerchant] = useState("")
  const [sort, setSort] = useState<EventCatalogSort>("name")
  const [grouped, setGrouped] = useState(false)
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
        sort,
        btcUsdRate,
      }),
    [products, identities, search, merchant, sort, btcUsdRate]
  )
  const hasFilters = search.trim().length > 0 || merchant !== ""
  const clearFilters = () => {
    setSearch("")
    setMerchant("")
  }
  const selectMerchant = (pubkey: string) => {
    setMerchant(pubkey)
    setSearch("")
  }
  const renderGrid = (entries: EventCatalogProduct[]) => (
    <ul className={PRODUCT_GRID_CLASS_NAME}>
      {entries.map((entry, index) => (
        <li key={entry.product.id} className="min-w-0 space-y-2">
          {renderProduct(entry, index, () =>
            selectMerchant(entry.product.pubkey)
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <section aria-labelledby="event-products-heading" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            id="event-products-heading"
            className="text-balance text-2xl font-semibold text-[var(--text-primary)]"
          >
            Shop the event
          </h2>
          <p
            role="status"
            aria-live="polite"
            className="text-sm tabular-nums text-[var(--text-secondary)]"
          >
            {hasFilters
              ? `${browse.products.length} of ${products.length}`
              : products.length}{" "}
            {products.length === 1 ? "product" : "products"}
            {!hasFilters && browse.merchants.length > 0
              ? ` · ${browse.merchants.length} ${browse.merchants.length === 1 ? "merchant" : "merchants"}`
              : ""}
          </p>
        </div>
        <div
          role="group"
          aria-label="Product view"
          className="flex rounded-lg border border-[var(--border)] p-1"
        >
          <Button
            size="sm"
            variant={grouped ? "ghost" : "primary"}
            aria-pressed={!grouped}
            onClick={() => setGrouped(false)}
          >
            All products
          </Button>
          <Button
            size="sm"
            variant={grouped ? "primary" : "ghost"}
            aria-pressed={grouped}
            onClick={() => setGrouped(true)}
          >
            By merchant
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1fr)_15rem_13rem]">
        <div className="relative col-span-2 min-w-0 lg:col-span-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-3 size-4 text-[var(--text-muted)]"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
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
            onValueChange={(value) => setMerchant(value === "all" ? "" : value)}
            searchPlaceholder="Find a merchant"
            emptyText="No matching merchants"
            selectedLabel={
              merchant
                ? (browse.merchants.find((entry) => entry.pubkey === merchant)
                    ?.name ?? "Selected merchant")
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
        <Select
          value={sort}
          onValueChange={(value) => setSort(value as EventCatalogSort)}
        >
          <SelectTrigger aria-label="Sort products" className="h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      ) : null}
      {browse.hasUnavailablePriceForSort ? (
        <p className="text-pretty text-sm text-[var(--text-secondary)]">
          Products without a comparable price appear last.
        </p>
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
      ) : grouped ? (
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
      ) : (
        renderGrid(browse.products)
      )}
    </section>
  )
}
