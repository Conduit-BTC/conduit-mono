import { useState } from "react"
import { categories, products, stores, type StudyProduct } from "./fixtures"
import { StudyHeader } from "./StudyHeader"
import { StudyProductCard } from "./StudyProductCard"
import {
  Button,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui"

export function StudyPage() {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("All products")
  const [store, setStore] = useState("all")
  const [sort, setSort] = useState("featured")
  const [preview, setPreview] = useState("loaded")
  const [cartCount, setCartCount] = useState(0)
  const [notice, setNotice] = useState("")

  const visibleProducts = products
    .filter(
      (product) =>
        (category === "All products" || product.category === category) &&
        (store === "all" || product.store === store) &&
        `${product.title} ${product.store}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
    )
    .sort((a, b) =>
      sort === "price-asc"
        ? a.sats - b.sats
        : sort === "price-desc"
          ? b.sats - a.sats
          : 0
    )
  const shownProducts = preview === "empty" ? [] : visibleProducts

  function resetFilters() {
    setQuery("")
    setCategory("All products")
    setStore("all")
    setSort("featured")
    setPreview("loaded")
  }

  function addToDemoCart(product: StudyProduct, option?: string) {
    setCartCount((count) => count + 1)
    setNotice(
      `Added ${product.title}${option ? ` (${option})` : ""} to the demo cart.`
    )
  }

  return (
    <div className="study-page">
      <a href="#products" className="study-skip-link">
        Skip to products
      </a>
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-center text-xs text-[var(--text-secondary)]">
        <strong className="font-semibold text-[var(--text-primary)]">
          Design study
        </strong>{" "}
        · Sample data only · No real purchases
      </div>
      <StudyHeader
        query={query}
        onQuery={setQuery}
        cartCount={cartCount}
        onClearCart={() => {
          setCartCount(0)
          setNotice("Demo cart cleared.")
        }}
      />
      <main id="products" tabIndex={-1} className="study-shell py-7 sm:py-10">
        <div className="mb-6">
          <h1 className="text-3xl font-semibold text-balance">Products</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)] text-pretty">
            Discover goods from independent shops.
          </p>
        </div>
        <fieldset className="mb-5">
          <legend className="sr-only">Product category</legend>
          <div className="flex flex-wrap gap-2">
            {["All products", ...categories].map((value) => (
              <Button
                key={value}
                type="button"
                variant="outline"
                aria-pressed={category === value}
                className={cn(
                  "rounded-full",
                  category === value &&
                    "border-[var(--text-secondary)] bg-[var(--surface-elevated)]"
                )}
                onClick={() => setCategory(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <p
            role="status"
            className="text-sm text-[var(--text-secondary)] tabular-nums"
          >
            {preview === "loading"
              ? "Loading sample products…"
              : `${shownProducts.length} sample products`}
          </p>
          <div className="grid w-full grid-cols-2 gap-3 sm:w-auto sm:min-w-96">
            <div>
              <label
                htmlFor="store-filter"
                className="mb-1 block text-xs text-[var(--text-secondary)]"
              >
                Shop
              </label>
              <Select value={store} onValueChange={setStore}>
                <SelectTrigger id="store-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All shops</SelectItem>
                  {stores.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label
                htmlFor="sort-order"
                className="mb-1 block text-xs text-[var(--text-secondary)]"
              >
                Sort
              </label>
              <Select value={sort} onValueChange={setSort}>
                <SelectTrigger id="sort-order">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="featured">Featured</SelectItem>
                  <SelectItem value="price-asc">Price: low to high</SelectItem>
                  <SelectItem value="price-desc">Price: high to low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        {preview === "loading" ? (
          <div className="study-grid" aria-hidden="true">
            {products.slice(0, 8).map((product) => (
              <div key={product.id} className="study-card">
                <div className="aspect-4/3 bg-[var(--surface-elevated)]" />
                <div className="m-4 h-4 w-2/3 rounded bg-[var(--surface-elevated)]" />
                <div className="m-4 h-4 w-1/3 rounded bg-[var(--surface-elevated)]" />
              </div>
            ))}
          </div>
        ) : shownProducts.length > 0 ? (
          <ul className="study-grid" aria-label="Sample products">
            {shownProducts.map((product) => (
              <StudyProductCard
                key={product.id}
                product={product}
                onAdd={addToDemoCart}
              />
            ))}
          </ul>
        ) : (
          <section className="rounded-xl border border-dashed border-[var(--border)] px-4 py-16 text-center">
            <h2 className="text-xl font-semibold text-balance">
              No products found
            </h2>
            <p className="my-3 text-sm text-[var(--text-secondary)] text-pretty">
              Try another search or reset the sample filters.
            </p>
            <Button type="button" variant="outline" onClick={resetFilters}>
              Reset filters
            </Button>
          </section>
        )}
        <p
          role="status"
          className="mt-4 min-h-5 text-sm text-[var(--text-secondary)]"
        >
          {notice}
        </p>
        <details className="mt-6 rounded-lg border border-[var(--border)] p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Study controls
          </summary>
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <div className="w-48">
              <label htmlFor="preview-state" className="mb-1 block text-sm">
                Preview state
              </label>
              <Select value={preview} onValueChange={setPreview}>
                <SelectTrigger id="preview-state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="loaded">Loaded</SelectItem>
                  <SelectItem value="loading">Loading</SelectItem>
                  <SelectItem value="empty">Empty</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="button" variant="outline" onClick={resetFilters}>
              Reset filters
            </Button>
            <p className="max-w-md text-xs text-[var(--text-secondary)] text-pretty">
              Edit this page, the cards, sample products, and study.css in
              apps/market/design-study/src. All interactions stay in this
              preview.
            </p>
          </div>
        </details>
      </main>
      <footer className="study-shell border-t border-[var(--border)] py-5 text-xs text-[var(--text-secondary)]">
        Conduit Market · UI sandbox · Not a live storefront
      </footer>
    </div>
  )
}
