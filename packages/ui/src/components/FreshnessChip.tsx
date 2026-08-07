import { useEffect, useRef, useState, type HTMLAttributes } from "react"
import { cva } from "class-variance-authority"
import { Check, LoaderCircle } from "lucide-react"
import { cn } from "../utils"

/**
 * Freshness state of the data behind a page or section.
 *
 * - `idle`: data is current; the chip fades out and reserves no space
 * - `updating`: a background refresh is running; shows a spinner
 * - `stale`: the data may be out of date (degraded or partial relay view)
 */
export type FreshnessChipStatus = "idle" | "updating" | "stale"

type FreshnessChipPhase = "hidden" | "updating" | "stale" | "synced"

const freshnessChipVariants = cva(
  "pointer-events-none inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-[opacity,color,background-color,border-color] duration-150",
  {
    variants: {
      visible: {
        true: "opacity-100",
        false: "opacity-0",
      },
      tone: {
        neutral:
          "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]",
        info: "border-[color-mix(in_srgb,var(--info)_45%,transparent)] bg-[color-mix(in_srgb,var(--info)_12%,var(--surface-elevated))] text-[var(--info)]",
        success:
          "border-[color-mix(in_srgb,var(--success)_45%,transparent)] bg-[color-mix(in_srgb,var(--success)_12%,var(--surface-elevated))] text-[var(--success)]",
      },
    },
    defaultVariants: {
      visible: false,
      tone: "neutral",
    },
  }
)

const phaseTone = {
  updating: "info",
  synced: "success",
  stale: "neutral",
} as const

export interface FreshnessChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Current freshness status driving visibility, label, and spinner. */
  status: FreshnessChipStatus
  /** Label shown while a background refresh runs. */
  updatingLabel?: string
  /** Label shown when the data may be out of date. */
  staleLabel?: string
  /** Label flashed briefly after a refresh completes. */
  syncedLabel?: string
  /** How long the synced confirmation stays visible, in ms. */
  syncedDurationMs?: number
}

/**
 * FreshnessChip -- a shift-free data-freshness indicator pill.
 *
 * The chip is always mounted and toggles via an opacity fade, so it never
 * inserts or removes layout space when a refresh starts. Place it inside a
 * `relative` container with `absolute right-0 top-0` (or any overlay
 * position) so it floats over free space instead of pushing content down.
 * The chip is pointer-transparent, so it never blocks clicks on content
 * beneath it.
 *
 * While `status` is `updating` the chip uses the shared `--info` (blue)
 * tone with a spinner. When `status` transitions from `updating` back to
 * `idle`, the chip flashes a `--success` (green) synced confirmation for
 * `syncedDurationMs` before fading out. A transition to `stale` shows the
 * neutral stale label instead.
 *
 * During fade-out the chip keeps the last active label so the text does not
 * swap mid-transition.
 *
 * @example
 * <div className="relative min-h-[1.625rem]">
 *   <FreshnessChip
 *     status={query.isHydrating ? "updating" : query.meta?.stale ? "stale" : "idle"}
 *     updatingLabel="Updating listings"
 *     staleLabel="Listings may be out of date"
 *     className="absolute right-0 top-0"
 *   />
 * </div>
 */
function FreshnessChip({
  status,
  updatingLabel = "Updating",
  staleLabel = "May be out of date",
  syncedLabel = "Synced",
  syncedDurationMs = 2000,
  className,
  ...props
}: FreshnessChipProps) {
  const [phase, setPhase] = useState<FreshnessChipPhase>(
    status === "idle" ? "hidden" : status
  )
  const prevStatus = useRef(status)

  useEffect(() => {
    const prev = prevStatus.current
    prevStatus.current = status

    if (status !== "idle") {
      setPhase(status)
      return
    }
    if (prev !== "updating") {
      setPhase("hidden")
      return
    }
    setPhase("synced")
    const timer = setTimeout(() => setPhase("hidden"), syncedDurationMs)
    return () => clearTimeout(timer)
  }, [status, syncedDurationMs])

  const lastActivePhase =
    useRef<Exclude<FreshnessChipPhase, "hidden">>("updating")
  if (phase !== "hidden") {
    lastActivePhase.current = phase
  }

  const visible = phase !== "hidden"
  const displayPhase = phase === "hidden" ? lastActivePhase.current : phase
  const label =
    displayPhase === "stale"
      ? staleLabel
      : displayPhase === "synced"
        ? syncedLabel
        : updatingLabel

  return (
    <span
      role="status"
      aria-hidden={!visible}
      className={cn(
        freshnessChipVariants({ visible, tone: phaseTone[displayPhase] }),
        className
      )}
      {...props}
    >
      {displayPhase === "updating" && (
        <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />
      )}
      {displayPhase === "synced" && (
        <Check aria-hidden="true" className="h-3 w-3" />
      )}
      {label}
    </span>
  )
}

export { FreshnessChip, freshnessChipVariants }
