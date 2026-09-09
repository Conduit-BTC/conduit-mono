export type LivePresenceIndicatorPageType = "product" | "store"

export interface LivePresenceIndicatorProps {
  className?: string
  count: number | null | undefined
  pageType: LivePresenceIndicatorPageType
}

const EXACT_SESSION_CLARIFICATION =
  "This is the exact number of active page sessions reported by the live service. One visitor can count more than once across browsers or devices."

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
  if (count === undefined) return null

  const visibleCount =
    typeof count === "number" && Number.isSafeInteger(count) && count > 0
      ? count
      : null

  return (
    <div
      aria-hidden={visibleCount === null ? "true" : undefined}
      className={`min-h-5 ${className}`}
    >
      {visibleCount === null ? null : (
        <div
          role="status"
          aria-atomic="true"
          aria-live="polite"
          title={EXACT_SESSION_CLARIFICATION}
          className="market-live-presence-in inline-flex max-w-full items-center gap-2 text-sm tabular-nums text-[var(--text-secondary)]"
        >
          <span
            aria-hidden="true"
            className="relative flex size-3 shrink-0 items-center justify-center"
          >
            <span className="absolute inset-0 rounded-full border border-[var(--success)] opacity-70 motion-safe:animate-ping" />
            <span className="relative size-2.5 rounded-full bg-[var(--success)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_14%,transparent)]" />
          </span>
          <span>{getLivePresenceLabel(visibleCount, pageType)}</span>
          <span className="sr-only"> {EXACT_SESSION_CLARIFICATION}</span>
        </div>
      )}
    </div>
  )
}
