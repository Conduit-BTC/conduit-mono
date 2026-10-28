import { type MouseEvent } from "react"
import { Button } from "./Button"

export interface EventSeriesDateLink {
  coordinate: string
  label: string
  href?: string
  unavailableReason?: string
}

export interface EventSeriesDateNavigationProps {
  dates: readonly EventSeriesDateLink[]
  currentCoordinate?: string
  onNavigate?: (coordinate: string) => void
}

/** Presentation only: callers retain signed membership and action readiness. */
export function EventSeriesDateNavigation({
  dates,
  currentCoordinate,
  onNavigate,
}: EventSeriesDateNavigationProps) {
  const current = dates.find((date) => date.coordinate === currentCoordinate)
  const otherDates = dates.filter((date) => date !== current)
  if (otherDates.length === 0) return null
  const title = current ? "Other dates in this series" : "Dates in this series"

  function navigate(event: MouseEvent<HTMLAnchorElement>, coordinate: string) {
    if (
      !onNavigate ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    event.preventDefault()
    onNavigate(coordinate)
  }

  return (
    <nav aria-label={title} className="space-y-2">
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      <ul className="flex flex-wrap gap-2">
        {otherDates.map((date) => (
          <li key={date.coordinate} className="max-w-full">
            {date.href && !date.unavailableReason ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={date.href}
                  onClick={(event) => navigate(event, date.coordinate)}
                  className="h-auto min-h-11 whitespace-normal text-left"
                >
                  {date.label}
                </a>
              </Button>
            ) : (
              <span
                aria-disabled="true"
                className="block px-3 py-2 text-sm text-[var(--text-secondary)]"
              >
                {date.label}
                {date.unavailableReason ? ` — ${date.unavailableReason}` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}
