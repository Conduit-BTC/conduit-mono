import { AlertCircle, Check, CircleDot, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
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
  /** Primary label (e.g. "Order delivered to merchant"). */
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
  iconClassName: string
  rowToneClassName: string
  labelToneClassName: string
  connectorClassName: string
  Icon: typeof Check
  spin?: boolean
} {
  switch (status) {
    case "complete":
      return {
        Icon: Check,
        iconClassName:
          "border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_18%,transparent)] text-[var(--success)]",
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--success)]",
        connectorClassName:
          "bg-[color-mix(in_srgb,var(--success)_55%,transparent)]",
      }
    case "in_progress":
      return {
        Icon: Loader2,
        spin: true,
        iconClassName:
          "border-[color-mix(in_srgb,var(--secondary-500)_55%,transparent)] bg-[color-mix(in_srgb,var(--secondary-500)_18%,transparent)] text-[var(--secondary-400)]",
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--secondary-400)]",
        connectorClassName:
          "bg-[color-mix(in_srgb,var(--secondary-500)_45%,transparent)]",
      }
    case "failed":
      return {
        Icon: AlertCircle,
        iconClassName:
          "border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_18%,transparent)] text-[var(--error)]",
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--error)]",
        connectorClassName: "bg-[var(--border)]",
      }
    case "retry_needed":
      return {
        Icon: AlertCircle,
        iconClassName:
          "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--warning)]",
        rowToneClassName: "text-[var(--text-primary)]",
        labelToneClassName: "text-[var(--warning)]",
        connectorClassName: "bg-[var(--border)]",
      }
    case "waiting":
    default:
      return {
        Icon: CircleDot,
        iconClassName:
          "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)]",
        rowToneClassName: "text-[var(--text-secondary)]",
        labelToneClassName: "text-[var(--text-muted)]",
        connectorClassName: "bg-[var(--border)]",
      }
  }
}

/**
 * StatusStepper -- generic vertical step list with per-row status state.
 *
 * Used for any multi-step async progress UI (e.g. payment tracking, multi-event
 * publish). Tokens drive all colors so the same component reads correctly
 * across light/dark themes.
 *
 * Reduced-motion: the in-progress spinner is disabled via `motion-reduce:`
 * so it appears as a static icon for users with `prefers-reduced-motion`.
 *
 * @example
 * <StatusStepper
 *   rows={[
 *     { key: "deliver", title: "Order delivered", status: "complete" },
 *     { key: "wallet",  title: "Connecting wallet", status: "in_progress" },
 *     { key: "pay",     title: "Payment confirmation", status: "waiting" },
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
        const Icon = meta.Icon
        const label = row.label ?? DEFAULT_LABELS[row.status]
        return (
          <li key={row.key} className="relative flex gap-4">
            {/* Icon + connector column */}
            <div className="flex shrink-0 flex-col items-center">
              <span
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                  meta.iconClassName
                )}
                aria-hidden="true"
              >
                <Icon
                  className={cn(
                    "h-4 w-4",
                    meta.spin ? "animate-spin motion-reduce:animate-none" : ""
                  )}
                />
              </span>
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
