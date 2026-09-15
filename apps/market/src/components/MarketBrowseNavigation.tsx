import { Link } from "@tanstack/react-router"
import { CalendarDays, LayoutGrid } from "lucide-react"
import { cn } from "@conduit/ui"
import type { ProductCatalogSourceMode } from "../lib/productCatalogRead"

export const MARKET_SOURCE_OPTIONS: ProductCatalogSourceMode[] = [
  "combined",
  "following",
  "conduit",
]

const MARKET_SOURCE_LABELS: Record<ProductCatalogSourceMode, string> = {
  combined: "Following + Conduit",
  following: "Following",
  conduit: "Conduit",
}

const browseLinkClassName =
  "inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"

export function MarketBrowseNavigation({
  active,
  source,
  connected,
  onSelectSource,
}: {
  active: "catalog" | "events"
  source: ProductCatalogSourceMode
  connected: boolean
  onSelectSource: (source: ProductCatalogSourceMode) => void
}) {
  return (
    <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <nav
        aria-label="Market browse"
        className="inline-flex w-fit rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1"
      >
        <Link
          to="/products"
          search={source === "combined" ? {} : { source }}
          aria-current={active === "catalog" ? "page" : undefined}
          className={cn(
            browseLinkClassName,
            active === "catalog"
              ? "bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          )}
        >
          <LayoutGrid className="h-4 w-4" aria-hidden="true" />
          Catalog
        </Link>
        <Link
          to="/events"
          search={source === "combined" ? {} : { source }}
          aria-current={active === "events" ? "page" : undefined}
          className={cn(
            browseLinkClassName,
            active === "events"
              ? "bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          )}
        >
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          Events
        </Link>
      </nav>

      <div className="flex min-h-10 min-w-0 flex-col gap-2 text-xs sm:flex-row sm:items-center">
        <div className="shrink-0 font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Perspective
        </div>
        <div
          role="group"
          aria-label="Market perspective"
          className="inline-flex w-fit max-w-full flex-wrap rounded-full border border-[var(--border)] bg-[var(--surface)] p-1"
        >
          {MARKET_SOURCE_OPTIONS.map((option) => {
            const selected = source === option
            const disabled = !connected && option !== "conduit"
            return (
              <button
                key={option}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onSelectSource(option)}
                className={cn(
                  "h-7 rounded-full px-3 font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                  selected
                    ? "bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  disabled && "pointer-events-none opacity-45"
                )}
              >
                {MARKET_SOURCE_LABELS[option]}
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
