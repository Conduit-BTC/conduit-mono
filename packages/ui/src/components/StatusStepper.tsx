import { AlertCircle, Check } from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import { cn } from "../utils"

export type StatusStepperRowStatus =
  | "waiting"
  | "in_progress"
  | "complete"
  | "failed"
  | "retry_needed"

export interface StatusStepperRow {
  /** Stable key for React reconciliation. */
  key: string
  /** Primary label (e.g. "Order sent to merchant"). */
  title: ReactNode
  /** Optional one-line subtitle rendered under the title. */
  subtitle?: ReactNode
  /** Current status of this row. */
  status: StatusStepperRowStatus
  /**
   * Optional override for the right-aligned status label. If omitted the
   * stepper uses a default label per `status` (e.g. "Waiting").
   */
  label?: ReactNode
}

export interface StatusStepperProps {
  rows: StatusStepperRow[]
  className?: string
  /**
   * Sets `aria-label` on the wrapping `<ol>` so screen readers announce the
   * tracker's purpose. Defaults to "Progress".
   */
  ariaLabel?: string
}

const DEFAULT_LABELS: Record<StatusStepperRowStatus, string> = {
  waiting: "Waiting",
  in_progress: "In progress",
  complete: "Complete",
  failed: "Failed",
  retry_needed: "Retry needed",
}

function getStatusMeta(status: StatusStepperRowStatus): {
  rowToneClassName: string
  labelToneClassName: string
  connectorClassName: string
} {
  switch (status) {
    case "complete":
      return {
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--success)]",
        connectorClassName:
          "bg-[color-mix(in_srgb,var(--success)_55%,transparent)]",
      }
    case "in_progress":
      return {
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--secondary-400)]",
        connectorClassName:
          "bg-[color-mix(in_srgb,var(--secondary-500)_45%,transparent)]",
      }
    case "failed":
      return {
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--error)]",
        connectorClassName: "bg-[var(--border)]",
      }
    case "retry_needed":
      return {
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--warning)]",
        connectorClassName: "bg-[var(--border)]",
      }
    case "waiting":
    default:
      return {
        rowToneClassName: "text-[var(--text-secondary)]",
        labelToneClassName: "text-[var(--text-muted)]",
        connectorClassName: "bg-[var(--border)]",
      }
  }
}

/**
 * StepIndicator -- the circular status node rendered in the left rail.
 *
 * Each status reads at a glance from the ring itself rather than only the icon:
 *  - complete:     success-toned outline ring (low-opacity fill) with a check
 *  - in_progress:  an animated arc that sweeps *around* the circle (progress
 *                  shown on the ring as the step runs); a static partial arc
 *                  under `prefers-reduced-motion`
 *  - waiting:      a muted ring with a small centered dot
 *  - failed:       error-toned ring with an alert glyph
 *  - retry_needed: warning-toned ring with an alert glyph
 */
function StepIndicator({ status }: { status: StatusStepperRowStatus }) {
  if (status === "complete") {
    return (
      <span
        aria-hidden="true"
        style={{
          borderColor: "color-mix(in srgb, var(--success) 55%, transparent)",
          backgroundColor:
            "color-mix(in srgb, var(--success) 16%, transparent)",
          color: "var(--success)",
        }}
        className="flex h-9 w-9 items-center justify-center rounded-full border"
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </span>
    )
  }

  if (status === "failed" || status === "retry_needed") {
    const tone = status === "failed" ? "var(--error)" : "var(--warning)"
    const indicatorStyle: CSSProperties = {
      borderColor: tone,
      color: tone,
      backgroundColor: `color-mix(in srgb, ${tone} 16%, transparent)`,
    }
    return (
      <span
        aria-hidden="true"
        style={indicatorStyle}
        className="flex h-9 w-9 items-center justify-center rounded-full border"
      >
        <AlertCircle className="h-4 w-4" />
      </span>
    )
  }

  if (status === "in_progress") {
    // r=15 -> circumference ~94.25; a ~30% arc reads as "in progress" while
    // the wrapper rotation sweeps it around the ring.
    return (
      <span
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center"
      >
        <svg
          viewBox="0 0 36 36"
          className="h-9 w-9 animate-spin motion-reduce:animate-none"
          fill="none"
        >
          <circle
            cx="18"
            cy="18"
            r="15"
            strokeWidth="2.5"
            style={{
              stroke:
                "color-mix(in srgb, var(--secondary-500) 22%, transparent)",
            }}
          />
          <circle
            cx="18"
            cy="18"
            r="15"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="94.25"
            strokeDashoffset="66"
            style={{ stroke: "var(--secondary-400)" }}
          />
        </svg>
      </span>
    )
  }

  // waiting
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]"
    >
      <span className="h-2 w-2 rounded-full bg-[var(--text-muted)]" />
    </span>
  )
}

/**
 * StatusStepper -- generic vertical step list with per-row status state.
 *
 * Used for any multi-step async progress UI (e.g. payment tracking, multi-event
 * publish). Tokens drive all colors so the same component reads correctly
 * across light/dark themes.
 *
 * Reduced-motion: the in-progress arc stops sweeping via `motion-reduce:` so it
 * appears as a static partial ring for users with `prefers-reduced-motion`.
 *
 * @example
 * <StatusStepper
 *   rows={[
 *     { key: "deliver", title: "Order sent", status: "complete" },
 *     { key: "wallet",  title: "Requesting invoice", status: "in_progress" },
 *     { key: "pay",     title: "Send payment", status: "waiting" },
 *   ]}
 * />
 */
export function StatusStepper({
  rows,
  className,
  ariaLabel = "Progress",
}: StatusStepperProps) {
  return (
    <ol
      aria-label={ariaLabel}
      aria-live="polite"
      className={cn("flex flex-col", className)}
    >
      {rows.map((row, index) => {
        const meta = getStatusMeta(row.status)
        const isLast = index === rows.length - 1
        const label = row.label ?? DEFAULT_LABELS[row.status]
        return (
          <li key={row.key} className="relative flex gap-4">
            {/* Icon + connector column */}
            <div className="flex shrink-0 flex-col items-center">
              <StepIndicator status={row.status} />
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "my-1 w-px flex-1 transition-colors",
                    meta.connectorClassName
                  )}
                />
              )}
            </div>

            {/* Title + subtitle + label */}
            <div
              className={cn(
                "flex flex-1 items-start justify-between gap-3",
                isLast ? "pb-0" : "pb-5"
              )}
            >
              <div className="min-w-0">
                <div
                  className={cn(
                    "text-sm font-medium leading-6",
                    meta.rowToneClassName
                  )}
                >
                  {row.title}
                </div>
                {row.subtitle && (
                  <div className="mt-0.5 text-xs leading-5 text-[var(--text-muted)]">
                    {row.subtitle}
                  </div>
                )}
              </div>
              <div
                className={cn(
                  "shrink-0 text-xs font-medium uppercase tracking-[0.08em]",
                  meta.labelToneClassName
                )}
              >
                {label}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
