import { type HTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-[var(--border)] bg-primary-500 text-white shadow-[var(--shadow-glass-inset)]",
        secondary:
          "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] transition-colors hover:bg-[var(--surface)] hover:border-[var(--text-secondary)]",
        success:
          "border-transparent bg-green-100 text-green-800",
        warning:
          "border-transparent bg-orange-100 text-orange-800",
        destructive:
          "border-transparent bg-red-100 text-red-800",
        outline:
          "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] shadow-[var(--shadow-glass-inset)] transition-colors hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
