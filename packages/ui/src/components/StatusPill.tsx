import { type HTMLAttributes } from "react"
import { CircleAlert, CircleCheck, CircleX, Info } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const statusPillVariants = cva(
  "inline-flex w-fit max-w-full items-start gap-1.5 text-xs font-medium leading-5",
  {
    variants: {
      variant: {
        warning: "text-[var(--warning-text)]",
        success: "text-[var(--success-text)]",
        info: "text-[var(--info-text)]",
        error: "text-[var(--error-text)]",
        neutral: "text-[var(--text-secondary)]",
      },
    },
    defaultVariants: { variant: "warning" },
  }
)

// Retained export for consumers of the original status icon.
function FilledWarningIcon({ size }: { size: number }) {
  return (
    <CircleAlert
      size={size}
      style={{ width: size, height: size }}
      className="shrink-0"
      aria-hidden="true"
    />
  )
}

const ICONS = {
  warning: CircleAlert,
  success: CircleCheck,
  info: Info,
  error: CircleX,
  neutral: null,
} as const

export interface StatusPillProps
  extends
    HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusPillVariants> {
  /** Icon size in px. Defaults to 14. */
  iconSize?: number
  /** Hide the leading icon when surrounding content already conveys the state. */
  noIcon?: boolean
}

/** Passive status label. The historical export name is retained for consumers. */
function StatusPill({
  className,
  variant = "warning",
  iconSize = 14,
  noIcon = false,
  children,
  ...props
}: StatusPillProps) {
  const Icon = ICONS[variant ?? "warning"]
  return (
    <span className={cn(statusPillVariants({ variant }), className)} {...props}>
      {!noIcon && Icon && (
        <Icon
          size={iconSize}
          style={{ width: iconSize, height: iconSize }}
          className="mt-[3px] shrink-0"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  )
}

export { StatusPill, statusPillVariants, FilledWarningIcon }
