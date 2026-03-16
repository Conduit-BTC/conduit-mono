import { type HTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-white/20 bg-primary-500 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]",
        secondary:
          "border-white/24 bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] transition-colors hover:bg-[var(--surface-elevated)]/80 hover:border-white/35",
        success:
          "border-transparent bg-green-100 text-green-800",
        warning:
          "border-transparent bg-orange-100 text-orange-800",
        destructive:
          "border-transparent bg-red-100 text-red-800",
        outline:
          "border-white/24 bg-white/[0.02] text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] transition-colors hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)] hover:border-white/35",
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
