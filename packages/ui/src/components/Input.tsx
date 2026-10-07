import { forwardRef, type ComponentPropsWithoutRef } from "react"
import { cn } from "../utils"

export type InputProps = ComponentPropsWithoutRef<"input">

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex min-h-11 sm:min-h-10 [@media(pointer:coarse)]:min-h-11 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-base text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:cursor-not-allowed disabled:opacity-50",
          type === "number" &&
            "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
