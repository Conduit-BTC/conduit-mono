import { useEffect, useState, type ButtonHTMLAttributes } from "react"
import { CheckCircle2, RotateCw } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./Button"
import {
  getRefreshChipDoneTimerDelay,
  resolveRefreshChipPhase,
  type RefreshChipPhase,
} from "./RefreshChipState"

export interface RefreshChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> {
  /** Whether the backing query is currently fetching. */
  refreshing: boolean
  /** Runs the requested refresh and settles after every backing source. */
  onRefresh: () => Promise<unknown>
  /** Preserved evidence used to avoid a false completion confirmation. */
  stale?: boolean
  /** Label shown while the control is idle and the data is current. */
  idleLabel?: string
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
 * green checked confirmation after an explicit refresh before settling back
 * to idle. Background refreshes may spin, but never announce completion or
 * turn the control into a network warning.
 *
 * The label column is shift-free: every phase label occupies the same grid
 * cell, so the cell keeps the intrinsic width of the widest label and phase
 * changes never move surrounding content.
 *
 * The phase machine follows the `refreshing` prop. While `refreshing` is
 * true the chip shows the refreshing label, reports `aria-busy`, and ignores
 * further clicks while staying fully opaque. When an explicit user refresh
 * completes, the chip flashes `doneLabel` for `doneDurationMs` before returning
 * to idle. That interval starts only after the externally reported refresh
 * also settles, so a re-keyed replacement read cannot consume the confirmation
 * behind the busy state. Background completion stays silent, and a completed
 * read that remains stale skips confirmation. The affected result surface owns
 * any consequential degraded-state copy.
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
  refreshingLabel = "Refreshing...",
  doneLabel = "Updated",
  doneDurationMs = 2000,
  disabled = false,
  className,
  ...props
}: RefreshChipProps) {
  const [phase, setPhase] = useState<RefreshChipPhase>("idle")

  useEffect(() => {
    const delay = getRefreshChipDoneTimerDelay({
      phase,
      refreshing,
      doneDurationMs,
    })
    if (delay === null) return
    const timer = setTimeout(() => setPhase("idle"), delay)
    return () => clearTimeout(timer)
  }, [phase, refreshing, doneDurationMs])

  const renderedPhase = resolveRefreshChipPhase({
    phase,
    refreshing,
    stale,
  })

  const refreshingPhase = renderedPhase === "refreshing"
  const accessibleLabel = refreshingPhase
    ? refreshingLabel
    : renderedPhase === "done"
      ? doneLabel
      : idleLabel

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
        setPhase("refreshing")
        let refreshResult: Promise<unknown>
        try {
          refreshResult = onRefresh()
        } catch {
          // The result surface owns refresh errors; the control only clears
          // its optimistic in-progress state.
          setPhase("idle")
          return
        }
        void refreshResult.then(
          () => setPhase("done"),
          () => setPhase("idle")
        )
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
              ? "text-[var(--text-secondary)]"
              : renderedPhase === "done"
                ? "text-[var(--success)]"
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
        <span className="inline-grid h-4 items-center justify-items-center">
          <span
            aria-hidden={renderedPhase !== "idle"}
            className={cn(
              "col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-200",
              renderedPhase === "idle"
                ? "opacity-100 text-[var(--text-primary)]"
                : "opacity-0"
            )}
          >
            {idleLabel}
          </span>
          <span
            aria-hidden={!refreshingPhase}
            className={cn(
              "col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-200",
              refreshingPhase
                ? "opacity-100 text-[var(--text-secondary)]"
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
