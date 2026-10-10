import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "../utils"

interface SegmentedControlProps extends HTMLAttributes<HTMLDivElement> {
  asChild?: boolean
}

const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  ({ className, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "div"
    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex w-fit max-w-full flex-wrap overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]",
          className
        )}
        {...props}
      />
    )
  }
)
SegmentedControl.displayName = "SegmentedControl"

interface SegmentedControlItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected: boolean
  asChild?: boolean
}

const SegmentedControlItem = forwardRef<
  HTMLButtonElement,
  SegmentedControlItemProps
>(({ className, selected, asChild = false, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : "button"}
      disabled={asChild ? undefined : disabled}
      className={cn(
        "inline-flex h-11 items-center gap-2 whitespace-nowrap px-3 sm:h-9 [@media(pointer:coarse)]:h-11 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
        selected
          ? "bg-[var(--text-primary)] text-[var(--background)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
        disabled && "pointer-events-none opacity-45",
        className
      )}
      {...props}
    />
  )
})
SegmentedControlItem.displayName = "SegmentedControlItem"

export { SegmentedControl, SegmentedControlItem }
export type { SegmentedControlProps, SegmentedControlItemProps }
