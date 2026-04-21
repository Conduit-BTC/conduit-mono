import { type HTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const statusPillVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium",
  {
    variants: {
      variant: {
        warning:
          "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] text-[var(--warning)]",
        success:
          "border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]",
        info: "border-[var(--info)] bg-[color-mix(in_srgb,var(--info)_12%,transparent)] text-[var(--info)]",
        error:
          "border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_12%,transparent)] text-[var(--error)]",
        neutral:
          "border-[var(--border-overlay)] bg-[color-mix(in_srgb,var(--neutral-500)_8%,transparent)] text-[var(--text-secondary)]",
      },
    },
    defaultVariants: {
      variant: "warning",
    },
  }
)

// ---------------------------------------------------------------------------
// Filled status icons -- solid circle, white negative-space glyph inside
// ---------------------------------------------------------------------------

function FilledWarningIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fillRule="evenodd"
        fill="currentColor"
        d={[
          // filled circle
          "M8 0A8 8 0 1 0 8 16A8 8 0 0 0 8 0Z",
          // exclamation stem (cutout)
          "M7.25 4H8.75V9.25H7.25Z",
          // exclamation dot (cutout)
          "M8 10.75A1.25 1.25 0 1 0 8 13.25A1.25 1.25 0 0 0 8 10.75Z",
        ].join(" ")}
      />
    </svg>
  )
}

function FilledSuccessIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      {/* checkmark */}
      <polyline
        points="4.5,8.5 7,11 11.5,5.5"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FilledInfoIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      {/* i dot */}
      <circle cx="8" cy="5" r="1" fill="white" />
      {/* i stem */}
      <rect x="7.25" y="7" width="1.5" height="4.5" rx="0.75" fill="white" />
    </svg>
  )
}

function FilledErrorIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      {/* X */}
      <line
        x1="5"
        y1="5"
        x2="11"
        y2="11"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <line
        x1="11"
        y1="5"
        x2="5"
        y2="11"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

const ICONS = {
  warning: FilledWarningIcon,
  success: FilledSuccessIcon,
  info: FilledInfoIcon,
  error: FilledErrorIcon,
} as const

export interface StatusPillProps
  extends
    HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusPillVariants> {
  /** Icon size in px. Defaults to 12. */
  iconSize?: number
  /** Hide the leading icon. */
  noIcon?: boolean
}

/**
 * StatusPill -- a small labelled pill for readiness / alert states.
 *
 * @example
 * <StatusPill variant="warning">Needs completion</StatusPill>
 * <StatusPill variant="success">Ready</StatusPill>
 */
function StatusPill({
  className,
  variant = "warning",
  iconSize = 12,
  noIcon = false,
  children,
  ...props
}: StatusPillProps) {
  const Icon = ICONS[variant ?? "warning"]

  return (
    <span className={cn(statusPillVariants({ variant }), className)} {...props}>
      {!noIcon && Icon && <Icon size={iconSize} />}
      {children}
    </span>
  )
}

export { StatusPill, statusPillVariants, FilledWarningIcon }
