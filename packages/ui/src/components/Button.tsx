import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cn } from "../utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 max-w-full whitespace-normal break-words rounded-[var(--radius-sm)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary-500 text-white hover:bg-primary-600 focus-visible:ring-primary-500",
        secondary:
          "bg-secondary-500 text-[var(--secondary-foreground)] hover:bg-secondary-400 focus-visible:ring-[var(--ring)]",
        accent:
          "bg-accent-500 text-white hover:bg-accent-600 focus-visible:ring-[var(--ring)]",
        outline:
          "border border-[var(--border)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--surface-elevated)] focus-visible:ring-primary-500",
        ghost:
          "bg-transparent text-[var(--text-primary)] hover:bg-[var(--surface-elevated)] focus-visible:ring-primary-500",
        muted:
          "bg-[var(--surface-elevated)] text-[var(--text-primary)] hover:opacity-90 focus-visible:ring-primary-500",
        destructive:
          "bg-[var(--destructive-action)] text-white hover:bg-[var(--destructive-action-hover)] focus-visible:ring-[var(--error-text)]",
        link: "text-[var(--link-text)] underline-offset-4 hover:underline focus-visible:ring-primary-500",
      },
      size: {
        sm: "min-h-11 px-3 py-1.5 text-sm sm:min-h-8 [@media(pointer:coarse)]:min-h-11",
        md: "min-h-11 px-4 py-2 text-sm sm:min-h-10 [@media(pointer:coarse)]:min-h-11",
        lg: "min-h-12 px-6 py-3 text-base",
        icon: "h-11 w-11 sm:h-10 sm:w-10 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
)

export interface ButtonProps
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
