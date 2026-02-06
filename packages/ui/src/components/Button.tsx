import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cn } from "../utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary-500 text-white hover:bg-primary-600 focus-visible:ring-primary-500",
        secondary:
          "bg-secondary-500 text-white hover:bg-secondary-600 focus-visible:ring-secondary-500",
        accent:
          "bg-accent-500 text-white hover:bg-accent-600 focus-visible:ring-accent-500",
        outline:
          "border border-neutral-300 bg-transparent hover:bg-neutral-100 focus-visible:ring-neutral-500",
        ghost:
          "bg-transparent hover:bg-neutral-100 focus-visible:ring-neutral-500",
        muted:
          "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 focus-visible:ring-neutral-500",
        destructive:
          "bg-error text-white hover:bg-red-600 focus-visible:ring-red-500",
        link: "text-primary-500 underline-offset-4 hover:underline focus-visible:ring-primary-500",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
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
