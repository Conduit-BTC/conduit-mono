export type LivePresenceIndicatorPageType = "product" | "store"

export interface LivePresenceIndicatorProps {
  className?: string
  count: number | null
  pageType: LivePresenceIndicatorPageType
}

const EXACT_SESSION_CLARIFICATION =
  "This is the exact number of active page sessions reported by the live service. One visitor can count more than once across browsers or devices."

export function getLivePresenceLabel(
  count: number,
  pageType: LivePresenceIndicatorPageType
): string {
  if (pageType === "product") {
    return count === 1
      ? "1 visitor is looking at this product"
      : `${count} visitors are looking at this product`
  }

  return count === 1
    ? "1 visitor is browsing this store"
    : `${count} visitors are browsing this store`
}

export function LivePresenceIndicator({
  className = "",
  count,
  pageType,
}: LivePresenceIndicatorProps) {
  if (count === null || !Number.isSafeInteger(count) || count <= 0) return null

  return (
    <div
      role="status"
      aria-atomic="true"
      aria-live="polite"
      title={EXACT_SESSION_CLARIFICATION}
      className={[
        "inline-flex max-w-full items-center gap-2 text-sm tabular-nums text-[var(--text-secondary)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full bg-[var(--success)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_14%,transparent)]"
      />
      <span>{getLivePresenceLabel(count, pageType)}</span>
      <span className="sr-only"> {EXACT_SESSION_CLARIFICATION}</span>
    </div>
  )
}
