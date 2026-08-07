import { forwardRef, type InputHTMLAttributes } from "react"
import { cn } from "../utils"

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  onCheckedChange?: (checked: boolean) => void
}

/**
 * Minimal shadcn-style checkbox built on the native input element so it
 * stays keyboard-accessible and form-compatible without extra dependencies.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ className, onCheckedChange, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        className={cn(
          "size-4 shrink-0 cursor-pointer appearance-none rounded border border-[var(--border)] bg-[var(--surface-elevated)] transition-colors",
          "checked:border-[var(--primary-500)] checked:bg-[var(--primary-500)]",
          "checked:bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M4%208.5l2.5%202.5L12%205.5%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] checked:bg-center checked:bg-no-repeat",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-500)]/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    )
  }
)
