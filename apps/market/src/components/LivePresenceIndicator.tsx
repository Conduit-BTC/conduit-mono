import { useEffect, useState } from "react"

export type LivePresenceIndicatorPageType = "product" | "store"

export interface LivePresenceIndicatorProps {
  className?: string
  count: number | null | undefined
  pageType: LivePresenceIndicatorPageType
}

const EXACT_SESSION_CLARIFICATION =
  "This is the exact number of active page sessions reported by the live service. One visitor can count more than once across browsers or devices."
const LIVE_PRESENCE_EXIT_DURATION_MS = 220

export function getLivePresenceLabel(
  count: number,
  pageType: LivePresenceIndicatorPageType
): string {
  const phrase =
    pageType === "product" ? "looking at this product" : "browsing this store"
  return `${count} ${count === 1 ? "visitor is" : "visitors are"} ${phrase}`
}

export function LivePresenceIndicator({
  className = "",
  count,
  pageType,
}: LivePresenceIndicatorProps) {
  const visibleCount =
    typeof count === "number" && Number.isSafeInteger(count) && count > 0
      ? count
      : null
  const [lastVisibleCount, setLastVisibleCount] = useState(visibleCount)

  useEffect(() => {
    if (visibleCount !== null) {
      setLastVisibleCount(visibleCount)
      return
    }

    if (count === undefined) {
      setLastVisibleCount(null)
      return
    }

    if (lastVisibleCount === null) return

    const timeoutId = window.setTimeout(
      () => setLastVisibleCount(null),
      LIVE_PRESENCE_EXIT_DURATION_MS
    )
    return () => window.clearTimeout(timeoutId)
  }, [count, lastVisibleCount, visibleCount])

  if (count === undefined) return null

  const displayCount = visibleCount ?? lastVisibleCount
  const isExiting = visibleCount === null && displayCount !== null

  return (
    <div
      aria-hidden={visibleCount === null ? "true" : undefined}
      className={`min-h-5 ${className}`}
    >
      {displayCount === null ? null : (
        <div
          role="status"
          aria-atomic="true"
          aria-live="polite"
          title={EXACT_SESSION_CLARIFICATION}
          className={`${isExiting ? "market-live-presence-out" : "market-live-presence-in"} inline-flex max-w-full items-center gap-2 text-sm tabular-nums text-[var(--text-secondary)]`}
        >
          <span
            aria-hidden="true"
            className="relative flex size-3 shrink-0 items-center justify-center"
          >
            <span className="absolute inset-0 rounded-full border border-[var(--success)] opacity-70 motion-safe:animate-ping" />
            <span className="relative size-2.5 rounded-full bg-[var(--success)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_14%,transparent)]" />
          </span>
          <span>{getLivePresenceLabel(displayCount, pageType)}</span>
          <span className="sr-only"> {EXACT_SESSION_CLARIFICATION}</span>
        </div>
      )}
    </div>
  )
}
