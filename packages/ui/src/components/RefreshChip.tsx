import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react"
import { CheckCircle2, RotateCw } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"
import {
  resolveRefreshChipPhase,
  type RefreshChipPhase,
} from "./RefreshChipState"

export interface RefreshChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> {
  /** Whether the backing query is currently fetching. */
  refreshing: boolean
  /** Called when the shopper or merchant asks for fresh data. */
  onRefresh: () => void
  /** Marks the shown data as possibly out of date; swaps the idle label. */
  stale?: boolean
  /** Label shown while the control is idle and the data is current. */
  idleLabel?: string
  /** Label shown while the control is idle and the data may be stale. */
  staleLabel?: string
  /** Label shown while a refresh runs. */
  refreshingLabel?: string
  /** Label flashed briefly after a refresh completes. */
  doneLabel?: string
  /** How long the done confirmation stays visible, in ms. */
  doneDurationMs?: number
}

/**
 * RefreshChip -- the shared refresh control used across Market and Merchant
 * data surfaces. It matches the Merchant orders page style: an outline
 * button with a rotate icon that spins while a refresh runs, then flashes a
 * green checked confirmation before settling back to idle.
 *
 * The label column is shift-free: every phase label occupies the same grid
 * cell, so the cell keeps the intrinsic width of the widest label and phase
 * changes never move surrounding content.
 *
 * The phase machine follows the `refreshing` prop. While `refreshing` is
 * true the chip shows the refreshing label, reports `aria-busy`, and ignores
 * further clicks while staying fully opaque. When a fresh read completes, the
 * chip flashes `doneLabel` for `doneDurationMs` before returning to idle. A
 * completed read that remains stale skips that confirmation and shows
 * `staleLabel` with a warning tone instead.
 *
 * @example
 * <RefreshChip
 *   refreshing={productsQuery.isFetching}
 *   onRefresh={() => productsQuery.refetch()}
 *   refreshingLabel="Refreshing listings..."
 * />
 */
function RefreshChip({
  refreshing,
  onRefresh,
  stale = false,
  idleLabel = "Refresh",
  staleLabel = "May be out of date",
  refreshingLabel = "Refreshing...",
  doneLabel = "Updated",
  doneDurationMs = 2000,
  disabled = false,
  className,
  ...props
}: RefreshChipProps) {
  const [phase, setPhase] = useState<RefreshChipPhase>(
    refreshing ? "refreshing" : "idle"
  )
  const prevRefreshing = useRef(refreshing)

  useEffect(() => {
    const wasRefreshing = prevRefreshing.current
    prevRefreshing.current = refreshing

    setPhase((currentPhase) =>
      resolveRefreshChipPhase({
        currentPhase,
        refreshCompleted: wasRefreshing && !refreshing,
        refreshing,
        stale,
      })
    )
  }, [refreshing, stale])

  useEffect(() => {
    if (phase !== "done") return
    const timer = setTimeout(() => setPhase("idle"), doneDurationMs)
    return () => clearTimeout(timer)
  }, [phase, doneDurationMs])

  const renderedPhase = resolveRefreshChipPhase({
    currentPhase: phase,
    refreshCompleted: false,
    refreshing,
    stale,
  })

  const shownIdleLabel = stale ? staleLabel : idleLabel
  const idleTextClass = stale
    ? "text-[var(--warning)]"
    : "text-[var(--text-primary)]"
  const refreshingPhase = renderedPhase === "refreshing"
  const accessibleLabel = refreshingPhase
    ? refreshingLabel
    : renderedPhase === "done"
      ? doneLabel
      : shownIdleLabel

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={accessibleLabel}
      aria-busy={refreshingPhase}
      onClick={() => {
        if (refreshingPhase) return
        onRefresh()
      }}
      className={cn("shrink-0", className)}
      {...props}
    >
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex h-4 w-4 items-center justify-center transition-colors duration-200",
            refreshingPhase
              ? "text-[var(--secondary-500)]"
              : renderedPhase === "done"
                ? "text-[var(--success)]"
                : stale
                  ? "text-[var(--warning)]"
                  : "text-[var(--text-secondary)]"
          )}
        >
          {renderedPhase === "done" ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <RotateCw
              className={cn("h-3.5 w-3.5", refreshingPhase && "animate-spin")}
            />
          )}
        </span>
        <span
          role="status"
          className="inline-grid h-4 items-center justify-items-center"
        >
          <span
            aria-hidden={renderedPhase !== "idle"}
            className={cn(
              "col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-200",
              renderedPhase === "idle"
                ? cn("opacity-100", idleTextClass)
                : "opacity-0"
            )}
          >
            {shownIdleLabel}
          </span>
          <span
            aria-hidden={!refreshingPhase}
            className={cn(
              "col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-200",
              refreshingPhase
                ? "opacity-100 text-[var(--secondary-500)]"
                : "opacity-0"
            )}
          >
            {refreshingLabel}
          </span>
          <span
            aria-hidden={renderedPhase !== "done"}
            className={cn(
              "col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-200",
              renderedPhase === "done"
                ? "opacity-100 text-[var(--success)]"
                : "opacity-0"
            )}
          >
            {doneLabel}
          </span>
        </span>
      </span>
    </Button>
  )
}

export { RefreshChip }
