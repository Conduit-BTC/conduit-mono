import { type HTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const badgeVariants = cva(
  "inline-flex max-w-full items-center rounded-[var(--radius-sm)] px-2 py-1 text-sm font-medium leading-5",
  {
    variants: {
      variant: {
        default: "bg-[var(--muted)] text-[var(--text-primary)]",
        secondary: "bg-[var(--muted)] text-[var(--text-secondary)]",
        success:
          "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success-text)]",
        warning:
          "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning-text)]",
        destructive:
          "bg-[color-mix(in_srgb,var(--error)_12%,transparent)] text-[var(--error-text)]",
        outline: "border border-[var(--border)] text-[var(--text-secondary)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
