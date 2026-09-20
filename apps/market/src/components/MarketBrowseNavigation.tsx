import { Link } from "@tanstack/react-router"
import { CalendarDays, LayoutGrid, Store, type LucideIcon } from "lucide-react"
import { SegmentedControl, SegmentedControlItem } from "@conduit/ui"
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

type MarketBrowseSection = "products" | "merchants" | "events"

const MARKET_BROWSE_SECTIONS: {
  id: MarketBrowseSection
  to: "/products" | "/merchants" | "/events"
  label: string
  icon: LucideIcon
}[] = [
  { id: "products", to: "/products", label: "Products", icon: LayoutGrid },
  { id: "merchants", to: "/merchants", label: "Merchants", icon: Store },
  { id: "events", to: "/events", label: "Events", icon: CalendarDays },
]

export function MarketBrowseNavigation({
  active,
  source,
  connected,
  onSelectSource,
}: {
  active: MarketBrowseSection
  source: ProductCatalogSourceMode
  connected: boolean
  onSelectSource: (source: ProductCatalogSourceMode) => void
}) {
  const sectionSearch = source === "combined" ? {} : { source }

  return (
    <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <SegmentedControl asChild>
        <nav aria-label="Market browse">
          {MARKET_BROWSE_SECTIONS.map(({ id, to, label, icon: Icon }) => (
            <SegmentedControlItem key={id} asChild selected={active === id}>
              <Link
                to={to}
                search={sectionSearch}
                aria-current={active === id ? "page" : undefined}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </Link>
            </SegmentedControlItem>
          ))}
        </nav>
      </SegmentedControl>

      {connected && (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
            Perspective
          </div>
          <SegmentedControl role="group" aria-label="Market perspective">
            {MARKET_SOURCE_OPTIONS.map((option) => {
              const selected = source === option
              return (
                <SegmentedControlItem
                  key={option}
                  selected={selected}
                  aria-pressed={selected}
                  onClick={() => onSelectSource(option)}
                >
                  {MARKET_SOURCE_LABELS[option]}
                </SegmentedControlItem>
              )
            })}
          </SegmentedControl>
        </div>
      )}
    </section>
  )
}
