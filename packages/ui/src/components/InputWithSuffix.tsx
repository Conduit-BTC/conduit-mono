import { forwardRef, useId } from "react"
import { Input, type InputProps } from "./Input"
import { cn } from "../utils"

export type InputWithSuffixProps = InputProps & { suffix: string }

export const InputWithSuffix = forwardRef<
  HTMLInputElement,
  InputWithSuffixProps
>(({ suffix, className, "aria-describedby": describedBy, ...props }, ref) => {
  const generatedId = useId()
  const suffixId = `${props.id ?? generatedId}-suffix`
  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        ref={ref}
        className={cn(
          "tabular-nums",
          suffix.length <= 2 ? "pr-10" : "pr-14",
          className
        )}
        aria-describedby={[describedBy, suffixId].filter(Boolean).join(" ")}
      />
      <span
        id={suffixId}
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-[var(--text-muted)]"
      >
        {suffix}
      </span>
    </div>
  )
})
InputWithSuffix.displayName = "InputWithSuffix"
